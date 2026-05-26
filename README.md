# Tether

Tether is a Google Drive sync plugin for Obsidian that keeps your vault structure in sync using your own Google Cloud project and Google account.

> Push during setup, pull when Obsidian opens, then push local changes back on the timer.

## Why Tether

Tether is built for people who want a self-managed sync workflow across desktop and mobile-compatible Obsidian setups without relying on shared credentials. It creates a dedicated folder for your vault in Google Drive, keeps the folder structure intact, and separates pull and push actions so each direction is predictable.

## Highlights

| Feature | What it means |
| --- | --- |
| Full-vault sync | Syncs notes, attachments, nested folders, and the `.obsidian` folder |
| Directional sync | Pull from Google Drive or push local changes with separate commands and sidebar buttons |
| Your own credentials | Uses your Google Cloud OAuth client instead of a shared backend |
| Mobile-friendly networking | Uses Obsidian's `requestUrl` API for Google OAuth and Drive requests |
| Built-in setup flow | Includes an in-app setup guide, login flow, folder picker, and sync status sidebar |
| Automatic syncing | Pulls on startup and pushes on the configured interval |

## How it works

1. Create your own Google Cloud OAuth app.
2. Use Tether's hosted setup pages for the OAuth homepage, privacy policy, terms, logo, and redirect URI.
3. Paste your client ID and client secret into Tether.
4. Sign in with Google from inside Obsidian.
5. Choose a Google Drive folder for Tether to use.
6. Tether creates a vault-named folder inside that Drive folder and keeps both sides in sync.

## Installation

### Community Plugins

Once Tether is approved in the Obsidian Community Plugins directory:

1. Open `Settings -> Community plugins`.
2. Select `Browse` and search for `Tether`.
3. Install the plugin and enable it.

### Manual installation

Until the community listing is live, you can install Tether manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create the folder `.obsidian/plugins/tether/` inside your vault.
3. Copy the three files into that folder.
4. Reload Obsidian.
5. Enable `Tether` under `Settings -> Community plugins`.

## Quick start

1. Open the Tether settings tab in Obsidian.
2. Select `Open Guide` if you want the in-app screenshot walkthrough.
3. Configure Google Cloud with the hosted Tether URLs listed in the guide.
4. Add your Google Cloud `Client ID` and `Client Secret`.
5. Select `Open Login Page`, sign in with Google, and paste the returned URL into `Authorization URL`.
6. Choose the Google Drive folder you want Tether to use.
7. Tether starts an initial push after folder selection. When Obsidian opens later, Tether pulls Drive changes first, and the interval timer pushes local changes.

> Important: if your Google Cloud OAuth app stays `External` + `Testing`, Google issues Drive refresh tokens that expire after 7 days. After confirming the setup works, move the OAuth app to `In production` in Google Cloud, then log in to Tether once more so Google issues a new refresh token. Tether can refresh normal access tokens automatically, but no local plugin can keep using a refresh token after Google expires or revokes it.

## iOS setup

If you already have Tether working on another device, the easiest iOS setup is to transfer the entire vault locally instead of configuring everything again on the phone or iPad.

1. From a device where Tether is already working, send or AirDrop the full vault to the iOS device.
2. Make sure the transfer includes the `.obsidian` folder so the plugin settings come with it.
3. In the Files app, move the vault into the Obsidian folder on the iOS device.
4. Open that vault in Obsidian.
5. Tether should continue from the existing setup. If Google asks you to authenticate again, open Tether settings and sign in again.

## Commands

- `Run Tether Push Sync`
- `Pull from Google Drive`
- `Push to Google Drive`
- `Open Sync Status Sidebar`

## Sync behavior

- Tether syncs Markdown notes, attachments, nested folders, and the `.obsidian` folder.
- Tether creates a dedicated vault folder inside the Google Drive folder you select.
- Initial setup pushes your local vault into the selected Google Drive folder.
- Startup sync pulls Google Drive changes when Obsidian opens, which helps devices catch up after being unused for days.
- After a plugin update, Tether also pulls Google Drive changes on load so the local vault matches the remote before interval pushes resume.
- Interval sync pushes local changes to Google Drive.
- Pull replaces local files with the Google Drive version, while deferring open or recently edited local files.
- Pull mirrors remote deletions locally; push mirrors local deletions to Google Drive.
- Pull now refuses to delete the local vault when the Drive vault root looks empty or completely mismatched. Push also refuses to delete every tracked remote item when the local vault looks empty or completely mismatched.
- If a startup/manual pull or manual push would delete most tracked files, Tether asks for confirmation before continuing. Background sync still pauses large deletion batches.
- Push updates existing Google Drive files so Drive keeps revisions instead of creating duplicate sibling files.
- Tether checks each Drive folder for duplicate same-name files, folds differing duplicate content into the chosen file's Drive revision history, then removes the extra Drive files.
- Tether excludes `.git`, `.trash`, and its own sync state file at `.obsidian/gdrive-sync.json`.

## Compatibility

- Minimum Obsidian version: `0.15.0`
- Plugin id: `tether`
- Manifest setting: `isDesktopOnly: false`
- Designed for desktop and mobile-compatible Obsidian environments.
- Sync and auth network calls use Obsidian's `requestUrl` API and avoid Node/Electron-only APIs in the mobile path.
- Sign-in opens Google in the system browser and redirects to Tether's GitHub Pages callback page. Copy the returned URL back into Obsidian to finish login.

## Privacy, security, and disclosures

- Tether requires a Google account and your own Google Cloud project.
- Tether does not ship with shared Google credentials.
- Tether connects to Google OAuth and Google Drive APIs.
- Tether requests these Google scopes: `https://www.googleapis.com/auth/drive`, `https://www.googleapis.com/auth/drive.metadata.readonly`, `openid`, and `email`.
- Tether stores your access token, refresh token, selected folder, and plugin settings in local Obsidian plugin data.
- Tether stores sync state in `.obsidian/gdrive-sync.json`.
- Tether reads and writes files in your vault, including `.obsidian`, in order to synchronize content.
- No ads, telemetry, or third-party analytics are used in the current plugin code.
- Tether is not affiliated with Google or Obsidian.

### Disclosures

- Plugin might make requests to 5 external domains: `accounts.google.com`, `oauth2.googleapis.com`, `llewellyn500.github.io`, `raw.githubusercontent.com`, and `www.googleapis.com`.
- Clipboard access: reads or writes the system clipboard, which may expose content the user copied from outside Obsidian.
- Found `atob()`/`btoa()` base64 calls (2 total), which may be used to obscure strings.
- Vault read: reads individual vault files via the Obsidian API (`vault.read`, `vault.cachedRead`).
- Vault write: creates or modifies vault files via the Obsidian API (`vault.modify`, `vault.create`, etc.).
- Malware scan not available.
- Obfuscation scan not available.
- Network requests scan not available.

## Full Google Cloud setup

Tether includes an in-app setup guide with screenshots. If you prefer a GitHub-readable version, expand the walkthrough below.

<details>
<summary>Open the full setup walkthrough</summary>

### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Select or create a project.
3. Create a new project named `Tether-Sync`.

### 2. Enable the Google Drive API

1. Open `APIs & Services`.
2. Open `Library`.
3. Search for `Google Drive API`.
4. Open it and select `Enable`.

### 3. Configure the OAuth consent screen

1. Open `OAuth consent screen`.
2. Select `Get started`.
3. Use `Tether` as the app name.
4. Choose your support email.
5. Select `External`.
6. Add your email under developer contact info.
7. Accept the Google API Services: User Data Policy and create the app.

### 4. Add Tether branding and app domain links

Use the hosted Tether support site for the values Google asks for during branding and OAuth setup:

```text
Homepage URL: https://llewellyn500.github.io/obsidian-tether/
Privacy Policy URL: https://llewellyn500.github.io/obsidian-tether/privacy.html
Terms of Service URL: https://llewellyn500.github.io/obsidian-tether/terms.html
Authorized Domain: llewellyn500.github.io
Logo URL: https://llewellyn500.github.io/obsidian-tether/assets/tether-google-cloud-logo.png
```

1. Open `Branding`.
2. Add the app homepage, privacy policy, and terms of service URLs.
3. Add `llewellyn500.github.io` under authorized domains if Google asks for an authorized domain.
4. Download the logo from the logo URL above and upload it as the app logo.
5. Save or publish the branding changes when Google allows it.

If Google requires a verified custom domain before full verification, you can still use these pages for setup while testing, then point a custom domain at the same GitHub Pages site later.

### 5. Add the required scopes

1. Open `Data Access`.
2. Select `Add or remove scopes`.
3. Add this scope string:

```text
https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email
```

4. Update and save.

### 6. Create an OAuth client

1. Open `Audience` and add your email as a test user.
2. Open `Clients` and select `Create client`.
3. Choose `Web application`.
4. Set the client name to `Tether Sync`.
5. Add this redirect URI:

```text
https://llewellyn500.github.io/obsidian-tether/oauth/callback.html
```

6. Create the client.
7. Copy the generated client ID and client secret into Tether.

### 7. Authenticate in Tether

1. Open Tether settings in Obsidian.
2. Select `Open Login Page`.
3. Sign in to Google.
4. When you are redirected to Tether's callback page, copy the full URL shown on the page.
5. Paste it into `Authorization URL`.
6. Select `Verify Login`.
7. After your first successful login, return to `Audience` in Google Cloud and publish the OAuth app to `In production` to avoid weekly re-logins. If it remains `External` + `Testing`, Google expires Drive refresh tokens after 7 days. After changing the publishing status, log in to Tether again so Google issues a fresh refresh token.

### 8. Choose a sync folder

1. Select `Select Folder`.
2. Pick an existing Google Drive folder or create a new one.
3. Tether will create a subfolder named after your vault inside that folder.

### Troubleshooting folder picker 403 errors

If login succeeds but `Select Folder` fails with `Google Drive API Error` or `status 403`, check these items in the same Google Cloud project that owns your OAuth client:

1. Open `APIs & Services` > `Library` and confirm `Google Drive API` is enabled.
2. Open `Google Auth Platform` > `Data Access` and confirm these scopes are added:

```text
https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email
```

3. If the OAuth app is still in `Testing`, open `Audience` and confirm the user's Google account is added as a test user.
4. If you changed scopes, test users, or API enablement after the user already logged in, have them log out of Tether and log in again before selecting a folder.
5. If this is a Google Workspace account, an admin policy may block third-party Drive apps until the app is allowed by the workspace admin.

</details>

## Support

If you run into a bug or want to request an improvement, open an issue in the repository used to publish this plugin.

## Author

Llewellyn Paintsil  
[GitHub profile](https://github.com/Llewellyn500)

## License

MIT
