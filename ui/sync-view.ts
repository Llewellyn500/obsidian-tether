import { ItemView, Notice, WorkspaceLeaf, TFile } from 'obsidian';

export const VIEW_TYPE_SYNC_STATUS = 'gdrive-sync-status-view';

export interface SyncStats {
	totalFiles: number;
	processed: number;
	failed: number;
	currentFile: string;
	status: string;
	lastSync: string;
	errors: { path: string, message: string }[];
	conflicts: { path: string, originalPath: string, timestamp: string }[];
	deferred: { path: string, reason: string }[];
}

export class SyncStatusView extends ItemView {
	stats: SyncStats = {
		totalFiles: 0,
		processed: 0,
		failed: 0,
		currentFile: '',
		status: 'Idle',
		lastSync: 'Never',
		errors: [],
		conflicts: [],
		deferred: []
	};

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_SYNC_STATUS;
	}

	getDisplayText() {
		return 'Google Drive Sync';
	}

	getIcon() {
		return 'cloud';
	}

	async onOpen() {
		const plugin = (this.app as any).plugins.getPlugin('tether');
		if (plugin && plugin.syncEngine) {
			this.stats = { ...plugin.syncEngine.stats };
		}
		this.render();
	}

	updateStats(newStats: Partial<SyncStats>) {
		this.stats = { ...this.stats, ...newStats };
		this.render();
	}

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gdrive-sync-view');

		container.createEl('h3', { text: 'Sync Status' });
		this.createSyncActions(container);

		const statsGrid = container.createDiv({ cls: 'sync-stats-grid' });
		
		this.createStat(statsGrid, 'Status', this.stats.status);
		this.createStat(statsGrid, 'Progress', `${this.stats.processed} / ${this.stats.totalFiles}`);
		this.createStat(statsGrid, 'Conflicts', this.stats.conflicts.length.toString(), this.stats.conflicts.length > 0 ? 'text-warning' : '');
		this.createStat(statsGrid, 'Deferred', this.stats.deferred.length.toString(), this.stats.deferred.length > 0 ? 'text-accent' : '');
		this.createStat(statsGrid, 'Failed', this.stats.failed.toString(), this.stats.failed > 0 ? 'text-error' : '');
		const plugin = (this.app as any).plugins.getPlugin('tether');
		if (plugin) {
			this.createStat(statsGrid, 'Auto Sync', plugin.settings?.syncPaused ? 'Stopped' : 'On', plugin.settings?.syncPaused ? 'text-warning' : '');
		}

		if (this.stats.currentFile) {
			container.createEl('p', { text: `Currently: ${this.stats.currentFile}`, cls: 'current-file-text' });
		}

		// Conflicts Section
		if (this.stats.conflicts.length > 0) {
			container.createEl('h4', { text: '🚩 Conflicts (Needs Review)' });
			const conflictList = container.createDiv({ cls: 'sync-conflict-list' });
			this.stats.conflicts.forEach(conflict => {
				const item = conflictList.createDiv({ cls: 'conflict-item' });
				const info = item.createDiv({ cls: 'conflict-info' });
				info.createEl('b', { text: conflict.path.split('/').pop() || conflict.path });
				info.createEl('p', { text: `Original: ${conflict.originalPath}`, cls: 'conflict-original-path' });
				
				const btnContainer = item.createDiv({ cls: 'conflict-buttons' });
				
				const openBtn = btnContainer.createEl('button', { text: 'Open', cls: 'mod-cta conflict-open-btn' });
				openBtn.onClickEvent(async () => {
					try {
						const file = this.app.vault.getAbstractFileByPath(conflict.path);
						if (file instanceof TFile) {
							await this.app.workspace.getLeaf(true).openFile(file);
						} else if (this.isConfigPath(conflict.path)) {
							new Notice('Cannot open hidden config files directly in the editor. Please use an external editor or a File Explorer plugin to view this file.');
						} else {
							await this.app.workspace.openLinkText(conflict.path, '', true);
						}
					} catch (e) {
						console.error('Failed to open conflict file', e);
						new Notice('Failed to open file: ' + e.message);
					}
				});

				const delBtn = btnContainer.createEl('button', { text: 'Delete', cls: 'mod-warning conflict-del-btn' });
				delBtn.onClickEvent(async () => {
					if (confirm(`Are you sure you want to delete this conflict file?\n${conflict.path}`)) {
						try {
							await this.app.vault.adapter.remove(conflict.path);
							this.stats.conflicts = this.stats.conflicts.filter(c => c.path !== conflict.path);
							this.render();
							new Notice('Conflict file deleted.');
						} catch (e) {
							new Notice('Failed to delete file: ' + e.message);
						}
					}
				});
			});
		}

		if (this.stats.deferred.length > 0) {
			container.createEl('h4', { text: 'Deferred (Active Edits)' });
			const deferredList = container.createDiv({ cls: 'sync-deferred-list' });
			this.stats.deferred.slice(-10).reverse().forEach(deferred => {
				const item = deferredList.createDiv({ cls: 'deferred-item' });
				item.createEl('b', { text: deferred.path.split('/').pop() || deferred.path });
				item.createEl('p', { text: `${deferred.reason}: ${deferred.path}` });
			});
		}

		if (this.stats.errors.length > 0) {
			container.createEl('h4', { text: 'Recent Errors' });
			const errorList = container.createDiv({ cls: 'sync-error-list' });
			this.stats.errors.slice(-10).reverse().forEach(err => {
				const item = errorList.createDiv({ cls: 'error-item' });
				item.createEl('b', { text: err.path.split('/').pop() || err.path });
				item.createEl('p', { text: err.message });
			});
		}
	}

	private createStat(parent: HTMLElement, label: string, value: string, cls: string = '') {
		const stat = parent.createDiv({ cls: 'sync-stat' });
		stat.createDiv({ text: label, cls: 'stat-label' });
		stat.createDiv({ text: value, cls: 'stat-value ' + cls });
	}

	private createSyncActions(parent: Element) {
		const plugin = (this.app as any).plugins.getPlugin('tether');
		const actions = parent.createDiv({ cls: 'sync-action-row' });

		const pullButton = actions.createEl('button', { text: 'Pull', cls: 'mod-cta' });
		pullButton.onClickEvent(() => plugin?.pullSync?.());

		const pushButton = actions.createEl('button', { text: 'Push' });
		pushButton.onClickEvent(() => plugin?.pushSync?.());

		const stopButton = actions.createEl('button', {
			text: plugin?.settings?.syncPaused ? 'Resume Auto Sync' : 'Stop Auto Sync',
			cls: plugin?.settings?.syncPaused ? 'mod-cta' : 'mod-warning'
		});
		stopButton.onClickEvent(() => {
			if (plugin?.settings?.syncPaused) {
				plugin?.resumeAutomaticSync?.();
			} else {
				plugin?.stopAutomaticSync?.();
			}
		});

		if (!plugin) {
			pullButton.disabled = true;
			pushButton.disabled = true;
			stopButton.disabled = true;
		}
	}

	private isConfigPath(path: string): boolean {
		const configDir = this.app.vault.configDir || '.obsidian';
		return path === configDir || path.startsWith(`${configDir}/`);
	}
}
