# Ergonode Batch Image Uploader — Design

## Overview

A lightweight desktop app for non-technical Ergonode customers to bulk-upload images to their Ergonode media library. Built with Tauri (Rust backend + HTML/CSS/JS frontend). Distributed as a downloadable executable for Windows (primary), macOS, and Linux.

## Target Users

Non-technical Ergonode customers who need to upload many images at once. Must be dead simple: download, run, configure API credentials, drag files, done.

## Architecture

- **Tauri (Rust)** backend handles all Ergonode API communication (bypasses CORS), file I/O, config persistence, and folder tree fetching.
- **Frontend** is a single-page HTML/CSS/JS UI — no framework. Communicates with Rust via Tauri's IPC (`invoke`).
- **Build target**: Tauri bundles into native installers (.msi/.exe for Windows, .dmg for macOS, .AppImage for Linux). Requires Windows 10+ (WebView2).

## Ergonode API Details

- **Endpoint**: `{instance_url}/api/graphql/`
- **Auth**: `X-API-KEY` header
- **Upload mutation**: `multimediaCreate` — multipart POST with `upload` (file binary) and `query` (GraphQL mutation string)
- **Folder tree**: fetched via GraphQL query on connect
- **Folder creation**: via GraphQL mutation
- **Rate limits**: 250 req/min for media, 500 req/min for other, max 6 concurrent connections
- **Max file size**: 100MB per file

## UI Design

Single screen with three zones: settings, folder picker, and upload area.

```
+---------------------------------------------+
|  Settings                        Ergonode    |
|  +---------------------------------------+   |
|  | API URL: [https://my.ergonode.com   ] |   |
|  | API Key: [************] (eye) [Clear] |   |
|  +---------------------------------------+   |
|                                              |
|  +- Folder ---------------------+            |
|  | / (root)                     |            |
|  | +-- Products                 |            |
|  |     +-- Electronics          |            |
|  |     +-- Clothing             |            |
|  | +-- Banners                  |            |
|  | +-- Blog                     |            |
|  |                              |            |
|  | [+ New Folder]  Selected: /  |            |
|  +------------------------------+            |
|                                              |
|  + - - - - - - - - - - - - - - - - - - -+   |
|  |                                       |   |
|  |     Drag & drop files here            |   |
|  |        or click to browse             |   |
|  |                                       |   |
|  + - - - - - - - - - - - - - - - - - - -+   |
|                                              |
|  file1.jpg  ========--  80%  done            |
|  file2.png  ======----  60%                  |
|  file3.webp ----------  queued               |
|  bigfile.tif  ! Exceeds 100MB - skipped      |
|                                              |
|  [Upload All]              3/5 complete      |
+---------------------------------------------+
```

### Settings Zone
- API URL and API Key fields, saved to local config
- Eye icon to toggle key visibility
- "Clear saved settings" button wipes stored credentials
- On valid credentials: folder tree loads automatically (doubles as connection test)

### Folder Picker
- Interactive collapsible tree fetched from Ergonode instance
- Click to select destination folder
- "New Folder" button: inline text input to create subfolder in selected location
- Refreshable via button

### Upload Zone
- Drag-and-drop area + click-to-browse file picker
- Pre-upload validation: files > 100MB flagged and skipped immediately
- Per-file progress bar with states: queued, uploading, done, failed
- Failed files get a retry button (no auto-retry)
- Summary counter: "X/Y complete"

## Rate Limiting & Concurrency

### Proactive
- Max 4 concurrent uploads (under the 6-connection limit, leaves headroom for folder queries)
- Internal counter tracking requests per minute

### Reactive (429 handling)
Since Ergonode does not send `Retry-After` headers:
1. On 429: pause entire queue immediately
2. Exponential backoff: 5s -> 10s -> 20s -> 40s -> 60s (cap)
3. Show user: "Ergonode is busy, resuming in Xs..."
4. Re-queue the failed file at the front of the queue
5. Reduce concurrency by 1 (minimum 1)
6. Restore concurrency gradually after 10 consecutive successes

No upload is ever lost — all failures are retryable.

## Error Handling

| Scenario              | Behavior                                              |
|-----------------------|-------------------------------------------------------|
| File > 100MB          | Flagged before upload, skipped with warning            |
| Network error         | File marked failed, retry button shown                 |
| Invalid API key       | Clear error message, prompt to check settings          |
| 429 rate limited      | Auto-pause, exponential backoff, notify user, resume   |
| Ergonode unreachable  | Connection test on credentials entry, warn before upload |
| Invalid folder        | Folder tree refresh, notify user                       |

## Config Storage

Stored via Tauri's `app_data_dir` in `config.json`:
- Windows: `%APPDATA%/ergonode-uploader/config.json`
- macOS: `~/Library/Application Support/ergonode-uploader/config.json`
- Linux: `~/.config/ergonode-uploader/config.json`

Contents: `{ apiUrl, apiKey, folderPath }`. "Clear settings" button deletes the file.

## Tech Stack Summary

| Layer     | Technology                    |
|-----------|-------------------------------|
| Desktop   | Tauri 2.x                     |
| Backend   | Rust (reqwest for HTTP)        |
| Frontend  | Vanilla HTML/CSS/JS            |
| Build     | Tauri CLI, cross-platform      |
| Config    | JSON file in OS app data dir   |
