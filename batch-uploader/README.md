# Ergonode Batch Uploader

A lightweight desktop app for bulk-uploading files to your Ergonode media library.

Built with [Tauri](https://tauri.app/) (Rust backend + vanilla HTML/CSS/JS frontend). No frameworks, no bloat — just a ~5MB native app.

## Features

- **Drag & drop** files or browse with native file picker
- **70+ supported file types** — images, videos, documents, 3D models, CAD, Adobe files, and more
- **Folder tree** browser — pick or create destination folders directly from your Ergonode instance
- **Rate limit handling** — respects Ergonode's 250 req/min media limit with automatic exponential backoff on 429 responses
- **Concurrent uploads** — up to 4 parallel uploads with dynamic concurrency adjustment
- **Progress tracking** — per-file status with real Ergonode error messages
- **Settings persistence** — remembers your API URL and key between sessions
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
6. Drag & drop your files and click **Upload All**

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

- **Backend**: Rust + Tauri 2.x + reqwest (multipart HTTP)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **API**: Ergonode GraphQL (`multimediaCreate` mutation, multipart POST)
- **Config**: JSON file in OS config directory

## License

See [LICENSE](../LICENSE) in the repository root.
