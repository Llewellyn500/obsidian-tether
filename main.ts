import { App, Plugin, PluginSettingTab, Setting, Notice, addIcon, WorkspaceLeaf } from 'obsidian';
import { StateManager } from './sync/state';
import { GoogleDriveClient, isSessionExpiredError } from './sync/gdrive';
import { SyncEngine, SyncMode } from './sync/engine';
import { FolderSuggestModal } from './ui/folder-modal';
import { SetupGuideModal } from './ui/setup-guide';
import { OAuthManager, OAuthTokenResponse } from './auth/oauth';
import { SyncStatusView, VIEW_TYPE_SYNC_STATUS } from './ui/sync-view';

const BACKGROUND_SYNC_IDLE_DELAY_MS = 60000;
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;

interface GoogleDriveSyncSettings {
	accessToken: string;
	accessTokenExpiresAt: number;
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	codeVerifier: string;
	authState: string;
	userEmail: string;
	folderId: string;
	folderName: string;
	syncInterval: number;
	syncOnStartup: boolean;
	initialPullComplete: boolean;
}

const DEFAULT_SETTINGS: GoogleDriveSyncSettings = {
	accessToken: '',
	accessTokenExpiresAt: 0,
	refreshToken: '',
	clientId: '',
	clientSecret: '',
	codeVerifier: '',
	authState: '',
	userEmail: '',
	folderId: '',
	folderName: '',
	syncInterval: 15,
	syncOnStartup: true,
	initialPullComplete: false,
}

export default class GoogleDriveSyncPlugin extends Plugin {
	settings!: GoogleDriveSyncSettings;
	stateManager!: StateManager;
	client!: GoogleDriveClient;
	syncEngine!: SyncEngine;
	statusBarItem!: HTMLElement;
	isSyncing: boolean = false;
	private lastLocalChangeAt = 0;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_SYNC_STATUS,
			(leaf) => new SyncStatusView(leaf)
		);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.setText('GDrive: Idle');
		this.statusBarItem.onClickEvent(() => this.activateView());

		this.stateManager = new StateManager(this);
		await this.stateManager.load();

		const markLocalChange = () => {
			this.lastLocalChangeAt = Date.now();
		};
		this.registerEvent(this.app.vault.on('create', markLocalChange));
		this.registerEvent(this.app.vault.on('modify', markLocalChange));
		this.registerEvent(this.app.vault.on('delete', markLocalChange));
		this.registerEvent(this.app.vault.on('rename', markLocalChange));

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

		// Add ribbon icons
		const pullRibbonIconEl = this.addRibbonIcon('cloud-download', 'Pull from Google Drive', (evt: MouseEvent) => {
			this.pullSync();
		});
		pullRibbonIconEl.addClass('gdrive-sync-ribbon-icon');

		const pushRibbonIconEl = this.addRibbonIcon('cloud-upload', 'Push to Google Drive', (evt: MouseEvent) => {
			this.pushSync();
		});
		pushRibbonIconEl.addClass('gdrive-sync-ribbon-icon');

		// Add command palette shortcuts
		this.addCommand({
			id: 'sync-google-drive',
			name: 'Run Next Tether Sync',
			callback: () => this.manualSync()
		});

		this.addCommand({
			id: 'pull-google-drive',
			name: 'Pull from Google Drive',
			callback: () => this.pullSync()
		});

		this.addCommand({
			id: 'push-google-drive',
			name: 'Push to Google Drive',
			callback: () => this.pushSync()
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
			async (tokens: OAuthTokenResponse) => {
				this.applyTokenResponse(tokens);
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
		const folderChanged = !!this.settings.folderId && this.settings.folderId !== oldFolderId;
		if (folderChanged) {
			this.settings.initialPullComplete = false;
		}
		await this.saveData(this.settings);
		
		if (folderChanged) {
			new Notice('Sync folder changed. Resetting local sync state...');
			const statePath = this.stateManager?.getStatePath?.() ?? `${this.app.vault.configDir || '.obsidian'}/gdrive-sync.json`;
			await this.app.vault.adapter.remove(statePath).catch(() => {});
			if (this.stateManager) this.stateManager.clear();
		}

		if (this.settings.accessToken) {
			this.initializeClient();
			this.setupSyncEngine();
		}
	}

	private applyTokenResponse(tokens: OAuthTokenResponse) {
		this.settings.accessToken = tokens.access_token;
		if (tokens.refresh_token) {
			this.settings.refreshToken = tokens.refresh_token;
		}
		this.settings.accessTokenExpiresAt = this.getAccessTokenExpiresAt(tokens);
	}

	private getAccessTokenExpiresAt(tokens: OAuthTokenResponse): number {
		const expiresIn = Number(tokens.expires_in);
		const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0
			? expiresIn * 1000
			: DEFAULT_ACCESS_TOKEN_TTL_MS;
		return Date.now() + ttlMs;
	}

	private shouldRefreshAccessToken(): boolean {
		return !this.settings.accessTokenExpiresAt ||
			this.settings.accessTokenExpiresAt - Date.now() <= ACCESS_TOKEN_REFRESH_BUFFER_MS;
	}

	async ensureValidSession(showNotice = true): Promise<boolean> {
		if (!this.settings.accessToken) {
			if (showNotice) {
				new Notice('Please log in to Google Drive first in settings.');
			}
			return false;
		}

		if (!this.shouldRefreshAccessToken()) {
			return true;
		}

		if (!this.settings.refreshToken) {
			await this.handleExpiredSession(showNotice);
			return false;
		}

		if (!this.client) {
			this.initializeClient();
		}

		try {
			await this.client.refreshAccessToken();
			return true;
		} catch (error) {
			if (isSessionExpiredError(error)) {
				await this.handleExpiredSession(true);
			} else {
				console.error('Session refresh failed', error);
				if (showNotice) {
					new Notice('Could not refresh Google session: ' + (error instanceof Error ? error.message : String(error)));
				}
			}
			return false;
		}
	}

	private async handleExpiredSession(showNotice = true) {
		this.settings.accessToken = '';
		this.settings.accessTokenExpiresAt = 0;
		this.settings.refreshToken = '';
		this.settings.codeVerifier = '';
		this.settings.authState = '';
		this.settings.userEmail = '';
		await this.saveSettings();

		if (this.syncEngine) {
			this.syncEngine.updateStatus('Session expired', {
				currentFile: '',
				failed: 1,
				errors: [{ path: 'Google Drive', message: 'Session expired. Please log in again in Tether settings.' }]
			}, true);
		}

		if (showNotice) {
			new Notice('Google session expired. Please log in again in Tether settings.');
		}
	}

	async manualSync() {
		if (!this.settings.initialPullComplete) {
			// First pull from remote to pick up any existing files
			await this.runSync('pull');
			// After a successful initial pull, immediately push local content
			if (this.settings.initialPullComplete && !this.isSyncing) {
				await this.runSync('push');
			}
		} else {
			await this.runSync('push');
		}
	}

	async pullSync() {
		await this.runSync('pull');
	}

	async pushSync() {
		await this.runSync('push');
	}

	private async runSync(mode: SyncMode, options: { silent?: boolean, revealStatus?: boolean } = {}) {
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
		if (!(await this.ensureValidSession(!options.silent))) {
			return;
		}
		
		this.isSyncing = true;
		if (options.revealStatus ?? true) {
			await this.activateView();
		}
		this.setupSyncEngine();

		if (!options.silent) {
			new Notice(`Starting Tether ${mode}...`);
		}
		try {
			await this.syncEngine.sync({ mode, silent: options.silent });
			if (mode === 'pull' && this.syncEngine.stats.failed === 0 && this.syncEngine.stats.deferred.length === 0) {
				this.settings.initialPullComplete = true;
				await this.saveSettings();
			}
		} catch (error) {
			console.error(`${mode} failed`, error);
			if (isSessionExpiredError(error)) {
				await this.handleExpiredSession(true);
			} else if (!options.silent) {
				new Notice(`${mode === 'pull' ? 'Pull' : 'Push'} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			this.isSyncing = false;
		}
	}

	async backgroundSync() {
		if (this.isSyncing || !this.settings.accessToken || !this.settings.folderId) return;
		if (Date.now() - this.lastLocalChangeAt < BACKGROUND_SYNC_IDLE_DELAY_MS) return;

		if (!this.settings.initialPullComplete) {
			await this.runSync('pull', { silent: true, revealStatus: false });
			// After a successful initial pull, immediately push local content
			if (this.settings.initialPullComplete && !this.isSyncing) {
				await this.runSync('push', { silent: true, revealStatus: false });
			}
		} else {
			await this.runSync('push', { silent: true, revealStatus: false });
		}
	}

	async startLogin() {
		if (!this.settings.clientId || !this.settings.clientSecret) {
			new Notice('Add your Google client ID and secret before opening the login page.');
			return;
		}

		const verifier = await OAuthManager.generateCodeVerifier();
		const authState = await OAuthManager.generateCodeVerifier();
		this.settings.codeVerifier = verifier;
		this.settings.authState = authState;
		await this.saveSettings();

		const challenge = await OAuthManager.generateCodeChallenge(verifier);
		const url = await OAuthManager.getAuthUrl(this.settings.clientId, challenge, authState);
		
		const opened = window.open(url, '_blank');
		if (!opened) {
			if (navigator.clipboard) {
				await navigator.clipboard.writeText(url).catch(() => {});
			}
			new Notice('Login page could not open automatically. The login URL was copied if clipboard access is available.');
		}
	}

	async finalizeLogin(input: string) {
		try {
			const params = this.extractOAuthParams(input);
			const oauthError = params.get('error');
			if (oauthError) {
				throw new Error(params.get('error_description') || oauthError);
			}

			let code = params.get('code') || input.trim();
			const returnedState = params.get('state');
			if (returnedState && this.settings.authState && returnedState !== this.settings.authState) {
				throw new Error('Authorization response did not match this login attempt. Please start login again.');
			}
			code = decodeURIComponent(code);
			
			const tokens = await OAuthManager.exchangeCodeForToken(
				code, 
				this.settings.codeVerifier, 
				this.settings.clientId, 
				this.settings.clientSecret
			);
			
			this.applyTokenResponse(tokens);
			this.settings.codeVerifier = '';
			this.settings.authState = '';
			
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

	private extractOAuthParams(input: string): URLSearchParams {
		const trimmed = input.trim();

		try {
			const url = new URL(trimmed);
			const params = new URLSearchParams(url.search);

			if (url.hash) {
				const hashParams = new URLSearchParams(url.hash.slice(1));
				hashParams.forEach((value, key) => params.set(key, value));
			}

			return params;
		} catch (e) {
			const normalized = trimmed.startsWith('?') || trimmed.startsWith('#')
				? trimmed.slice(1)
				: trimmed;

			if (normalized.includes('=')) {
				return new URLSearchParams(normalized);
			}

			return new URLSearchParams({ code: normalized });
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
						this.plugin.settings.accessTokenExpiresAt = 0;
						this.plugin.settings.refreshToken = '';
						this.plugin.settings.codeVerifier = '';
						this.plugin.settings.authState = '';
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
				btn.onClick(async () => {
					if (!(await this.plugin.ensureValidSession(true))) {
						this.display();
						return;
					}
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
			.setDesc(this.plugin.settings.initialPullComplete ? 'Next automatic sync will push local changes.' : 'Next automatic sync will pull from Google Drive first.')
			.addButton(btn => btn
				.setButtonText('Pull')
				.onClick(() => this.plugin.pullSync()))
			.addButton(btn => btn
				.setButtonText('Push')
				.setCta()
				.onClick(() => this.plugin.pushSync()));
	}
}
