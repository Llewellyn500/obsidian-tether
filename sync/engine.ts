import { App, TFile, TFolder, Notice, TAbstractFile } from 'obsidian';
import { GoogleDriveClient, DriveFile } from './gdrive';
import { StateManager, SyncEntry } from './state';
import { SyncStatusView, SyncStats } from '../ui/sync-view';

export class SyncEngine {
	app: App;
	client: GoogleDriveClient;
	stateManager: StateManager;
	folderId: string;
	statusBarItem: HTMLElement;
	view?: SyncStatusView;
	private folderCache: Map<string, string> = new Map();
	
	private stats: SyncStats = {
		totalFiles: 0,
		processed: 0,
		failed: 0,
		currentFile: '',
		status: 'Idle',
		lastSync: '',
		errors: [],
		conflicts: []
	};

	constructor(app: App, client: GoogleDriveClient, stateManager: StateManager, folderId: string, statusBarItem: HTMLElement, view?: SyncStatusView) {
		this.app = app;
		this.client = client;
		this.stateManager = stateManager;
		this.folderId = folderId;
		this.statusBarItem = statusBarItem;
		this.view = view;
	}

	updateStatus(text: string, partialStats?: Partial<SyncStats>) {
		this.statusBarItem.setText(`☁️ GDrive: ${text}`);
		this.stats.status = text;
		if (partialStats) {
			this.stats = { ...this.stats, ...partialStats };
		}
		if (this.view && typeof this.view.updateStats === 'function') {
			this.view.updateStats(this.stats);
		}
	}

	async sync() {
		if (!this.folderId) {
			new Notice('Google Drive folder ID not set.');
			return;
		}

		try {
			this.stats.processed = 0;
			this.stats.failed = 0;
			this.stats.errors = [];
			this.folderCache.clear();
			
			this.updateStatus('Loading state...');
			await this.stateManager.load();
			
			const vaultName = this.app.vault.getName();
			this.updateStatus(`Locating vault root...`);
			
			const vaultRootDriveId = await this.ensureVaultRoot(vaultName);
			this.folderCache.set('', vaultRootDriveId);

			this.updateStatus('Fetching remote changes...');
			const remoteMap = await this.buildRemoteMap(vaultRootDriveId);
			
			this.updateStatus('Scanning local items...');
			const localPaths = await this.listAllLocalItems('');
			const localPathSet = new Set(localPaths);
			this.stats.totalFiles = localPaths.length;

			// 1. Handle Deletions
			this.updateStatus('Checking for deletions...');
			const stateEntries = Object.entries(this.stateManager.state);
			for (const [path, entry] of stateEntries) {
				if (path === '__VAULT_ROOT__' || this.isExcluded(path)) continue;
				
				if (!localPathSet.has(path)) {
					try {
						this.updateStatus(`Deleting remote: ${path}`);
						await this.client.deleteFile(entry.driveId);
						this.stateManager.remove(path);
						remoteMap.delete(path);
					} catch (e) {
						console.error(`Failed to delete remote ${path}`, e);
						// If already deleted or folder is gone, just remove from state
						if (e.message.includes('404') || e.status === 404) {
							this.stateManager.remove(path);
							remoteMap.delete(path);
						}
					}
				}
			}

			// 2. Pull Remote to Local
			this.updateStatus('Pulling changes...');
			for (const [path, remoteFile] of remoteMap.entries()) {
				if (this.isExcluded(path)) continue;
				try {
					this.stats.currentFile = path;
					await this.processRemoteFile(path, remoteFile);
				} catch (e) {
					console.error(`Failed to pull ${path}`, e);
					this.stats.failed++;
					this.stats.errors.push({ path, message: e.message });
				}
				this.updateStatus(this.stats.status);
			}

			// 3. Push Local to Remote
			this.updateStatus('Pushing changes...');
			for (const path of localPaths) {
				this.stats.processed++;
				this.stats.currentFile = path;
				if (this.stats.processed % 5 === 0 || this.stats.processed === this.stats.totalFiles) {
					this.updateStatus(`Syncing ${this.stats.processed}/${this.stats.totalFiles}${this.stats.failed ? ` (${this.stats.failed} failed)` : ''}`);
				}
				
				try {
					await this.processLocalPath(path, vaultRootDriveId);
				} catch (e) {
					console.error(`Failed to push ${path}`, e);
					// If the file/folder we are trying to update was deleted on remote, 
					// clear the state so the next sync treats it as a new upload.
					if (e.message.includes('404') || e.status === 404) {
						this.stateManager.remove(path);
					}
					this.stats.failed++;
					this.stats.errors.push({ path, message: e.message });
				}
				this.updateStatus(this.stats.status);
			}

			this.stats.lastSync = new Date().toLocaleTimeString();
			this.stats.currentFile = '';
			this.updateStatus('Idle');
			await this.stateManager.save();
			
			if (this.stats.failed > 0) {
				new Notice(`Sync complete with ${this.stats.failed} errors. Check sidebar.`);
			} else {
				new Notice('Sync complete successfully!');
			}
		} catch (error) {
			this.updateStatus('Failed');
			console.error('Critical sync failure', error);
			throw error;
		}
	}

	private isExcluded(path: string): boolean {
		return path.startsWith('.git/') || 
			   path === '.git' || 
			   path === '.obsidian/gdrive-sync.json' ||
			   path.includes('/.git/');
	}

	private async listAllLocalItems(folderPath: string): Promise<string[]> {
		const items: string[] = [];
		const result = await this.app.vault.adapter.list(folderPath);
		
		for (const file of result.files) {
			if (!this.isExcluded(file)) {
				items.push(file);
			}
		}
		
		for (const folder of result.folders) {
			if (!this.isExcluded(folder)) {
				items.push(folder);
				const subItems = await this.listAllLocalItems(folder);
				items.push(...subItems);
			}
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

		const state = this.stateManager.get(path);
		const extension = path.includes('.') ? path.split('.').pop() || '' : '';
		const mimeType = this.getMimeType(extension);
		const fileName = path.split('/').pop() || path;

		if (!state) {
			const parentPath = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
			const driveParentId = await this.ensureRemotePathByPath(parentPath, vaultRootId);
			
			const content = await this.app.vault.adapter.readBinary(path);
			const remoteFile = await this.client.uploadFile(fileName, driveParentId, content, mimeType);
			
			this.stateManager.set(path, {
				driveId: remoteFile.id,
				lastSyncedMtime: stat.mtime,
				remoteMtime: remoteFile.modifiedTime,
				etag: ''
			});
			await this.stateManager.save();
		} else if (stat.mtime > state.lastSyncedMtime) {
			const content = await this.app.vault.adapter.readBinary(path);
			const remoteFile = await this.client.updateFile(state.driveId, content, mimeType);
			
			this.stateManager.set(path, {
				...state,
				lastSyncedMtime: stat.mtime,
				remoteMtime: remoteFile.modifiedTime
			});
			await this.stateManager.save();
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
			await this.stateManager.save();
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
		await this.stateManager.save();

		return remoteFolder.id;
	}

	private async buildRemoteMap(folderId: string, parentPath: string = '', depth: number = 0): Promise<Map<string, DriveFile>> {
		if (depth > 50) throw new Error('Maximum folder depth reached.');
		
		const map = new Map<string, DriveFile>();
		this.updateStatus(`Scanning Drive: ${parentPath || 'root'}...`);
		
		try {
			const items = await this.client.listFiles(folderId);

			for (const item of items) {
				const path = parentPath ? `${parentPath}/${item.name}` : item.name;
				if (item.mimeType === 'application/vnd.google-apps.folder') {
					const subMap = await this.buildRemoteMap(item.id, path, depth + 1);
					for (const [subPath, subFile] of subMap) {
						map.set(subPath, subFile);
					}
				} else {
					map.set(path, item);
				}
			}
		} catch (error) {
			console.error(`Failed to scan Drive folder ${folderId}`, error);
			throw error;
		}
		return map;
	}

	private async ensureVaultRoot(name: string): Promise<string> {
		const stateKey = `__VAULT_ROOT__`;
		const state = this.stateManager.get(stateKey);
		if (state) return state.driveId;

		const folders = await this.client.listFolders(this.folderId);
		const existing = folders.find(f => f.name.toLowerCase() === name.toLowerCase());
		
		if (existing) {
			const entry = { driveId: existing.id, lastSyncedMtime: 0, remoteMtime: existing.modifiedTime, etag: '' };
			this.stateManager.set(stateKey, entry);
			await this.stateManager.save();
			return existing.id;
		}

		const newFolder = await this.client.createFolder(name, this.folderId);
		const entry = { driveId: newFolder.id, lastSyncedMtime: 0, remoteMtime: newFolder.modifiedTime, etag: '' };
		this.stateManager.set(stateKey, entry);
		await this.stateManager.save();
		return newFolder.id;
	}

	private async processRemoteFile(path: string, remoteFile: DriveFile) {
		const state = this.stateManager.get(path);
		const existsLocal = await this.app.vault.adapter.exists(path);

		if (!state) {
			if (existsLocal) {
				await this.handleConflict(path, remoteFile);
			} else {
				await this.download(path, remoteFile);
			}
		} else if (remoteFile.modifiedTime !== state.remoteMtime) {
			const stat = await this.app.vault.adapter.stat(path);
			if (stat && stat.mtime > state.lastSyncedMtime) {
				await this.handleConflict(path, remoteFile);
			} else {
				await this.download(path, remoteFile);
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
		await this.stateManager.save();
	}

	private async ensureLocalPath(path: string) {
		if (!path || path === '.') return;
		if (await this.app.vault.adapter.exists(path)) return;

		const parts = path.split('/');
		const parent = parts.slice(0, -1).join('/');
		if (parent) await this.ensureLocalPath(parent);
		
		await this.app.vault.adapter.mkdir(path);
	}

	private async handleConflict(path: string, remoteFile: DriveFile) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const lastDotIndex = path.lastIndexOf('.');
		const conflictPath = lastDotIndex !== -1 
			? path.slice(0, lastDotIndex) + ` (conflict ${timestamp})` + path.slice(lastDotIndex)
			: `${path} (conflict ${timestamp})`;
		
		const content = await this.client.downloadFile(remoteFile.id);
		await this.app.vault.adapter.writeBinary(conflictPath, content);
		
		new Notice(`Conflict detected for ${path}. Kept both versions.`);
		
		this.stats.conflicts.push({
			path: conflictPath,
			originalPath: path,
			timestamp: timestamp
		});

		const stat = await this.app.vault.adapter.stat(conflictPath);
		this.stateManager.set(conflictPath, {
			driveId: remoteFile.id,
			lastSyncedMtime: stat ? stat.mtime : Date.now(),
			remoteMtime: remoteFile.modifiedTime,
			etag: ''
		});
		await this.stateManager.save();
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
