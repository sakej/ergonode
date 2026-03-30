# Revert Upload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Revert" button that deletes uploaded files and optionally created folders from Ergonode, using batched GraphQL mutations (50 per request), with a summary of results.

**Architecture:** JS-side session-scoped ledger tracks what was uploaded (files) and created (folders). New Rust command `batch_delete` sends up to 50 aliased `multimediaDelete` or `multimediaFolderDelete` mutations in one GraphQL request. JS orchestrates: files deleted first, then folders deepest-first. Revert confirmation modal lets user choose what to delete (files, folders, or both).

**Tech Stack:** Tauri 2.x, Rust (reqwest, serde), vanilla JS/HTML/CSS, Ergonode GraphQL batched mutations.

---

## Existing codebase context

Key files (read before implementing):
- `batch-uploader/src-tauri/src/lib.rs` — Tauri commands registry
- `batch-uploader/src-tauri/src/ergonode.rs` — `ErgonodeClient` with `create_folder`, `create_folders_batch`, `upload_file`
- `batch-uploader/ui/app.js` — `state` object, `finishQueue()`, `addFoldersByPath()`, `clearFiles()`, inline status helpers
- `batch-uploader/ui/index.html` — existing modal (`#folder-modal`), upload controls with button-row
- `batch-uploader/ui/styles.css` — modal styles, button styles, file status colors

Design doc: `batch-uploader/docs/plans/2026-03-30-revert-upload-design.md`

---

## Task 1: Rust — batch_delete command

Adds a Tauri command that sends up to 50 aliased delete mutations in one GraphQL request and returns per-item results.

**Files:**
- Modify: `batch-uploader/src-tauri/src/ergonode.rs`
- Modify: `batch-uploader/src-tauri/src/lib.rs`

**Step 1: Add BatchDeleteResult type and batch_delete method to ErgonodeClient in ergonode.rs**

Add these types near the top of ergonode.rs (after UploadResult):

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct DeleteItemResult {
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BatchDeleteResult {
    pub results: Vec<DeleteItemResult>,
}
```

Add this method to `impl ErgonodeClient`, after `create_folders_batch`:

```rust
/// Send a batched GraphQL request with up to 50 aliased delete mutations.
/// `delete_type` is "file" or "folder".
pub async fn batch_delete(
    &self,
    paths: &[String],
    delete_type: &str,
) -> Result<BatchDeleteResult, String> {
    let mutation_name = match delete_type {
        "folder" => "multimediaFolderDelete",
        _ => "multimediaDelete",
    };

    // Build aliased mutations: d0: multimediaDelete(input:{path:"..."}) { __typename }
    let mutations: Vec<String> = paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            let escaped = path.replace('"', r#"\""#);
            format!(r#"d{i}:{mutation_name}(input:{{path:\"{escaped}\"}}){{__typename}}"#)
        })
        .collect();

    let query = format!(
        r#"{{"query":"mutation{{{}}}" }}"#,
        mutations.join(" ")
    );

    let resp = self
        .client
        .post(self.endpoint())
        .header("X-API-KEY", &self.api_key)
        .header("Content-Type", "application/json")
        .body(query)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Rate limited (429). Please try again later.".to_string());
    }
    if !status.is_success() {
        return Err(format!("Server returned status {status}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bad response: {e}"))?;

    // Parse per-alias results from data and errors
    let data = body.get("data");
    let errors = body.get("errors").and_then(|e| e.as_array());

    // Build a set of aliases that had errors
    let mut error_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(errs) = errors {
        for err in errs {
            // Errors may have a "path" field like ["d0"] indicating which alias failed
            if let Some(path_arr) = err.get("path").and_then(|p| p.as_array()) {
                if let Some(alias) = path_arr.first().and_then(|a| a.as_str()) {
                    let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("Unknown error");
                    error_map.insert(alias.to_string(), msg.to_string());
                }
            }
        }
    }

    let results: Vec<DeleteItemResult> = paths
        .iter()
        .enumerate()
        .map(|(i, path)| {
            let alias = format!("d{i}");
            if let Some(err_msg) = error_map.get(&alias) {
                DeleteItemResult {
                    path: path.clone(),
                    success: false,
                    error: Some(err_msg.clone()),
                }
            } else {
                // Check if data contains the alias (successful deletion)
                let has_data = data
                    .and_then(|d| d.get(&alias))
                    .is_some();
                if has_data {
                    DeleteItemResult {
                        path: path.clone(),
                        success: true,
                        error: None,
                    }
                } else {
                    DeleteItemResult {
                        path: path.clone(),
                        success: false,
                        error: Some("No response for this item".to_string()),
                    }
                }
            }
        })
        .collect();

    Ok(BatchDeleteResult { results })
}
```

**Step 2: Add Tauri command in lib.rs**

Add after `create_folders_batch` command, and update the import line to include the new types:

Update the use line:
```rust
use ergonode::{ErgonodeClient, FolderInfo, UploadResult, BatchDeleteResult};
```

Add command:
```rust
#[tauri::command]
async fn batch_delete(
    api_url: String,
    api_key: String,
    paths: Vec<String>,
    delete_type: String,
) -> Result<BatchDeleteResult, String> {
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.batch_delete(&paths, &delete_type).await
}
```

Register in `invoke_handler!`:
```rust
load_settings, save_settings, clear_settings,
test_connection, fetch_folders, create_folder, upload_file, get_file_size,
scan_directory, is_directory, create_folders_batch, batch_delete
```

**Step 3: Build to verify**

```bash
cd batch-uploader && cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | grep "^error" | head -20
```
Expected: no errors.

**Step 4: Commit**

```bash
git add batch-uploader/src-tauri/src/ergonode.rs batch-uploader/src-tauri/src/lib.rs
git commit -m "feat: add batch_delete Rust command for batched GraphQL deletions"
```

---

## Task 2: JS — upload ledger in state

Adds the ledger to state, populates it after upload finishes, stores created folders from folder drops.

**Files:**
- Modify: `batch-uploader/ui/app.js`

**Step 1: Add uploadLedger to state**

In the `state` object (after `pauseTimer: null`), add:

```js
  // Revert ledger (session-scoped)
  uploadLedger: null,       // { uploadedFiles: [{name, folderPath}], createdFolders: [path] }
  pendingCreatedFolders: [], // temp: folders created in pre-flight, moved to ledger after upload
```

**Step 2: Capture created folders in addFoldersByPath**

In `addFoldersByPath`, right after the successful `create_folders_batch` invoke (after `hideInlineStatus()`), add:

```js
    // Remember folders for revert ledger
    state.pendingCreatedFolders = subfolders.map(rel => {
      return state.selectedFolder
        ? state.selectedFolder + "/" + rel
        : rel;
    });
```

**Step 3: Populate ledger in finishQueue**

In `finishQueue()`, before the existing `renderFileList()` call, add:

```js
  // Build revert ledger from successfully uploaded files
  const doneFiles = state.files.filter(f => f.status === "done");
  if (doneFiles.length > 0) {
    state.uploadLedger = {
      uploadedFiles: doneFiles.map(f => ({
        name: f.name,
        folderPath: f.targetFolder !== null ? f.targetFolder : state.selectedFolder,
      })),
      createdFolders: [...state.pendingCreatedFolders],
    };
  } else {
    state.uploadLedger = null;
  }
  state.pendingCreatedFolders = [];
```

**Step 4: Clear ledger on disconnect and new upload start**

In `resetToDisconnected()`, add before the existing lines:
```js
  state.uploadLedger = null;
  state.pendingCreatedFolders = [];
```

In `startUploadQueue()`, add after `state.activeUploads = 0;`:
```js
  state.uploadLedger = null;
```

**Step 5: Commit**

```bash
git add batch-uploader/ui/app.js
git commit -m "feat: add upload ledger to track files and folders for revert"
```

---

## Task 3: HTML/CSS — revert button and revert modal

Adds the Revert button to upload controls and a revert confirmation modal with checkboxes.

**Files:**
- Modify: `batch-uploader/ui/index.html`
- Modify: `batch-uploader/ui/styles.css`

**Step 1: Add Revert button to upload controls in index.html**

In the `.button-row` inside `#upload-controls`, add after the "Clear All" button:

```html
<button class="btn btn-revert hidden" id="btn-revert">Revert Upload</button>
```

**Step 2: Add revert modal to index.html**

Add after the existing `#folder-modal` div (before the closing `</div>` of `#app`):

```html
<!-- Revert Upload Confirmation Modal -->
<div id="revert-modal" class="modal-overlay hidden">
  <div class="modal-card">
    <h3 class="modal-title">Revert last upload?</h3>
    <p class="modal-body">This will permanently delete items from Ergonode.</p>
    <div class="revert-options">
      <label class="revert-checkbox">
        <input type="checkbox" id="revert-files-check" checked>
        <span id="revert-files-label">Delete uploaded files (0)</span>
      </label>
      <label class="revert-checkbox" id="revert-folders-row">
        <input type="checkbox" id="revert-folders-check" checked>
        <span id="revert-folders-label">Delete created folders (0)</span>
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="revert-modal-cancel">Cancel</button>
      <button class="btn btn-revert" id="revert-modal-confirm">Revert</button>
    </div>
  </div>
</div>
```

**Step 3: Add CSS for revert button, checkboxes, and reverted status**

Add to end of `styles.css`:

```css
/* ---------- Revert ---------- */

.btn-revert {
  background: var(--red-subtle);
  color: var(--red);
  border: 1px solid #fecaca;
}

.btn-revert:hover:not(:disabled) {
  background: #fecaca;
}

.revert-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 20px;
}

.revert-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}

.revert-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--red);
  cursor: pointer;
}

.file-progress-bar.reverted {
  background: var(--text-tertiary);
  width: 100%;
}

.file-status.reverted { color: var(--text-tertiary); }
```

**Step 4: Commit**

```bash
git add batch-uploader/ui/index.html batch-uploader/ui/styles.css
git commit -m "feat: add revert button and revert confirmation modal UI"
```

---

## Task 4: JS — revert flow (modal, deletion, summary)

Wires the Revert button to the full flow: show modal with checkboxes → delete files in batches → delete folders deepest-first → show summary.

**Files:**
- Modify: `batch-uploader/ui/app.js`

**Step 1: Add DOM refs**

Near the other DOM refs, add:

```js
const btnRevert          = $("#btn-revert");
const revertModal        = $("#revert-modal");
const revertFilesCheck   = $("#revert-files-check");
const revertFoldersCheck = $("#revert-folders-check");
const revertFilesLabel   = $("#revert-files-label");
const revertFoldersLabel = $("#revert-folders-label");
const revertFoldersRow   = $("#revert-folders-row");
const revertModalCancel  = $("#revert-modal-cancel");
const revertModalConfirm = $("#revert-modal-confirm");
```

**Step 2: Add "reverted" to statusLabel**

In `statusLabel`, add before the `default` case:

```js
    case "reverted":   return "Reverted";
```

**Step 3: Show/hide Revert button in finishQueue**

In `finishQueue()`, after the ledger population code (added in Task 2), add:

```js
  // Show revert button if ledger has content
  if (state.uploadLedger) {
    btnRevert.classList.remove("hidden");
  } else {
    btnRevert.classList.add("hidden");
  }
```

Also hide the revert button in `startUploadQueue()` (after `state.uploadLedger = null;`):
```js
  btnRevert.classList.add("hidden");
```

And in `clearFiles()`, after `state.files = [];`:
```js
  state.uploadLedger = null;
  state.pendingCreatedFolders = [];
  btnRevert.classList.add("hidden");
```

**Step 4: Add revert confirmation modal handler**

Add after `showFolderModal` function:

```js
function showRevertModal() {
  return new Promise((resolve) => {
    const ledger = state.uploadLedger;
    if (!ledger) { resolve(null); return; }

    revertFilesLabel.textContent = `Delete uploaded files (${ledger.uploadedFiles.length})`;
    revertFoldersLabel.textContent = `Delete created folders (${ledger.createdFolders.length})`;

    // Only show folders checkbox if folders were created
    if (ledger.createdFolders.length === 0) {
      revertFoldersRow.classList.add("hidden");
      revertFoldersCheck.checked = false;
    } else {
      revertFoldersRow.classList.remove("hidden");
      revertFoldersCheck.checked = true;
    }
    revertFilesCheck.checked = true;

    revertModal.classList.remove("hidden");

    const cleanup = () => {
      revertModal.classList.add("hidden");
      revertModalConfirm.removeEventListener("click", onConfirm);
      revertModalCancel.removeEventListener("click", onCancel);
    };

    const onConfirm = () => {
      cleanup();
      resolve({
        deleteFiles: revertFilesCheck.checked,
        deleteFolders: revertFoldersCheck.checked,
      });
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    revertModalConfirm.addEventListener("click", onConfirm, { once: true });
    revertModalCancel.addEventListener("click", onCancel, { once: true });
  });
}
```

**Step 5: Add the main revert handler**

Add after `showRevertModal`:

```js
const DELETE_BATCH_SIZE = 50;

async function handleRevert() {
  const choice = await showRevertModal();
  if (!choice || (!choice.deleteFiles && !choice.deleteFolders)) return;

  const ledger = state.uploadLedger;
  if (!ledger) return;

  // Disable buttons during revert
  btnRevert.disabled = true;
  btnUpload.disabled = true;
  btnClearFiles.disabled = true;

  const summary = { filesOk: 0, filesFail: 0, foldersOk: 0, foldersFail: 0, errors: [] };

  // Phase 1: Delete files
  if (choice.deleteFiles && ledger.uploadedFiles.length > 0) {
    const filePaths = ledger.uploadedFiles.map(f => {
      return f.folderPath ? f.folderPath + "/" + f.name : f.name;
    });

    for (let i = 0; i < filePaths.length; i += DELETE_BATCH_SIZE) {
      const batch = filePaths.slice(i, i + DELETE_BATCH_SIZE);
      showInlineStatus(`Deleting files... ${i}/${filePaths.length}`);

      try {
        const result = await invoke("batch_delete", {
          apiUrl: state.apiUrl,
          apiKey: state.apiKey,
          paths: batch,
          deleteType: "file",
        });

        for (const r of result.results) {
          if (r.success) {
            summary.filesOk++;
            // Mark file as reverted in the file list
            const match = state.files.find(f =>
              f.status === "done" && f.name === r.path.split("/").pop()
            );
            if (match) {
              match.status = "reverted";
              updateFileRow(match);
            }
          } else {
            summary.filesFail++;
            summary.errors.push(`${r.path}: ${r.error}`);
          }
        }
      } catch (err) {
        summary.filesFail += batch.length;
        summary.errors.push(`Batch error: ${err}`);
      }
    }
    showInlineStatus(`Deleting files... ${filePaths.length}/${filePaths.length}`);
  }

  // Phase 2: Delete folders (deepest first)
  if (choice.deleteFolders && ledger.createdFolders.length > 0) {
    // Sort by depth descending (deepest first)
    const sorted = [...ledger.createdFolders].sort((a, b) => {
      const depthA = a.split("/").length;
      const depthB = b.split("/").length;
      return depthB - depthA;
    });

    for (let i = 0; i < sorted.length; i += DELETE_BATCH_SIZE) {
      const batch = sorted.slice(i, i + DELETE_BATCH_SIZE);
      showInlineStatus(`Deleting folders... ${i}/${sorted.length}`);

      try {
        const result = await invoke("batch_delete", {
          apiUrl: state.apiUrl,
          apiKey: state.apiKey,
          paths: batch,
          deleteType: "folder",
        });

        for (const r of result.results) {
          if (r.success) {
            summary.foldersOk++;
          } else {
            summary.foldersFail++;
            summary.errors.push(`${r.path}: ${r.error}`);
          }
        }
      } catch (err) {
        summary.foldersFail += batch.length;
        summary.errors.push(`Batch error: ${err}`);
      }
    }
  }

  // Phase 3: Show summary
  const parts = [];
  if (choice.deleteFiles) parts.push(`${summary.filesOk}/${summary.filesOk + summary.filesFail} files deleted`);
  if (choice.deleteFolders) parts.push(`${summary.foldersOk}/${summary.foldersOk + summary.foldersFail} folders deleted`);
  const msg = "Reverted: " + parts.join(", ");

  if (summary.filesFail === 0 && summary.foldersFail === 0) {
    showInlineStatus(msg);
    rateLimitMsg.style.color = "var(--green)";
  } else {
    showInlineError(msg);
    console.warn("[revert] Failures:", summary.errors);
    // Show details in a title tooltip on the status message
    rateLimitMsg.title = summary.errors.join("\n");
  }

  // Clear ledger and re-enable buttons
  state.uploadLedger = null;
  btnRevert.classList.add("hidden");
  btnRevert.disabled = false;
  btnUpload.disabled = false;
  btnClearFiles.disabled = false;
  renderFileList();
  updateCounter();

  // Refresh folder tree if folders were deleted
  if (choice.deleteFolders) {
    await loadFolders();
  }
}
```

**Step 6: Bind events**

In `bindEvents()`, add:

```js
  btnRevert.addEventListener("click", handleRevert);
```

**Step 7: Build and test**

```bash
cd batch-uploader && npx tauri dev
```

Test flow:
1. Connect to Ergonode, select a folder
2. Drop a folder with subfolders, confirm, upload all
3. After upload completes, verify "Revert Upload" button appears
4. Click Revert → modal with checkboxes appears
5. Confirm → files deleted, folders deleted deepest-first, summary shown
6. Verify folder tree refreshes
7. Test partial revert (files only, folders only)
8. Test with regular file upload (no folders) — revert should only show files checkbox

**Step 8: Commit**

```bash
git add batch-uploader/ui/app.js
git commit -m "feat: revert upload flow with batched deletions and summary"
```

---

## Final: Build and verify

```bash
cd batch-uploader && npx tauri build --debug
```

Verify:
1. Upload files → Revert appears → deletes files → summary shown
2. Upload folder structure → Revert with both checkboxes → deletes files then folders → summary
3. Partial failures shown in amber with tooltip details
4. Revert button hidden after revert completes
5. Clear All clears ledger and hides Revert
6. New upload clears previous ledger
7. Disconnect clears ledger
