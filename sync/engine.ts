import { App, Notice, Platform } from 'obsidian';
import type { Stat } from 'obsidian';
import { GoogleDriveClient, DriveFile, GoogleDriveApiError, isSessionExpiredError } from './gdrive';
import { StateManager } from './state';
import type { SyncEntry } from './state';
import { syncDiagnostics } from './diagnostics';
import { SyncStatusView, SyncStats, VIEW_TYPE_SYNC_STATUS } from '../ui/sync-view';

const RECENT_LOCAL_EDIT_GRACE_MS = 30000;
const DRAWING_LOCAL_EDIT_GRACE_MS = 30000;
const STATE_SAVE_CHANGE_LIMIT = 40;
const STATE_SAVE_INTERVAL_MS = 10000;
const MOBILE_STATE_SAVE_CHANGE_LIMIT = 120;
const MOBILE_STATE_SAVE_INTERVAL_MS = 20000;
const MANUAL_STATUS_UPDATE_MS = 500;
const MOBILE_STATUS_UPDATE_MS = 1000;
const BACKGROUND_STATUS_UPDATE_MS = 3000;
const WORK_YIELD_ITEM_LIMIT = 15;
const MOBILE_WORK_YIELD_ITEM_LIMIT = 4;
const MOBILE_WORK_YIELD_MS = 16;
const CATASTROPHIC_DELETE_RATIO = 0.8;
const UPLOAD_PROGRESS_DETAIL_BYTES = 256 * 1024;
const PUSH_PARALLELISM = 3;
const LARGE_UPLOAD_BYTES = 2 * 1024 * 1024;
const MOBILE_CHUNKED_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MOBILE_DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
const PARTIAL_DOWNLOAD_SUFFIX = '.tether-part';
const EXCLUDED_PATH_SEGMENTS = new Set([
	'.git',
	'.codex-worktrees',
	'.trash',
	'node_modules',
	'.venv',
	'venv',
	'__pycache__',
	'.next',
	'dist',
	'build',
	'target',
	'.cache',
	'.turbo',
	'.parcel-cache',
	'coverage',
	'.pytest_cache',
	'.mypy_cache',
	'.tox',
	'.idea',
	'.vscode',
]);

export type SyncMode = 'pull' | 'push';
const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export class SyncStoppedError extends Error {
	constructor() {
		super('Sync stopped by user.');
		this.name = 'SyncStoppedError';
	}
}

interface SyncOptions {
	mode?: SyncMode;
	silent?: boolean;
	statusUpdateIntervalMs?: number;
}

interface RemoteScanTracker {
	seenCount: number;
	trackedCount: number;
	pendingDeletionPaths: Set<string>;
}

export class SyncEngine {
	app: App;
	client: GoogleDriveClient;
	stateManager: StateManager;
	folderId: string;
	statusBarItem: HTMLElement;
	private folderCache: Map<string, string> = new Map();
	private folderEnsurePromises: Map<string, Promise<string>> = new Map();
	private remoteFolderCache: Map<string, DriveFile[]> = new Map();
	private remoteFolderLoadPromises: Map<string, Promise<DriveFile[]>> = new Map();
	private silent = false;
	private statusUpdateIntervalMs = MANUAL_STATUS_UPDATE_MS;
	private lastStatusUpdateAt = 0;
	private processedSinceYield = 0;
	private stopRequested = false;
	private largeUploadTail: Promise<void> = Promise.resolve();
	private completedPushItems = 0;
	
	public stats: SyncStats = {
		totalFiles: 0,
		processed: 0,
		failed: 0,
		currentFile: '',
		detail: '',
		status: 'Idle',
		lastSync: '',
		errors: [],
		conflicts: [],
		deferred: []
	};

	constructor(app: App, client: GoogleDriveClient, stateManager: StateManager, folderId: string, statusBarItem: HTMLElement) {
		this.app = app;
		this.client = client;
		this.stateManager = stateManager;
		this.folderId = folderId;
		this.statusBarItem = statusBarItem;
	}

	requestStop() {
		this.stopRequested = true;
		this.updateStatus('Stopping...', undefined, true);
	}

	updateStatus(text: string, partialStats?: Partial<SyncStats>, force = false) {
		// This runs for every item in a large sync. Mutating the stable stats object avoids
		// producing thousands of short-lived copies that put pressure on mobile garbage collection.
		this.stats.status = text;
		if (partialStats) Object.assign(this.stats, partialStats);

		const now = Date.now();
		const shouldRender = force ||
			text === 'Idle' ||
			text === 'Failed' ||
			now - this.lastStatusUpdateAt >= this.statusUpdateIntervalMs;

		if (!shouldRender) return;
		this.lastStatusUpdateAt = now;

		this.statusBarItem.setText(`GDrive: ${text}`);

		const visibleLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);
		if (visibleLeaves.length > 0) {
			const view = visibleLeaves[0].view as SyncStatusView;
			if (typeof view.updateStats === 'function') {
				view.updateStats(this.stats);
			}
		}
	}

	async sync(options: SyncOptions = {}) {
		if (!this.folderId) {
			new Notice('Google Drive folder ID not set.');
			return;
		}

		const previousSilent = this.silent;
		const previousStatusUpdateIntervalMs = this.statusUpdateIntervalMs;
		this.silent = options.silent ?? false;
		this.statusUpdateIntervalMs = options.statusUpdateIntervalMs ?? (
			this.silent
				? BACKGROUND_STATUS_UPDATE_MS
				: (Platform.isMobileApp ? MOBILE_STATUS_UPDATE_MS : MANUAL_STATUS_UPDATE_MS)
		);
		this.lastStatusUpdateAt = 0;
		this.processedSinceYield = 0;
		this.stopRequested = false;

		try {
			this.stats.processed = 0;
			this.stats.failed = 0;
			this.stats.errors = [];
			this.stats.conflicts = [];
			this.stats.deferred = [];
			this.stats.detail = '';
			this.folderCache.clear();
			this.folderEnsurePromises.clear();
			this.remoteFolderCache.clear();
			this.remoteFolderLoadPromises.clear();
			const mode = options.mode ?? 'push';
			const modeLabel = mode === 'pull' ? 'Pull' : 'Push';
			syncDiagnostics.startSession(mode);
			
			this.updateStatus('Loading state...', undefined, true);
			await this.stateManager.load();
			
			const vaultName = this.app.vault.getName();
			this.updateStatus(`Locating vault root...`);
			
			const vaultRootDriveId = await this.ensureVaultRoot(vaultName, mode === 'push');
			this.folderCache.set('', vaultRootDriveId);
			this.throwIfStopped();

			if (mode === 'pull') {
				await this.pullFromRemote(vaultRootDriveId);
			} else {
				await this.pushToRemote(vaultRootDriveId);
			}

			this.stats.lastSync = new Date().toLocaleTimeString();
			this.stats.currentFile = '';
			this.stats.detail = '';
			await this.flushStateIfNeeded(true);
			this.updateStatus('Idle', undefined, true);
			syncDiagnostics.endSession('completed', this.stats);
			
			if (!this.silent && this.stats.failed > 0) {
				new Notice(`${modeLabel} complete with ${this.stats.failed} errors. Check sidebar.`);
			} else if (!this.silent && this.stats.deferred.length > 0) {
				new Notice(`${modeLabel} complete. Deferred ${this.stats.deferred.length} active file${this.stats.deferred.length === 1 ? '' : 's'} until editing stops.`);
			} else if (!this.silent) {
				new Notice(`${modeLabel} complete successfully!`);
			}
		} catch (error) {
			if (error instanceof SyncStoppedError) {
				this.updateStatus('Stopped', { currentFile: '' }, true);
				syncDiagnostics.endSession('stopped', this.stats);
				throw error;
			}

			this.updateStatus('Failed', undefined, true);
			syncDiagnostics.error(
				error instanceof Error ? error.message : String(error),
				this.stats.currentFile || undefined,
				error instanceof GoogleDriveApiError ? error.status : undefined,
				error instanceof GoogleDriveApiError ? error.reason : undefined
			);
			syncDiagnostics.endSession('failed', this.stats);
			console.error('Critical sync failure', error);
			throw error;
		} finally {
			this.silent = previousSilent;
			this.statusUpdateIntervalMs = previousStatusUpdateIntervalMs;
		}
	}

	private async pullFromRemote(vaultRootDriveId: string) {
		this.stats.processed = 0;
		this.stats.totalFiles = 0;
		this.updateStatus('Pulling changes...');

		// Track only previously-known paths that have not been seen. A first pull no longer
		// retains a second copy of every remote path while the state map is being populated.
		const pendingDeletionPaths = new Set<string>();
		for (const path of Object.keys(this.stateManager.state)) {
			if (path !== '__VAULT_ROOT__' && !this.isExcluded(path)) {
				pendingDeletionPaths.add(path);
			}
		}
		const tracker: RemoteScanTracker = {
			seenCount: 0,
			trackedCount: pendingDeletionPaths.size,
			pendingDeletionPaths
		};

		await this.processRemoteTree(vaultRootDriveId, tracker);
		if (tracker.seenCount === 0) {
			const msg = 'Pull found an empty Drive vault root. No local files were changed. Check the selected Google Drive folder/account, or use Push if this is a new empty Drive setup.';
			console.error(msg);
			new Notice(msg);
			this.stats.failed++;
			this.stats.errors.push({ path: 'Google Drive vault root', message: msg });
			return;
		}

		await this.handleRemoteDeletions(tracker);
	}

	private async pushToRemote(vaultRootDriveId: string) {
		this.updateStatus('Scanning local items...');
		const localPathSet = await this.collectLocalPathSet('');
		this.stats.totalFiles = localPathSet.size;
		this.throwIfStopped();

		await this.handleLocalDeletions(localPathSet);
		this.throwIfStopped();

		this.updateStatus('Pushing changes...', undefined, true);
		this.completedPushItems = 0;
		const paths = Array.from(localPathSet);
		let nextIndex = 0;

		const worker = async () => {
			while (true) {
				this.throwIfStopped();
				const index = nextIndex++;
				if (index >= paths.length) return;

				const path = paths[index];
				this.stats.currentFile = path;
				this.reportPushProgress('Checking');

				try {
					await this.processLocalPath(path, vaultRootDriveId);
				} catch (e) {
					if (isSessionExpiredError(e) || e instanceof SyncStoppedError) throw e;
					console.error(`Failed to push ${path}`, e);
					const message = this.getErrorMessage(e);
					syncDiagnostics.error(
						message,
						path,
						e instanceof GoogleDriveApiError ? e.status : undefined,
						e instanceof GoogleDriveApiError ? e.reason : undefined
					);
					if (this.isNotFound(e)) {
						this.stateManager.remove(path);
					} else {
						this.stats.failed++;
						this.stats.errors.push({ path, message });
					}
				}

				this.completedPushItems++;
				this.stats.processed = this.completedPushItems;
				this.stats.detail = '';
				this.reportPushProgress();
				await this.afterWorkItem();
			}
		};

		const workers = Array.from(
			{ length: Math.min(PUSH_PARALLELISM, Math.max(1, paths.length)) },
			() => worker()
		);

		const results = await Promise.allSettled(workers);
		for (const result of results) {
			if (result.status === 'rejected') {
				throw result.reason;
			}
		}
	}

	private async withLargeUploadGate<T>(size: number, fn: () => Promise<T>): Promise<T> {
		if (size < LARGE_UPLOAD_BYTES) {
			return fn();
		}

		const previous = this.largeUploadTail;
		let release!: () => void;
		this.largeUploadTail = new Promise<void>(resolve => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	private reportPushProgress(detailPrefix?: string, force = false) {
		const failedSuffix = this.stats.failed ? ` (${this.stats.failed} failed)` : '';
		const status = `Pushing ${this.stats.processed}/${this.stats.totalFiles}${failedSuffix}`;
		const fileName = this.stats.currentFile.split('/').pop() || this.stats.currentFile;
		const detail = detailPrefix
			? (this.stats.currentFile ? `${detailPrefix}: ${fileName}` : detailPrefix)
			: this.stats.detail;
		this.updateStatus(status, { currentFile: this.stats.currentFile, detail }, force);
	}

	private formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	private createUploadProgressHandler(path: string) {
		const fileName = path.split('/').pop() || path;
		return (uploadedBytes: number, totalBytes: number) => {
			const pct = totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0;
			const detail = totalBytes > UPLOAD_PROGRESS_DETAIL_BYTES
				? `Uploading ${fileName}: ${this.formatBytes(uploadedBytes)} / ${this.formatBytes(totalBytes)} (${pct}%)`
				: `Uploading ${fileName}: ${this.formatBytes(totalBytes)}`;
			this.stats.detail = detail;
			const failedSuffix = this.stats.failed ? ` (${this.stats.failed} failed)` : '';
			const shortName = fileName.length > 24 ? `${fileName.slice(0, 21)}...` : fileName;
			const status = totalBytes > UPLOAD_PROGRESS_DETAIL_BYTES
				? `Pushing ${this.stats.processed}/${this.stats.totalFiles} · ${shortName} ${pct}%${failedSuffix}`
				: `Pushing ${this.stats.processed}/${this.stats.totalFiles} · ${shortName}${failedSuffix}`;
			this.updateStatus(status, { currentFile: path, detail }, true);
		};
	}

	private isExcluded(path: string): boolean {
		const statePath = this.stateManager.getStatePath();
		const segments = path.split('/');

		if (path === statePath || path.startsWith(`${statePath}/`)) return true;
		if (path.endsWith(PARTIAL_DOWNLOAD_SUFFIX)) return true;

		for (const segment of segments) {
			if (EXCLUDED_PATH_SEGMENTS.has(segment)) return true;
		}

		return false;
	}

	private isConfigPath(path: string): boolean {
		const configDir = this.app.vault.configDir || '.obsidian';
		return path === configDir || path.startsWith(`${configDir}/`);
	}

	private isSameOrChildPath(path: string, parentPath: string): boolean {
		return path === parentPath || path.startsWith(`${parentPath}/`);
	}

	private isLocallyDeletedPath(path: string, locallyDeletedPaths: Set<string>): boolean {
		for (const deletedPath of locallyDeletedPaths) {
			if (this.isSameOrChildPath(path, deletedPath)) return true;
		}

		return false;
	}

	private isOpenFilePath(path: string): boolean {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile?.path === path) return true;

		let isOpen = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as { file?: { path?: string } | null };
			if (view.file?.path === path) {
				isOpen = true;
			}
		});

		return isOpen;
	}

	private async flushStateIfNeeded(force = false) {
		const changeLimit = Platform.isMobileApp ? MOBILE_STATE_SAVE_CHANGE_LIMIT : STATE_SAVE_CHANGE_LIMIT;
		const intervalMs = Platform.isMobileApp ? MOBILE_STATE_SAVE_INTERVAL_MS : STATE_SAVE_INTERVAL_MS;
		if (force || this.stateManager.shouldSave(changeLimit, intervalMs)) {
			await this.stateManager.save();
		}
	}

	private async afterWorkItem() {
		await this.flushStateIfNeeded();
		this.throwIfStopped();

		this.processedSinceYield++;
		const yieldItemLimit = Platform.isMobileApp ? MOBILE_WORK_YIELD_ITEM_LIMIT : WORK_YIELD_ITEM_LIMIT;
		if (this.processedSinceYield >= yieldItemLimit) {
			this.processedSinceYield = 0;
			const delayMs = Platform.isMobileApp ? MOBILE_WORK_YIELD_MS : 0;
			await new Promise<void>(resolve => window.setTimeout(resolve, delayMs));
			this.throwIfStopped();
		}
	}

	private throwIfStopped() {
		if (this.stopRequested) {
			throw new SyncStoppedError();
		}
	}

	private isNotFound(error: unknown): boolean {
		const status = typeof error === 'object' && error !== null && 'status' in error
			? (error as { status?: number }).status
			: undefined;
		return status === 404 || this.getErrorMessage(error).includes('404');
	}

	private isENOENT(error: unknown): boolean {
		const message = this.getErrorMessage(error).toLowerCase();
		const code = typeof error === 'object' && error !== null && 'code' in error
			? String((error as { code?: string }).code).toLowerCase()
			: '';
		return code === 'enoent' || message.includes('enoent');
	}

	private async safeStat(path: string): Promise<Stat | null> {
		try {
			return await this.app.vault.adapter.stat(path);
		} catch (error) {
			if (this.isENOENT(error)) {
				syncDiagnostics.warn(`Skipped missing path during sync: ${path}`, path);
				return null;
			}
			throw error;
		}
	}

	private shouldProceedWithLargeDeletion(mode: SyncMode, count: number, trackedCount: number): boolean {
		const percent = Math.round((count / trackedCount) * 100);
		const target = mode === 'pull' ? 'local' : 'remote';
		const source = mode === 'pull' ? 'Google Drive' : 'this device';
		const staleDeviceNote = mode === 'pull'
			? '\n\nThis can be normal when this device has not pulled changes for a while and the other device moved or deleted many files.'
			: '';
		const msg = `${mode === 'pull' ? 'Pull' : 'Push'} wants to delete ${count} of ${trackedCount} tracked ${target} files (${percent}%) because they are missing from ${source}.${staleDeviceNote}\n\nContinue only if this matches what you expect.`;

		if (this.silent) {
			return false;
		}

		return window.confirm(msg);
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private async listAllLocalItems(folderPath: string): Promise<string[]> {
		return Array.from(await this.collectLocalPathSet(folderPath));
	}

	private async collectLocalPathSet(folderPath: string, items: Set<string> = new Set()): Promise<Set<string>> {
		this.throwIfStopped();
		let result;
		try {
			result = await this.app.vault.adapter.list(folderPath);
		} catch (error) {
			if (this.isENOENT(error)) {
				syncDiagnostics.warn(`Skipped missing folder during scan: ${folderPath}`, folderPath);
				return items;
			}
			throw error;
		}
		
		for (const file of result.files) {
			this.throwIfStopped();
			if (!this.isExcluded(file)) {
				items.add(file);
			}
		}
		
		for (const folder of result.folders) {
			this.throwIfStopped();
			if (!this.isExcluded(folder)) {
				items.add(folder);
				await this.collectLocalPathSet(folder, items);
			}
			await this.afterWorkItem();
		}

		return items;
	}

	private async processLocalPath(path: string, vaultRootId: string) {
		const stat = await this.safeStat(path);
		if (!stat) return;

		if (stat.type === 'folder') {
			await this.ensureRemotePathByPath(path, vaultRootId);
			return;
		}

		if (await this.shouldDeferActiveLocalFile(path, stat)) {
			return;
		}

		const extension = path.includes('.') ? path.split('.').pop() || '' : '';
		const mimeType = this.getMimeType(extension);
		const fileName = path.split('/').pop() || path;
		const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
		const driveParentId = await this.ensureRemotePathByPath(parentPath, vaultRootId);
		let state = this.stateManager.get(path);
		if (state && stat.mtime <= state.lastSyncedMtime) {
			return;
		}

		// Known Drive ID: update directly (no folder listing). Saves a lot of API + RAM on large vaults.
		if (state?.driveId && stat.mtime > state.lastSyncedMtime) {
			let updated = false;
			await this.withLargeUploadGate(stat.size, async () => {
				const upload = await this.readStableLocalFile(path, stat);
				if (!upload) {
					updated = true;
					return;
				}
				try {
					const onProgress = this.createUploadProgressHandler(path);
					const remoteFile = await this.client.updateFile(state!.driveId, upload.content, mimeType, onProgress);
					this.updateCachedRemoteFile(driveParentId, remoteFile);
					this.stateManager.set(path, {
						...state!,
						lastSyncedMtime: upload.stat.mtime,
						remoteMtime: remoteFile.modifiedTime
					});
					await this.deferIfChangedAfterUpload(path, upload.stat);
					await this.flushStateIfNeeded();
					updated = true;
				} catch (e) {
					if (!this.isNotFound(e)) throw e;
					this.stateManager.remove(path);
					state = undefined;
				}
			});
			if (updated) return;
		}

		const existingRemote = await this.findRemoteFileByName(driveParentId, parentPath, fileName);

		if (state && existingRemote && state.driveId !== existingRemote.id) {
			state = { ...state, driveId: existingRemote.id, remoteMtime: existingRemote.modifiedTime };
			this.stateManager.set(path, state);
			await this.flushStateIfNeeded();
		}

		if (!state) {
			await this.withLargeUploadGate(stat.size, async () => {
				const upload = await this.readStableLocalFile(path, stat);
				if (!upload) return;
				const onProgress = this.createUploadProgressHandler(path);
				const remoteFile = existingRemote
					? await this.client.updateFile(existingRemote.id, upload.content, mimeType, onProgress)
					: await this.client.uploadFile(fileName, driveParentId, upload.content, mimeType, onProgress);
				this.updateCachedRemoteFile(driveParentId, remoteFile);

				this.stateManager.set(path, {
					driveId: remoteFile.id,
					lastSyncedMtime: upload.stat.mtime,
					remoteMtime: remoteFile.modifiedTime,
					etag: ''
				});
				await this.deferIfChangedAfterUpload(path, upload.stat);
				await this.flushStateIfNeeded();
			});
		} else if (stat.mtime > state.lastSyncedMtime) {
			await this.withLargeUploadGate(stat.size, async () => {
				const upload = await this.readStableLocalFile(path, stat);
				if (!upload) return;
				const onProgress = this.createUploadProgressHandler(path);
				const remoteFile = await this.client.updateFile(state!.driveId, upload.content, mimeType, onProgress);
				this.updateCachedRemoteFile(driveParentId, remoteFile);

				this.stateManager.set(path, {
					...state!,
					lastSyncedMtime: upload.stat.mtime,
					remoteMtime: remoteFile.modifiedTime
				});
				await this.deferIfChangedAfterUpload(path, upload.stat);
				await this.flushStateIfNeeded();
			});
		}
	}

	private async ensureRemotePathByPath(path: string, vaultRootId: string): Promise<string> {
		if (!path || path === '.' || path === '/') return vaultRootId;
		if (this.folderCache.has(path)) return this.folderCache.get(path)!;

		const promiseKey = path.toLowerCase();
		const pending = this.folderEnsurePromises.get(promiseKey);
		if (pending) return pending;

		const ensurePromise = this.resolveRemotePathByPath(path, vaultRootId);
		this.folderEnsurePromises.set(promiseKey, ensurePromise);

		try {
			return await ensurePromise;
		} finally {
			if (this.folderEnsurePromises.get(promiseKey) === ensurePromise) {
				this.folderEnsurePromises.delete(promiseKey);
			}
		}
	}

	private async resolveRemotePathByPath(path: string, vaultRootId: string): Promise<string> {
		const parts = path.split('/');
		const folderName = parts.pop() || '';
		const parentPath = parts.join('/');
		
		const parentDriveId = await this.ensureRemotePathByPath(parentPath, vaultRootId);
		
		const existingItems = await this.listCanonicalRemoteItems(parentDriveId, parentPath);
		const existing = existingItems.find(
			f => f.mimeType === GOOGLE_FOLDER_MIME_TYPE && f.name.toLowerCase() === folderName.toLowerCase()
		);
		
		if (existing) {
			this.stateManager.set(path, {
				driveId: existing.id,
				lastSyncedMtime: 0,
				remoteMtime: existing.modifiedTime,
				etag: ''
			});
			this.folderCache.set(path, existing.id);
			await this.flushStateIfNeeded();
			return existing.id;
		}

		const remoteFolder = await this.client.createFolder(folderName, parentDriveId);
		this.updateCachedRemoteFile(parentDriveId, remoteFolder);
		this.stateManager.set(path, {
			driveId: remoteFolder.id,
			lastSyncedMtime: 0,
			remoteMtime: remoteFolder.modifiedTime,
			etag: ''
		});
		this.folderCache.set(path, remoteFolder.id);
		await this.flushStateIfNeeded();

		return remoteFolder.id;
	}

	private async findRemoteFileByName(folderId: string, parentPath: string, fileName: string): Promise<DriveFile | undefined> {
		const items = await this.listCanonicalRemoteItems(folderId, parentPath);
		const normalizedFileName = fileName.toLowerCase();
		return items.find(item => item.mimeType !== GOOGLE_FOLDER_MIME_TYPE && item.name.toLowerCase() === normalizedFileName);
	}

	private async listCanonicalRemoteItems(folderId: string, parentPath: string): Promise<DriveFile[]> {
		if (this.remoteFolderCache.has(folderId)) {
			return this.remoteFolderCache.get(folderId)!;
		}

		const pending = this.remoteFolderLoadPromises.get(folderId);
		if (pending) return pending;

		const loadPromise = (async () => {
			const items = await this.client.listFiles(folderId);
			const canonicalItems = await this.consolidateDuplicateRemoteItems(folderId, parentPath, items);
			this.remoteFolderCache.set(folderId, canonicalItems);
			return canonicalItems;
		})();
		this.remoteFolderLoadPromises.set(folderId, loadPromise);

		try {
			return await loadPromise;
		} finally {
			if (this.remoteFolderLoadPromises.get(folderId) === loadPromise) {
				this.remoteFolderLoadPromises.delete(folderId);
			}
		}
	}

	private updateCachedRemoteFile(folderId: string, file: DriveFile) {
		const cached = this.remoteFolderCache.get(folderId);
		if (!cached) return;

		const index = cached.findIndex(item => item.id === file.id);
		if (index >= 0) {
			cached[index] = file;
		} else {
			cached.push(file);
		}
	}

	private async consolidateDuplicateRemoteItems(_folderId: string, parentPath: string, items: DriveFile[]): Promise<DriveFile[]> {
		const itemGroups = new Map<string, DriveFile[]>();
		const canonicalItems: DriveFile[] = [];

		for (const item of items) {
			if (item.mimeType === GOOGLE_FOLDER_MIME_TYPE || this.canMergeRemoteFile(item)) {
				const type = item.mimeType === GOOGLE_FOLDER_MIME_TYPE ? 'folder' : 'file';
				const key = `${type}:${item.name.toLowerCase()}`;
				const group = itemGroups.get(key) || [];
				group.push(item);
				itemGroups.set(key, group);
			} else {
				canonicalItems.push(item);
			}
		}

		for (const group of itemGroups.values()) {
			if (group.length === 1) {
				canonicalItems.push(group[0]);
				continue;
			}

			const isFolderGroup = group[0].mimeType === GOOGLE_FOLDER_MIME_TYPE;
			try {
				canonicalItems.push(isFolderGroup
					? await this.mergeDuplicateRemoteFolders(group, parentPath)
					: await this.mergeDuplicateRemoteFiles(group, parentPath));
			} catch (e) {
				if (isSessionExpiredError(e) || e instanceof SyncStoppedError) throw e;
				const displayName = parentPath ? `${parentPath}/${group[0].name}` : group[0].name;
				console.error(`Failed to merge Drive duplicates for ${displayName}`, e);
				this.stats.failed++;
				this.stats.errors.push({
					path: displayName,
					message: `Failed to merge duplicate Drive ${isFolderGroup ? 'folders' : 'files'}: ${this.getErrorMessage(e)}`
				});
				if (isFolderGroup) {
					throw e;
				} else {
					canonicalItems.push(this.chooseCanonicalRemoteItem(group));
				}
			}
		}

		return canonicalItems;
	}

	private async mergeDuplicateRemoteFolders(group: DriveFile[], parentPath: string): Promise<DriveFile> {
		const canonical = this.chooseCanonicalRemoteItem(group);
		const displayName = parentPath ? `${parentPath}/${canonical.name}` : canonical.name;

		this.updateStatus(`Merging duplicate folders: ${displayName}`);

		for (const duplicate of group) {
			if (duplicate.id === canonical.id) continue;
			this.throwIfStopped();

			const canonicalItems = await this.client.listFiles(canonical.id);
			const duplicateItems = await this.client.listFiles(duplicate.id);

			for (const child of duplicateItems) {
				this.throwIfStopped();
				const sameName = canonicalItems.filter(item => item.name.toLowerCase() === child.name.toLowerCase());
				const childIsFolder = child.mimeType === GOOGLE_FOLDER_MIME_TYPE;
				const hasFolderCollision = sameName.some(item => item.mimeType === GOOGLE_FOLDER_MIME_TYPE);
				const hasFileCollision = sameName.some(item => item.mimeType !== GOOGLE_FOLDER_MIME_TYPE);
				let moved: DriveFile;

				if (sameName.length === 0 || (childIsFolder && hasFolderCollision && !hasFileCollision)) {
					moved = await this.client.moveFile(child.id, duplicate.id, canonical.id);
				} else if (childIsFolder || hasFolderCollision) {
					throw new Error(`Cannot safely merge "${displayName}" because "${child.name}" exists as both a file and a folder.`);
				} else {
					const original = this.chooseCanonicalRemoteItem(sameName);
					if (this.sameRemoteContent(original, child)) {
						this.repointStateEntry(child.id, original.id, original.modifiedTime);
						await this.flushStateIfNeeded(true);
						this.throwIfStopped();
						await this.client.trashFile(child.id);
						continue;
					}

					const conflictName = this.makeRemoteConflictName(child.name, child.id, canonicalItems);
					this.removeStateEntriesForDriveId(child.id);
					await this.flushStateIfNeeded(true);
					this.throwIfStopped();
					moved = await this.client.moveFile(child.id, duplicate.id, canonical.id, conflictName);
					syncDiagnostics.warn(
						`Preserved differing Drive duplicate as "${conflictName}".`,
						`${displayName}/${child.name}`
					);
				}

				canonicalItems.push(moved);
				await this.flushStateIfNeeded();
			}

			this.remoteFolderCache.delete(canonical.id);
			this.remoteFolderCache.delete(duplicate.id);
			const remaining = await this.client.listFiles(duplicate.id);
			if (remaining.length > 0) {
				throw new Error(`Drive folder "${displayName}" still contains ${remaining.length} item${remaining.length === 1 ? '' : 's'} after merge.`);
			}

			this.repointStateEntry(duplicate.id, canonical.id, canonical.modifiedTime);
			await this.flushStateIfNeeded(true);
			this.throwIfStopped();
			await this.client.trashFile(duplicate.id);
		}

		this.remoteFolderCache.delete(canonical.id);
		this.throwIfStopped();
		await this.listCanonicalRemoteItems(canonical.id, displayName);
		this.repointStateEntry(canonical.id, canonical.id, canonical.modifiedTime);
		await this.flushStateIfNeeded();
		return canonical;
	}

	private makeRemoteConflictName(name: string, driveId: string, items: DriveFile[]): string {
		const dot = name.lastIndexOf('.');
		const hasExtension = dot > 0;
		const base = hasExtension ? name.slice(0, dot) : name;
		const extension = hasExtension ? name.slice(dot) : '';
		const suffix = ` (Tether conflict ${driveId.slice(0, 8)})`;
		const taken = new Set(items.map(item => item.name.toLowerCase()));
		let candidate = `${base}${suffix}${extension}`;
		let counter = 2;

		while (taken.has(candidate.toLowerCase())) {
			candidate = `${base}${suffix} ${counter}${extension}`;
			counter++;
		}
		return candidate;
	}

	private async mergeDuplicateRemoteFiles(group: DriveFile[], parentPath: string): Promise<DriveFile> {
		const canonical = this.chooseCanonicalRemoteItem(group);
		const displayName = parentPath ? `${parentPath}/${canonical.name}` : canonical.name;
		const resolvedItems = [canonical];

		this.updateStatus(`Merging duplicates: ${displayName}`);

		for (const duplicate of group) {
			if (duplicate.id === canonical.id) continue;
			this.throwIfStopped();

			if (this.sameRemoteContent(canonical, duplicate)) {
				this.repointStateEntry(duplicate.id, canonical.id, canonical.modifiedTime);
				await this.flushStateIfNeeded(true);
				this.throwIfStopped();
				await this.client.trashFile(duplicate.id);
			} else {
				const conflictName = this.makeRemoteConflictName(duplicate.name, duplicate.id, resolvedItems);
				this.removeStateEntriesForDriveId(duplicate.id);
				await this.flushStateIfNeeded(true);
				this.throwIfStopped();
				const renamed = await this.client.renameFile(duplicate.id, conflictName);
				resolvedItems.push(renamed);
				syncDiagnostics.warn(`Preserved differing Drive duplicate as "${conflictName}".`, displayName);
			}
		}

		this.repointStateEntry(canonical.id, canonical.id, canonical.modifiedTime);
		await this.flushStateIfNeeded();
		return canonical;
	}

	private chooseCanonicalRemoteItem(group: DriveFile[]): DriveFile {
		return [...group].sort((a, b) => {
			const aTime = new Date(a.createdTime || a.modifiedTime).getTime();
			const bTime = new Date(b.createdTime || b.modifiedTime).getTime();
			if (aTime !== bTime) return aTime - bTime;
			return a.id.localeCompare(b.id);
		})[0];
	}

	private repointStateEntry(oldDriveId: string, newDriveId: string, remoteMtime: string) {
		for (const [path, entry] of Object.entries(this.stateManager.state)) {
			if (entry.driveId === oldDriveId) {
				this.stateManager.set(path, {
					...entry,
					driveId: newDriveId,
					remoteMtime
				});
			}
		}

		for (const [path, driveId] of this.folderCache.entries()) {
			if (driveId === oldDriveId) {
				this.folderCache.set(path, newDriveId);
			}
		}
	}

	private removeStateEntriesForDriveId(driveId: string) {
		for (const [path, entry] of Object.entries(this.stateManager.state)) {
			if (entry.driveId === driveId) {
				this.stateManager.remove(path);
			}
		}
	}

	private canMergeRemoteFile(file: DriveFile): boolean {
		return file.mimeType !== GOOGLE_FOLDER_MIME_TYPE && !file.mimeType.startsWith('application/vnd.google-apps.');
	}

	private sameRemoteContent(a: DriveFile, b: DriveFile): boolean {
		return a.mimeType === b.mimeType &&
			!!a.size &&
			!!b.size &&
			a.size === b.size &&
			!!a.md5Checksum &&
			!!b.md5Checksum &&
			a.md5Checksum === b.md5Checksum;
	}

	private async processRemoteTree(folderId: string, tracker: RemoteScanTracker, parentPath: string = '', depth: number = 0, locallyDeletedPaths: Set<string> = new Set()): Promise<void> {
		if (depth > 50) throw new Error('Maximum folder depth reached.');
		this.throwIfStopped();
		this.updateStatus(`Scanning Drive: ${parentPath || 'root'}...`);
		
		try {
			const items = await this.listCanonicalRemoteItems(folderId, parentPath);

			for (const item of items) {
				this.throwIfStopped();
				const path = parentPath ? `${parentPath}/${item.name}` : item.name;
				if (this.isLocallyDeletedPath(path, locallyDeletedPaths)) {
					continue;
				}

				tracker.seenCount++;
				tracker.pendingDeletionPaths.delete(path);

				if (this.isExcluded(path)) continue;

				try {
					this.stats.processed++;
					this.stats.totalFiles = Math.max(this.stats.totalFiles, this.stats.processed);
					this.stats.currentFile = path;
					await this.processRemoteFile(path, item);
				} catch (e) {
					if (isSessionExpiredError(e)) throw e;
					console.error(`Failed to pull ${path}`, e);
					const message = this.getErrorMessage(e);
					syncDiagnostics.error(
						message,
						path,
						e instanceof GoogleDriveApiError ? e.status : undefined,
						e instanceof GoogleDriveApiError ? e.reason : undefined
					);
					if (this.isNotFound(e)) {
						this.stateManager.remove(path);
					} else {
						this.stats.failed++;
						this.stats.errors.push({ path, message });
					}
				}

				this.updateStatus(this.stats.status);
				await this.afterWorkItem();

				if (item.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
					await this.processRemoteTree(item.id, tracker, path, depth + 1, locallyDeletedPaths);
				}
			}
		} catch (error) {
			console.error(`Failed to scan Drive folder ${folderId}`, error);
			throw error;
		} finally {
			// Pull never needs a completed folder listing again. Releasing it here bounds
			// memory to the current folder ancestry instead of retaining the whole vault.
			this.remoteFolderCache.delete(folderId);
		}
	}

	private async ensureVaultRoot(name: string, createIfMissing = true): Promise<string> {
		const stateKey = `__VAULT_ROOT__`;
		const state = this.stateManager.get(stateKey);

		const folders = await this.client.listFolders(this.folderId);
		let candidates = folders.filter(f => f.name.toLowerCase() === name.toLowerCase());
		if (candidates.length > 1) {
			const canonical = await this.mergeDuplicateRemoteFolders(candidates, '');
			candidates = [canonical];
		}

		if (!createIfMissing) {
			const selected = await this.selectPullVaultRoot(name, candidates, state?.driveId);
			if (!selected) {
				throw new Error(`Drive vault folder "${name}" was not found with files inside the selected sync folder. Pull stopped before changing local files. Check the selected Google Drive folder and account, then try again. If this is a new empty Drive setup, use Push first.`);
			}

			await this.saveVaultRootState(selected);
			return selected.id;
		}

		const stateCandidate = candidates.find(folder => folder.id === state?.driveId);
		if (stateCandidate) return stateCandidate.id;

		const existing = candidates[0];
		
		if (existing) {
			await this.saveVaultRootState(existing);
			return existing.id;
		}

		const newFolder = await this.client.createFolder(name, this.folderId);
		await this.saveVaultRootState(newFolder);
		return newFolder.id;
	}

	private async saveVaultRootState(folder: DriveFile) {
		const stateKey = `__VAULT_ROOT__`;
		const entry = { driveId: folder.id, lastSyncedMtime: 0, remoteMtime: folder.modifiedTime, etag: '' };
		this.stateManager.set(stateKey, entry);
		await this.flushStateIfNeeded(true);
	}

	private async selectPullVaultRoot(name: string, candidates: DriveFile[], stateDriveId?: string): Promise<DriveFile | undefined> {
		const stateCandidate = candidates.find(folder => folder.id === stateDriveId);
		const scoredCandidates = await Promise.all(candidates.map(async (folder) => ({
			folder,
			childCount: await this.getImmediateRemoteChildCount(folder.id)
		})));
		const nonEmptyCandidates = scoredCandidates.filter(candidate => candidate.childCount > 0);

		const scoredStateCandidate = nonEmptyCandidates.find(candidate => candidate.folder.id === stateDriveId);
		if (scoredStateCandidate) return scoredStateCandidate.folder;

		if (nonEmptyCandidates.length > 0) {
			const selected = nonEmptyCandidates.sort((a, b) => {
				if (b.childCount !== a.childCount) return b.childCount - a.childCount;
				return new Date(b.folder.modifiedTime).getTime() - new Date(a.folder.modifiedTime).getTime();
			})[0].folder;

			if (stateCandidate && selected.id !== stateCandidate.id) {
				new Notice(`Tether switched Pull from an empty "${name}" Drive folder to a matching folder that contains files.`);
			}

			return selected;
		}

		if (stateDriveId && !stateCandidate) {
			const stateChildCount = await this.getImmediateRemoteChildCount(stateDriveId).catch(() => 0);
			if (stateChildCount > 0) {
				return {
					id: stateDriveId,
					name,
					mimeType: GOOGLE_FOLDER_MIME_TYPE,
					modifiedTime: new Date().toISOString()
				};
			}
		}

		return undefined;
	}

	private async getImmediateRemoteChildCount(folderId: string): Promise<number> {
		const page = await this.client.listFilesPage(folderId);
		return page.files.length + (page.nextPageToken ? 1 : 0);
	}

	private async processRemoteFile(path: string, remoteFile: DriveFile) {
		if (remoteFile.mimeType === 'application/vnd.google-apps.folder') {
			await this.ensureLocalPath(path);
			const state = this.stateManager.get(path);
			this.stateManager.set(path, {
				driveId: remoteFile.id,
				lastSyncedMtime: state ? state.lastSyncedMtime : 0,
				remoteMtime: remoteFile.modifiedTime,
				etag: ''
			});
			await this.flushStateIfNeeded();
			return;
		}

		let state = this.stateManager.get(path);
		if (state && state.driveId !== remoteFile.id) {
			state = { ...state, driveId: remoteFile.id };
			this.stateManager.set(path, state);
			await this.flushStateIfNeeded();
		}

		const existsLocal = await this.app.vault.adapter.exists(path);
		const localStat = existsLocal ? await this.safeStat(path) : null;

		if (localStat?.type === 'file' && await this.shouldDeferActiveLocalFile(path, localStat)) {
			return;
		}

		if (!state) {
			if (existsLocal) {
				if (this.isConfigPath(path) && localStat) {
					const remoteTime = new Date(remoteFile.modifiedTime).getTime();
					if (remoteTime > localStat.mtime) {
						await this.download(path, remoteFile);
					} else {
						// Local is newer. Update state so we don't treat it as a conflict next time.
						// processLocalPath will handle the upload to remote.
						this.stateManager.set(path, {
							driveId: remoteFile.id,
							lastSyncedMtime: localStat.mtime,
							remoteMtime: remoteFile.modifiedTime,
							etag: ''
						});
						await this.flushStateIfNeeded();
					}
				} else {
					await this.download(path, remoteFile);
				}
			} else {
				await this.download(path, remoteFile);
			}
		} else if (remoteFile.modifiedTime !== state.remoteMtime) {
			if (localStat && localStat.mtime > state.lastSyncedMtime) {
				if (this.isConfigPath(path)) {
					const remoteTime = new Date(remoteFile.modifiedTime).getTime();
					if (remoteTime > localStat.mtime) {
						await this.download(path, remoteFile);
					} else {
						// Local is newer. We've already verified mtime > lastSyncedMtime.
						// Update state to match current remote so processLocalPath sees the local change correctly.
						this.stateManager.set(path, {
							...state,
							remoteMtime: remoteFile.modifiedTime
						});
						await this.flushStateIfNeeded();
					}
				} else {
					await this.download(path, remoteFile);
				}
			} else {
				await this.download(path, remoteFile);
			}
		}
	}

	private async handleLocalDeletions(localPathSet: Set<string>): Promise<Set<string>> {
		this.updateStatus('Checking for deletions...');
		this.throwIfStopped();
		const stateEntries = Object.entries(this.stateManager.state);
		const locallyDeletedPaths = new Set<string>();

		// Collect candidates for deletion first
		const deletionCandidates: [string, typeof stateEntries[0][1]][] = [];
		const trackedCount = stateEntries.filter(([p]) => p !== '__VAULT_ROOT__' && !this.isExcluded(p)).length;

		for (const [path, entry] of stateEntries) {
			if (path === '__VAULT_ROOT__' || this.isExcluded(path)) continue;
			if (!localPathSet.has(path)) {
				deletionCandidates.push([path, entry]);
			}
		}

		// Safeguard: abort if deleting too many remote files at once
		if (deletionCandidates.length === 0) {
			return locallyDeletedPaths;
		}

		if (localPathSet.size === 0 || deletionCandidates.length === trackedCount) {
			const msg = localPathSet.size === 0
				? `Push paused remote deletions: this device returned no local files or folders, but Drive has ${trackedCount} tracked item${trackedCount === 1 ? '' : 's'}. No remote files were deleted.`
				: `Push paused remote deletions: every tracked remote item is missing locally (${trackedCount}/${trackedCount}). No remote files were deleted. Check this vault before pushing again.`;
			console.error(msg);
			new Notice(msg);
			this.stats.failed++;
			this.stats.errors.push({ path: 'Remote deletions', message: msg });
			return locallyDeletedPaths;
		}

		if (trackedCount > 0 && deletionCandidates.length / trackedCount >= CATASTROPHIC_DELETE_RATIO) {
			if (!this.shouldProceedWithLargeDeletion('push', deletionCandidates.length, trackedCount)) {
				const msg = `Push paused remote deletions: would delete ${deletionCandidates.length} of ${trackedCount} remote files (>=${Math.round(CATASTROPHIC_DELETE_RATIO * 100)}%). No remote files were deleted.`;
				console.error(msg);
				new Notice(msg);
				this.stats.failed++;
				this.stats.errors.push({ path: 'Remote deletions', message: msg });
				return locallyDeletedPaths;
			}

			new Notice(`Confirmed large push deletion batch: deleting ${deletionCandidates.length} remote files.`);
		}

		for (const [path, entry] of deletionCandidates) {
			this.throwIfStopped();
			try {
				this.updateStatus(`Deleting remote: ${path}`);
				await this.client.deleteFile(entry.driveId);
				this.stateManager.remove(path);
				locallyDeletedPaths.add(path);
				await this.flushStateIfNeeded();
			} catch (e) {
				if (isSessionExpiredError(e)) throw e;
				if (this.isNotFound(e)) {
					this.stateManager.remove(path);
					locallyDeletedPaths.add(path);
					await this.flushStateIfNeeded();
				} else {
					console.error(`Failed to delete remote ${path}`, e);
					this.stats.failed++;
					this.stats.errors.push({ path, message: this.getErrorMessage(e) });
				}
			}

			await this.afterWorkItem();
		}

		return locallyDeletedPaths;
	}

	private async handleRemoteDeletions(tracker: RemoteScanTracker) {
		// Only paths left in this set were tracked before the scan and are now absent
		// from Drive. Materialize and sort candidates only, not the entire state map.
		const deletionCandidates: [string, SyncEntry][] = [];
		for (const path of tracker.pendingDeletionPaths) {
			const entry = this.stateManager.get(path);
			if (entry) deletionCandidates.push([path, entry]);
		}
		deletionCandidates.sort((a, b) => b[0].length - a[0].length);
		const trackedCount = tracker.trackedCount;
		if (deletionCandidates.length === 0) return;

		if (tracker.seenCount === 0 || deletionCandidates.length === trackedCount) {
			const msg = tracker.seenCount === 0
				? `Pull paused local deletions: the Drive vault root returned no files or folders, but this device has ${trackedCount} tracked local item${trackedCount === 1 ? '' : 's'}. No local files were deleted. Check the selected Google Drive folder/account before pulling again.`
				: `Pull paused local deletions: every tracked local item is missing from Drive (${trackedCount}/${trackedCount}). No local files were deleted. Check the selected Google Drive folder/account before pulling again.`;
			console.error(msg);
			new Notice(msg);
			this.stats.failed++;
			this.stats.errors.push({ path: 'Local deletions', message: msg });
			return;
		}

		// Safeguard: abort if deleting too many local files at once
		if (trackedCount > 0 && deletionCandidates.length / trackedCount >= CATASTROPHIC_DELETE_RATIO) {
			if (!this.shouldProceedWithLargeDeletion('pull', deletionCandidates.length, trackedCount)) {
				const msg = `Pull paused local deletions: would delete ${deletionCandidates.length} of ${trackedCount} local files (>=${Math.round(CATASTROPHIC_DELETE_RATIO * 100)}%). No local files were deleted.`;
				console.error(msg);
				new Notice(msg);
				this.stats.failed++;
				this.stats.errors.push({ path: 'Local deletions', message: msg });
				return;
			}

			new Notice(`Confirmed large pull deletion batch: deleting ${deletionCandidates.length} local files.`);
		}

		for (const [path, entry] of deletionCandidates) {
			this.throwIfStopped();
			try {
				if (await this.app.vault.adapter.exists(path)) {
					this.updateStatus(`Deleting local: ${path}`);
					const stat = await this.safeStat(path);
					if (stat?.type === 'file' && this.isOpenFilePath(path)) {
						this.addDeferredFile(path, 'open in Obsidian');
						continue;
					}

					if (stat?.type === 'file' && stat.mtime > entry.lastSyncedMtime) {
						if (await this.shouldDeferActiveLocalFile(path, stat)) {
							this.stateManager.remove(path);
							continue;
						}

						this.stateManager.remove(path);
						continue;
					}
					if (stat?.type === 'folder') {
						if (await this.hasUnsyncedLocalDescendant(path)) {
							this.stateManager.remove(path);
							continue;
						}

						// Use rmdir for folders. Recursive: false because we handle children individually
						// due to the sorted loop.
						await this.app.vault.adapter.rmdir(path, false).catch(async () => {
							// If rmdir fails because it's not empty (shouldn't happen with our sorting, 
							// but safety first), try recursive if it's not a critical folder.
							if (!this.isConfigPath(path)) {
								await this.app.vault.adapter.rmdir(path, true);
							}
						});
					} else {
						await this.app.vault.adapter.remove(path);
					}
				}
				this.stateManager.remove(path);
				await this.flushStateIfNeeded();
			} catch (e) {
				console.error(`Failed to delete local ${path}`, e);
				this.stats.failed++;
				this.stats.errors.push({ path, message: this.getErrorMessage(e) });
			}

			await this.afterWorkItem();
		}
	}

	private async download(path: string, remoteFile: DriveFile) {
		const parts = path.split('/');
		if (parts.length > 1) {
			const folderPath = parts.slice(0, -1).join('/');
			await this.ensureLocalPath(folderPath);
		}

		const downloaded = await this.downloadAndWrite(path, remoteFile);
		if (!downloaded) return;
		const stat = await this.safeStat(path);
		
		this.stateManager.set(path, {
			driveId: remoteFile.id,
			lastSyncedMtime: stat ? stat.mtime : Date.now(),
			remoteMtime: remoteFile.modifiedTime,
			etag: ''
		});
		const remoteSize = this.getRemoteFileSize(remoteFile);
		const wasChunked = Platform.isMobileApp && remoteSize !== null && remoteSize > MOBILE_CHUNKED_DOWNLOAD_BYTES;
		await this.flushStateIfNeeded(wasChunked);
		this.stats.detail = '';
	}

	private async downloadAndWrite(path: string, remoteFile: DriveFile): Promise<boolean> {
		const remoteSize = this.getRemoteFileSize(remoteFile);
		if (Platform.isMobileApp && remoteSize !== null && remoteSize > MOBILE_CHUNKED_DOWNLOAD_BYTES) {
			if (typeof this.app.vault.adapter.appendBinary !== 'function') {
				const reason = `large mobile download (${this.formatBytes(remoteSize)}); update Obsidian to download it safely in chunks`;
				this.addDeferredFile(path, reason);
				syncDiagnostics.warn(`Deferred ${reason}`, path);
				return false;
			}

			await this.downloadLargeMobileFile(path, remoteFile.id, remoteSize);
			return true;
		}

		// Keep the binary buffer in this small async frame so it becomes collectible before
		// stat calls or a potentially large state serialization run on memory-limited devices.
		const content = await this.client.downloadFile(remoteFile.id);
		await this.app.vault.adapter.writeBinary(path, content);
		return true;
	}

	private getRemoteFileSize(remoteFile: DriveFile): number | null {
		if (!remoteFile.size) return null;
		const size = Number(remoteFile.size);
		return Number.isFinite(size) && size >= 0 ? size : null;
	}

	private async downloadLargeMobileFile(path: string, driveId: string, totalBytes: number) {
		const tempPath = `${path}${PARTIAL_DOWNLOAD_SUFFIX}`;
		if (await this.app.vault.adapter.exists(tempPath)) {
			await this.app.vault.adapter.remove(tempPath);
		}

		syncDiagnostics.info(`Chunked mobile download started (${this.formatBytes(totalBytes)})`, path);
		let offset = 0;
		let firstChunk = true;

		while (offset < totalBytes) {
			this.throwIfStopped();
			const end = Math.min(totalBytes - 1, offset + MOBILE_DOWNLOAD_CHUNK_BYTES - 1);
			const bytesWritten = await this.downloadAndWriteChunk(tempPath, driveId, offset, end, firstChunk);
			offset += bytesWritten;
			firstChunk = false;

			const fileName = path.split('/').pop() || path;
			const pct = Math.min(100, Math.round((offset / totalBytes) * 100));
			this.updateStatus(
				`Pulling ${this.stats.processed}/${this.stats.totalFiles} · ${fileName} ${pct}%`,
				{ currentFile: path, detail: `Downloading ${this.formatBytes(offset)} / ${this.formatBytes(totalBytes)} in low-memory chunks` }
			);

			// Give the WebView a frame to release the completed response before requesting
			// the next chunk and let Obsidian remain interactive during long videos.
			await new Promise<void>(resolve => window.setTimeout(resolve, MOBILE_WORK_YIELD_MS));
		}

		await this.replaceWithCompletedDownload(tempPath, path);
		syncDiagnostics.info(`Chunked mobile download completed (${this.formatBytes(totalBytes)})`, path);
	}

	private async downloadAndWriteChunk(tempPath: string, driveId: string, start: number, end: number, firstChunk: boolean): Promise<number> {
		const expectedBytes = end - start + 1;
		const chunk = await this.client.downloadFileRange(driveId, start, end);

		if (chunk.status !== 206) {
			throw new Error(`Drive did not honor the low-memory byte range request (HTTP ${chunk.status}).`);
		}
		if (chunk.content.byteLength !== expectedBytes) {
			throw new Error(`Drive returned ${chunk.content.byteLength} bytes for a ${expectedBytes}-byte download range.`);
		}

		if (firstChunk) {
			await this.app.vault.adapter.writeBinary(tempPath, chunk.content);
		} else {
			await this.app.vault.adapter.appendBinary(tempPath, chunk.content);
		}
		return chunk.content.byteLength;
	}

	private async replaceWithCompletedDownload(tempPath: string, path: string) {
		try {
			await this.app.vault.adapter.rename(tempPath, path);
			return;
		} catch (error) {
			const tempExists = await this.app.vault.adapter.exists(tempPath);
			const destinationExists = await this.app.vault.adapter.exists(path);
			if (!tempExists && destinationExists) return;
			if (!tempExists || !destinationExists) throw error;
		}

		// Some adapters do not replace an existing destination during rename. The old
		// file remains intact until the complete temporary download is ready.
		await this.app.vault.adapter.remove(path);
		await this.app.vault.adapter.rename(tempPath, path);
	}

	private async ensureLocalPath(path: string) {
		if (!path || path === '.') return;
		if (await this.app.vault.adapter.exists(path)) return;

		const parts = path.split('/');
		const parent = parts.slice(0, -1).join('/');
		if (parent) await this.ensureLocalPath(parent);
		
		try {
			await this.app.vault.adapter.mkdir(path);
		} catch (e) {
			const msg = this.getErrorMessage(e).toLowerCase();
			if (!msg.includes('already exists')) {
				throw e;
			}
		}
	}

	private async hasUnsyncedLocalDescendant(folderPath: string): Promise<boolean> {
		const descendants = await this.listAllLocalItems(folderPath);

		for (const path of descendants) {
			const stat = await this.safeStat(path);
			if (!stat || stat.type !== 'file') continue;

			const state = this.stateManager.get(path);
			if (!state || stat.mtime > state.lastSyncedMtime) {
				await this.shouldDeferActiveLocalFile(path, stat);
				return true;
			}
		}

		return false;
	}

	private async shouldDeferActiveLocalFile(path: string, stat?: Stat | null): Promise<boolean> {
		const localStat = stat ?? await this.safeStat(path);
		if (!localStat || localStat.type !== 'file') return false;

		const graceMs = this.getLocalEditGraceMs(path);
		const ageMs = Date.now() - localStat.mtime;
		if (ageMs < graceMs) {
			const reason = this.isOpenFilePath(path) ? 'open and recently edited' : 'recent local edit';
			this.addDeferredFile(path, reason);
			return true;
		}

		return false;
	}

	private async readStableLocalFile(path: string, stat: Stat): Promise<{ content: ArrayBuffer, stat: Stat } | null> {
		let content: ArrayBuffer;
		try {
			content = await this.app.vault.adapter.readBinary(path);
		} catch (error) {
			if (this.isENOENT(error)) {
				syncDiagnostics.warn(`Skipped missing file during read: ${path}`, path);
				return null;
			}
			throw error;
		}

		const latestStat = await this.safeStat(path);

		if (!latestStat || latestStat.type !== 'file') {
			this.addDeferredFile(path, 'changed while syncing');
			return null;
		}

		if (latestStat.mtime !== stat.mtime || latestStat.size !== stat.size) {
			this.addDeferredFile(path, 'changed while syncing');
			return null;
		}

		return { content, stat: latestStat };
	}

	private async deferIfChangedAfterUpload(path: string, syncedStat: Stat) {
		const latestStat = await this.safeStat(path);
		if (!latestStat || latestStat.type !== 'file') return;

		if (latestStat.mtime !== syncedStat.mtime || latestStat.size !== syncedStat.size) {
			this.addDeferredFile(path, 'changed while syncing');
		}
	}

	private addDeferredFile(path: string, reason: string) {
		if (this.stats.deferred.some(item => item.path === path)) return;
		this.stats.deferred.push({ path, reason });
	}

	private getLocalEditGraceMs(path: string): number {
		return this.isDrawingPath(path) ? DRAWING_LOCAL_EDIT_GRACE_MS : RECENT_LOCAL_EDIT_GRACE_MS;
	}

	private isDrawingPath(path: string): boolean {
		const normalized = path.toLowerCase();
		return normalized.endsWith('.drawing') ||
			   normalized.startsWith('assets/ink/') ||
			   normalized.includes('/ink/');
	}

	private getMimeType(extension: string): string {
		const mimes: Record<string, string> = {
			'md': 'text/markdown',
			'txt': 'text/plain',
			'png': 'image/png',
			'jpg': 'image/jpeg',
			'jpeg': 'image/jpeg',
			'gif': 'image/gif',
			'pdf': 'application/pdf',
			'mp4': 'video/mp4',
			'zip': 'application/zip'
		};
		return mimes[extension] || 'application/octet-stream';
	}
}
