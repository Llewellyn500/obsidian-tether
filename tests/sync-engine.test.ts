import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncEngine } from '../sync/engine';
import { DriveFile, GoogleDriveApiError, GoogleDriveClient } from '../sync/gdrive';
import { StateManager } from '../sync/state';

const FOLDER = 'application/vnd.google-apps.folder';

interface StoredItem extends DriveFile {
	parentId: string;
	content?: string;
	trashed?: boolean;
}

class FakeState {
	state: Record<string, { driveId: string, lastSyncedMtime: number, remoteMtime: string, etag: string }> = {};
	saveCount = 0;

	get(path: string) {
		return this.state[path];
	}

	set(path: string, entry: typeof this.state[string]) {
		this.state[path] = entry;
	}

	remove(path: string) {
		delete this.state[path];
	}

	shouldSave() {
		return false;
	}

	async save() {
		this.saveCount++;
	}
}

class FakeDrive {
	items = new Map<string, StoredItem>();
	createFolderCalls = 0;
	moveCalls: Array<{ id: string, from: string, to: string, name?: string }> = [];
	renameCalls: Array<{ id: string, name: string }> = [];
	trashCalls: string[] = [];
	deleteCalls: string[] = [];
	updateCalls: string[] = [];
	private nextId = 1;

	add(item: StoredItem) {
		this.items.set(item.id, { ...item });
	}

	async listFiles(parentId: string): Promise<DriveFile[]> {
		const snapshot = [...this.items.values()]
			.filter(item => !item.trashed && item.parentId === parentId)
			.map(item => this.driveFile(item));
		await Promise.resolve();
		return snapshot;
	}

	async createFolder(name: string, parentId: string): Promise<DriveFile> {
		this.createFolderCalls++;
		await Promise.resolve();
		const id = `created-${this.nextId++}`;
		const item: StoredItem = {
			id,
			name,
			mimeType: FOLDER,
			createdTime: '2026-01-01T00:00:00.000Z',
			modifiedTime: '2026-01-01T00:00:00.000Z',
			parentId
		};
		this.add(item);
		return this.driveFile(item);
	}

	async moveFile(id: string, from: string, to: string, name?: string): Promise<DriveFile> {
		const item = this.required(id);
		assert.equal(item.parentId, from);
		item.parentId = to;
		if (name) item.name = name;
		this.moveCalls.push({ id, from, to, name });
		return this.driveFile(item);
	}

	async renameFile(id: string, name: string): Promise<DriveFile> {
		const item = this.required(id);
		item.name = name;
		this.renameCalls.push({ id, name });
		return this.driveFile(item);
	}

	async trashFile(id: string): Promise<void> {
		const item = this.required(id);
		if (item.mimeType === FOLDER) {
			const children = await this.listFiles(id);
			assert.equal(children.length, 0, `refused to trash non-empty folder ${id}`);
		}
		item.trashed = true;
		this.trashCalls.push(id);
	}

	async deleteFile(id: string): Promise<void> {
		this.deleteCalls.push(id);
		throw new Error(`Unexpected permanent delete of ${id}`);
	}

	async updateFile(id: string): Promise<DriveFile> {
		this.updateCalls.push(id);
		throw new Error(`Unexpected content overwrite of ${id}`);
	}

	activeChildren(parentId: string): StoredItem[] {
		return [...this.items.values()].filter(item => !item.trashed && item.parentId === parentId);
	}

	private required(id: string): StoredItem {
		const item = this.items.get(id);
		if (!item) throw new Error(`Missing fake Drive item ${id}`);
		return item;
	}

	private driveFile(item: StoredItem): DriveFile {
		return {
			id: item.id,
			name: item.name,
			mimeType: item.mimeType,
			createdTime: item.createdTime,
			modifiedTime: item.modifiedTime,
			md5Checksum: item.md5Checksum,
			size: item.size
		};
	}
}

function file(id: string, name: string, parentId: string, content: string): StoredItem {
	return {
		id,
		name,
		parentId,
		content,
		mimeType: 'text/markdown',
		createdTime: `2026-01-01T00:00:${id.length.toString().padStart(2, '0')}.000Z`,
		modifiedTime: '2026-01-01T00:01:00.000Z',
		md5Checksum: `md5-${content}`,
		size: String(content.length)
	};
}

function folder(id: string, name: string, parentId: string, second: number): StoredItem {
	return {
		id,
		name,
		parentId,
		mimeType: FOLDER,
		createdTime: `2026-01-01T00:00:${second.toString().padStart(2, '0')}.000Z`,
		modifiedTime: `2026-01-01T00:00:${second.toString().padStart(2, '0')}.000Z`
	};
}

function makeEngine(drive: FakeDrive, state = new FakeState()) {
	const app = {
		workspace: {
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			iterateAllLeaves: () => {}
		}
	};
	const statusBar = { setText: () => {} };
	const engine = new SyncEngine(app as any, drive as any, state as any, 'selected-root', statusBar as any);
	return {
		engine: engine as unknown as {
			ensureRemotePathByPath(path: string, rootId: string): Promise<string>;
			listCanonicalRemoteItems(folderId: string, parentPath: string): Promise<DriveFile[]>;
		},
		state
	};
}

test('three concurrent folder resolutions create one Drive folder', async () => {
	const drive = new FakeDrive();
	const { engine } = makeEngine(drive);

	const ids = await Promise.all([
		engine.ensureRemotePathByPath('00 Home', 'root'),
		engine.ensureRemotePathByPath('00 home', 'root'),
		engine.ensureRemotePathByPath('00 Home', 'root')
	]);

	assert.equal(new Set(ids).size, 1);
	assert.equal(drive.createFolderCalls, 1);
	assert.equal(drive.activeChildren('root').length, 1);
});

test('duplicate folders merge recursively before empty sources are trashed', async () => {
	const drive = new FakeDrive();
	drive.add(folder('docs-old', 'Docs', 'root', 1));
	drive.add(folder('docs-new', 'docs', 'root', 2));
	drive.add(file('file-a', 'a.md', 'docs-old', 'A'));
	drive.add(file('file-b', 'b.md', 'docs-new', 'B'));
	drive.add(file('copy-old', 'copy.md', 'docs-old', 'same'));
	drive.add(file('copy-new', 'copy.md', 'docs-new', 'same'));
	drive.add(folder('sub-old', 'Sub', 'docs-old', 3));
	drive.add(folder('sub-new', 'sub', 'docs-new', 4));
	drive.add(file('nested-a', 'one.md', 'sub-old', 'one'));
	drive.add(file('nested-b', 'two.md', 'sub-new', 'two'));

	const { engine, state } = makeEngine(drive);
	state.set('Docs', { driveId: 'docs-new', lastSyncedMtime: 0, remoteMtime: '', etag: '' });
	await engine.listCanonicalRemoteItems('root', '');

	const rootFolders = drive.activeChildren('root').filter(item => item.mimeType === FOLDER);
	assert.deepEqual(rootFolders.map(item => item.id), ['docs-old']);
	const subFolders = drive.activeChildren('docs-old').filter(item => item.mimeType === FOLDER);
	assert.deepEqual(subFolders.map(item => item.id), ['sub-old']);
	assert.deepEqual(
		drive.activeChildren('docs-old').filter(item => item.mimeType !== FOLDER).map(item => item.id).sort(),
		['copy-old', 'file-a', 'file-b']
	);
	assert.deepEqual(drive.activeChildren('sub-old').map(item => item.id).sort(), ['nested-a', 'nested-b']);
	assert.equal(state.get('Docs')?.driveId, 'docs-old');
	assert.deepEqual(drive.trashCalls.sort(), ['copy-new', 'docs-new', 'sub-new']);
	assert.equal(drive.deleteCalls.length, 0);
});

test('differing same-name files survive folder merge and later rediscovery', async () => {
	const drive = new FakeDrive();
	drive.add(folder('docs-old', 'Docs', 'root', 1));
	drive.add(folder('docs-new', 'Docs', 'root', 2));
	drive.add(file('same-old', 'same.md', 'docs-old', 'old content'));
	drive.add(file('same-new', 'same.md', 'docs-new', 'new content'));

	const first = makeEngine(drive);
	first.state.set('Docs/same.md', { driveId: 'same-new', lastSyncedMtime: 1, remoteMtime: '', etag: '' });
	await first.engine.listCanonicalRemoteItems('root', '');

	const active = drive.activeChildren('docs-old').filter(item => item.mimeType !== FOLDER);
	assert.deepEqual(active.map(item => item.id).sort(), ['same-new', 'same-old']);
	assert.equal(new Set(active.map(item => item.name.toLowerCase())).size, 2);
	assert.deepEqual(active.map(item => item.content).sort(), ['new content', 'old content']);
	assert.equal(drive.updateCalls.length, 0);
	assert.equal(drive.deleteCalls.length, 0);

	const second = makeEngine(drive);
	await second.engine.listCanonicalRemoteItems('root', '');
	await second.engine.listCanonicalRemoteItems('docs-old', 'Docs');

	assert.deepEqual(drive.activeChildren('docs-old').map(item => item.id).sort(), ['same-new', 'same-old']);
	assert.equal(drive.updateCalls.length, 0);
	assert.equal(drive.deleteCalls.length, 0);
});

test('folder creation retries reuse one pre-generated Drive ID', async () => {
	const client = new GoogleDriveClient('token') as any;
	const requests: any[] = [];
	client.request = async (options: any) => {
		requests.push(options);
		if (options.url.includes('generateIds')) {
			return { json: { ids: ['fixed-folder-id'] } };
		}
		if (options.method === 'POST') {
			const body = JSON.parse(options.body);
			assert.equal(body.id, 'fixed-folder-id');
			throw new GoogleDriveApiError(409, 'Already exists');
		}
		return {
			json: {
				id: 'fixed-folder-id',
				name: 'Notes',
				mimeType: FOLDER,
				createdTime: '2026-01-01T00:00:00.000Z',
				modifiedTime: '2026-01-01T00:00:00.000Z',
				parents: ['root'],
				trashed: false
			}
		};
	};

	const created = await client.createFolder('Notes', 'root');
	assert.equal(created.id, 'fixed-folder-id');
	assert.equal(requests.filter(request => request.method === 'POST').length, 1);
});

test('range downloads request only the selected bytes', async () => {
	const client = new GoogleDriveClient('token') as any;
	client.request = async (options: any) => {
		assert.equal(options.method, 'GET');
		assert.equal(options.headers.Range, 'bytes=2097152-4194303');
		return { status: 206, arrayBuffer: new ArrayBuffer(2 * 1024 * 1024) };
	};

	const chunk = await client.downloadFileRange('large-video', 2 * 1024 * 1024, 4 * 1024 * 1024 - 1);
	assert.equal(chunk.status, 206);
	assert.equal(chunk.content.byteLength, 2 * 1024 * 1024);
});

test('a failed folder creation invocation keeps its generated ID reserved', async () => {
	const reservations = new Map<string, Promise<string>>();
	const firstClient = new GoogleDriveClient('token-1', undefined, undefined, reservations) as any;
	const replacementClient = new GoogleDriveClient('token-2', undefined, undefined, reservations) as any;
	let generatedIds = 0;
	let postCalls = 0;
	const postedIds: string[] = [];

	const request = async (options: any) => {
		if (options.url.includes('generateIds')) {
			generatedIds++;
			return { json: { ids: [`reserved-${generatedIds}`] } };
		}
		if (options.method === 'POST') {
			postCalls++;
			const body = JSON.parse(options.body);
			postedIds.push(body.id);
			if (postCalls === 1) {
				throw new GoogleDriveApiError(0, 'Timed out');
			}
			return {
				json: {
					id: body.id,
					name: body.name,
					mimeType: FOLDER,
					createdTime: '2026-01-01T00:00:00.000Z',
					modifiedTime: '2026-01-01T00:00:00.000Z',
					parents: body.parents,
					trashed: false
				}
			};
		}
		throw new GoogleDriveApiError(404, 'Not found');
	};
	firstClient.request = request;
	replacementClient.request = request;

	await assert.rejects(firstClient.createFolder('Notes', 'root'));
	const created = await replacementClient.createFolder('notes', 'root');

	assert.equal(created.id, 'reserved-1');
	assert.equal(generatedIds, 1);
	assert.deepEqual(postedIds, ['reserved-1', 'reserved-1']);
});

test('state saves serialize and finish with the newest snapshot on disk', async () => {
	let startFirstWrite!: () => void;
	let releaseFirstWrite!: () => void;
	const firstWriteStarted = new Promise<void>(resolve => { startFirstWrite = resolve; });
	const firstWriteReleased = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
	const committedWrites: string[] = [];
	let writeCalls = 0;
	const plugin = {
		app: {
			vault: {
				configDir: '.obsidian',
				adapter: {
					read: async () => '{}',
					write: async (_path: string, data: string) => {
						writeCalls++;
						if (writeCalls === 1) {
							startFirstWrite();
							await firstWriteReleased;
						}
						committedWrites.push(data);
					}
				}
			}
		}
	};
	const state = new StateManager(plugin);
	const entry = (driveId: string) => ({
		driveId,
		lastSyncedMtime: 0,
		remoteMtime: '2026-01-01T00:00:00.000Z',
		etag: ''
	});

	state.set('first.md', entry('first'));
	const firstSave = state.save();
	await firstWriteStarted;
	state.set('second.md', entry('second'));
	const secondSave = state.save();
	releaseFirstWrite();
	await Promise.all([firstSave, secondSave]);

	assert.equal(committedWrites.length, 2);
	assert.equal(JSON.parse(committedWrites[0])['second.md'], undefined);
	assert.equal(JSON.parse(committedWrites[1])['second.md'].driveId, 'second');
	assert.equal(state.hasUnsavedChanges(), false);
});
