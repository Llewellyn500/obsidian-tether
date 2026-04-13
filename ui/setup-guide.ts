import { App, Modal } from 'obsidian';

export class SetupGuideModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gdrive-setup-modal');
		
		contentEl.createEl('h2', { text: '🚀 Google Drive Sync: 2-Minute Setup' });

		const step1 = contentEl.createEl('div', { cls: 'setup-step' });
		step1.createEl('h3', { text: '1. Create your Google Cloud Project' });
		const list1 = step1.createEl('ol');
		list1.createEl('li', { text: 'Go to the ' }).createEl('a', { text: 'Google Cloud Console', href: 'https://console.cloud.google.com/' });
		list1.createEl('li', { text: 'Click the project dropdown (top left) > "New Project".' });
		list1.createEl('li', { text: 'Name it "Obsidian Sync" and click "Create". Wait for the notification that it\'s ready.' });

		const step2 = contentEl.createEl('setup-step');
		step2.createEl('h3', { text: '2. Enable the Drive API (Crucial!)' });
		const list2 = step2.createEl('ol');
		list2.createEl('li', { text: 'In the sidebar, go to "APIs & Services" > "Library".' });
		list2.createEl('li', { text: 'Search for "Google Drive API". Click it and click "Enable".' });
		list2.createEl('li', { text: '⚠️ If you don\'t enable this, you will get an error when adding scopes later.' });

		const step3 = contentEl.createEl('div', { cls: 'setup-step' });
		step3.createEl('h3', { text: '3. Configure Consent Screen' });
		const list3 = step3.createEl('ol');
		list3.createEl('li', { text: 'Go to "APIs & Services" > "OAuth consent screen".' });
		list3.createEl('li', { text: 'Select "External" and click "Create".' });
		list3.createEl('li', { text: 'Fill in: App Name (Obsidian Sync), User support email (yours), and Developer contact info (yours). Click "Save and Continue".' });
		list3.createEl('li', { text: 'In "Scopes", click "ADD OR REMOVE SCOPES".' });
		list3.createEl('li', { text: 'Scroll down to "Manually add scopes" and paste this EXACT string (Required for full sync!):' });
		step3.createEl('code', { text: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email', style: 'display: block; background: #222; padding: 10px; margin: 10px 0; border-radius: 4px; user-select: all; color: #00ff00; font-family: monospace; white-space: pre-wrap; word-break: break-all;' });
		list3.createEl('li', { text: 'Click "ADD TO TABLE", then click "UPDATE". Google WILL show a "Restricted" warning—this is necessary to sync files you didn\'t create with this plugin. Click "Save and Continue".' });
		list3.createEl('li', { text: '⚠️ In "Test users", click "ADD USERS" and add your own Gmail address. This is the ONLY way to log in while in testing mode.' });

		const step4 = contentEl.createEl('div', { cls: 'setup-step' });
		step4.createEl('h3', { text: '4. Get your Keys' });
		const list4 = step4.createEl('ol');
		list4.createEl('li', { text: 'Go to "APIs & Services" > "Credentials".' });
		list4.createEl('li', { text: 'Click "+ Create Credentials" > "OAuth client ID".' });
		list4.createEl('li', { text: 'Application type: "Web application". Name: "Obsidian Plugin".' });
		list4.createEl('li', { text: 'Authorized redirect URIs: Add "https://obsidian.md". Click "Create".' });
		list4.createEl('li', { text: 'Copy the "Client ID" and "Client Secret" into the Obsidian settings.' });

		const step5 = contentEl.createEl('div', { cls: 'setup-step' });
		step5.createEl('h3', { text: '5. Final Login' });
		const list5 = step5.createEl('ol');
		list5.createEl('li', { text: 'In Obsidian settings, click "Open Login Page".' });
		list5.createEl('li', { text: 'Log in and click "Allow". You will be redirected to obsidian.md.' });
		list5.createEl('li', { text: 'Look at the address bar. It will have "?code=4/0Af..." in the URL.' });
		list5.createEl('li', { text: 'Copy EVERYTHING after "code=" and BEFORE the next "&" (if there is one).' });
		list5.createEl('li', { text: 'Paste it into "Authorization Code" in Obsidian and click "Verify Code".' });

		contentEl.createEl('p', { text: '🎉 You are now ready to sync!', style: 'font-weight: bold; text-align: center; margin-top: 20px;' });
		
		const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		btnContainer.createEl('button', { text: 'Got it, let\'s go!', cls: 'mod-cta' }).onClickEvent(() => this.close());
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
