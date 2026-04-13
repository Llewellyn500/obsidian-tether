import { App, Modal, Setting, Notice } from 'obsidian';
import { GoogleDriveClient, DriveFile } from '../sync/gdrive';

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
			listEl.createEl('p', { text: 'Failed to fetch folders: ' + error.message });
			console.error('Folder fetch failed', error);
		}
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
