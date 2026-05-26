import { App, Notice } from 'obsidian';
import type { Stat } from 'obsidian';
import { GoogleDriveClient, DriveFile, isSessionExpiredError } from './gdrive';
import { StateManager } from './state';
import { SyncStatusView, SyncStats, VIEW_TYPE_SYNC_STATUS } from '../ui/sync-view';

const RECENT_LOCAL_EDIT_GRACE_MS = 5000;
const DRAWING_LOCAL_EDIT_GRACE_MS = 30000;
const STATE_SAVE_CHANGE_LIMIT = 40;
const STATE_SAVE_INTERVAL_MS = 10000;
const MANUAL_STATUS_UPDATE_MS = 500;
const BACKGROUND_STATUS_UPDATE_MS = 3000;
const WORK_YIELD_ITEM_LIMIT = 25;
const CATASTROPHIC_DELETE_RATIO = 0.8;

export type SyncMode = 'pull' | 'push';
const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

interface SyncOptions {
	mode?: SyncMode;
	silent?: boolean;
	statusUpdateIntervalMs?: number;
}

export class SyncEngine {
	app: App;
	client: GoogleDriveClient;
	stateManager: StateManager;
	folderId: string;
	statusBarItem: HTMLElement;
	private folderCache: Map<string, string> = new Map();
	private remoteFolderCache: Map<string, DriveFile[]> = new Map();
	private silent = false;
	private statusUpdateIntervalMs = MANUAL_STATUS_UPDATE_MS;
	private lastStatusUpdateAt = 0;
	private processedSinceYield = 0;
	
	public stats: SyncStats = {
		totalFiles: 0,
		processed: 0,
		failed: 0,
		currentFile: '',
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

	updateStatus(text: string, partialStats?: Partial<SyncStats>, force = false) {
		this.stats = { ...this.stats, status: text, ...partialStats };

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
		this.statusUpdateIntervalMs = options.statusUpdateIntervalMs ?? (this.silent ? BACKGROUND_STATUS_UPDATE_MS : MANUAL_STATUS_UPDATE_MS);
		this.lastStatusUpdateAt = 0;
		this.processedSinceYield = 0;

		try {
			this.stats.processed = 0;
			this.stats.failed = 0;
			this.stats.errors = [];
			this.stats.conflicts = [];
			this.stats.deferred = [];
			this.folderCache.clear();
			this.remoteFolderCache.clear();
			const mode = options.mode ?? 'push';
			const modeLabel = mode === 'pull' ? 'Pull' : 'Push';
			
			this.updateStatus('Loading state...', undefined, true);
			await this.stateManager.load();
			
			const vaultName = this.app.vault.getName();
			this.updateStatus(`Locating vault root...`);
			
			const vaultRootDriveId = await this.ensureVaultRoot(vaultName, mode === 'push');
			this.folderCache.set('', vaultRootDriveId);

			if (mode === 'pull') {
				await this.pullFromRemote(vaultRootDriveId);
			} else {
				await this.pushToRemote(vaultRootDriveId);
			}

			this.stats.lastSync = new Date().toLocaleTimeString();
			this.stats.currentFile = '';
			await this.flushStateIfNeeded(true);
			this.updateStatus('Idle', undefined, true);
			
			if (!this.silent && this.stats.failed > 0) {
				new Notice(`${modeLabel} complete with ${this.stats.failed} errors. Check sidebar.`);
			} else if (!this.silent && this.stats.deferred.length > 0) {
				new Notice(`${modeLabel} complete. Deferred ${this.stats.deferred.length} active file${this.stats.deferred.length === 1 ? '' : 's'} until editing stops.`);
			} else if (!this.silent) {
				new Notice(`${modeLabel} complete successfully!`);
			}
		} catch (error) {
			this.updateStatus('Failed', undefined, true);
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

		const remotePathSet = new Set<string>();
		await this.processRemoteTree(vaultRootDriveId, remotePathSet);
		await this.handleRemoteDeletions(remotePathSet);
	}

	private async pushToRemote(vaultRootDriveId: string) {
		this.updateStatus('Scanning local items...');
		const localPathSet = await this.collectLocalPathSet('');
		this.stats.totalFiles = localPathSet.size;

		await this.handleLocalDeletions(localPathSet);

		this.updateStatus('Pushing changes...');
		for (const path of localPathSet) {
			this.stats.processed++;
			this.stats.currentFile = path;
			if (this.stats.processed % 10 === 0 || this.stats.processed === this.stats.totalFiles) {
				this.updateStatus(`Pushing ${this.stats.processed}/${this.stats.totalFiles}${this.stats.failed ? ` (${this.stats.failed} failed)` : ''}`);
			}
			
			try {
				await this.processLocalPath(path, vaultRootDriveId);
			} catch (e) {
				if (isSessionExpiredError(e)) throw e;
				console.error(`Failed to push ${path}`, e);
				if (this.isNotFound(e)) {
					this.stateManager.remove(path);
				} else {
					this.stats.failed++;
					this.stats.errors.push({ path, message: this.getErrorMessage(e) });
				}
			}
			this.updateStatus(this.stats.status);
			await this.afterWorkItem();
		}
	}

	private isExcluded(path: string): boolean {
		const statePath = this.stateManager.getStatePath();
		return path.startsWith('.git/') || 
			   path === '.git' || 
			   path.startsWith('.trash/') ||
			   path === '.trash' ||
			   path === statePath ||
			   path.includes('/.git/');
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
		if (force || this.stateManager.shouldSave(STATE_SAVE_CHANGE_LIMIT, STATE_SAVE_INTERVAL_MS)) {
			await this.stateManager.save();
		}
	}

	private async afterWorkItem() {
		await this.flushStateIfNeeded();

		this.processedSinceYield++;
		if (this.processedSinceYield >= WORK_YIELD_ITEM_LIMIT) {
			this.processedSinceYield = 0;
			await new Promise<void>(resolve => window.setTimeout(resolve, 0));
		}
	}

	private isNotFound(error: unknown): boolean {
		const status = typeof error === 'object' && error !== null && 'status' in error
			? (error as { status?: number }).status
			: undefined;
		return status === 404 || this.getErrorMessage(error).includes('404');
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
		const result = await this.app.vault.adapter.list(folderPath);
		
		for (const file of result.files) {
			if (!this.isExcluded(file)) {
				items.add(file);
			}
		}
		
		for (const folder of result.folders) {
			if (!this.isExcluded(folder)) {
				items.add(folder);
				await this.collectLocalPathSet(folder, items);
			}
			await this.afterWorkItem();
		}

		return items;
	}

	private async processLocalPath(path: string, vaultRootId: string) {
		const stat = await this.app.vault.adapter.stat(path);
		if (!stat) return;

		if (stat.type === 'folder') {
			await this.ensureRemotePathByPath(path, vaultRootId);
			return;
		}

		if (await this.shouldDeferActiveLocalFile(path, stat)) {
			return;
		}

		let state = this.stateManager.get(path);
		const extension = path.includes('.') ? path.split('.').pop() || '' : '';
		const mimeType = this.getMimeType(extension);
		const fileName = path.split('/').pop() || path;
		const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
		const driveParentId = await this.ensureRemotePathByPath(parentPath, vaultRootId);
		const existingRemote = await this.findRemoteFileByName(driveParentId, parentPath, fileName);

		if (state && existingRemote && state.driveId !== existingRemote.id) {
			state = { ...state, driveId: existingRemote.id, remoteMtime: existingRemote.modifiedTime };
			this.stateManager.set(path, state);
			await this.flushStateIfNeeded();
		}

		if (!state) {
			const upload = await this.readStableLocalFile(path, stat);
			if (!upload) return;
			const remoteFile = existingRemote
				? await this.client.updateFile(existingRemote.id, upload.content, mimeType)
				: await this.client.uploadFile(fileName, driveParentId, upload.content, mimeType);
			this.updateCachedRemoteFile(driveParentId, remoteFile);
			
			this.stateManager.set(path, {
				driveId: remoteFile.id,
				lastSyncedMtime: upload.stat.mtime,
				remoteMtime: remoteFile.modifiedTime,
				etag: ''
			});
			await this.deferIfChangedAfterUpload(path, upload.stat);
			await this.flushStateIfNeeded();
		} else if (stat.mtime > state.lastSyncedMtime) {
			const upload = await this.readStableLocalFile(path, stat);
			if (!upload) return;
			const remoteFile = await this.client.updateFile(state.driveId, upload.content, mimeType);
			this.updateCachedRemoteFile(driveParentId, remoteFile);
			
			this.stateManager.set(path, {
				...state,
				lastSyncedMtime: upload.stat.mtime,
				remoteMtime: remoteFile.modifiedTime
			});
			await this.deferIfChangedAfterUpload(path, upload.stat);
			await this.flushStateIfNeeded();
		}
	}

	private async ensureRemotePathByPath(path: string, vaultRootId: string): Promise<string> {
		if (!path || path === '.' || path === '/') return vaultRootId;
		if (this.folderCache.has(path)) return this.folderCache.get(path)!;

		const state = this.stateManager.get(path);
		if (state) {
			this.folderCache.set(path, state.driveId);
			return state.driveId;
		}

		const parts = path.split('/');
		const folderName = parts.pop() || '';
		const parentPath = parts.join('/');
		
		const parentDriveId = await this.ensureRemotePathByPath(parentPath, vaultRootId);
		
		const existingFolders = await this.client.listFolders(parentDriveId);
		const existing = existingFolders.find(f => f.name.toLowerCase() === folderName.toLowerCase());
		
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

		const items = await this.client.listFiles(folderId);
		const canonicalItems = await this.consolidateDuplicateRemoteFiles(folderId, parentPath, items);
		this.remoteFolderCache.set(folderId, canonicalItems);
		return canonicalItems;
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

	private async consolidateDuplicateRemoteFiles(folderId: string, parentPath: string, items: DriveFile[]): Promise<DriveFile[]> {
		const fileGroups = new Map<string, DriveFile[]>();
		const canonicalItems: DriveFile[] = [];

		for (const item of items) {
			if (this.canMergeRemoteFile(item)) {
				const key = item.name.toLowerCase();
				const group = fileGroups.get(key) || [];
				group.push(item);
				fileGroups.set(key, group);
			} else {
				canonicalItems.push(item);
			}
		}

		for (const group of fileGroups.values()) {
			if (group.length === 1) {
				canonicalItems.push(group[0]);
				continue;
			}

			try {
				canonicalItems.push(await this.mergeDuplicateRemoteFiles(group, parentPath));
			} catch (e) {
				if (isSessionExpiredError(e)) throw e;
				const displayName = parentPath ? `${parentPath}/${group[0].name}` : group[0].name;
				console.error(`Failed to merge Drive duplicates for ${displayName}`, e);
				this.stats.failed++;
				this.stats.errors.push({ path: displayName, message: `Failed to merge duplicate Drive files: ${this.getErrorMessage(e)}` });
				canonicalItems.push(this.chooseCanonicalRemoteFile(group, parentPath));
			}
		}

		return canonicalItems;
	}

	private async mergeDuplicateRemoteFiles(group: DriveFile[], parentPath: string): Promise<DriveFile> {
		const displayName = parentPath ? `${parentPath}/${group[0].name}` : group[0].name;
		const sorted = [...group].sort((a, b) => new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime());
		const canonical = this.chooseCanonicalRemoteFile(sorted, parentPath);
		const latest = sorted[sorted.length - 1];
		const restoreCanonicalHead = latest.id === canonical.id;
		const canonicalOriginalContent = restoreCanonicalHead ? await this.client.downloadFile(canonical.id) : null;
		let canonicalFile = canonical;
		let wroteRevision = false;

		this.updateStatus(`Merging duplicates: ${displayName}`);

		for (const duplicate of sorted) {
			if (duplicate.id === canonical.id) continue;

			if (!this.sameRemoteContent(canonicalFile, duplicate)) {
				const duplicateContent = await this.client.downloadFile(duplicate.id);
				canonicalFile = await this.client.updateFile(canonical.id, duplicateContent, duplicate.mimeType);
				wroteRevision = true;
			}

			await this.client.deleteFile(duplicate.id);
			this.repointStateEntry(duplicate.id, canonical.id, canonicalFile.modifiedTime);
		}

		if (restoreCanonicalHead && wroteRevision && canonicalOriginalContent) {
			canonicalFile = await this.client.updateFile(canonical.id, canonicalOriginalContent, canonical.mimeType);
		}

		this.repointStateEntry(canonical.id, canonical.id, canonicalFile.modifiedTime);
		await this.flushStateIfNeeded();
		return { ...canonicalFile, name: canonical.name || canonicalFile.name };
	}

	private chooseCanonicalRemoteFile(group: DriveFile[], parentPath: string): DriveFile {
		const stateMatch = group.find(item => {
			const exactPath = parentPath ? `${parentPath}/${item.name}` : item.name;
			return this.stateManager.get(exactPath)?.driveId === item.id ||
				Object.values(this.stateManager.state).some(entry => entry.driveId === item.id);
		});

		if (stateMatch) return stateMatch;

		return [...group].sort((a, b) => new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime())[0];
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
	}

	private canMergeRemoteFile(file: DriveFile): boolean {
		return file.mimeType !== GOOGLE_FOLDER_MIME_TYPE && !file.mimeType.startsWith('application/vnd.google-apps.');
	}

	private sameRemoteContent(a: DriveFile, b: DriveFile): boolean {
		return !!a.md5Checksum && !!b.md5Checksum && a.md5Checksum === b.md5Checksum;
	}

	private async processRemoteTree(folderId: string, remotePathSet: Set<string>, parentPath: string = '', depth: number = 0, locallyDeletedPaths: Set<string> = new Set()): Promise<void> {
		if (depth > 50) throw new Error('Maximum folder depth reached.');
		this.updateStatus(`Scanning Drive: ${parentPath || 'root'}...`);
		
		try {
			const items = await this.listCanonicalRemoteItems(folderId, parentPath);

			for (const item of items) {
				const path = parentPath ? `${parentPath}/${item.name}` : item.name;
				if (this.isLocallyDeletedPath(path, locallyDeletedPaths)) {
					continue;
				}

				remotePathSet.add(path);

				if (this.isExcluded(path)) continue;

				try {
					this.stats.processed++;
					this.stats.totalFiles = Math.max(this.stats.totalFiles, this.stats.processed);
					this.stats.currentFile = path;
					await this.processRemoteFile(path, item);
				} catch (e) {
					if (isSessionExpiredError(e)) throw e;
					console.error(`Failed to pull ${path}`, e);
					if (this.isNotFound(e)) {
						this.stateManager.remove(path);
					} else {
						this.stats.failed++;
						this.stats.errors.push({ path, message: this.getErrorMessage(e) });
					}
				}

				this.updateStatus(this.stats.status);
				await this.afterWorkItem();

				if (item.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
					await this.processRemoteTree(item.id, remotePathSet, path, depth + 1, locallyDeletedPaths);
				}
			}
		} catch (error) {
			console.error(`Failed to scan Drive folder ${folderId}`, error);
			throw error;
		}
	}

	private async ensureVaultRoot(name: string, createIfMissing = true): Promise<string> {
		const stateKey = `__VAULT_ROOT__`;
		const state = this.stateManager.get(stateKey);
		if (state) return state.driveId;

		const folders = await this.client.listFolders(this.folderId);
		const existing = folders.find(f => f.name.toLowerCase() === name.toLowerCase());
		
		if (existing) {
			const entry = { driveId: existing.id, lastSyncedMtime: 0, remoteMtime: existing.modifiedTime, etag: '' };
			this.stateManager.set(stateKey, entry);
			await this.flushStateIfNeeded(true);
			return existing.id;
		}

		if (!createIfMissing) {
			throw new Error(`Drive vault folder "${name}" was not found inside the selected sync folder. Pull stopped before changing local files. Check the selected Google Drive folder and account, then try again.`);
		}

		const newFolder = await this.client.createFolder(name, this.folderId);
		const entry = { driveId: newFolder.id, lastSyncedMtime: 0, remoteMtime: newFolder.modifiedTime, etag: '' };
		this.stateManager.set(stateKey, entry);
		await this.flushStateIfNeeded(true);
		return newFolder.id;
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
		const localStat = existsLocal ? await this.app.vault.adapter.stat(path) : null;

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

	private async handleRemoteDeletions(remotePathSet: Set<string>) {
		const stateEntries = Object.entries(this.stateManager.state);
		// Sort by path length descending to handle children before parents
		const sortedEntries = stateEntries
			.filter(([path]) => path !== '__VAULT_ROOT__' && !this.isExcluded(path))
			.sort((a, b) => b[0].length - a[0].length);

		// Collect candidates for deletion
		const deletionCandidates = sortedEntries.filter(([path]) => !remotePathSet.has(path));
		const trackedCount = sortedEntries.length;
		if (deletionCandidates.length === 0) return;

		if (remotePathSet.size === 0 || deletionCandidates.length === trackedCount) {
			const msg = remotePathSet.size === 0
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
			try {
				if (await this.app.vault.adapter.exists(path)) {
					this.updateStatus(`Deleting local: ${path}`);
					const stat = await this.app.vault.adapter.stat(path);
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
		}
	}

	private async download(path: string, remoteFile: DriveFile) {
		const content = await this.client.downloadFile(remoteFile.id);
		
		const parts = path.split('/');
		if (parts.length > 1) {
			const folderPath = parts.slice(0, -1).join('/');
			await this.ensureLocalPath(folderPath);
		}

		await this.app.vault.adapter.writeBinary(path, content);
		const stat = await this.app.vault.adapter.stat(path);
		
		this.stateManager.set(path, {
			driveId: remoteFile.id,
			lastSyncedMtime: stat ? stat.mtime : Date.now(),
			remoteMtime: remoteFile.modifiedTime,
			etag: ''
		});
		await this.flushStateIfNeeded();
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
			const stat = await this.app.vault.adapter.stat(path);
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
		const localStat = stat ?? await this.app.vault.adapter.stat(path);
		if (!localStat || localStat.type !== 'file') return false;

		if (this.isOpenFilePath(path)) {
			this.addDeferredFile(path, 'open in Obsidian');
			return true;
		}

		const graceMs = this.getLocalEditGraceMs(path);
		const ageMs = Date.now() - localStat.mtime;
		if (ageMs < graceMs) {
			this.addDeferredFile(path, 'recent local edit');
			return true;
		}

		return false;
	}

	private async readStableLocalFile(path: string, stat: Stat): Promise<{ content: ArrayBuffer, stat: Stat } | null> {
		const content = await this.app.vault.adapter.readBinary(path);
		const latestStat = await this.app.vault.adapter.stat(path);

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
		const latestStat = await this.app.vault.adapter.stat(path);
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
