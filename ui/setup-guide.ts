import { App, Modal } from 'obsidian';

interface SetupStep {
	text: string;
	image?: string;
	codeBlock?: string;
}

const SETUP_GUIDE_IMAGE_BASE_URL = 'https://raw.githubusercontent.com/Llewellyn500/obsidian-tether/main/images';

function getSetupGuideImageUrl(imageName: string): string {
	return `${SETUP_GUIDE_IMAGE_BASE_URL}/${imageName}.png`;
}

export class SetupGuideModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gdrive-setup-modal');

		// ── Header ──
		contentEl.createEl('h2', { text: '🚀 Tether: Full Setup Guide' });
		const subtitle = contentEl.createEl('p', {
			text: 'Follow these steps to configure your Google Cloud project. This ensures full vault sync (including hidden folders) works perfectly.'
		});
		subtitle.setAttr('style', 'opacity: 0.8; margin-bottom: 16px;');

		const stepsContainer = contentEl.createDiv({ cls: 'setup-steps-scroll' });
		stepsContainer.setAttr('style', 'max-height: 70vh; overflow-y: auto; padding-right: 10px; margin-bottom: 20px;');

		// ── Steps matching README exactly ──
		// image values map to the README step-numbered screenshot filenames
		const steps: SetupStep[] = [
			{ text: 'Go to Google Cloud Console', image: 'step-1' },
			{ text: 'Click "Select a project"', image: 'step-2' },
			{ text: 'Click "New project"', image: 'step-3' },
			{ text: 'In the project name field, type "Tether-Sync"', image: 'step-4' },
			{ text: 'Click "Create"', image: 'step-5' },
			{ text: 'Click "APIs & Services"', image: 'step-6' },
			{ text: 'Click "Library"', image: 'step-7' },
			{ text: 'Click the "Search for APIs & Services" field.', image: 'step-8' },
			{ text: 'Type "Google drive"' },
			{ text: 'Click "google drive api"', image: 'step-10' },
			{ text: 'Click "Google Drive API"', image: 'step-11' },
			{ text: 'Click "Enable"', image: 'step-12' },
			{ text: 'Click "OAuth consent screen"', image: 'step-13' },
			{ text: 'Click "Get started"', image: 'step-14' },
			{ text: 'Click the "App name" field.', image: 'step-15' },
			{ text: 'Type "Tether-Sync"' },
			{ text: 'Click User Support email.', image: 'step-17' },
			{ text: 'Click your email address from the dropdown.' },
			{ text: 'Click "External"', image: 'step-19' },
			{ text: 'Pick the developer\'s "Email address" (Developer contact info)', image: 'step-20' },
			{ text: 'Click the "I agree to the Google API Services: User Data Policy." field.' },
			{ text: 'Click "Create"', image: 'step-22' },
			{ text: 'Click "Data Access"', image: 'step-23' },
			{ text: 'Click "Add or remove scopes"', image: 'step-24' },
			{
				text: 'Copy the scope string below:',
				codeBlock: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email'
			},
			{ text: 'Paste the string in the "Manually add scopes" field.', image: 'step-26' },
			{ text: 'Click "Add to table"', image: 'step-27' },
			{ text: 'Click "Update"', image: 'step-28' },
			{ text: 'Click "Save"', image: 'step-29' },
			{ text: 'Click "Audience"', image: 'step-30' },
			{ text: 'Click "Add users"', image: 'step-31' },
			{ text: 'Add your email as a user.' },
			{ text: 'Click "Clients"', image: 'step-33' },
			{ text: 'Click "Create client"', image: 'step-34' },
			{ text: 'Choose "Web application" as the application type.', image: 'step-35' },
			{ text: 'Type "Tether Sync" in the "Name" field.', image: 'step-36' },
			{
				text: 'Copy the redirect URI below:',
				codeBlock: 'https://obsidian.md'
			},
			{ text: 'Click the "Add URI" icon.', image: 'step-38' },
			{ text: 'Paste the redirect URI in the "URIs 1" field.', image: 'step-39' },
			{ text: 'Click "Create"' },
			{ text: 'Copy the Client ID and paste it in Tether\'s settings.' },
			{ text: 'Copy the Client Secret and paste it in Tether\'s settings.', image: 'step-42' },
		];

		steps.forEach((step, index) => {
			const stepDiv = stepsContainer.createDiv({ cls: 'setup-step' });
			stepDiv.setAttr('style', 'margin-bottom: 24px; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 20px;');

			// Step number badge + text
			const headerEl = stepDiv.createEl('div');
			headerEl.setAttr('style', 'display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px;');

			const badge = headerEl.createEl('span', { text: `${index + 1}` });
			badge.setAttr('style',
				'display: inline-flex; align-items: center; justify-content: center; ' +
				'min-width: 28px; height: 28px; border-radius: 50%; ' +
				'background: var(--interactive-accent); color: var(--text-on-accent); ' +
				'font-weight: 700; font-size: 13px; flex-shrink: 0;'
			);

			const textEl = headerEl.createEl('span', { text: step.text });
			textEl.setAttr('style', 'font-size: 15px; line-height: 1.5;');

			// Code block (scope string / redirect URI)
			if (step.codeBlock) {
				const codeWrapper = stepDiv.createEl('div');
				codeWrapper.setAttr('style',
					'position: relative; margin-top: 8px; border-radius: 6px; overflow: hidden;'
				);
				const code = codeWrapper.createEl('code', { text: step.codeBlock });
				code.setAttr('style',
					'display: block; background: var(--code-background); ' +
					'padding: 12px 14px; color: var(--code-normal); ' +
					'font-size: 13px; word-break: break-all; border-radius: 6px; ' +
					'border: 1px solid var(--background-modifier-border); ' +
					'font-family: var(--font-monospace); user-select: all; cursor: text;'
				);
			}

			// Screenshot image (only if available)
			if (step.image) {
				const img = stepDiv.createEl('img');
				img.setAttr('src', getSetupGuideImageUrl(step.image));
				img.setAttr('alt', `Screenshot for Step ${index + 1}`);
				img.setAttr('loading', 'lazy');
				img.setAttr('style',
					'max-width: 100%; border: 1px solid var(--background-modifier-border); ' +
					'border-radius: 6px; display: block; margin-top: 10px; ' +
					'min-height: 40px; background: var(--background-secondary);'
				);
			}
		});

		// ── Final Step: Login ──
		const finalStep = stepsContainer.createDiv({ cls: 'setup-step' });
		finalStep.setAttr('style', 'margin-bottom: 24px; padding-bottom: 20px;');

		const finalHeader = finalStep.createEl('h3', { text: '🔐 Final Step: Authentication' });
		finalHeader.setAttr('style', 'margin-top: 8px; margin-bottom: 12px;');

		const loginSteps = [
			'In Obsidian settings for Tether, click "Open Login Page".',
			'Log in with your Google account.',
			'You will be redirected to obsidian.md. Copy the entire URL from your browser bar.',
			'Paste that URL into the "Authorization URL" box in Obsidian and click Verify Login.'
		];
		const list = finalStep.createEl('ol');
		list.setAttr('style', 'padding-left: 22px; line-height: 1.8;');
		loginSteps.forEach(text => {
			list.createEl('li', { text });
		});

		// ── Ready banner ──
		const readyBanner = contentEl.createEl('div');
		readyBanner.setAttr('style',
			'text-align: center; padding: 12px; margin-bottom: 8px; ' +
			'border-radius: 8px; background: var(--background-secondary);'
		);
		readyBanner.createEl('span', { text: '🎉 You are ready to go!' }).setAttr('style', 'font-weight: 700; font-size: 16px;');

		// ── Close button ──
		const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		btnContainer.createEl('button', { text: 'Got it, let\'s go!', cls: 'mod-cta' }).onClickEvent(() => this.close());
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

