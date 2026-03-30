# Folder Structure Recreation & Google Drive Integration Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add two features to the Ergonode Batch Uploader: (1) automatically recreate nested folder structures in Ergonode when dropping folders, and (2) allow users to pick files from Google Drive and upload them to Ergonode preserving any nested folder structure.

**Architecture:** Both features share a common "folder-aware upload" pipeline. Files carry a `targetFolder` property (their resolved Ergonode destination path) instead of always using the globally selected folder. Folder creation is pre-flight — all required folders are created before uploads start.

**Tech Stack:** Tauri 2.x, Rust (reqwest, tokio), vanilla JS/HTML/CSS, Google OAuth 2.0 desktop flow, Google Drive REST API v3.

---

## Feature 1: Folder Structure Recreation

### Trigger
User drops a folder (or multiple folders) onto the drop zone. Currently the app only accepts files — this extends it to accept directories.

### Behavior

1. When a drop contains a directory, Rust recursively walks it collecting all files and their paths relative to the dropped folder root.
2. The relative paths are passed to the frontend alongside file metadata.
3. Before adding to the queue, a **confirmation dialog** is shown:
   - If destination is selected: *"This will create the full folder structure inside '[selected folder name]'. Continue?"*
   - If no destination selected (root): *"No folder selected. The folder structure will be created at the root of your Ergonode media library. Continue?"*
   - Dialog has **Cancel** and **Continue** buttons.
4. On confirm: the app computes the unique set of subfolders needed (sorted parent-first), creates them in Ergonode sequentially, then queues files each with their resolved `targetFolder`.
5. File list shows each file's relative subfolder path so the user sees where each file is going.
6. Upload proceeds through the existing queue — the only change is each file uses its own `targetFolder` instead of the global selected folder.

### Confirmation dialog design
- Modal overlay, simple card
- Title: "Create folder structure?"
- Body: shows destination path + a note about how many folders will be created and how many files will be uploaded
- Two buttons: Cancel / Continue

### Error handling
- If a subfolder already exists in Ergonode → treat as success (Ergonode returns a "folder already exists" error which we ignore for this flow)
- If a subfolder creation fails for any other reason → abort, show error, do not start uploads

---

## Feature 2: Google Drive Integration

### Auth flow (Google OAuth 2.0 desktop — PKCE not required for Picker flow)

1. User enters their **Google OAuth Client ID** once in Connection Settings (new field, persisted to config). They obtain this from Google Cloud Console (free, no payment needed). Instructions linked in UI.
2. User clicks **"From Google Drive"** button (shown in the workspace after connecting to Ergonode).
3. App generates a random local port, starts a one-shot HTTP listener in Rust on `http://127.0.0.1:{PORT}/callback`.
4. App opens system browser with OAuth URL:
   ```
   https://accounts.google.com/o/oauth2/v2/auth
     ?client_id=CLIENT_ID
     &scope=https://www.googleapis.com/auth/drive.file
     &redirect_uri=http://127.0.0.1:{PORT}/callback
     &response_type=code
     &access_type=offline
     &prompt=consent
     &trigger_onepick=true
     &allow_multiple=true
   ```
5. User picks files in browser (Google Picker UI). Browser redirects to callback with `?picked_file_ids=...&code=...`.
6. Rust listener captures the response, exchanges `code` for access token via Drive token endpoint.
7. Rust fetches file metadata (name, size, mimeType, parents) for each picked file ID using Drive API v3.
8. File list is sent to frontend for display. User can dequeue files. User clicks Upload All.
9. Rust downloads each file to OS temp dir (`std::env::temp_dir()`), then runs it through the normal upload pipeline.
10. Temp files are deleted after successful upload (failed files kept for retry, deleted on clear/disconnect).

### Folder structure from Google Drive
- When fetching file metadata, also fetch the full folder path of each file relative to the common ancestor of all selected files.
- If files come from multiple subfolders, the relative structure is preserved — same confirmation dialog as Feature 1.
- If all files are at the same level (no subfolders), no folder structure dialog — files go to selected destination directly.

### Google Client ID setup
- New field in Connection Settings: "Google Client ID" with a small "?" link to setup instructions.
- Persisted in the same config file as API URL and key.
- "From Google Drive" button is hidden/disabled if no Client ID is configured, with a tooltip "Set up Google Client ID in settings".

### Scope
- Only `drive.file` scope — this is the minimal scope for desktop Picker apps and the only one Google permits for this flow. It only grants access to files the user explicitly picks, not their entire Drive.

### Error handling
- OAuth timeout (user doesn't complete in 2 min) → cancel listener, show error
- Token exchange failure → show error message
- Download failure → file marked failed with error message, same as a normal upload failure
- Drive API quota errors → show friendly message

---

## Shared: Folder-Aware Upload Pipeline

Both features require files to carry their own target folder. Changes needed:

- File object gains optional `targetFolder` field (overrides global selected folder when set)
- `upload_file` Rust command already accepts `folder_path: Option<String>` — just pass per-file value
- Pre-flight folder creation: new `create_folders_batch` Rust command that takes a list of paths and creates them in order, returning a map of path → Ergonode folder ID
- Existing "folder already exists" error code (`54c25a35`) treated as success in batch creation

---

## UI Changes Summary

| Location | Change |
|---|---|
| Connection Settings | New "Google Client ID" input field |
| Connected bar / workspace | New "From Google Drive" button |
| Drop zone | Accepts folders (not just files) |
| Upload controls | Confirmation modal for folder structure |
| File list | Shows relative path for files with a targetFolder |
