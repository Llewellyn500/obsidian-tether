# Tether

A simple, structure-aware Google Drive sync engine for Obsidian, developed by **Llewellyn Paintsil**. Tether provides a seamless way to keep your entire vault—including settings, themes, and complex folder hierarchies—perfectly synced between your local device (Android/Desktop) and Google Drive using your own Google Cloud project so you control your data.

## 🌟 Key Features

### 📱 Full Android & Desktop Compatibility

Built specifically to bypass the limitations of mobile devices. Tether uses Obsidian's native `requestUrl` API to handle large network requests and file operations without triggering CORS errors or memory crashes on Android.

### 📁 Exhaustive Vault Structure Sync

- **Hidden Folders:** Syncs the `.obsidian` folder, ensuring your plugins, themes, hotkeys, and CSS snippets are identical across all devices.
- **Deep Nesting:** Supports vaults with complex sub-folder structures.
- **Vault Root Isolation:** Creates a dedicated folder named after your vault inside your chosen Google Drive directory.

### 🚀 Performance & Reliability

- **Resumable Uploads:** Uses Google's resumable upload protocol to handle files of any size with zero file size limits.
- **Auto-Pagination:** Correctly handles large vaults by automatically paginating through Google Drive API results.
- **Background Sync:** Automatically checks for updates on startup and at configurable intervals.

### 🛡️ Data Safety & Conflict Resolution

- **Keep Both Strategy:** If a file is edited on two devices simultaneously, Tether creates a `(conflict - timestamp)` copy. It **never** overwrites your local data during a conflict.
- **Mirror Deletions:** If you delete a file locally, it is automatically removed from Google Drive on the next sync.
- **Conflict Management:** View and open conflicted files directly from the sync sidebar to resolve them manually.

---

## 🛠️ Installation

1.  **Locate Plugin Folder:** Open your vault folder and navigate to `.obsidian/plugins/`.
2.  **Create Directory:** Create a folder named `tether-google-drive-sync`.
3.  **Transfer Files:** Copy the following 3 files from this project into that new folder:
    - `main.js`
    - `manifest.json`
    - `styles.css`
4.  **Enable Plugin:** Open Obsidian, go to `Settings > Community Plugins`, click the Refresh icon, and toggle **Tether** to ON.

---

## 🚀 Step-by-Step Setup Guide

Tether includes a **Setup Wizard** in the settings tab to guide you through these steps:

### Step 1: Create Google Cloud Credentials (Google Cloud Console)

1.  Go to [Google Cloud Console](https://console.cloud.google.com/)
    ![Step 1](images/step-1.png)

2.  Click **"Select a project"**
    ![Step 2](images/step-2.png)

3.  Click **"New project"**
    ![Step 3](images/step-3.png)

4.  In the project name field, type **"Tether-Sync"**
    ![Step 4](images/step-4.png)

5.  Click **"Create"** button.
    ![Step 5](images/step-5.png)

6.  Click **"APIs & Services"**
    ![Step 6](images/step-6.png)

7.  Click **"Library"**
    ![Step 8](images/step-8.png)
9.  Click the **"Search for APIs & Services"** field.
    ![Step 9](images/step-9.png)
10. Type **"Google drive"**
    ![Step 10](images/step-10.png)
11. Click **"google drive api"**
    ![Step 11](images/step-11.png)
12. Click **"Google Drive API"**
    ![Step 12](images/step-12.png)
13. Click **"Enable"**
    ![Step 13](images/step-13.png)
14. Click **"OAuth consent screen"**
    ![Step 14](images/step-14.png)
15. Click **"Get started"**
    ![Step 15](images/step-15.png)
16. Click the **"App name"** field.
    ![Step 16](images/step-16.png)
17. Type **"Tether-Sync"**
    ![Step 17](images/step-17.png)
18. Click **User Support email**.
    ![Step 18](images/step-18.png)
19. Click **"your-email@gmail.com"**
    ![Step 19](images/step-19.png)
20. Click **"Next"**
    ![Step 20](images/step-20.png)
21. Click **"External"**
    ![Step 21](images/step-21.png)
22. Click **"Next"**
    ![Step 22](images/step-22.png)
23. Click **"Email addresses"** (Developer contact info)
    ![Step 23](images/step-23.png)
24. Click **"Next"**
    ![Step 24](images/step-24.png)
25. Click the **"I agree to the Google API Services: User Data Policy."** field.
    ![Step 25](images/step-25.png)
26. Click **"Continue"**
    ![Step 26](images/step-26.png)
27. Click **"Create"**
    ![Step 27](images/step-27.png)
28. Click **"Data Access"**
    ![Step 28](images/step-28.png)
29. Click **"Add or remove scopes"**
    ![Step 29](images/step-29.png)
30. Click the scope string: `https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata.readonly openid email`
    ![Step 30](images/step-30.png)
31. Press **Ctrl + C** to copy it.
    ![Step 31](images/step-31.png)
32. Click the **"Manually add scopes"** field.
    ![Step 32](images/step-32.png)
33. Press **Ctrl + V** to paste the string.
    ![Step 33](images/step-33.png)
34. Click **"Add to table"**
    ![Step 34](images/step-34.png)
35. Click **"Update"**
    ![Step 35](images/step-35.png)
36. Click **"Save"**
    ![Step 36](images/step-36.png)
37. Click **"Audience"**
    ![Step 37](images/step-37.png)
38. Click **"Add users"**
    ![Step 38](images/step-38.png)
39. Click the field to add your email.
    ![Step 39](images/step-39.png)
40. Click **"Save"**
    ![Step 40](images/step-40.png)
41. Click **"Clients"**
    ![Step 41](images/step-41.png)
42. Click **"Create client"**
    ![Step 42](images/step-42.png)
43. Click the **"Application type"** dropdown.
    ![Step 43](images/step-43.png)
44. Click **"Web application"**
    ![Step 44](images/step-44.png)
45. Click the **"Name"** field.
    ![Step 45](images/step-45.png)
46. Press **Ctrl + A** to select all.
    ![Step 46](images/step-46.png)
47. Type **"Tether Sync"**
    ![Step 47](images/step-47.png)
48. Click the redirect URI: `https://obsidian.md`
    ![Step 48](images/step-48.png)
49. Press **Ctrl + C** to copy it.
    ![Step 49](images/step-49.png)
50. Switch back to the **"Create OAuth client ID"** tab.
    ![Step 50](images/step-50.png)
51. Click the **"Add URI"** icon.
    ![Step 51](images/step-51.png)
52. Click the **"URIs 1"** field.
    ![Step 52](images/step-52.png)
53. Press **Ctrl + V** to paste the URI.
    ![Step 53](images/step-53.png)
54. Click **"Create"**
    ![Step 54](images/step-54.png)
55. Click the **"Copy Client ID"** icon.
    ![Step 55](images/step-55.png)
56. Click the **"Copy Client Secret"** icon.
    ![Step 56](images/step-56.png)
57. Click **"OK"** and paste these keys into Tether's settings.
    ![Step 57](images/step-57.png)

### Step 2: Authentication

1.  In Obsidian settings for Tether, click **"Open Login Page"**.
2.  Log in with your Google account.
3.  You will be redirected to `obsidian.md`. **Copy the entire URL** from your browser bar.
4.  Paste that URL into the **"Authorization Code"** box in Obsidian and click **Verify Code**.

### Step 3: Choose Folder

1.  Click **"Select Drive Folder"**.
2.  Browse your Google Drive hierarchy.
3.  Either select an existing folder or create a new one.
4.  Click **"Select This Folder"** to begin syncing.

---

## 🔗 Author

**Llewellyn Paintsil**

- GitHub: [@Llewellyn500](https://github.com/Llewellyn500)
- Project Repo: [Tether](https://github.com/Llewellyn500/tether)

## 📄 License

This project is licensed under the MIT License.
