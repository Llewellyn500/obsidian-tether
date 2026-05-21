import { App, Modal, Setting, Notice } from 'obsidian';
import { GoogleDriveApiError, GoogleDriveClient, DriveFile } from '../sync/gdrive';

export class FolderSuggestModal extends Modal {
	client: GoogleDriveClient;
	onSelect: (folder: DriveFile) => void;
	currentFolderId: string = 'root';
	currentFolderName: string = 'My Drive';
	pathStack: { id: string, name: string }[] = [];

	constructor(app: App, client: GoogleDriveClient, onSelect: (folder: DriveFile) => void) {
		super(app);
		this.client = client;
		this.onSelect = onSelect;
	}

	async onOpen() {
		await this.render();
	}

	async render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Select Google Drive Folder' });

		// Breadcrumbs / Navigation Path
		const navPath = this.pathStack.map(f => f.name).join(' > ');
		contentEl.createEl('div', { text: `Path: My Drive ${navPath ? '> ' + navPath : ''}`, cls: 'gdrive-folder-path' });

		const listEl = contentEl.createDiv({ cls: 'gdrive-folder-list' });
		listEl.createEl('p', { text: 'Loading folders...' });

		try {
			const folders = await this.client.listFolders(this.currentFolderId);
			listEl.empty();

			// "Select THIS Folder" button
			new Setting(listEl)
				.setName(`🎯 Select "${this.currentFolderName}"`)
				.setDesc('Click to use this folder for syncing.')
				.addButton(btn => btn
					.setButtonText('Select This Folder')
					.setCta()
					.onClick(() => {
						this.onSelect({ id: this.currentFolderId, name: this.currentFolderName, mimeType: '', modifiedTime: '' });
						this.close();
					}));

			// Navigation: "Back" Button
			if (this.pathStack.length > 0) {
				new Setting(listEl)
					.setName('⬅ Back')
					.addButton(btn => btn
						.setButtonText('Go Up')
						.onClick(async () => {
							const parent = this.pathStack.pop();
							if (this.pathStack.length === 0) {
								this.currentFolderId = 'root';
								this.currentFolderName = 'My Drive';
							} else {
								const prev = this.pathStack[this.pathStack.length - 1];
								this.currentFolderId = prev.id;
								this.currentFolderName = prev.name;
							}
							await this.render();
						}));
			}

			// "Create New" Button (in current folder)
			new Setting(listEl)
				.setName('++ Create New Sub-Folder ++')
				.addButton(btn => btn
					.setButtonText('Create')
					.onClick(() => {
						new CreateFolderModal(this.app, this.client, this.currentFolderId, async (newFolder) => {
							await this.render();
						}).open();
					}));

			// List Existing Sub-Folders
			if (folders.length === 0) {
				listEl.createEl('p', { text: 'No sub-folders found here.', style: 'opacity: 0.6; text-align: center; margin: 20px 0;' });
			}

			folders.forEach(folder => {
				new Setting(listEl)
					.setName(`📁 ${folder.name}`)
					.addButton(btn => btn
						.setButtonText('Open')
						.onClick(async () => {
							this.pathStack.push({ id: folder.id, name: folder.name });
							this.currentFolderId = folder.id;
							this.currentFolderName = folder.name;
							await this.render();
						}));
			});

		} catch (error) {
			listEl.empty();
			this.renderFolderFetchError(listEl, error);
			new Notice('Failed to fetch Google Drive folders. Check the folder picker for setup steps.');
			console.error('Folder fetch failed', error);
		}
	}

	private renderFolderFetchError(parent: HTMLElement, error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		parent.createEl('p', { text: 'Tether could not load your Google Drive folders.' });
		parent.createEl('p', { text: message, cls: 'gdrive-folder-error-message' });

		const steps = this.getFolderFetchSteps(error);
		const list = parent.createEl('ol', { cls: 'gdrive-folder-error-steps' });
		steps.forEach(step => list.createEl('li', { text: step }));

		new Setting(parent)
			.setName('Try again')
			.setDesc('After updating Google Cloud settings, log in again if you changed scopes or tester access.')
			.addButton(btn => btn
				.setButtonText('Retry')
				.setCta()
				.onClick(() => this.render()));
	}

	private getFolderFetchSteps(error: unknown): string[] {
		if (error instanceof GoogleDriveApiError && error.status === 403) {
			const steps = [
				'In Google Cloud, confirm the Google Drive API is enabled for the same project that owns this OAuth client.',
				'Open Google Auth Platform > Data Access and confirm the Drive, Drive metadata, openid, and email scopes are added.',
				'If the OAuth app is still in Testing, confirm this Google account is listed under Audience > Test users.',
				'If you changed scopes or test users, log out of Tether and log in again before selecting a folder.'
			];

			if (error.hint) {
				return [error.hint, ...steps];
			}

			return steps;
		}

		return [
			'Check your internet connection and try again.',
			'Confirm the Google Drive API is enabled in Google Cloud.',
			'Log out of Tether and log in again if you recently changed OAuth settings.'
		];
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class CreateFolderModal extends Modal {
	client: GoogleDriveClient;
	parentId: string;
	onCreated: (folder: DriveFile) => void;
	folderName: string = '';

	constructor(app: App, client: GoogleDriveClient, parentId: string, onCreated: (folder: DriveFile) => void) {
		super(app);
		this.client = client;
		this.parentId = parentId;
		this.onCreated = onCreated;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Create New Sub-Folder' });

		new Setting(contentEl)
			.setName('Folder Name')
			.addText(text => text
				.setPlaceholder('Enter folder name...')
				.onChange(value => this.folderName = value));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Create')
				.setCta()
				.onClick(async () => {
					if (!this.folderName) {
						new Notice('Please enter a folder name');
						return;
					}
					try {
						const folder = await this.client.createFolder(this.folderName, this.parentId);
						new Notice(`Folder "${this.folderName}" created`);
						this.onCreated(folder);
						this.close();
					} catch (error) {
						new Notice('Failed to create folder: ' + error.message);
					}
				}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
