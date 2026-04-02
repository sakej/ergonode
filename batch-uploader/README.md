# Ergonode Batch Uploader

A lightweight desktop app for bulk-uploading files to your Ergonode media library.

> **Disclaimer:** This is not an official Ergonode product. It's a personal tool I built and decided to share.

Built with [Tauri](https://tauri.app/) (Rust backend + vanilla HTML/CSS/JS frontend). No frameworks, no bloat — just a ~6MB native app.

### Highlights

- **Bulk upload** — drag & drop files or entire folders; handles rate limits and retries automatically
- **Google Drive import** — browse Drive folders in-app, pick files, upload straight to Ergonode
- **Folder structure recreation** — drop a folder and recreate its directory tree in Ergonode
- **Revert upload** — undo the last batch with one click (files and/or folders)
- **53 file types** — images, videos, documents, 3D models, CAD, Adobe, spreadsheets, archives
- **Secure credentials** — API keys and OAuth tokens stored in OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- **Cross-platform** — Windows, macOS, Linux

## Features

- **Drag & drop** files or folders — browse with native file picker
- **Google Drive import** — pick files directly from Google Drive, download and upload to Ergonode
- **Folder structure recreation** — drop a folder and recreate its tree in Ergonode automatically
- **Upload options** — flat upload (no subfolders) and include root folder toggles
- **Revert upload** — undo the last upload batch (delete files and/or folders) with batched GraphQL mutations
- **53 supported file types** — images, videos, documents, 3D models, CAD, Adobe files, and more
- **Folder tree** browser — pick or create destination folders directly from your Ergonode instance
- **Rate limit handling** — respects Ergonode's 250 req/min media limit with automatic exponential backoff on 429 responses
- **Concurrent uploads** — up to 4 parallel uploads with dynamic concurrency adjustment; **single connection** toggle to limit to 1 at a time
- **Progress tracking** — per-file status with real Ergonode error messages
- **Google Drive sign-out** — revoke OAuth token and remove from keychain from the connected bar
- **Credential storage** — API URL, API key, Google credentials, and OAuth tokens stored as a single blob in OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) with encrypted file fallback; prompted to save on first connect
- **Settings persistence** — remembers upload preferences between sessions
- **Stop & resume** — cancel uploads mid-flight, retry failed files
- **Cross-platform** — Windows 10+, macOS, Linux

## Supported File Types

| Category | Extensions |
|---|---|
| 3D / CAD | 3ds, dwf, dwg, dxf, fbx, glb, obj, skp, stp, igs, plt, hpgl |
| Vector Graphics | ai, eps, svg, cdr |
| Raster Images | bmp, gif, jpeg, jpg, png, tif, tiff, webp, avif, heic, hdr |
| Video / Animation | mkv, mov, mp4, webm, wmv, hevc |
| Documents | doc, docx, odt, pdf, txt |
| Spreadsheets | csv, ods, xls, xlsx |
| Presentations | ppt, pptx, key |
| Adobe / Design | psd, indd, indt |
| Special Packages | ggpkg |
| Archives | zip |
| 3D Scenes | max, usdz, vrm |

## Requirements

- An Ergonode instance with API access
- An API key with **"Allow to write"** privilege

## Quick Start

1. Download the latest release for your OS from [Releases](https://github.com/sakej/ergonode/releases)
2. Install and open the app
3. Enter your Ergonode instance URL and API key
4. Click **Connect**
5. Select a destination folder (or create a new one)
6. Drag & drop files/folders, browse, or click **import from Google Drive**
7. When dropping folders, a confirmation modal lets you choose:
   - **Flat upload** — skip subfolder creation, upload all files to destination
   - **Include root folder** — create the dropped folder as a parent in Ergonode
8. After uploading, click **Revert Upload** to undo (delete uploaded files and/or created folders)

> **Note:** Google Drive import requires a Client ID — see [Google Drive Setup](#google-drive-setup) below.

## Installation Notes

### Windows: SmartScreen warning

This build is not code-signed. Windows SmartScreen may show a warning when running the installer.

Click **More info** → **Run anyway**

Or: right-click the `.msi`/`.exe` → Properties → check **Unblock** → Apply

### macOS: "damaged and can't be opened"

macOS Gatekeeper blocks apps that aren't signed with an Apple Developer certificate. To open the app after installing:

**Option A** — Terminal:
```sh
xattr -cr /Applications/"Ergonode Batch Uploader.app"
```

**Option B** — Right-click the app → Open → Open Anyway

**Option C** — System Settings → Privacy & Security → "Open Anyway"

## Google Drive Setup

Google Drive import is optional. Without a Client ID, the app works normally — the Drive link is replaced by a **Set up Google Drive** link in the drop zone, where you can enter credentials at runtime without rebuilding.

### Creating your own Client ID

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Enable the **Google Drive API**:
   - Navigate to **APIs & Services** → **Library**
   - Search for "Google Drive API" → click **Enable**
4. Configure the **OAuth consent screen**:
   - Go to **APIs & Services** → **OAuth consent screen**
   - Choose **Internal** user type (if available — requires Google Workspace; otherwise choose **External**)
   - Fill in the required fields (app name, support email)
   - Add scope: `https://www.googleapis.com/auth/drive.file`
5. Create **OAuth credentials**:
   - Go to **APIs & Services** → **Credentials**
   - Click **Create Credentials** → **OAuth client ID**
   - Application type: **Desktop app**
   - Name it anything (e.g. "Ergonode Batch Uploader")
   - Click **Create** and copy the **Client ID**

### Using your Client ID

**Option A — Runtime entry (no rebuild needed):**
Enter your Client ID and Client Secret in the **Connection Settings** card before connecting, or click **Set up Google Drive** in the drop zone after connecting. Either way, credentials are saved to the OS keychain alongside your other credentials.

**Option B — Compile-time embed:**
Create a `.env` file in the `batch-uploader/` directory:

```
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret-here
```

Then build or run the app — both values are embedded at compile time. Runtime credentials take priority over compile-time values.

> **Testing mode:** While your Google Cloud project is in "Testing" status, only users listed as test users can authorize. This is fine for personal use.

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.70+
- Platform-specific Tauri dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Build

```bash
cd batch-uploader
npm install
npm run tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

To include Google Drive support, create a `.env` file first (see [Google Drive Setup](#google-drive-setup)).

### Development

```bash
npm run tauri dev
```

## Ergonode API Constraints

The app respects these Ergonode API limits:

| Constraint | Limit |
|---|---|
| Media requests | 250/min |
| Other requests | 500/min |
| Max concurrent connections | 6 |
| Max file size | 100 MB |

On receiving a 429 (Too Many Requests), the app pauses with exponential backoff (5s, 10s, 20s, 40s, 60s cap) and reduces concurrency. After 10 consecutive successes, concurrency is gradually restored.

## Tech Stack

- **Backend**: Rust + Tauri 2.x + reqwest (multipart HTTP) + google-drive3 SDK + keyring (OS credential store)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **API**: Ergonode GraphQL (`multimediaCreate` mutation, multipart POST), Google Drive API v3
- **Config**: JSON file in OS config directory (non-sensitive settings), OS keychain for all credentials (unified blob: API key, Google client credentials, OAuth tokens)

## License

See [LICENSE](../LICENSE) in the repository root.
