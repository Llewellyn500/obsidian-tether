import { App, Plugin, PluginSettingTab, Setting, Notice, addIcon, WorkspaceLeaf } from 'obsidian';
import { StateManager } from './sync/state';
import { GoogleDriveClient } from './sync/gdrive';
import { SyncEngine } from './sync/engine';
import { FolderSuggestModal } from './ui/folder-modal';
import { SetupGuideModal } from './ui/setup-guide';
import { OAuthManager } from './auth/oauth';
import { SyncStatusView, VIEW_TYPE_SYNC_STATUS } from './ui/sync-view';

interface GoogleDriveSyncSettings {
	accessToken: string;
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	codeVerifier: string;
	userEmail: string;
	folderId: string;
	folderName: string;
	syncInterval: number;
	syncOnStartup: boolean;
}

const DEFAULT_SETTINGS: GoogleDriveSyncSettings = {
	accessToken: '',
	refreshToken: '',
	clientId: '',
	clientSecret: '',
	codeVerifier: '',
	userEmail: '',
	folderId: '',
	folderName: '',
	syncInterval: 15,
	syncOnStartup: true,
}

export default class GoogleDriveSyncPlugin extends Plugin {
	settings!: GoogleDriveSyncSettings;
	stateManager!: StateManager;
	client!: GoogleDriveClient;
	syncEngine!: SyncEngine;
	statusBarItem!: HTMLElement;
	isSyncing: boolean = false;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_SYNC_STATUS,
			(leaf) => new SyncStatusView(leaf)
		);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText('☁️ GDrive: Idle');
		this.statusBarItem.onClickEvent(() => this.activateView());

		this.stateManager = new StateManager(this);
		await this.stateManager.load();

		if (this.settings.accessToken) {
			this.initializeClient();
			this.setupSyncEngine();
			
			if (this.settings.syncOnStartup && this.settings.folderId) {
				setTimeout(() => {
					new Notice('Google Drive: Checking for updates...');
					this.backgroundSync();
				}, 5000); 
			}
		}

		// Add ribbon icon
		const ribbonIconEl = this.addRibbonIcon('cloud', 'Sync with Google Drive', (evt: MouseEvent) => {
			this.manualSync();
		});
		ribbonIconEl.addClass('gdrive-sync-ribbon-icon');

		// Add command palette shortcuts
		this.addCommand({
			id: 'sync-google-drive',
			name: 'Sync with Google Drive',
			callback: () => this.manualSync()
		});

		this.addCommand({
			id: 'open-gdrive-sync-status',
			name: 'Open Sync Status Sidebar',
			callback: () => this.activateView()
		});

		// Add settings tab
		this.addSettingTab(new GoogleDriveSyncSettingTab(this.app, this));

		// Register intervals
		if (this.settings.syncInterval > 0) {
			this.registerInterval(window.setInterval(() => this.backgroundSync(), this.settings.syncInterval * 60 * 1000));
		}

		console.log('Google Drive Sync plugin loaded');
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_SYNC_STATUS, active: true });
		}

		workspace.revealLeaf(leaf);
	}

	async onunload() {
		console.log('Google Drive Sync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	initializeClient() {
		this.client = new GoogleDriveClient(
			this.settings.accessToken,
			async (tokens) => {
				this.settings.accessToken = tokens.access_token;
				if (tokens.refresh_token) this.settings.refreshToken = tokens.refresh_token;
				await this.saveSettings();
			},
			{
				refreshToken: this.settings.refreshToken,
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret
			}
		);
	}

	setupSyncEngine() {
		if (!this.settings.folderId) return;
		
		if (!this.syncEngine) {
			this.syncEngine = new SyncEngine(this.app, this.client, this.stateManager, this.settings.folderId, this.statusBarItem);
		} else {
			this.syncEngine.client = this.client;
			this.syncEngine.folderId = this.settings.folderId;
		}
	}

	async saveSettings() {
		const oldFolderId = (await this.loadData())?.folderId;
		await this.saveData(this.settings);
		
		if (this.settings.folderId && this.settings.folderId !== oldFolderId) {
			new Notice('Sync folder changed. Resetting local sync state...');
			await this.app.vault.adapter.remove('.obsidian/gdrive-sync.json').catch(() => {});
			if (this.stateManager) this.stateManager.state = {};
		}

		if (this.settings.accessToken) {
			this.initializeClient();
			this.setupSyncEngine();
		}
	}

	async manualSync() {
		if (this.isSyncing) {
			new Notice('Sync is already in progress.');
			return;
		}
		if (!this.settings.accessToken) {
			new Notice('Please log in to Google Drive first in settings.');
			return;
		}
		if (!this.settings.folderId) {
			new Notice('Please select a Google Drive folder in settings.');
			return;
		}
		
		this.isSyncing = true;
		await this.activateView(); // Show the sidebar when manual sync starts
		this.setupSyncEngine(); // Re-setup to ensure view reference is fresh

		new Notice('Starting Tether Sync...');
		try {
			await this.syncEngine.sync();
		} catch (error) {
			console.error('Sync failed', error);
			new Notice(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.isSyncing = false;
		}
	}

	async backgroundSync() {
		if (this.isSyncing || !this.settings.accessToken || !this.settings.folderId) return;
		
		this.isSyncing = true;
		this.setupSyncEngine();
		try {
			await this.syncEngine.sync();
		} catch (error) {
			console.error('Background sync failed', error);
		} finally {
			this.isSyncing = false;
		}
	}

	async startLogin() {
		const verifier = await OAuthManager.generateCodeVerifier();
		this.settings.codeVerifier = verifier;
		await this.saveSettings();

		const challenge = await OAuthManager.generateCodeChallenge(verifier);
		const url = await OAuthManager.getAuthUrl(this.settings.clientId, challenge);
		
		window.open(url, '_blank');
	}

	async finalizeLogin(input: string) {
		try {
			let code = input;
			if (input.includes('code=')) {
				const url = input.replace('#', '?');
				const urlParams = new URLSearchParams(url.split('?')[1]);
				code = urlParams.get('code') || input;
			}
			code = decodeURIComponent(code);
			
			const tokens = await OAuthManager.exchangeCodeForToken(
				code, 
				this.settings.codeVerifier, 
				this.settings.clientId, 
				this.settings.clientSecret
			);
			
			this.settings.accessToken = tokens.access_token;
			this.settings.refreshToken = tokens.refresh_token;
			
			const client = new GoogleDriveClient(tokens.access_token);
			const userInfo = await client.getUserInfo();
			this.settings.userEmail = userInfo.email;

			await this.saveSettings();
			new Notice(`Successfully logged in as ${userInfo.email}!`);
		} catch (error) {
			console.error('Login failed', error);
			new Notice('Login failed: ' + (error instanceof Error ? error.message : String(error)));
		}
	}
}

class GoogleDriveSyncSettingTab extends PluginSettingTab {
	plugin: GoogleDriveSyncPlugin;
	authCode: string = '';

	constructor(app: App, plugin: GoogleDriveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'Tether: Setup Wizard'});
		containerEl.createEl('p', {text: 'Created by Llewellyn Paintsil', cls: 'tether-author-credit'});

		// STEP 1: CREDENTIALS
		const step1 = containerEl.createEl('div', { cls: 'gdrive-setup-step' });
		step1.createEl('h3', { text: 'Step 1: API Credentials' });
		
		const hasKeys = this.plugin.settings.clientId && this.plugin.settings.clientSecret;
		
		if (hasKeys) {
			new Setting(step1)
				.setName('Keys Saved ✓')
				.setDesc('Your Client ID and Secret are configured.')
				.addButton(btn => btn
					.setButtonText('Edit Keys')
					.onClick(() => {
						this.plugin.settings.clientId = '';
						this.plugin.settings.clientSecret = '';
						this.display();
					}));
		} else {
			new Setting(step1)
				.setName('Setup Guide')
				.setDesc('First, follow this guide to get your keys.')
				.addButton(button => button
					.setButtonText('Open Guide')
					.onClick(() => new SetupGuideModal(this.app).open()));

			new Setting(step1)
				.setName('Client ID')
				.addText(text => text
					.setPlaceholder('Enter Client ID')
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					}));

			new Setting(step1)
				.setName('Client Secret')
				.addText(text => text
					.setPlaceholder('Enter Client Secret')
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					}));
			
			new Setting(step1)
				.addButton(btn => btn
					.setButtonText('Continue')
					.setCta()
					.onClick(() => this.display()));
			return; // Stop here until keys are set
		}

		// STEP 2: AUTHENTICATION
		const step2 = containerEl.createEl('div', { cls: 'gdrive-setup-step' });
		step2.createEl('h3', { text: 'Step 2: Log in' });

		const isLoggedIn = !!this.plugin.settings.accessToken;

		if (isLoggedIn) {
			new Setting(step2)
				.setName('Logged in ✓')
				.setDesc(`Account: ${this.plugin.settings.userEmail}`)
				.addButton(btn => btn
					.setButtonText('Log Out')
					.onClick(async () => {
						this.plugin.settings.accessToken = '';
						this.plugin.settings.refreshToken = '';
						this.plugin.settings.userEmail = '';
						await this.plugin.saveSettings();
						this.display();
					}));
		} else {
			new Setting(step2)
				.setName('Authorize Plugin')
				.setDesc('Click to open Google login in your browser.')
				.addButton(btn => btn
					.setButtonText('Open Login Page')
					.setCta()
					.onClick(() => this.plugin.startLogin()));

			new Setting(step2)
				.setName('Authorization URL')
				.setDesc('After logging in, copy the full redirected URL from your browser and paste it here.')
				.addText(text => text
					.setPlaceholder('Paste full URL here...')
					.onChange(value => this.authCode = value))
				.addButton(btn => btn
					.setButtonText('Verify Login')
					.onClick(async () => {
						if (!this.authCode) {
							new Notice('Please paste the redirected URL first.');
							return;
						}
						await this.plugin.finalizeLogin(this.authCode);
						this.display();
					}));
			return; // Stop here until logged in
		}

		// STEP 3: FOLDER SELECTION
		const step3 = containerEl.createEl('div', { cls: 'gdrive-setup-step' });
		step3.createEl('h3', { text: 'Step 3: Choose Folder' });

		const hasFolder = !!this.plugin.settings.folderId;

		new Setting(step3)
			.setName(hasFolder ? 'Folder Selected ✓' : 'Select Sync Folder')
			.setDesc(hasFolder ? `Syncing with: ${this.plugin.settings.folderName}` : 'Choose where to sync your notes.')
			.addButton(btn => {
				btn.setButtonText(hasFolder ? 'Change Folder' : 'Select Folder');
				if (!hasFolder) btn.setCta();
				btn.onClick(() => {
					new FolderSuggestModal(this.app, this.plugin.client, async (folder) => {
						this.plugin.settings.folderId = folder.id;
						this.plugin.settings.folderName = folder.name;
						await this.plugin.saveSettings();
						this.display();
						new Notice(`Sync folder set to ${folder.name}.`);
						this.plugin.manualSync();
					}).open();
				});
			});

		if (!hasFolder) return;

		// STEP 4: CONFIGURATION
		const step4 = containerEl.createEl('div', { cls: 'gdrive-setup-step' });
		step4.createEl('h3', { text: 'Step 4: Sync Settings' });

		new Setting(step4)
			.setName('Sync on Startup')
			.setDesc('Automatically check for changes when Obsidian opens.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(step4)
			.setName('Sync Interval (minutes)')
			.setDesc('Minutes between automatic syncs (0 to disable).')
			.addText(text => text
				.setPlaceholder('15')
				.setValue(this.plugin.settings.syncInterval.toString())
				.onChange(async (value) => {
					this.plugin.settings.syncInterval = parseInt(value) || 0;
					await this.plugin.saveSettings();
				}));

		new Setting(step4)
			.setName('Manual Sync')
			.setDesc('Trigger a sync immediately.')
			.addButton(btn => btn
				.setButtonText('Sync Now')
				.onClick(() => this.plugin.manualSync()));
	}
}
