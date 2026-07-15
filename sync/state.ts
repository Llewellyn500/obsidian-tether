import { normalizePath } from 'obsidian';

export interface SyncEntry {
	driveId: string;
	lastSyncedMtime: number;
	remoteMtime: string; // ISO 8601 from Google Drive
	etag: string;
}

export type SyncState = Record<string, SyncEntry>;

export class StateManager {
	state: SyncState = {};
	plugin: any;
	private dirty = false;
	private pendingChanges = 0;
	private lastSavedAt = 0;

	constructor(plugin: any) {
		this.plugin = plugin;
	}

	getStatePath(): string {
		const configDir = this.plugin.app.vault.configDir || '.obsidian';
		return normalizePath(`${configDir}/gdrive-sync.json`);
	}

	async load() {
		const data = await this.plugin.app.vault.adapter.read(this.getStatePath()).catch(() => '{}');
		this.state = JSON.parse(data);
		this.dirty = false;
		this.pendingChanges = 0;
		this.lastSavedAt = Date.now();
	}

	async save() {
		if (!this.dirty) return;

		await this.plugin.app.vault.adapter.write(this.getStatePath(), JSON.stringify(this.state));
		this.dirty = false;
		this.pendingChanges = 0;
		this.lastSavedAt = Date.now();
	}

	shouldSave(changeLimit: number, maxAgeMs: number): boolean {
		return this.dirty && (this.pendingChanges >= changeLimit || Date.now() - this.lastSavedAt >= maxAgeMs);
	}

	hasUnsavedChanges(): boolean {
		return this.dirty;
	}

	get(path: string): SyncEntry | undefined {
		return this.state[path];
	}

	set(path: string, entry: SyncEntry) {
		const previous = this.state[path];
		this.state[path] = entry;
		if (!previous ||
			previous.driveId !== entry.driveId ||
			previous.lastSyncedMtime !== entry.lastSyncedMtime ||
			previous.remoteMtime !== entry.remoteMtime ||
			previous.etag !== entry.etag) {
			this.markDirty();
		}
	}

	remove(path: string) {
		if (Object.prototype.hasOwnProperty.call(this.state, path)) {
			delete this.state[path];
			this.markDirty();
		}
	}

	clear() {
		this.state = {};
		this.markDirty();
	}

	private markDirty() {
		this.dirty = true;
		this.pendingChanges++;
	}
}
