# Tether

Tether is a Google Drive sync plugin for Obsidian that keeps your vault structure in sync using your own Google Cloud project and Google account.

> Sync notes, attachments, nested folders, and `.obsidian` settings to Google Drive while keeping conflicts visible instead of silently overwriting files.

## Why Tether

Tether is built for people who want a self-managed sync workflow across desktop and mobile-compatible Obsidian setups without relying on shared credentials. It creates a dedicated folder for your vault in Google Drive, keeps the folder structure intact, and helps you review conflicts instead of losing data.

## Highlights

| Feature | What it means |
| --- | --- |
| Full-vault sync | Syncs notes, attachments, nested folders, and the `.obsidian` folder |
| Conflict-safe behavior | Creates timestamped conflict copies so both versions are preserved |
| Your own credentials | Uses your Google Cloud OAuth client instead of a shared backend |
| Mobile-friendly networking | Uses Obsidian's `requestUrl` API for Google OAuth and Drive requests |
| Built-in setup flow | Includes an in-app setup guide, login flow, folder picker, and sync status sidebar |
| Automatic syncing | Supports sync on startup and interval-based background sync |

## How it works

1. Create your own Google Cloud OAuth app.
2. Paste your client ID and client secret into Tether.
3. Sign in with Google from inside Obsidian.
4. Choose a Google Drive folder for Tether to use.
5. Tether creates a vault-named folder inside that Drive folder and keeps both sides in sync.

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
3. Add your Google Cloud `Client ID` and `Client Secret`.
4. Select `Open Login Page`, sign in with Google, and paste the returned URL into `Authorization URL`.
5. Choose the Google Drive folder you want Tether to use.
6. Run `Sync with Google Drive`.

## iOS setup

If you already have Tether working on another device, the easiest iOS setup is to transfer the entire vault locally instead of configuring everything again on the phone or iPad.

1. From a device where Tether is already working, send or AirDrop the full vault to the iOS device.
2. Make sure the transfer includes the `.obsidian` folder so the plugin settings come with it.
3. In the Files app, move the vault into the Obsidian folder on the iOS device.
4. Open that vault in Obsidian.
5. Tether should continue from the existing setup. If Google asks you to authenticate again, open Tether settings and sign in again.

## Commands

- `Sync with Google Drive`
- `Open Sync Status Sidebar`

## Sync behavior

- Tether syncs Markdown notes, attachments, nested folders, and the `.obsidian` folder.
- Tether creates a dedicated vault folder inside the Google Drive folder you select.
- Local deletions are mirrored to Google Drive.
- Remote deletions are mirrored back to your vault.
- If both local and remote versions changed, Tether keeps both by creating a timestamped conflict copy.
- Tether excludes `.git`, `.trash`, and its own sync state file at `.obsidian/gdrive-sync.json`.

## Compatibility

- Minimum Obsidian version: `0.15.0`
- Plugin id: `tether`
- Manifest setting: `isDesktopOnly: false`
- Designed for desktop and mobile-compatible Obsidian environments

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
3. Use `Tether-Sync` as the app name.
4. Choose your support email.
5. Select `External`.
6. Add your email under developer contact info.
7. Accept the Google API Services: User Data Policy and create the app.

### 4. Add the required scopes

1. Open `Data Access`.
2. Select `Add or remove scopes`.
3. Add this scope string:

```text
https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email
```

4. Update and save.

### 5. Create an OAuth client

1. Open `Audience` and add your email as a test user.
2. Open `Clients` and select `Create client`.
3. Choose `Web application`.
4. Set the client name to `Tether Sync`.
5. Add this redirect URI:

```text
https://obsidian.md
```

6. Create the client.
7. Copy the generated client ID and client secret into Tether.

### 6. Authenticate in Tether

1. Open Tether settings in Obsidian.
2. Select `Open Login Page`.
3. Sign in to Google.
4. When you are redirected to `obsidian.md`, copy the full URL or just the `code=` value.
5. Paste it into `Authorization URL`.
6. Select `Verify Login`.

### 7. Choose a sync folder

1. Select `Select Folder`.
2. Pick an existing Google Drive folder or create a new one.
3. Tether will create a subfolder named after your vault inside that folder.

</details>

## Support

If you run into a bug or want to request an improvement, open an issue in the repository used to publish this plugin.

## Author

Llewellyn Paintsil  
[GitHub profile](https://github.com/Llewellyn500)

## License

MIT
