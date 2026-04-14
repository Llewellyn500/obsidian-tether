import { App, Modal } from 'obsidian';

export class SetupGuideModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gdrive-setup-modal');
		
		contentEl.createEl('h2', { text: '🚀 Google Drive Sync: Full Setup Guide' });
		contentEl.createEl('p', { text: 'Follow these 57 steps to configure your Google Cloud project correctly. This ensures full vault sync (including hidden folders) works perfectly.' });

		const stepsContainer = contentEl.createDiv({ cls: 'setup-steps-scroll' });
		stepsContainer.setAttr('style', 'max-height: 70vh; overflow-y: auto; padding-right: 10px; margin-bottom: 20px;');

		const steps = [
			"Navigate to \'https://console.cloud.google.com/\"",
			"Click \"Select a project\"",
			"Click \"New project\"",
			"Type \"Tether-Sync\"",
			"Click \"Create\"",
			"Click \"APIs & Services\"",
			"Click \"Library\"",
			"Click the \"Search for APIs & Services\" field.",
			"Type \"Google drive\"",
			"Click \"google drive api\"",
			"Click \"Google Drive API\"",
			"Click \"Enable\"",
			"Click \"OAuth consent screen\"",
			"Click \"Get started\"",
			"Click the \"App name\" field.",
			"Type \"Tether-Sync\"",
			"Click User Support email.",
			"Click your email address from the dropdown.",
			"Click \"Next\"",
			"Click \"External\"",
			"Click \"Next\"",
			"Click \"Email addresses\" (under Developer contact info).",
			"Click \"Next\"",
			"Click the \"I agree to the Google API Services: User Data Policy.\" field.",
			"Click \"Continue\"",
			"Click \"Create\"",
			"Click \"Data Access\"",
			"Click \"Add or remove scopes\"",
			"Manually add the following scope string: https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email",
			"Press ctrl + c to copy the scope string above.",
			"Click the \"Manually add scopes\" field.",
			"Press ctrl + v to paste the scope string.",
			"Click \"Add to table\"",
			"Click \"Update\"",
			"Click \"Save\"",
			"Click \"Audience\"",
			"Click \"Add users\"",
			"Add your own Gmail address as a test user.",
			"Click \"Save\"",
			"Click \"Clients\"",
			"Click \"Create client\"",
			"Click the \"Application type\" dropdown.",
			"Click \"Web application\"",
			"Click the \"Name\" field.",
			"Press ctrl + a to select existing name.",
			"Type \"Tether Sync\"",
			"Under \"Authorized redirect URIs\", add: https://obsidian.md",
			"Press ctrl + c to copy the redirect URI.",
			"Switch back to the Google Cloud tab.",
			"Click the \"Add URI\" button.",
			"Click the \"URIs 1\" field.",
			"Press ctrl + v to paste the redirect URI.",
			"Click \"Create\"",
			"Copy the \"Client ID\" and paste it into Tether settings.",
			"Copy the \"Client Secret\" and paste it into Tether settings.",
			"Click \"OK\""
		];

		steps.forEach((stepText, index) => {
			const stepDiv = stepsContainer.createDiv({ cls: 'setup-step' });
			stepDiv.setAttr('style', 'margin-bottom: 30px; border-bottom: 1px solid #333; padding-bottom: 20px;');
			
			stepDiv.createEl('h3', { text: `Step ${index + 1}` });
			stepDiv.createEl('p', { text: stepText });
			
			const img = stepDiv.createEl('img');
			img.setAttr('src', `images/step-${index + 1}.png`);
			img.setAttr('alt', `Screenshot for Step ${index + 1}`);
			img.setAttr('style', 'max-width: 100%; border: 1px solid #444; border-radius: 4px; display: block; margin-top: 10px; min-height: 50px; background: #222;');
			
			// If scope string step, highlight the string
			if (index === 29) {
				const code = stepDiv.createEl('code', { 
					text: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email' 
				});
				code.setAttr('style', 'display: block; background: #111; padding: 10px; margin-top: 10px; color: #4caf50; word-break: break-all;');
			}
		});

		const finalStep = stepsContainer.createDiv({ cls: 'setup-step' });
		finalStep.createEl('h3', { text: 'Final Step: Login' });
		const list = finalStep.createEl('ol');
		list.createEl('li', { text: 'Go back to Tether settings and click "Open Login Page".' });
		list.createEl('li', { text: 'Log in and you will be redirected to obsidian.md.' });
		list.createEl('li', { text: 'Copy the entire URL from the browser bar and paste it into the "Authorization Code" box in Obsidian.' });

		const readyText = contentEl.createEl('p', { text: '🎉 You are ready to go!' });
		readyText.setAttr('style', 'font-weight: bold; text-align: center;');
		
		const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		btnContainer.createEl('button', { text: 'Got it, let\'s go!', cls: 'mod-cta' }).onClickEvent(() => this.close());
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
