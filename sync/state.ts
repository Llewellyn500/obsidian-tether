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

	constructor(plugin: any) {
		this.plugin = plugin;
	}

	async load() {
		const data = await this.plugin.app.vault.adapter.read('.obsidian/gdrive-sync.json').catch(() => '{}');
		this.state = JSON.parse(data);
	}

	async save() {
		await this.plugin.app.vault.adapter.write('.obsidian/gdrive-sync.json', JSON.stringify(this.state, null, 2));
	}

	get(path: string): SyncEntry | undefined {
		return this.state[path];
	}

	set(path: string, entry: SyncEntry) {
		this.state[path] = entry;
	}

	remove(path: string) {
		delete this.state[path];
	}
}
