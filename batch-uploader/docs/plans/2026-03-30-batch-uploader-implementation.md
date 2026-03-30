# Ergonode Batch Image Uploader — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Tauri 2.x desktop app that lets non-technical users bulk-upload images to their Ergonode media library with folder browsing, drag-and-drop, and graceful rate limiting.

**Architecture:** Rust backend (Tauri commands + reqwest HTTP) handles all Ergonode API calls. Vanilla HTML/CSS/JS frontend communicates via Tauri IPC. Config persisted to OS app data directory.

**Tech Stack:** Tauri 2.x, Rust, reqwest, serde, vanilla HTML/CSS/JS

---

## Ergonode API Reference (for implementer)

All requests go to `{api_url}/api/graphql/` with header `X-API-KEY: {api_key}`.

**Upload file** — multipart POST:
- Part `upload`: file binary
- Part `query`: `mutation{multimediaCreate(input:{name:"filename.ext",folderPath:"path"}){__typename}}`
- `folderPath` is optional (null = root)

**List folders** — POST JSON:
```graphql
{ multimediaFolderList(first: 300) { edges { node { path name } cursor } pageInfo { hasNextPage } totalCount } }
```

**Create folder** — POST JSON:
```graphql
mutation { multimediaFolderCreate(input: { name: "FolderName", folderPath: "parent/path", createFolderPath: true }) { __typename } }
```

**Rate limits:** 250 req/min media, 500 req/min other, max 6 concurrent connections.

---

## Task 1: Scaffold Tauri Project

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/icons/` (use default Tauri icons)
- Create: `ui/index.html`
- Create: `package.json`

**Step 1: Initialize the project**

Create `package.json` at project root:
```json
{
  "name": "ergonode-uploader",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "tauri": "tauri"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

Run: `npm install`

**Step 2: Initialize Tauri**

Run: `npm run tauri init`

When prompted:
- App name: `ergonode-uploader`
- Window title: `Ergonode Batch Uploader`
- Web assets location: `../ui`
- Dev server URL: `../ui`
- Frontend dev command: (empty)
- Frontend build command: (empty)

**Step 3: Update Cargo.toml dependencies**

Edit `src-tauri/Cargo.toml` to include:
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["multipart", "json"] }
tokio = { version = "1", features = ["full"] }
thiserror = "2"
dirs = "6"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

**Step 4: Update tauri.conf.json**

Edit `src-tauri/tauri.conf.json` to set:
- `identifier`: `"com.ergonode.uploader"`
- `app.withGlobalTauri`: `true`
- `app.windows[0].width`: 700
- `app.windows[0].height`: 800
- `app.windows[0].title`: `"Ergonode Batch Uploader"`
- `app.windows[0].resizable`: `true`

**Step 5: Create minimal frontend**

Create `ui/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ergonode Batch Uploader</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">
    <h1>Ergonode Batch Uploader</h1>
    <p>Loading...</p>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

Create `ui/styles.css` and `ui/app.js` as empty files.

**Step 6: Create minimal Rust backend**

`src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/src/lib.rs`:
```rust
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ergonode_uploader_lib::run();
}
```

Note: The `lib.rs` crate name in main.rs depends on the package name in Cargo.toml. If package name is `ergonode-uploader`, use `ergonode_uploader::run()`. Check the actual crate name.

**Step 7: Verify it builds and runs**

Run: `npm run tauri dev`
Expected: A window opens showing "Ergonode Batch Uploader" with "Loading..." text.

**Step 8: Commit**

```bash
git init
git add -A
git commit -m "feat: scaffold Tauri 2 project with minimal frontend"
```

---

## Task 2: Config Persistence (Rust Backend)

**Files:**
- Create: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Create config module**

`src-tauri/src/config.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub folder_path: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("ergonode-uploader").join("config.json"))
}

pub fn load_config() -> AppConfig {
    let Some(path) = config_path() else {
        return AppConfig::default();
    };
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path().ok_or("Cannot determine config directory")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

pub fn clear_config() -> Result<(), String> {
    let path = config_path().ok_or("Cannot determine config directory")?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

**Step 2: Add Tauri commands for config**

Add to `src-tauri/src/lib.rs`:
```rust
mod config;
use config::AppConfig;

#[tauri::command]
fn load_settings() -> AppConfig {
    config::load_config()
}

#[tauri::command]
fn save_settings(api_url: String, api_key: String, folder_path: Option<String>) -> Result<(), String> {
    let cfg = AppConfig { api_url, api_key, folder_path };
    config::save_config(&cfg)
}

#[tauri::command]
fn clear_settings() -> Result<(), String> {
    config::clear_config()
}
```

Register all commands in the builder:
```rust
.invoke_handler(tauri::generate_handler![load_settings, save_settings, clear_settings])
```

**Step 3: Verify build**

Run: `npm run tauri dev`
Expected: Compiles without errors.

**Step 4: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/lib.rs
git commit -m "feat: add config persistence for API credentials"
```

---

## Task 3: Ergonode API Client (Rust Backend)

**Files:**
- Create: `src-tauri/src/ergonode.rs`
- Modify: `src-tauri/src/lib.rs`

**Step 1: Create the Ergonode API module**

`src-tauri/src/ergonode.rs`:
```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
struct GraphQLResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphQLError>>,
}

#[derive(Debug, Deserialize)]
struct GraphQLError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct FolderListData {
    #[serde(rename = "multimediaFolderList")]
    multimedia_folder_list: FolderConnection,
}

#[derive(Debug, Deserialize)]
struct FolderConnection {
    edges: Vec<FolderEdge>,
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Debug, Deserialize)]
struct FolderEdge {
    node: FolderNode,
    cursor: String,
}

#[derive(Debug, Deserialize)]
struct FolderNode {
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
struct PageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UploadResult {
    pub file_name: String,
    pub success: bool,
    pub error: Option<String>,
    pub rate_limited: bool,
}

pub struct ErgonodeClient {
    client: Client,
    api_url: String,
    api_key: String,
}

impl ErgonodeClient {
    pub fn new(api_url: &str, api_key: &str) -> Self {
        let api_url = api_url.trim_end_matches('/').to_string();
        Self {
            client: Client::new(),
            api_url,
            api_key: api_key.to_string(),
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/api/graphql/", self.api_url)
    }

    /// Test connection by fetching folder list
    pub async fn test_connection(&self) -> Result<(), String> {
        let query = r#"{"query":"{ multimediaFolderList(first:1) { totalCount } }"}"#;
        let resp = self.client
            .post(&self.endpoint())
            .header("X-API-KEY", &self.api_key)
            .header("Content-Type", "application/json")
            .body(query.to_string())
            .send()
            .await
            .map_err(|e| format!("Connection failed: {}", e))?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("Invalid API key".to_string());
        }
        if !status.is_success() {
            return Err(format!("Server returned status {}", status));
        }
        Ok(())
    }

    /// Fetch all multimedia folders (handles pagination)
    pub async fn fetch_folders(&self) -> Result<Vec<FolderInfo>, String> {
        let mut folders = Vec::new();
        let mut after: Option<String> = None;

        loop {
            let query = match &after {
                Some(cursor) => format!(
                    r#"{{"query":"{{ multimediaFolderList(first:300, after:\"{}\") {{ edges {{ node {{ name path }} cursor }} pageInfo {{ hasNextPage }} }} }}"}}"#,
                    cursor
                ),
                None => r#"{"query":"{ multimediaFolderList(first:300) { edges { node { name path } cursor } pageInfo { hasNextPage } } }"}"#.to_string(),
            };

            let resp = self.client
                .post(&self.endpoint())
                .header("X-API-KEY", &self.api_key)
                .header("Content-Type", "application/json")
                .body(query)
                .send()
                .await
                .map_err(|e| format!("Failed to fetch folders: {}", e))?;

            if resp.status().as_u16() == 429 {
                return Err("Rate limited. Please try again in a moment.".to_string());
            }

            let body: GraphQLResponse<FolderListData> = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse response: {}", e))?;

            if let Some(errors) = body.errors {
                let msgs: Vec<String> = errors.into_iter().map(|e| e.message).collect();
                return Err(msgs.join(", "));
            }

            if let Some(data) = body.data {
                let conn = data.multimedia_folder_list;
                for edge in &conn.edges {
                    folders.push(FolderInfo {
                        name: edge.node.name.clone(),
                        path: edge.node.path.clone(),
                    });
                }
                if conn.page_info.has_next_page {
                    after = conn.edges.last().map(|e| e.cursor.clone());
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        Ok(folders)
    }

    /// Create a new folder
    pub async fn create_folder(&self, name: &str, parent_path: Option<&str>) -> Result<(), String> {
        let folder_path_part = match parent_path {
            Some(p) if !p.is_empty() => format!(r#", folderPath: \"{}\""#, p),
            _ => String::new(),
        };
        let query = format!(
            r#"{{"query":"mutation {{ multimediaFolderCreate(input: {{ name: \"{}\"{}, createFolderPath: true }}) {{ __typename }} }}"}}"#,
            name, folder_path_part
        );

        let resp = self.client
            .post(&self.endpoint())
            .header("X-API-KEY", &self.api_key)
            .header("Content-Type", "application/json")
            .body(query)
            .send()
            .await
            .map_err(|e| format!("Failed to create folder: {}", e))?;

        if resp.status().as_u16() == 429 {
            return Err("Rate limited. Please try again in a moment.".to_string());
        }

        let body: GraphQLResponse<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(errors) = body.errors {
            let msgs: Vec<String> = errors.into_iter().map(|e| e.message).collect();
            return Err(msgs.join(", "));
        }

        Ok(())
    }

    /// Upload a single file via multipart
    pub async fn upload_file(&self, file_path: &str, file_name: &str, folder_path: Option<&str>) -> UploadResult {
        let file_bytes = match std::fs::read(file_path) {
            Ok(b) => b,
            Err(e) => return UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some(format!("Cannot read file: {}", e)),
                rate_limited: false,
            },
        };

        let folder_part = match folder_path {
            Some(p) if !p.is_empty() => format!(r#",folderPath:"{}""#, p),
            _ => String::new(),
        };
        let mutation = format!(
            r#"mutation{{multimediaCreate(input:{{name:"{}"{}}}){{__typename}}}}"#,
            file_name, folder_part
        );

        let part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name.to_string());

        let form = reqwest::multipart::Form::new()
            .part("upload", part)
            .text("query", mutation);

        let resp = match self.client
            .post(&self.endpoint())
            .header("X-API-KEY", &self.api_key)
            .multipart(form)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some(format!("Network error: {}", e)),
                rate_limited: false,
            },
        };

        if resp.status().as_u16() == 429 {
            return UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some("Rate limited by Ergonode".to_string()),
                rate_limited: true,
            };
        }

        if !resp.status().is_success() {
            return UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some(format!("Server error: {}", resp.status())),
                rate_limited: false,
            };
        }

        let body: Result<GraphQLResponse<serde_json::Value>, _> = resp.json().await;
        match body {
            Ok(b) if b.errors.is_some() => {
                let msgs: Vec<String> = b.errors.unwrap().into_iter().map(|e| e.message).collect();
                UploadResult {
                    file_name: file_name.to_string(),
                    success: false,
                    error: Some(msgs.join(", ")),
                    rate_limited: false,
                }
            }
            Ok(_) => UploadResult {
                file_name: file_name.to_string(),
                success: true,
                error: None,
                rate_limited: false,
            },
            Err(e) => UploadResult {
                file_name: file_name.to_string(),
                success: false,
                error: Some(format!("Parse error: {}", e)),
                rate_limited: false,
            },
        }
    }
}
```

**Step 2: Add Tauri commands for API operations**

Add to `src-tauri/src/lib.rs`:
```rust
mod ergonode;
use ergonode::{ErgonodeClient, FolderInfo, UploadResult};

#[tauri::command]
async fn test_connection(api_url: String, api_key: String) -> Result<(), String> {
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.test_connection().await
}

#[tauri::command]
async fn fetch_folders(api_url: String, api_key: String) -> Result<Vec<FolderInfo>, String> {
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.fetch_folders().await
}

#[tauri::command]
async fn create_folder(api_url: String, api_key: String, name: String, parent_path: Option<String>) -> Result<(), String> {
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.create_folder(&name, parent_path.as_deref()).await
}

#[tauri::command]
async fn upload_file(api_url: String, api_key: String, file_path: String, file_name: String, folder_path: Option<String>) -> UploadResult {
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.upload_file(&file_path, &file_name, folder_path.as_deref()).await
}
```

Register all commands:
```rust
.invoke_handler(tauri::generate_handler![
    load_settings, save_settings, clear_settings,
    test_connection, fetch_folders, create_folder, upload_file
])
```

**Step 3: Verify build**

Run: `npm run tauri dev`
Expected: Compiles without errors.

**Step 4: Commit**

```bash
git add src-tauri/src/ergonode.rs src-tauri/src/lib.rs
git commit -m "feat: add Ergonode API client with upload, folders, and connection test"
```

---

## Task 4: Frontend — Settings UI

**Files:**
- Modify: `ui/index.html`
- Modify: `ui/styles.css`
- Modify: `ui/app.js`

**Step 1: Build the HTML structure**

Replace `ui/index.html` body content with the full app layout:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ergonode Batch Uploader</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div id="app">
    <header>
      <h1>Ergonode Batch Uploader</h1>
    </header>

    <!-- Settings -->
    <section id="settings" class="card">
      <h2>Settings</h2>
      <div class="field">
        <label for="apiUrl">API URL</label>
        <input type="url" id="apiUrl" placeholder="https://your-instance.ergonode.com">
      </div>
      <div class="field">
        <label for="apiKey">API Key</label>
        <div class="input-group">
          <input type="password" id="apiKey" placeholder="Your API key">
          <button id="toggleKey" title="Show/hide key">👁</button>
        </div>
      </div>
      <div class="button-row">
        <button id="connectBtn" class="primary">Connect</button>
        <button id="clearBtn" class="danger">Clear Saved Settings</button>
      </div>
      <div id="connectionStatus"></div>
    </section>

    <!-- Folder picker (hidden until connected) -->
    <section id="folderSection" class="card hidden">
      <h2>Destination Folder</h2>
      <div id="folderTree"></div>
      <div class="button-row">
        <button id="newFolderBtn">+ New Folder</button>
        <button id="refreshFoldersBtn">↻ Refresh</button>
      </div>
      <div id="newFolderInput" class="hidden">
        <input type="text" id="newFolderName" placeholder="Folder name">
        <button id="createFolderBtn">Create</button>
        <button id="cancelFolderBtn">Cancel</button>
      </div>
      <p id="selectedFolder">Selected: <strong>/ (root)</strong></p>
    </section>

    <!-- Upload zone (hidden until connected) -->
    <section id="uploadSection" class="card hidden">
      <h2>Upload Files</h2>
      <div id="dropZone">
        <p>Drag & drop files here<br>or click to browse</p>
        <input type="file" id="fileInput" multiple accept="image/*" hidden>
      </div>
      <div id="fileList"></div>
      <div id="uploadControls" class="hidden">
        <button id="uploadBtn" class="primary">Upload All</button>
        <span id="uploadSummary"></span>
      </div>
      <div id="rateLimitNotice" class="hidden"></div>
    </section>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

**Step 2: Add base styles**

Write `ui/styles.css` — clean, minimal design. Use system fonts, soft colors, clear spacing. Key classes:
- `.card` — white background, rounded corners, padding, margin-bottom
- `.hidden` — `display: none`
- `.field` — label + input vertical stack
- `.input-group` — input + button inline
- `.primary` — blue button
- `.danger` — red/muted button
- `#dropZone` — dashed border, centered text, hover highlight
- `.file-item` — flex row with name, progress bar, status
- `.progress-bar` — outer container with inner fill div
- `.status-queued`, `.status-uploading`, `.status-done`, `.status-failed`, `.status-skipped` — colored status indicators

Use `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` for cross-platform consistency.

Colors:
- Primary: `#2563eb` (blue)
- Success: `#16a34a` (green)
- Warning: `#d97706` (amber)
- Error: `#dc2626` (red)
- Background: `#f8fafc`
- Card: `#ffffff`
- Border: `#e2e8f0`

**Step 3: Implement settings logic in app.js**

Start `ui/app.js` with the settings section:
```javascript
const { invoke } = window.__TAURI__.core;

// State
const state = {
  apiUrl: '',
  apiKey: '',
  connected: false,
  selectedFolder: null, // null = root
  folders: [],
  files: [],         // { id, name, path, size, status, progress, error }
  uploading: false,
  maxConcurrency: 4,
  currentConcurrency: 4,
  consecutiveSuccesses: 0,
  backoffMs: 5000,
};

// DOM refs
const apiUrlInput = document.getElementById('apiUrl');
const apiKeyInput = document.getElementById('apiKey');
const toggleKeyBtn = document.getElementById('toggleKey');
const connectBtn = document.getElementById('connectBtn');
const clearBtn = document.getElementById('clearBtn');
const connectionStatus = document.getElementById('connectionStatus');
const folderSection = document.getElementById('folderSection');
const uploadSection = document.getElementById('uploadSection');

// Init: load saved settings
async function init() {
  try {
    const config = await invoke('load_settings');
    if (config.api_url) apiUrlInput.value = config.api_url;
    if (config.api_key) apiKeyInput.value = config.api_key;
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

// Toggle API key visibility
toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// Connect
connectBtn.addEventListener('click', async () => {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  if (!apiUrl || !apiKey) {
    showStatus('Please enter both API URL and API Key', 'error');
    return;
  }
  showStatus('Connecting...', 'info');
  connectBtn.disabled = true;
  try {
    await invoke('test_connection', { apiUrl, apiKey });
    state.apiUrl = apiUrl;
    state.apiKey = apiKey;
    state.connected = true;
    await invoke('save_settings', { apiUrl, apiKey, folderPath: null });
    showStatus('Connected successfully!', 'success');
    folderSection.classList.remove('hidden');
    uploadSection.classList.remove('hidden');
    await loadFolders();
  } catch (e) {
    showStatus(e, 'error');
    state.connected = false;
  } finally {
    connectBtn.disabled = false;
  }
});

// Clear settings
clearBtn.addEventListener('click', async () => {
  await invoke('clear_settings');
  apiUrlInput.value = '';
  apiKeyInput.value = '';
  state.connected = false;
  folderSection.classList.add('hidden');
  uploadSection.classList.add('hidden');
  showStatus('Settings cleared', 'info');
});

function showStatus(msg, type) {
  connectionStatus.textContent = msg;
  connectionStatus.className = `status-${type}`;
}

init();
```

**Step 4: Verify build and test settings UI**

Run: `npm run tauri dev`
Expected: Settings section visible, can type URL/key, connect button calls test_connection, saves config.

**Step 5: Commit**

```bash
git add ui/ src-tauri/src/lib.rs
git commit -m "feat: add settings UI with connection test and config persistence"
```

---

## Task 5: Frontend — Folder Tree Browser

**Files:**
- Modify: `ui/app.js`

**Step 1: Implement folder loading and tree rendering**

Add to `ui/app.js`:
```javascript
const folderTree = document.getElementById('folderTree');
const selectedFolderEl = document.getElementById('selectedFolder');
const newFolderBtn = document.getElementById('newFolderBtn');
const newFolderInput = document.getElementById('newFolderInput');
const newFolderName = document.getElementById('newFolderName');
const createFolderBtn = document.getElementById('createFolderBtn');
const cancelFolderBtn = document.getElementById('cancelFolderBtn');
const refreshFoldersBtn = document.getElementById('refreshFoldersBtn');

async function loadFolders() {
  try {
    const folders = await invoke('fetch_folders', {
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
    });
    state.folders = folders;
    renderFolderTree(folders);
  } catch (e) {
    folderTree.innerHTML = `<p class="error">Failed to load folders: ${e}</p>`;
  }
}

function buildTree(folders) {
  // folders is flat list with paths like "folder1", "folder1/subfolder"
  // Build tree structure from paths
  const root = { name: '/ (root)', path: '', children: [] };
  const map = { '': root };

  // Sort by path depth so parents are processed first
  const sorted = [...folders].sort((a, b) => a.path.split('/').length - b.path.split('/').length);

  for (const f of sorted) {
    const parts = f.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const node = { name: f.name, path: f.path, children: [] };
    map[f.path] = node;
    const parent = map[parentPath] || root;
    parent.children.push(node);
  }
  return root;
}

function renderFolderTree(folders) {
  const tree = buildTree(folders);
  folderTree.innerHTML = '';
  folderTree.appendChild(renderNode(tree, true));
}

function renderNode(node, isRoot) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.className = 'folder-item' + (isRoot && state.selectedFolder === null ? ' selected' : '') +
                   (!isRoot && state.selectedFolder === node.path ? ' selected' : '');
  span.textContent = '📁 ' + node.name;
  span.addEventListener('click', () => {
    state.selectedFolder = isRoot ? null : node.path;
    // Update all selected states
    document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('selected'));
    span.classList.add('selected');
    selectedFolderEl.innerHTML = `Selected: <strong>${isRoot ? '/ (root)' : node.path}</strong>`;
  });
  li.appendChild(span);

  if (node.children.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'folder-children';
    for (const child of node.children) {
      ul.appendChild(renderNode(child, false));
    }
    li.appendChild(ul);
  }
  return li;
}

// New folder
newFolderBtn.addEventListener('click', () => {
  newFolderInput.classList.remove('hidden');
  newFolderName.value = '';
  newFolderName.focus();
});

cancelFolderBtn.addEventListener('click', () => {
  newFolderInput.classList.add('hidden');
});

createFolderBtn.addEventListener('click', async () => {
  const name = newFolderName.value.trim();
  if (!name) return;
  createFolderBtn.disabled = true;
  try {
    await invoke('create_folder', {
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
      name,
      parentPath: state.selectedFolder,
    });
    newFolderInput.classList.add('hidden');
    await loadFolders();
  } catch (e) {
    alert('Failed to create folder: ' + e);
  } finally {
    createFolderBtn.disabled = false;
  }
});

refreshFoldersBtn.addEventListener('click', loadFolders);
```

**Step 2: Add folder tree CSS**

Add to `ui/styles.css`:
```css
#folderTree ul {
  list-style: none;
  padding-left: 1.2rem;
  margin: 0;
}
#folderTree > li { padding-left: 0; }

.folder-item {
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
}
.folder-item:hover { background: #e2e8f0; }
.folder-item.selected { background: #dbeafe; color: #1d4ed8; font-weight: 600; }
```

**Step 3: Verify folder tree works**

Run: `npm run tauri dev`
Expected: After connecting, folder tree loads and renders. Can click to select. New folder button works.

**Step 4: Commit**

```bash
git add ui/
git commit -m "feat: add folder tree browser with create folder support"
```

---

## Task 6: Frontend — Drag & Drop + File List

**Files:**
- Modify: `ui/app.js`

**Step 1: Implement drag-and-drop and file selection**

Add to `ui/app.js`:
```javascript
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const uploadControls = document.getElementById('uploadControls');
const uploadBtn = document.getElementById('uploadBtn');
const uploadSummary = document.getElementById('uploadSummary');

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
let fileIdCounter = 0;

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

function addFiles(fileListObj) {
  for (const file of fileListObj) {
    const id = ++fileIdCounter;
    const oversized = file.size > MAX_FILE_SIZE;
    state.files.push({
      id,
      name: file.name,
      path: file.path || '', // Tauri provides file.path for native drag-drop
      size: file.size,
      status: oversized ? 'skipped' : 'queued',
      progress: 0,
      error: oversized ? `Exceeds 100MB (${(file.size / 1024 / 1024).toFixed(1)}MB)` : null,
      file, // keep reference for upload via file picker (non-drag)
    });
  }
  renderFileList();
  updateUploadControls();
}

function renderFileList() {
  fileList.innerHTML = '';
  for (const f of state.files) {
    const div = document.createElement('div');
    div.className = `file-item status-${f.status}`;
    div.id = `file-${f.id}`;
    div.innerHTML = `
      <span class="file-name">${f.name}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${f.progress}%"></div></div>
      <span class="file-status">${statusLabel(f)}</span>
      ${f.status === 'failed' ? `<button class="retry-btn" data-id="${f.id}">Retry</button>` : ''}
      <button class="remove-btn" data-id="${f.id}">✕</button>
    `;
    fileList.appendChild(div);
  }

  // Bind retry buttons
  document.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      const file = state.files.find(f => f.id === id);
      if (file) {
        file.status = 'queued';
        file.progress = 0;
        file.error = null;
        renderFileList();
      }
    });
  });

  // Bind remove buttons
  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      state.files = state.files.filter(f => f.id !== id);
      renderFileList();
      updateUploadControls();
    });
  });
}

function statusLabel(f) {
  switch (f.status) {
    case 'queued': return 'Queued';
    case 'uploading': return `${f.progress}%`;
    case 'done': return '✓ Done';
    case 'failed': return `✗ ${f.error || 'Failed'}`;
    case 'skipped': return `⚠ ${f.error}`;
    default: return '';
  }
}

function updateUploadControls() {
  const uploadable = state.files.filter(f => f.status === 'queued' || f.status === 'failed').length;
  const done = state.files.filter(f => f.status === 'done').length;
  const total = state.files.filter(f => f.status !== 'skipped').length;

  if (state.files.length > 0) {
    uploadControls.classList.remove('hidden');
    uploadSummary.textContent = `${done}/${total} complete`;
    uploadBtn.disabled = uploadable === 0 || state.uploading;
  } else {
    uploadControls.classList.add('hidden');
  }
}
```

Note: Tauri's drag-and-drop provides `file.path` on the File object, which is the native file path needed for the Rust upload command. For files selected via the file picker, we may need to use Tauri's dialog plugin or read the file in JS and pass bytes. The implementer should handle both cases — check if `file.path` is available (drag-drop) and fall back to reading via FileReader if needed. Alternatively, use `window.__TAURI__.dialog.open()` for the file picker to get native paths.

**Step 2: Add file list CSS**

Add to `ui/styles.css`:
```css
.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #e2e8f0;
}
.file-name { flex: 0 0 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.progress-bar { flex: 1; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; background: #2563eb; transition: width 0.3s; border-radius: 4px; }
.status-done .progress-fill { background: #16a34a; }
.status-failed .progress-fill { background: #dc2626; }
.file-status { flex: 0 0 auto; font-size: 0.85rem; }
.status-skipped .file-status { color: #d97706; }
.status-done .file-status { color: #16a34a; }
.status-failed .file-status { color: #dc2626; }
.retry-btn, .remove-btn { background: none; border: none; cursor: pointer; font-size: 0.85rem; }
.retry-btn { color: #2563eb; }
.remove-btn { color: #94a3b8; }
#dropZone.drag-over { border-color: #2563eb; background: #eff6ff; }
```

**Step 3: Verify drag-and-drop works**

Run: `npm run tauri dev`
Expected: Can drag files onto drop zone, file list renders with names and sizes, oversized files flagged.

**Step 4: Commit**

```bash
git add ui/
git commit -m "feat: add drag-and-drop file selection with validation"
```

---

## Task 7: Frontend — Upload Queue with Rate Limiting

**Files:**
- Modify: `ui/app.js`

**Step 1: Implement the upload queue**

Add to `ui/app.js`:
```javascript
const rateLimitNotice = document.getElementById('rateLimitNotice');

uploadBtn.addEventListener('click', startUpload);

async function startUpload() {
  if (state.uploading) return;
  state.uploading = true;
  state.currentConcurrency = state.maxConcurrency;
  state.consecutiveSuccesses = 0;
  state.backoffMs = 5000;
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading...';

  await processQueue();

  state.uploading = false;
  uploadBtn.disabled = false;
  uploadBtn.textContent = 'Upload All';
  updateUploadControls();
}

async function processQueue() {
  const getNext = () => state.files.find(f => f.status === 'queued');
  const active = new Set();

  return new Promise((resolve) => {
    function tryLaunch() {
      while (active.size < state.currentConcurrency) {
        const file = getNext();
        if (!file) {
          if (active.size === 0) resolve();
          return;
        }
        file.status = 'uploading';
        updateFileUI(file);
        active.add(file.id);
        uploadSingleFile(file).then(() => {
          active.delete(file.id);
          updateUploadControls();
          tryLaunch();
        });
      }
    }
    tryLaunch();
  });
}

async function uploadSingleFile(file) {
  // For drag-and-drop, file.path is available from Tauri
  // For file picker, we need the native path
  const filePath = file.path;
  if (!filePath) {
    file.status = 'failed';
    file.error = 'No file path available (try drag & drop)';
    updateFileUI(file);
    return;
  }

  file.progress = 10; // Indicate upload started (no streaming progress from reqwest)
  updateFileUI(file);

  const result = await invoke('upload_file', {
    apiUrl: state.apiUrl,
    apiKey: state.apiKey,
    filePath: filePath,
    fileName: file.name,
    folderPath: state.selectedFolder,
  });

  if (result.rate_limited) {
    // 429 handling
    file.status = 'queued';
    file.progress = 0;
    // Move to front of queue (it's already in the array, just reset status)
    state.currentConcurrency = Math.max(1, state.currentConcurrency - 1);
    state.consecutiveSuccesses = 0;

    // Show notice and wait
    rateLimitNotice.classList.remove('hidden');
    rateLimitNotice.textContent = `Ergonode is busy, resuming in ${state.backoffMs / 1000}s...`;
    updateFileUI(file);

    await sleep(state.backoffMs);
    state.backoffMs = Math.min(state.backoffMs * 2, 60000);
    rateLimitNotice.classList.add('hidden');
    return;
  }

  if (result.success) {
    file.status = 'done';
    file.progress = 100;
    state.consecutiveSuccesses++;
    // Restore concurrency after 10 consecutive successes
    if (state.consecutiveSuccesses >= 10 && state.currentConcurrency < state.maxConcurrency) {
      state.currentConcurrency++;
      state.consecutiveSuccesses = 0;
      state.backoffMs = 5000; // Reset backoff
    }
  } else {
    file.status = 'failed';
    file.error = result.error || 'Unknown error';
    state.consecutiveSuccesses = 0;
  }

  updateFileUI(file);
}

function updateFileUI(file) {
  const el = document.getElementById(`file-${file.id}`);
  if (!el) return;
  el.className = `file-item status-${file.status}`;
  el.querySelector('.progress-fill').style.width = `${file.progress}%`;
  el.querySelector('.file-status').textContent = statusLabel(file);

  // Add/remove retry button
  const existing = el.querySelector('.retry-btn');
  if (file.status === 'failed' && !existing) {
    const btn = document.createElement('button');
    btn.className = 'retry-btn';
    btn.dataset.id = file.id;
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => {
      file.status = 'queued';
      file.progress = 0;
      file.error = null;
      updateFileUI(file);
    });
    el.querySelector('.remove-btn').before(btn);
  } else if (file.status !== 'failed' && existing) {
    existing.remove();
  }

  updateUploadControls();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

**Step 2: Handle Tauri drag-and-drop file paths**

Tauri 2 exposes native file paths on drag-and-drop events. The implementer must verify that `event.dataTransfer.files[i].path` is populated by Tauri's webview. If not, use Tauri's `onDragDropEvent` listener from `@tauri-apps/api/window` or the `tauri-plugin-dialog` for the browse button:

```javascript
// For "click to browse" — use Tauri dialog to get native paths
const { open } = window.__TAURI__.dialog;
dropZone.addEventListener('click', async () => {
  const selected = await open({
    multiple: true,
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'bmp', 'svg'] }],
  });
  if (selected) {
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop();
      // Get file size via a Rust command (add get_file_size command)
      addFileFromPath(p, name);
    }
  }
});
```

The implementer should add a `get_file_size` Tauri command in Rust:
```rust
#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}
```

**Step 3: Verify upload flow works end-to-end**

Run: `npm run tauri dev`
Expected: Add files, click Upload All, files upload with progress updates, 429s handled gracefully.

**Step 4: Commit**

```bash
git add ui/ src-tauri/src/lib.rs
git commit -m "feat: add upload queue with concurrency control and 429 backoff"
```

---

## Task 8: Polish & Build

**Files:**
- Modify: `ui/styles.css` — final visual polish
- Modify: `src-tauri/tauri.conf.json` — app metadata for build
- Create: `src-tauri/icons/` — app icon (can use Tauri's icon generator)

**Step 1: Add app icon**

Run: `npm run tauri icon path/to/icon.png`
(Use any 1024x1024 PNG as source — Tauri generates all needed sizes)

If no icon available, skip this — Tauri uses a default icon.

**Step 2: Configure build metadata**

In `src-tauri/tauri.conf.json`, ensure:
```json
{
  "productName": "Ergonode Batch Uploader",
  "version": "0.1.0",
  "identifier": "com.ergonode.uploader",
  "bundle": {
    "active": true,
    "targets": "all",
    "windows": {
      "wix": null
    }
  }
}
```

**Step 3: Final CSS polish**

Ensure styles cover:
- Responsive sizing (min-width, max-width on cards)
- Scrollable folder tree (max-height with overflow-y)
- Scrollable file list (max-height with overflow-y)
- Disabled button states
- Loading spinners/indicators for async operations

**Step 4: Build for distribution**

Run: `npm run tauri build`

Expected output:
- Windows: `src-tauri/target/release/bundle/msi/*.msi` and `nsis/*.exe`
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg`
- Linux: `src-tauri/target/release/bundle/appimage/*.AppImage`

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: polish UI and configure build for distribution"
```

---

## Summary of Tauri Commands (Rust → Frontend IPC)

| Command | Args | Returns |
|---------|------|---------|
| `load_settings` | — | `AppConfig` |
| `save_settings` | `apiUrl, apiKey, folderPath` | `()` |
| `clear_settings` | — | `()` |
| `test_connection` | `apiUrl, apiKey` | `()` or error |
| `fetch_folders` | `apiUrl, apiKey` | `Vec<FolderInfo>` |
| `create_folder` | `apiUrl, apiKey, name, parentPath` | `()` or error |
| `upload_file` | `apiUrl, apiKey, filePath, fileName, folderPath` | `UploadResult` |
| `get_file_size` | `path` | `u64` or error |
