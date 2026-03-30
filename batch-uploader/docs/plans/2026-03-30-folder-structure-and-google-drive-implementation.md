# Folder Structure Recreation & Google Drive Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add recursive folder structure recreation (drop a folder → recreate its tree in Ergonode) and Google Drive file picker integration (OAuth2 → pick files → download to temp → upload to Ergonode preserving folder structure).

**Architecture:** Both features share a folder-aware upload pipeline where each file carries its own `targetFolder` (overriding the global selected folder). Folder creation is pre-flight — all needed subfolders are created in Ergonode before uploads start. Google Drive files are downloaded to OS temp dir first, then uploaded through the existing queue.

**Tech Stack:** Tauri 2.x, Rust (reqwest, tokio, std::fs), vanilla JS/HTML/CSS, Google OAuth 2.0 authorization code flow (desktop app type), Google Drive REST API v3.

---

## Existing codebase context

Key files (read before implementing):
- `batch-uploader/src-tauri/src/lib.rs` — Tauri commands registry
- `batch-uploader/src-tauri/src/ergonode.rs` — `ErgonodeClient` with `create_folder`, `upload_file`
- `batch-uploader/src-tauri/src/config.rs` — `AppConfig` struct, load/save/clear
- `batch-uploader/src-tauri/Cargo.toml` — current deps: tauri 2, reqwest 0.12 (multipart+json), tokio full, serde, dirs, mime_guess
- `batch-uploader/ui/app.js` — `state.files` array with `{id, name, path, status, error}`, `pumpQueue()`, `uploadSingleFile()` uses `state.selectedFolder`
- `batch-uploader/ui/index.html` — drop zone, upload controls, settings card
- `batch-uploader/ui/styles.css` — existing design tokens (--accent, --green, --red, --border, etc.)

Error code to remember: `54c25a35-59da-4215-aa61-997bb80d303f` = "Folder already exists" — treat as success in batch folder creation.

---

## Task 1: Rust — scan_directory command

Adds a Tauri command that recursively walks a directory and returns all files with their paths relative to the dropped root.

**Files:**
- Create: `batch-uploader/src-tauri/src/fs_utils.rs`
- Modify: `batch-uploader/src-tauri/src/lib.rs`

**Step 1: Create fs_utils.rs**

```rust
// batch-uploader/src-tauri/src/fs_utils.rs
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone)]
pub struct ScannedFile {
    pub name: String,
    pub absolute_path: String,
    /// Path relative to the dropped folder root, e.g. "winter/photos/img.jpg"
    /// Empty string if the file is directly in the dropped folder (no subfolder).
    pub relative_dir: String,
}

/// Recursively walk `dir`, returning all files.
/// `root` is the originally dropped directory (used to compute relative paths).
pub fn scan_dir(dir: &Path, root: &Path) -> Result<Vec<ScannedFile>, String> {
    let mut results = Vec::new();
    scan_recursive(dir, root, &mut results)?;
    Ok(results)
}

fn scan_recursive(dir: &Path, root: &Path, results: &mut Vec<ScannedFile>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read directory {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // Skip hidden files/dirs (starting with .)
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false)
        {
            continue;
        }

        if path.is_dir() {
            scan_recursive(&path, root, results)?;
        } else if path.is_file() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // relative_dir: path of the containing folder relative to root
            let containing_dir = path.parent().unwrap_or(root);
            let relative_dir = containing_dir
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default()
                .to_string();

            results.push(ScannedFile {
                name,
                absolute_path: path.to_string_lossy().to_string(),
                relative_dir,
            });
        }
    }

    Ok(())
}
```

**Step 2: Add scan_directory command to lib.rs**

Add `mod fs_utils;` at the top and add this command:

```rust
#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<fs_utils::ScannedFile>, String> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(format!("{} is not a directory", path));
    }
    fs_utils::scan_dir(p, p)
}
```

Register in `invoke_handler!`:
```rust
load_settings, save_settings, clear_settings,
test_connection, fetch_folders, create_folder, upload_file, get_file_size,
scan_directory
```

**Step 3: Build to verify**

```bash
cd batch-uploader
npx tauri build --debug 2>&1 | grep -E "error|warning.*unused" | head -20
```
Expected: no errors (warnings about unused `extract_gql_error` are pre-existing and fine).

**Step 4: Commit**

```bash
git add batch-uploader/src-tauri/src/fs_utils.rs batch-uploader/src-tauri/src/lib.rs
git commit -m "feat: add scan_directory Rust command for recursive folder walk"
```

---

## Task 2: Rust — create_folders_batch command

Adds a command that creates a list of subfolder paths in Ergonode in order (parent before child), treating "already exists" as success.

**Files:**
- Modify: `batch-uploader/src-tauri/src/ergonode.rs`
- Modify: `batch-uploader/src-tauri/src/lib.rs`

**Step 1: Add create_folders_batch to ErgonodeClient in ergonode.rs**

Add after `create_folder`:

```rust
/// Create multiple folders in order. "Already exists" errors are treated as success.
/// `base_path` is the currently selected Ergonode folder (None = root).
/// `relative_paths` is a list like ["winter", "winter/photos", "summer"].
/// Returns Ok(()) if all folders were created or already exist.
pub async fn create_folders_batch(
    &self,
    base_path: Option<&str>,
    relative_paths: &[String],
) -> Result<(), String> {
    // Sort by depth (parents first)
    let mut sorted = relative_paths.to_vec();
    sorted.sort_by_key(|p| p.chars().filter(|&c| c == '/').count());
    sorted.dedup();

    for rel_path in &sorted {
        // Build the full Ergonode path: base_path + "/" + rel_path
        let full_path = match base_path {
            Some(b) if !b.is_empty() => format!("{b}/{rel_path}"),
            _ => rel_path.clone(),
        };

        // Split into parent path and folder name
        let (parent, name) = if let Some(idx) = full_path.rfind('/') {
            (Some(&full_path[..idx]), &full_path[idx + 1..])
        } else {
            (None, full_path.as_str())
        };

        match self.create_folder(name, parent).await {
            Ok(_) => {}
            Err(e) => {
                // "Folder already exists" UUID — treat as success
                if e.contains("54c25a35") {
                    continue;
                }
                return Err(format!("Failed to create folder '{full_path}': {e}"));
            }
        }
    }

    Ok(())
}
```

**Step 2: Add Tauri command to lib.rs**

```rust
#[tauri::command]
async fn create_folders_batch(
    api_url: String,
    api_key: String,
    base_path: Option<String>,
    relative_paths: Vec<String>,
) -> Result<(), String> {
    let client = ErgonodeClient::new(&api_url, &api_key);
    client
        .create_folders_batch(base_path.as_deref(), &relative_paths)
        .await
}
```

Register in `invoke_handler!`:
```rust
load_settings, save_settings, clear_settings,
test_connection, fetch_folders, create_folder, upload_file, get_file_size,
scan_directory, create_folders_batch
```

**Step 3: Build to verify**

```bash
cd batch-uploader
npx tauri build --debug 2>&1 | grep "^error" | head -10
```
Expected: no errors.

**Step 4: Commit**

```bash
git add batch-uploader/src-tauri/src/ergonode.rs batch-uploader/src-tauri/src/lib.rs
git commit -m "feat: add create_folders_batch Rust command"
```

---

## Task 3: JS — per-file targetFolder in upload pipeline

Extends the file object with `targetFolder` so each file can upload to a different Ergonode folder. Updates the upload call to use it.

**Files:**
- Modify: `batch-uploader/ui/app.js`

**Step 1: Add targetFolder to file objects in addFilesByPath**

In `addFilesByPath`, change the file object creation:

```js
const file = {
  id: state.nextFileId++,
  name: fileName,
  path: filePath,
  status: "queued",
  error: null,
  targetFolder: null,   // null = use state.selectedFolder
  relativeDir: "",      // "" = no subfolder, shown in file list
};
```

**Step 2: Update uploadSingleFile to use file.targetFolder**

In `uploadSingleFile`, change the invoke call:

```js
const result = await invoke("upload_file", {
  apiUrl: state.apiUrl,
  apiKey: state.apiKey,
  filePath: file.path,
  fileName: file.name,
  folderPath: file.targetFolder !== null ? file.targetFolder : state.selectedFolder,
});
```

**Step 3: Show relative path in file list when set**

In `renderFileList`, in the file name element section, after setting `nameEl.textContent = file.name`:

```js
if (file.relativeDir) {
  const pathEl = document.createElement("span");
  pathEl.className = "file-relative-dir";
  pathEl.textContent = file.relativeDir + "/";
  pathEl.title = file.relativeDir + "/" + file.name;
  row.insertBefore(pathEl, nameEl);
}
```

**Step 4: Add CSS for file-relative-dir**

In `styles.css`, after `.file-name`:

```css
.file-relative-dir {
  font-size: 10px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80px;
  flex-shrink: 0;
}
```

**Step 5: Test manually**

Run `npm run tauri dev`. Add files normally. Verify existing upload still works (targetFolder=null falls through to selectedFolder).

**Step 6: Commit**

```bash
git add batch-uploader/ui/app.js batch-uploader/ui/styles.css
git commit -m "feat: per-file targetFolder in upload pipeline"
```

---

## Task 4: HTML/CSS — folder structure confirmation modal

Adds the confirmation modal shown before creating folder structure in Ergonode.

**Files:**
- Modify: `batch-uploader/ui/index.html`
- Modify: `batch-uploader/ui/styles.css`

**Step 1: Add modal HTML**

Add before the closing `</div>` of `#app` (before `<script>`):

```html
<!-- Folder Structure Confirmation Modal -->
<div id="folder-modal" class="modal-overlay hidden">
  <div class="modal-card">
    <h3 class="modal-title">Create folder structure?</h3>
    <p id="folder-modal-body" class="modal-body"></p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="folder-modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="folder-modal-continue">Continue</button>
    </div>
  </div>
</div>
```

**Step 2: Add modal CSS**

Add to end of `styles.css`:

```css
/* ---------- Modal ---------- */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-overlay.hidden {
  display: none;
}

.modal-card {
  background: var(--surface);
  border-radius: 12px;
  padding: 24px;
  max-width: 380px;
  width: calc(100% - 40px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 10px;
  color: var(--text-primary);
}

.modal-body {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 20px;
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
```

**Step 3: Wire modal in app.js**

Add DOM refs near the other refs:

```js
const folderModal       = $("#folder-modal");
const folderModalBody   = $("#folder-modal-body");
const folderModalCancel = $("#folder-modal-cancel");
const folderModalContinue = $("#folder-modal-continue");
```

Add a helper function:

```js
// Returns a Promise<boolean> — true if user clicked Continue, false if Cancel
function showFolderModal(message) {
  return new Promise((resolve) => {
    folderModalBody.textContent = message;
    folderModal.classList.remove("hidden");

    const onContinue = () => {
      folderModal.classList.add("hidden");
      folderModalCancel.removeEventListener("click", onCancel);
      resolve(true);
    };
    const onCancel = () => {
      folderModal.classList.add("hidden");
      folderModalContinue.removeEventListener("click", onContinue);
      resolve(false);
    };

    folderModalContinue.addEventListener("click", onContinue, { once: true });
    folderModalCancel.addEventListener("click", onCancel, { once: true });
  });
}
```

**Step 4: Commit**

```bash
git add batch-uploader/ui/index.html batch-uploader/ui/styles.css batch-uploader/ui/app.js
git commit -m "feat: add folder structure confirmation modal"
```

---

## Task 5: JS — drop zone handles dropped folders

Extends the drag-drop handler to detect directories, scan them, show the confirmation modal, create folders in Ergonode, then queue files with targetFolder set.

**Files:**
- Modify: `batch-uploader/ui/app.js`

**Step 1: Add addFoldersByPath function**

Add after `addFilesByPath`:

```js
async function addFoldersByPath(dirPaths) {
  // Scan all dropped directories
  let allScanned = [];
  for (const dirPath of dirPaths) {
    try {
      const scanned = await invoke("scan_directory", { path: dirPath });
      allScanned = allScanned.concat(scanned);
    } catch (err) {
      showStatus(connStatus, "Failed to read folder: " + err, "error");
      return;
    }
  }

  if (allScanned.length === 0) return;

  // Collect unique relative subfolder paths (non-empty)
  const subfolders = [...new Set(
    allScanned
      .map(f => f.relative_dir)
      .filter(d => d.length > 0)
  )];

  // Compute display destination
  const destName = state.selectedFolder
    ? state.selectedFolder.split("/").pop()
    : "root";

  // Build modal message
  let msg;
  if (!state.selectedFolder) {
    msg = `No folder selected. This will create the folder structure at the root of your Ergonode media library.\n\n${allScanned.length} file(s)`;
    if (subfolders.length > 0) msg += ` across ${subfolders.length} subfolder(s)`;
    msg += ` will be uploaded.`;
  } else {
    msg = `This will create the folder structure inside "${destName}".`;
    if (subfolders.length > 0) msg += `\n\n${subfolders.length} subfolder(s) and `;
    else msg += `\n\n`;
    msg += `${allScanned.length} file(s) will be uploaded.`;
  }

  const confirmed = await showFolderModal(msg);
  if (!confirmed) return;

  // Create folders in Ergonode pre-flight
  if (subfolders.length > 0) {
    try {
      await invoke("create_folders_batch", {
        apiUrl: state.apiUrl,
        apiKey: state.apiKey,
        basePath: state.selectedFolder || null,
        relativePaths: subfolders,
      });
    } catch (err) {
      showStatus(connStatus, "Failed to create folders: " + err, "error");
      return;
    }
  }

  // Queue files with targetFolder
  for (const scanned of allScanned) {
    if (state.files.some(f => f.path === scanned.absolute_path)) continue;

    // Resolve full Ergonode folder path for this file
    let targetFolder = null;
    if (scanned.relative_dir) {
      targetFolder = state.selectedFolder
        ? state.selectedFolder + "/" + scanned.relative_dir
        : scanned.relative_dir;
    } else {
      targetFolder = state.selectedFolder || null;
    }

    const file = {
      id: state.nextFileId++,
      name: scanned.name,
      path: scanned.absolute_path,
      status: "queued",
      error: null,
      targetFolder,
      relativeDir: scanned.relative_dir,
    };

    // Check file size
    try {
      const size = await invoke("get_file_size", { path: scanned.absolute_path });
      if (size > MAX_FILE_SIZE) {
        file.status = "skipped";
        file.error = "File exceeds 100 MB limit";
      }
    } catch (err) {
      file.status = "skipped";
      file.error = "Cannot read file: " + err;
    }

    state.files.push(file);
  }

  renderFileList();
  uploadControls.classList.remove("hidden");
  dropZone.classList.add("hidden");
}
```

**Step 2: Update the Tauri drag-drop listener to route directories**

Find the existing `listen("tauri://drag-drop", ...)` handler in `setupDragDrop`. Replace it:

```js
listen("tauri://drag-drop", async (event) => {
  dropZone.classList.remove("drag-over");
  const paths = event.payload.paths || event.payload;
  if (!Array.isArray(paths) || paths.length === 0) return;

  // Separate files from directories
  const dirs = [];
  const files = [];
  for (const p of paths) {
    try {
      const size = await invoke("get_file_size", { path: p });
      // get_file_size succeeds for files, fails for dirs
      files.push(p);
    } catch (_) {
      dirs.push(p);
    }
  }

  if (dirs.length > 0) {
    await addFoldersByPath(dirs);
  }
  if (files.length > 0) {
    await addFilesByPath(files);
  }
});
```

Note: `get_file_size` returns an error for directories (metadata().len() on a dir is OS-dependent but the Rust impl will succeed — so use a different approach). Actually `std::fs::metadata` works for both files and dirs. We need a dedicated `is_directory` command.

**Step 3: Add is_directory Rust command**

In `lib.rs`, add:

```rust
#[tauri::command]
fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}
```

Register: add `is_directory` to `invoke_handler!`.

**Step 4: Update drag-drop to use is_directory**

Replace the try/catch detection with:

```js
listen("tauri://drag-drop", async (event) => {
  dropZone.classList.remove("drag-over");
  const paths = event.payload.paths || event.payload;
  if (!Array.isArray(paths) || paths.length === 0) return;

  const dirs = [];
  const files = [];
  for (const p of paths) {
    const isDir = await invoke("is_directory", { path: p });
    if (isDir) dirs.push(p);
    else files.push(p);
  }

  if (dirs.length > 0) await addFoldersByPath(dirs);
  if (files.length > 0) await addFilesByPath(files);
});
```

**Step 5: Build and test**

```bash
cd batch-uploader && npx tauri dev
```

Test: drop a folder with subfolders. Verify modal appears with correct message. Click Continue. Verify files are queued with relativeDir shown. Upload and verify files land in correct Ergonode folders.

**Step 6: Commit**

```bash
git add batch-uploader/src-tauri/src/lib.rs batch-uploader/ui/app.js
git commit -m "feat: handle dropped folders with recursive structure recreation"
```

---

## Task 6: Config + UI — Google Client ID field

Adds `google_client_id` to the persisted config and a new input field in Connection Settings.

**Files:**
- Modify: `batch-uploader/src-tauri/src/config.rs`
- Modify: `batch-uploader/src-tauri/src/lib.rs`
- Modify: `batch-uploader/ui/index.html`
- Modify: `batch-uploader/ui/app.js`

**Step 1: Add google_client_id to AppConfig**

In `config.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub folder_path: Option<String>,
    #[serde(default)]
    pub google_client_id: Option<String>,
}
```

**Step 2: Update save_settings command in lib.rs**

```rust
#[tauri::command]
fn save_settings(
    api_url: String,
    api_key: String,
    folder_path: Option<String>,
    google_client_id: Option<String>,
) -> Result<(), String> {
    let cfg = AppConfig { api_url, api_key, folder_path, google_client_id };
    config::save_config(&cfg)
}
```

**Step 3: Add Google Client ID input to index.html**

In the settings card, after the API Key field and before the button row:

```html
<div class="form-group">
  <label for="google-client-id">
    Google Client ID
    <span class="label-hint">(<a href="https://console.cloud.google.com/apis/credentials" target="_blank" class="label-link">get one free</a> — optional, for Drive import)</span>
  </label>
  <input type="text" id="google-client-id" placeholder="xxxx.apps.googleusercontent.com">
</div>
```

**Step 4: Add "From Google Drive" button to workspace**

In `index.html`, inside `#workspace`, after the connected bar area, add a button to the folder card header or as a standalone row. Add it in the `#files-card` section, inside `#upload-controls .button-row`:

```html
<button class="btn btn-ghost" id="btn-google-drive" title="Import files from Google Drive">From Google Drive</button>
```

Place it before the "Upload All" button.

**Step 5: Wire in app.js**

Add DOM refs:
```js
const googleClientIdInput = $("#google-client-id");
const btnGoogleDrive      = $("#btn-google-drive");
```

In `init()`, after loading settings:
```js
if (settings.google_client_id) googleClientIdInput.value = settings.google_client_id;
```

Update `state` to include:
```js
googleClientId: "",
```

In `handleConnect`, after setting `state.apiUrl` and `state.apiKey`:
```js
state.googleClientId = googleClientIdInput.value.trim();
```

Update the `save_settings` invoke to include `googleClientId`:
```js
await invoke("save_settings", {
  apiUrl,
  apiKey,
  folderPath: state.selectedFolder,
  googleClientId: state.googleClientId || null,
});
```

Show/hide the Google Drive button based on whether client ID is set:
```js
if (state.googleClientId) {
  btnGoogleDrive.classList.remove("hidden");
} else {
  btnGoogleDrive.classList.add("hidden");
}
```

Also add `hidden` class to the button in HTML by default, and add the event listener in `bindEvents`:
```js
btnGoogleDrive.addEventListener("click", handleGoogleDrivePicker);
```

**Step 6: Add CSS for label-link**

In `styles.css`:
```css
.label-link {
  color: var(--accent);
  text-decoration: none;
}
.label-link:hover {
  text-decoration: underline;
}
```

**Step 7: Update all other save_settings calls in app.js**

Find all `invoke("save_settings", ...)` calls (there are two: in `handleConnect` and in the folder selection click handler). Add `googleClientId: state.googleClientId || null` to both.

**Step 8: Build and test**

Run `npm run tauri dev`. Enter a Google Client ID in settings, connect. Verify it persists after restart. Verify "From Google Drive" button appears only when client ID is set.

**Step 9: Commit**

```bash
git add batch-uploader/src-tauri/src/config.rs batch-uploader/src-tauri/src/lib.rs \
        batch-uploader/ui/index.html batch-uploader/ui/app.js batch-uploader/ui/styles.css
git commit -m "feat: add Google Client ID config field and From Google Drive button"
```

---

## Task 7: Rust — Google Drive OAuth listener and token exchange

Implements the one-shot local HTTP server that catches the OAuth callback and exchanges the code for an access token.

**Files:**
- Create: `batch-uploader/src-tauri/src/google_drive.rs`
- Modify: `batch-uploader/src-tauri/Cargo.toml`
- Modify: `batch-uploader/src-tauri/src/lib.rs`

**Step 1: Add `open` crate to Cargo.toml**

```toml
open = "5"
```

**Step 2: Create google_drive.rs**

```rust
// batch-uploader/src-tauri/src/google_drive.rs
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriveFileInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    /// Relative folder path within the picked set, e.g. "winter/photos"
    /// Empty string = file is at the top level of the selection.
    pub relative_dir: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

/// Full OAuth2 + Drive Picker flow.
/// Opens browser, waits for callback (2 min timeout), exchanges code,
/// fetches metadata for picked files, resolves relative folder paths.
pub async fn open_picker_and_get_files(
    client_id: &str,
) -> Result<Vec<DriveFileInfo>, String> {
    // Bind to a random available port
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Cannot bind local port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
         ?client_id={client_id}\
         &scope=https://www.googleapis.com/auth/drive.file\
         &redirect_uri={redirect_uri}\
         &response_type=code\
         &access_type=offline\
         &prompt=consent\
         &trigger_onepick=true\
         &allow_multiple=true"
    );

    // Open browser
    open::that(&auth_url).map_err(|e| format!("Cannot open browser: {e}"))?;

    // Wait up to 2 minutes for callback
    let (mut stream, _) = timeout(Duration::from_secs(120), listener.accept())
        .await
        .map_err(|_| "Timed out waiting for Google authorization (2 min limit)".to_string())?
        .map_err(|e| format!("Connection error: {e}"))?;

    // Read HTTP request
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();

    // Send success response to browser
    let html_response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:sans-serif;padding:40px'>\
        <h2>✓ Authorization complete</h2>\
        <p>You can close this tab and return to Ergonode Batch Uploader.</p>\
        </body></html>";
    let _ = stream.write_all(html_response.as_bytes()).await;

    // Parse query string from "GET /callback?..." line
    let params = parse_query_from_request(&request)?;

    let code = params
        .get("code")
        .ok_or("No authorization code in callback")?
        .clone();

    let picked_ids_raw = params
        .get("picked_file_ids")
        .ok_or("No file IDs in callback — did you select files?")?
        .clone();

    let file_ids: Vec<String> = picked_ids_raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if file_ids.is_empty() {
        return Err("No files were selected".to_string());
    }

    // Exchange code for access token
    let access_token = exchange_code(client_id, &code, &redirect_uri).await?;

    // Fetch metadata for all files
    let files = fetch_files_metadata(&access_token, &file_ids).await?;

    Ok(files)
}

fn parse_query_from_request(request: &str) -> Result<HashMap<String, String>, String> {
    // First line: "GET /callback?foo=bar&... HTTP/1.1"
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");

    let query = if let Some(idx) = path.find('?') {
        &path[idx + 1..]
    } else {
        return Ok(HashMap::new());
    };

    let mut params = HashMap::new();
    for part in query.split('&') {
        if let Some(idx) = part.find('=') {
            let key = urlencoding_decode(&part[..idx]);
            let val = urlencoding_decode(&part[idx + 1..]);
            params.insert(key, val);
        }
    }
    Ok(params)
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            if let Ok(byte) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

async fn exchange_code(
    client_id: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let params = [
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];

    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange network error: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {body}"));
    }

    let token: TokenResponse = resp.json().await.map_err(|e| format!("Token parse error: {e}"))?;
    Ok(token.access_token)
}

async fn fetch_files_metadata(
    access_token: &str,
    file_ids: &[String],
) -> Result<Vec<DriveFileInfo>, String> {
    let client = reqwest::Client::new();
    let mut files = Vec::new();

    // Cache folder id -> name to avoid redundant requests
    let mut folder_cache: HashMap<String, String> = HashMap::new();

    for id in file_ids {
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{id}?fields=id,name,size,mimeType,parents"
        );
        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| format!("Drive API error for {id}: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Drive API returned error for {id}: {body}"));
        }

        let meta: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Drive metadata parse error: {e}"))?;

        let name = meta["name"].as_str().unwrap_or("unknown").to_string();
        let size = meta["size"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let mime_type = meta["mimeType"].as_str().unwrap_or("application/octet-stream").to_string();

        // Resolve parent folder chain to get relative_dir
        let relative_dir = if let Some(parents) = meta["parents"].as_array() {
            if let Some(parent_id) = parents.first().and_then(|p| p.as_str()) {
                resolve_folder_path(access_token, parent_id, &client, &mut folder_cache).await
                    .unwrap_or_default()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        files.push(DriveFileInfo {
            id: id.clone(),
            name,
            size,
            mime_type,
            relative_dir,
        });
    }

    // Normalize relative_dirs: strip common prefix
    // (so if all files are under "My Drive/campaign/winter", relative_dir = "" or "photos", etc.)
    normalize_relative_dirs(&mut files);

    Ok(files)
}

/// Walk parent chain up to 5 levels deep, building a path string like "campaign/winter"
async fn resolve_folder_path(
    access_token: &str,
    folder_id: &str,
    client: &reqwest::Client,
    cache: &mut HashMap<String, String>,
) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current_id = folder_id.to_string();

    for _ in 0..5 {
        if current_id == "root" || current_id.is_empty() {
            break;
        }

        if let Some(cached) = cache.get(&current_id) {
            parts.push(cached.clone());
            break;
        }

        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{current_id}?fields=id,name,parents"
        );
        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| format!("Folder metadata error: {e}"))?;

        if !resp.status().is_success() {
            break;
        }

        let meta: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let name = meta["name"].as_str().unwrap_or("").to_string();
        cache.insert(current_id.clone(), name.clone());
        parts.push(name);

        current_id = meta["parents"]
            .as_array()
            .and_then(|p| p.first())
            .and_then(|p| p.as_str())
            .unwrap_or("root")
            .to_string();
    }

    parts.reverse();
    Ok(parts.join("/"))
}

/// Strip the common folder prefix from all files so relative_dir is truly relative.
fn normalize_relative_dirs(files: &mut Vec<DriveFileInfo>) {
    if files.is_empty() {
        return;
    }

    // Find common prefix segments
    let paths: Vec<Vec<&str>> = files
        .iter()
        .map(|f| f.relative_dir.split('/').filter(|s| !s.is_empty()).collect())
        .collect();

    let min_len = paths.iter().map(|p| p.len()).min().unwrap_or(0);
    let mut common_len = 0;
    for i in 0..min_len {
        if paths.iter().all(|p| p[i] == paths[0][i]) {
            common_len += 1;
        } else {
            break;
        }
    }

    // Strip common prefix
    for file in files.iter_mut() {
        let parts: Vec<&str> = file
            .relative_dir
            .split('/')
            .filter(|s| !s.is_empty())
            .skip(common_len)
            .collect();
        file.relative_dir = parts.join("/");
    }
}
```

**Step 3: Add mod and Tauri command in lib.rs**

Add `mod google_drive;` at the top.

Add command:

```rust
#[tauri::command]
async fn open_google_drive_picker(client_id: String) -> Result<Vec<google_drive::DriveFileInfo>, String> {
    google_drive::open_picker_and_get_files(&client_id).await
}
```

Register: add `open_google_drive_picker` to `invoke_handler!`.

**Step 4: Build**

```bash
cd batch-uploader && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -20
```
Expected: no errors.

**Step 5: Commit**

```bash
git add batch-uploader/src-tauri/src/google_drive.rs batch-uploader/src-tauri/src/lib.rs \
        batch-uploader/src-tauri/Cargo.toml batch-uploader/src-tauri/Cargo.lock
git commit -m "feat: Google Drive OAuth listener and file metadata resolution"
```

---

## Task 8: Rust — Drive file download + temp file cleanup

Adds commands to download a Drive file to temp dir and delete temp files.

**Files:**
- Modify: `batch-uploader/src-tauri/src/google_drive.rs`
- Modify: `batch-uploader/src-tauri/src/lib.rs`

**Step 1: Add download_drive_file to google_drive.rs**

```rust
/// Download a Drive file to OS temp directory.
/// Returns the absolute path of the downloaded temp file.
pub async fn download_drive_file(
    access_token: &str,
    file_id: &str,
    file_name: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    );

    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Drive download error: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Drive download failed: {body}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download read error: {e}"))?;

    // Write to temp dir: /tmp/ergonode_drive_{file_id}_{file_name}
    let safe_name = file_name.replace(['/', '\\', ':'], "_");
    let temp_path = std::env::temp_dir().join(format!("ergonode_drive_{file_id}_{safe_name}"));
    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| format!("Cannot write temp file: {e}"))?;

    Ok(temp_path.to_string_lossy().to_string())
}

/// Delete a temp file (silently ignore if not found).
pub fn delete_temp_file(path: &str) {
    let _ = std::fs::remove_file(path);
}
```

**Step 2: Add Tauri commands in lib.rs**

```rust
#[tauri::command]
async fn download_drive_file(
    access_token: String,
    file_id: String,
    file_name: String,
) -> Result<String, String> {
    google_drive::download_drive_file(&access_token, &file_id, &file_name).await
}

#[tauri::command]
fn delete_temp_file(path: String) -> Result<(), String> {
    google_drive::delete_temp_file(&path);
    Ok(())
}
```

Register both in `invoke_handler!`.

**Step 3: Build**

```bash
cd batch-uploader && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -10
```

**Step 4: Commit**

```bash
git add batch-uploader/src-tauri/src/google_drive.rs batch-uploader/src-tauri/src/lib.rs
git commit -m "feat: Drive file download to temp dir and temp file cleanup"
```

---

## Task 9: JS — Google Drive full flow

Wires the "From Google Drive" button to the full picker flow: OAuth → file list → folder confirmation → download → upload queue.

**Files:**
- Modify: `batch-uploader/ui/app.js`

The flow needs an access token in state so downloads can reference it. Add to state:

```js
driveAccessToken: null,
```

**Step 1: Add handleGoogleDrivePicker function**

```js
async function handleGoogleDrivePicker() {
  if (!state.googleClientId) return;

  btnGoogleDrive.disabled = true;
  btnGoogleDrive.textContent = "Connecting to Drive...";

  let driveFiles;
  try {
    driveFiles = await invoke("open_google_drive_picker", {
      clientId: state.googleClientId,
    });
  } catch (err) {
    showStatus(connStatus, "Google Drive error: " + err, "error");
    btnGoogleDrive.disabled = false;
    btnGoogleDrive.textContent = "From Google Drive";
    return;
  }

  btnGoogleDrive.disabled = false;
  btnGoogleDrive.textContent = "From Google Drive";

  if (!driveFiles || driveFiles.length === 0) return;

  // Store access token returned with file list
  // NOTE: open_google_drive_picker returns DriveFileInfo[] — we need access token too.
  // See Step 2 for updated return type.
  const token = driveFiles._accessToken;

  // Separate files with subfolders
  const subfolders = [...new Set(
    driveFiles.map(f => f.relative_dir).filter(d => d.length > 0)
  )];

  // Show confirmation if there are subfolders
  if (subfolders.length > 0) {
    const destName = state.selectedFolder
      ? state.selectedFolder.split("/").pop()
      : "root";
    const msg = `This will create the folder structure inside "${destName}" from your Google Drive selection.\n\n${driveFiles.length} file(s) across ${subfolders.length} subfolder(s) will be downloaded and uploaded.`;
    const confirmed = await showFolderModal(msg);
    if (!confirmed) return;

    // Create folders in Ergonode
    try {
      await invoke("create_folders_batch", {
        apiUrl: state.apiUrl,
        apiKey: state.apiKey,
        basePath: state.selectedFolder || null,
        relativePaths: subfolders,
      });
    } catch (err) {
      showStatus(connStatus, "Failed to create folders: " + err, "error");
      return;
    }
  }

  // Queue each Drive file
  for (const driveFile of driveFiles) {
    if (driveFile.size > MAX_FILE_SIZE) {
      state.files.push({
        id: state.nextFileId++,
        name: driveFile.name,
        path: "",
        status: "skipped",
        error: "File exceeds 100 MB limit",
        targetFolder: null,
        relativeDir: driveFile.relative_dir,
        driveFileId: driveFile.id,
        driveAccessToken: token,
        isTempFile: false,
      });
      continue;
    }

    let targetFolder = null;
    if (driveFile.relative_dir) {
      targetFolder = state.selectedFolder
        ? state.selectedFolder + "/" + driveFile.relative_dir
        : driveFile.relative_dir;
    } else {
      targetFolder = state.selectedFolder || null;
    }

    state.files.push({
      id: state.nextFileId++,
      name: driveFile.name,
      path: "",                    // will be filled after download
      status: "queued",
      error: null,
      targetFolder,
      relativeDir: driveFile.relative_dir,
      driveFileId: driveFile.id,
      driveAccessToken: token,
      isTempFile: false,           // true after download
      tempPath: null,
    });
  }

  renderFileList();
  uploadControls.classList.remove("hidden");
  dropZone.classList.add("hidden");
}
```

**Step 2: Update open_google_drive_picker to return access token**

The Rust command needs to also return the access token so the JS can download files. Update the return type in `google_drive.rs`:

```rust
#[derive(Serialize)]
pub struct PickerResult {
    pub files: Vec<DriveFileInfo>,
    pub access_token: String,
}
```

Update `open_picker_and_get_files` to return `PickerResult`:

```rust
Ok(PickerResult { files, access_token })
```

Update the Tauri command in `lib.rs`:

```rust
#[tauri::command]
async fn open_google_drive_picker(client_id: String) -> Result<google_drive::PickerResult, String> {
    google_drive::open_picker_and_get_files(&client_id).await
}
```

Update JS to use `result.files` and `result.access_token`:

```js
const result = await invoke("open_google_drive_picker", { clientId: state.googleClientId });
const driveFiles = result.files;
const token = result.access_token;
```

**Step 3: Update uploadSingleFile to handle Drive files**

Drive files need to be downloaded before upload. At the start of `uploadSingleFile`:

```js
async function uploadSingleFile(file) {
  // Download Drive files first
  if (file.driveFileId && !file.isTempFile) {
    try {
      const tempPath = await invoke("download_drive_file", {
        accessToken: file.driveAccessToken,
        fileId: file.driveFileId,
        fileName: file.name,
      });
      file.path = tempPath;
      file.tempPath = tempPath;
      file.isTempFile = true;
    } catch (err) {
      file.status = "failed";
      file.error = "Download failed: " + err;
      state.activeUploads--;
      updateFileRow(file);
      updateCounter();
      pumpQueue();
      return;
    }
  }

  // ... rest of existing uploadSingleFile code unchanged
```

**Step 4: Delete temp files after successful upload**

In `uploadSingleFile`, after `file.status = "done"`:

```js
if (result.success) {
  file.status = "done";
  file.error = null;
  state.consecutiveSuccess++;
  updateFileRow(file);

  // Clean up temp file for Drive downloads
  if (file.isTempFile && file.tempPath) {
    invoke("delete_temp_file", { path: file.tempPath }).catch(() => {});
    file.tempPath = null;
  }
  // ...
```

**Step 5: Delete temp files on clearFiles**

In `clearFiles()`, before clearing state.files:

```js
function clearFiles() {
  if (state.uploading) return;
  // Clean up any remaining temp files
  for (const file of state.files) {
    if (file.isTempFile && file.tempPath) {
      invoke("delete_temp_file", { path: file.tempPath }).catch(() => {});
    }
  }
  state.files = [];
  // ...
```

**Step 6: Build and test**

```bash
cd batch-uploader && npx tauri dev
```

Test: Enter a Google Client ID, connect, click "From Google Drive". Browser opens → pick files → return to app. Verify files appear in queue. Click Upload All. Verify files upload to correct Ergonode folders.

**Step 7: Commit**

```bash
git add batch-uploader/src-tauri/src/google_drive.rs batch-uploader/src-tauri/src/lib.rs \
        batch-uploader/ui/app.js
git commit -m "feat: Google Drive picker full flow with folder structure support"
```

---

## Final: Build release and verify

```bash
cd batch-uploader && npx tauri build
```

Run `scripts/fix-dmg.sh` on macOS to clean up the DMG. Verify:
1. Drop a nested folder → confirmation modal → uploads to correct Ergonode subfolders
2. Google Drive button hidden when no Client ID, visible when set
3. Google Drive → OAuth → file list → uploads to correct folders
4. Temp files cleaned up after successful upload
5. Clear All cleans up remaining temp files
