// ========================================
// Ergonode Batch Uploader — Application
// ========================================

const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

// ---------- State ----------

const state = {
  apiUrl: "",
  apiKey: "",
  connected: false,
  folders: [],          // flat list from API: [{ name, path }, ...]
  selectedFolder: null, // null = root, string = path
  files: [],            // [{ id, name, path, status, error }]
  nextFileId: 1,

  // Upload queue
  uploading: false,
  stopping: false,
  maxConcurrency: 4,
  concurrency: 4,
  activeUploads: 0,
  backoff: 5000,        // ms — current backoff delay
  consecutiveSuccess: 0,
  paused: false,
  pauseTimer: null,

  // Revert ledger (session-scoped)
  revertMode: false,
  uploadLedger: null,       // { uploadedFiles: [{name, folderPath}], createdFolders: [path] }
  pendingCreatedFolders: [], // temp: folders created in pre-flight, moved to ledger after upload
};

const MAX_FILE_SIZE = 104857600; // 100 MB

// Ergonode GraphQL error codes → human-readable messages
// https://docs.ergonode.com/graphql/overview/error-codes
const ERGONODE_ERRORS = {
  "d62579bf-6fde-4396-9f12-bc71d6394746": "File already exists in this folder",
  "eabcf146-a4e7-425c-999f-9e04a6c8a988": "File not found at path",
  "9670b62d-5db8-4de8-81bd-7d6119625df0": "File must be an image",
  "df8637af-d466-48c6-a59d-e7126250a654": "File is too large",
  "dd4722d6-9371-42a2-9c35-87b2a03009e7": "File extension not supported",
  "9465e18e-be76-46e8-ab9f-1db22426ab06": "File corrupted or extension mismatch",
  "ef0dd12b-f075-4bbb-8535-4f299452cf30": "Extension doesn't match file type",
  "d64f83eb-32ae-48f6-a46d-ffa4fcba6ee3": "Destination folder not found",
  "54c25a35-59da-4215-aa61-997bb80d303f": "Folder already exists",
  "aa82dbed-9098-4d4b-af22-3a0dde5d47bb": "File type not accepted",
  "c1051bb4-d103-4f74-8988-acbcafc7fdc3": "Value cannot be blank",
  "d94b19cc-114f-4f44-9cc4-4138e80a87b9": "File name too long",
};

function parseUploadError(rawError) {
  if (!rawError) return "Unknown error";

  // Try to parse as JSON (raw GQL error object from Rust)
  try {
    const err = JSON.parse(rawError);
    // Log full structure for debugging
    console.log("GQL error:", JSON.stringify(err, null, 2));

    // Check for Ergonode error codes anywhere in the structure
    const jsonStr = JSON.stringify(err);
    for (const [code, message] of Object.entries(ERGONODE_ERRORS)) {
      if (jsonStr.includes(code)) return message;
    }

    // Use extensions.code if available
    const code = err.extensions?.code;
    const msg = err.message || "";
    if (code && msg && msg !== "An unknown error occurred.") {
      return code + ": " + msg;
    }
    if (code) return code;
    if (msg) return msg;
  } catch (_) {
    // Not JSON — treat as plain string
  }

  // Check for known Ergonode error code UUIDs in plain text
  for (const [code, message] of Object.entries(ERGONODE_ERRORS)) {
    if (rawError.includes(code)) return message;
  }
  // Clean up common HTTP patterns
  if (rawError.includes("429")) return "Rate limited (429)";
  if (rawError.includes("413")) return "File too large (413)";
  if (rawError.includes("401") || rawError.includes("403")) return "Auth failed";
  if (rawError.includes("500")) return "Server error (500)";
  if (rawError.includes("timeout") || rawError.includes("Timeout")) return "Upload timed out";
  // Return as-is but truncated
  return rawError.length > 80 ? rawError.substring(0, 77) + "..." : rawError;
}

// ---------- DOM refs ----------

const $ = (sel) => document.querySelector(sel);
const apiUrlInput     = $("#api-url");
const apiKeyInput     = $("#api-key");
const toggleKeyBtn    = $("#toggle-key");
const eyeIcon         = $("#eye-icon");
const btnConnect      = $("#btn-connect");
const btnClear        = $("#btn-clear");
const connStatus      = $("#connection-status");
const settingsCard    = $("#settings-card");
const connectedBar    = $("#connected-bar");
const connectedUrl    = $("#connected-url");
const btnDisconnect   = $("#btn-disconnect");
const workspace       = $("#workspace");
const folderTree      = $("#folder-tree");
const selectedDisplay = $("#selected-folder-path");
const btnNewFolder    = $("#btn-new-folder");
const btnRefreshFolders = $("#btn-refresh-folders");
const newFolderForm   = $("#new-folder-form");
const newFolderName   = $("#new-folder-name");
const btnCreateFolder = $("#btn-create-folder");
const btnCancelFolder = $("#btn-cancel-folder");
const newFolderStatus = $("#new-folder-status");
const dropZone        = $("#drop-zone");
const uploadControls  = $("#upload-controls");
const fileListEl      = $("#file-list");
const uploadCounter   = $("#upload-counter");
const rateLimitMsg    = $("#rate-limit-msg");
const btnUpload         = $("#btn-upload");
const btnStop           = $("#btn-stop");
const btnClearFiles     = $("#btn-clear-files");
const singleConnectionEl = $("#single-connection");
const folderModal         = $("#folder-modal");
const folderModalBody     = $("#folder-modal-body");
const folderModalCancel   = $("#folder-modal-cancel");
const folderModalContinue = $("#folder-modal-continue");
const scanSpinner        = $("#scan-spinner");
const scanSpinnerText    = $("#scan-spinner-text");
const folderModalOptions = $("#folder-modal-options");
const flatUploadEl       = $("#flat-upload");
const includeRootEl      = $("#include-root");
const revertModal        = $("#revert-modal");
const revertFilesCheck   = $("#revert-files-check");
const revertFoldersCheck = $("#revert-folders-check");
const revertFilesLabel   = $("#revert-files-label");
const revertFoldersLabel = $("#revert-folders-label");
const revertFoldersRow   = $("#revert-folders-row");
const revertModalCancel  = $("#revert-modal-cancel");
const revertModalConfirm = $("#revert-modal-confirm");
const driveLink          = $("#drive-link");
const driveLinkSeparator = $("#drive-link-separator");

// ---------- Init ----------

async function init() {
  try {
    const settings = await invoke("load_settings");
    if (settings.api_url) apiUrlInput.value = settings.api_url;
    if (settings.api_key) apiKeyInput.value = settings.api_key;
    if (settings.folder_path) state.selectedFolder = settings.folder_path;
  } catch (_) {
    // No saved settings — that's fine
  }
  // Check if Google Drive is available (Client ID embedded at build time)
  try {
    const driveAvailable = await invoke("is_google_drive_available");
    if (driveAvailable) {
      driveLink.classList.remove("hidden");
      driveLinkSeparator.classList.remove("hidden");
    }
  } catch (_) {}

  bindEvents();
  setupDragDrop();
}

// ---------- Event bindings ----------

function bindEvents() {
  // Show/hide API key
  toggleKeyBtn.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
    eyeIcon.textContent = isPassword ? "Hide" : "Show";
  });

  btnConnect.addEventListener("click", handleConnect);
  btnClear.addEventListener("click", handleClearSettings);
  btnDisconnect.addEventListener("click", handleDisconnect);

  // Folder controls
  btnNewFolder.addEventListener("click", () => {
    newFolderForm.classList.remove("hidden");
    newFolderName.value = "";
    newFolderName.focus();
    hideStatus(newFolderStatus);
  });
  btnCancelFolder.addEventListener("click", () => {
    newFolderForm.classList.add("hidden");
  });
  btnCreateFolder.addEventListener("click", handleCreateFolder);
  newFolderName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleCreateFolder();
  });
  btnRefreshFolders.addEventListener("click", () => loadFolders());

  // Drop zone click -> file picker
  dropZone.addEventListener("click", handleFilePicker);

  // Google Drive link
  driveLink.addEventListener("click", (e) => {
    e.stopPropagation(); // Don't trigger dropZone click
    handleGoogleDrivePicker();
  });

  // Upload controls
  btnUpload.addEventListener("click", () => {
    if (state.revertMode) handleRevert();
    else startUploadQueue();
  });
  btnStop.addEventListener("click", stopUploadQueue);
  btnClearFiles.addEventListener("click", clearFiles);

  // Single connection toggle
  const savedSingle = localStorage.getItem("singleConnection") === "true";
  singleConnectionEl.checked = savedSingle;
  if (savedSingle) {
    state.maxConcurrency = 1;
    state.concurrency = 1;
  }
  singleConnectionEl.addEventListener("change", () => {
    const single = singleConnectionEl.checked;
    localStorage.setItem("singleConnection", single);
    state.maxConcurrency = single ? 1 : 4;
    state.concurrency = single ? 1 : 4;
  });

  // Folder upload options (remembered)
  flatUploadEl.checked = localStorage.getItem("flatUpload") === "true";
  includeRootEl.checked = localStorage.getItem("includeRoot") === "true";
  flatUploadEl.addEventListener("change", () => {
    localStorage.setItem("flatUpload", flatUploadEl.checked);
  });
  includeRootEl.addEventListener("change", () => {
    localStorage.setItem("includeRoot", includeRootEl.checked);
  });
}

// ---------- Folder Modal ----------

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

// ---------- Revert Modal ----------

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

const DELETE_BATCH_SIZE = 50;

async function handleRevert() {
  const choice = await showRevertModal();
  if (!choice || (!choice.deleteFiles && !choice.deleteFolders)) return;

  const ledger = state.uploadLedger;
  if (!ledger) return;

  // Disable buttons during revert
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
            // Mark file as reverted in the file list (match by name + folder)
            const deletedName = r.path.split("/").pop();
            const deletedFolder = r.path.includes("/")
              ? r.path.substring(0, r.path.lastIndexOf("/"))
              : null;
            const match = state.files.find(f =>
              f.status === "done" &&
              f.name === deletedName &&
              (f.targetFolder ?? state.selectedFolder ?? null) === deletedFolder
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
  exitRevertMode();
  btnUpload.disabled = false;
  btnClearFiles.disabled = false;
  renderFileList();
  updateCounter();

  // Refresh folder tree if folders were deleted
  if (choice.deleteFolders) {
    try { await loadFolders(); } catch (e) { console.warn("[revert] folder refresh failed:", e); }
  }
}

// ---------- Drag & Drop (Tauri native) ----------

function setupDragDrop() {
  // Visual drag-over feedback using standard DOM events
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  });

  // Tauri native drag-drop event gives us real file paths
  listen("tauri://drag-drop", async (event) => {
    dropZone.classList.remove("drag-over");
    const paths = event.payload.paths || event.payload;
    if (!Array.isArray(paths) || paths.length === 0) return;

    // Separate files from directories
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

  // Also listen for drag-enter/drag-over for visual feedback via Tauri events
  listen("tauri://drag-over", () => {
    dropZone.classList.add("drag-over");
  });
  listen("tauri://drag-leave", () => {
    dropZone.classList.remove("drag-over");
  });
}

// ---------- Connection ----------

async function handleConnect() {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!apiUrl || !apiKey) {
    showStatus(connStatus, "Please enter both API URL and API Key.", "error");
    return;
  }

  btnConnect.disabled = true;
  showStatus(connStatus, "Connecting...", "connecting");

  try {
    await invoke("test_connection", { apiUrl, apiKey });

    state.apiUrl = apiUrl;
    state.apiKey = apiKey;
    state.connected = true;

    // Save settings
    await invoke("save_settings", { apiUrl, apiKey, folderPath: state.selectedFolder });

    showStatus(connStatus, "Connected successfully!", "success");

    // Switch to compact connected bar
    settingsCard.classList.add("hidden");
    connectedUrl.textContent = apiUrl.replace(/^https?:\/\//, "");
    connectedBar.classList.remove("hidden");
    workspace.classList.remove("hidden");

    await loadFolders();
  } catch (err) {
    showStatus(connStatus, "Connection failed: " + err, "error");
    state.connected = false;
  } finally {
    btnConnect.disabled = false;
  }
}

async function handleClearSettings() {
  try {
    await invoke("clear_settings");
  } catch (_) {}
  resetToDisconnected();
  apiUrlInput.value = "";
  apiKeyInput.value = "";
}

function handleDisconnect() {
  resetToDisconnected();
}

function resetToDisconnected() {
  state.uploadLedger = null;
  state.pendingCreatedFolders = [];
  state.apiUrl = "";
  state.apiKey = "";
  state.connected = false;
  state.selectedFolder = null;
  settingsCard.classList.remove("hidden");
  connectedBar.classList.add("hidden");
  workspace.classList.add("hidden");
  hideStatus(connStatus);
}

// ---------- Folders ----------

async function loadFolders() {
  folderTree.innerHTML = '<div class="folder-loading">Loading folders...</div>';

  try {
    const folders = await invoke("fetch_folders", {
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
    });
    state.folders = folders;
    renderFolderTree(folders);
  } catch (err) {
    folderTree.innerHTML = '<div class="folder-loading" style="color:var(--red)">Failed to load folders: ' + escapeHtml(String(err)) + "</div>";
  }
}

function buildTree(flatFolders) {
  // Each folder has { name, path } where path is like "folder/subfolder"
  // Build a nested tree structure
  const root = { name: "/", path: null, children: [] };
  const pathMap = { "": root };

  // Sort by path so parents come first
  const sorted = [...flatFolders].sort((a, b) => a.path.localeCompare(b.path));

  for (const folder of sorted) {
    const parts = folder.path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const parent = pathMap[parentPath] || root;

    const node = { name: folder.name, path: folder.path, children: [] };
    parent.children.push(node);
    pathMap[folder.path] = node;
  }

  return root;
}

function renderFolderTree(flatFolders) {
  const tree = buildTree(flatFolders);
  folderTree.innerHTML = "";

  // Render root item
  const rootEl = createFolderItem(tree, true);
  folderTree.appendChild(rootEl);

  // Update selection display
  updateSelectedDisplay();
}

function createFolderItem(node, isRoot) {
  const wrapper = document.createElement("div");

  const hasChildren = node.children.length > 0;
  const isSelected =
    (node.path === null && state.selectedFolder === null) ||
    (node.path !== null && state.selectedFolder === node.path);

  // The clickable row
  const row = document.createElement("div");
  row.className = "folder-item" + (isSelected ? " selected" : "");
  row.dataset.path = node.path === null ? "__root__" : node.path;

  // Toggle arrow
  const toggle = document.createElement("span");
  toggle.className = "folder-toggle" + (hasChildren ? " expanded" : " no-children");
  toggle.textContent = "\u25B6"; // right-pointing triangle
  row.appendChild(toggle);

  // Icon
  const icon = document.createElement("span");
  icon.className = "folder-icon";
  icon.textContent = isRoot ? "\uD83D\uDCC1" : "\uD83D\uDCC2";
  row.appendChild(icon);

  // Name
  const nameSpan = document.createElement("span");
  nameSpan.className = "folder-name";
  nameSpan.textContent = isRoot ? "/ (root)" : node.name;
  row.appendChild(nameSpan);

  wrapper.appendChild(row);

  // Children container
  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement("div");
    childrenEl.className = "folder-children";
    for (const child of node.children) {
      childrenEl.appendChild(createFolderItem(child, false));
    }
    wrapper.appendChild(childrenEl);
  }

  // Click to select
  row.addEventListener("click", (e) => {
    e.stopPropagation();

    // If clicking toggle area and has children, toggle collapse
    if (hasChildren && (e.target === toggle || e.target === icon)) {
      const isExpanded = toggle.classList.contains("expanded");
      toggle.classList.toggle("expanded", !isExpanded);
      childrenEl.classList.toggle("collapsed", isExpanded);
      return;
    }

    // Select this folder
    state.selectedFolder = node.path;
    updateSelectedDisplay();

    // Update visual selection
    folderTree.querySelectorAll(".folder-item").forEach((el) => el.classList.remove("selected"));
    row.classList.add("selected");

    // Persist selection
    invoke("save_settings", {
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
      folderPath: state.selectedFolder,
    }).catch(() => {});
  });

  // Double-click to toggle children
  if (hasChildren) {
    row.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const isExpanded = toggle.classList.contains("expanded");
      toggle.classList.toggle("expanded", !isExpanded);
      childrenEl.classList.toggle("collapsed", isExpanded);
    });
  }

  return wrapper;
}

function updateSelectedDisplay() {
  if (state.selectedFolder === null) {
    selectedDisplay.textContent = "/ (root)";
  } else {
    selectedDisplay.textContent = state.selectedFolder;
  }
}

async function handleCreateFolder() {
  const name = newFolderName.value.trim();
  if (!name) return;

  btnCreateFolder.disabled = true;
  hideStatus(newFolderStatus);

  try {
    await invoke("create_folder", {
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
      name: name,
      parentPath: state.selectedFolder,
    });
    showStatus(newFolderStatus, 'Folder "' + name + '" created.', "success");
    newFolderName.value = "";
    await loadFolders();
  } catch (err) {
    showStatus(newFolderStatus, "Error: " + err, "error");
  } finally {
    btnCreateFolder.disabled = false;
  }
}

// ---------- File Selection ----------

async function handleFilePicker() {
  try {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Supported Files",
          extensions: [
            "3ds", "dwf", "dwg", "dxf", "fbx", "glb", "obj", "skp", "stp", "igs", "plt", "hpgl",
            "ai", "eps", "svg", "cdr",
            "bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp", "avif", "heic", "hdr",
            "mkv", "mov", "mp4", "webm", "wmv", "hevc",
            "doc", "docx", "odt", "pdf", "txt",
            "csv", "ods", "xls", "xlsx",
            "ppt", "pptx", "key",
            "psd", "indd", "indt",
            "ggpkg",
            "zip",
            "max", "usdz", "vrm",
          ],
        },
        {
          name: "All Files",
          extensions: ["*"],
        },
      ],
    });

    if (selected && selected.length > 0) {
      await addFilesByPath(selected);
    }
  } catch (_) {
    // User cancelled
  }
}

async function addFilesByPath(paths) {
  for (const filePath of paths) {
    // Extract file name from path
    const parts = filePath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1];

    // Check for duplicates by path
    if (state.files.some((f) => f.path === filePath)) continue;

    const file = {
      id: state.nextFileId++,
      name: fileName,
      path: filePath,
      status: "queued",
      error: null,
      targetFolder: null,   // null = use state.selectedFolder
      relativeDir: "",      // "" = no subfolder
    };

    // Check file size
    try {
      const size = await invoke("get_file_size", { path: filePath });
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

function showInlineStatus(msg) {
  rateLimitMsg.textContent = msg;
  rateLimitMsg.className = "rate-limit-msg";
  rateLimitMsg.style.color = "";
  rateLimitMsg.title = "";
  rateLimitMsg.classList.remove("hidden");
  console.log("[folder-drop]", msg);
}

function hideInlineStatus() {
  rateLimitMsg.classList.add("hidden");
  rateLimitMsg.style.color = "";
}

function showInlineError(msg) {
  rateLimitMsg.textContent = msg;
  rateLimitMsg.className = "rate-limit-msg";
  rateLimitMsg.style.color = "var(--red)";
  rateLimitMsg.classList.remove("hidden");
  console.error("[folder-drop]", msg);
}

function resetDropState() {
  if (state.files.length === 0) {
    uploadControls.classList.add("hidden");
    dropZone.classList.remove("hidden");
  }
}

async function addFoldersByPath(dirPaths) {
  // Show centered spinner immediately
  dropZone.classList.add("hidden");
  uploadControls.classList.add("hidden");
  scanSpinner.classList.remove("hidden");
  scanSpinnerText.textContent = "Scanning folders...";

  // Scan all dropped directories
  let allScanned = [];
  for (const dirPath of dirPaths) {
    try {
      const scanned = await invoke("scan_directory", { path: dirPath });
      allScanned = allScanned.concat(scanned);
      scanSpinnerText.textContent = `Scanning... ${allScanned.length} files found`;
    } catch (err) {
      scanSpinner.classList.add("hidden");
      showInlineError("Failed to read folder: " + err);
      resetDropState();
      return;
    }
  }

  if (allScanned.length === 0) {
    scanSpinner.classList.add("hidden");
    resetDropState();
    return;
  }

  scanSpinner.classList.add("hidden");
  uploadControls.classList.remove("hidden");

  // Show folder options inside modal if there are subfolders
  const hasStructure = allScanned.some(f => f.relative_dir.length > 0);
  if (hasStructure) {
    folderModalOptions.classList.remove("hidden");
  } else {
    folderModalOptions.classList.add("hidden");
  }

  // Compute display destination
  const destName = state.selectedFolder
    ? state.selectedFolder.split("/").pop()
    : "/ (root)";

  // Build modal message
  let msg = `${allScanned.length} file(s) from ${dirPaths.length} folder(s) will be uploaded to "${destName}".`;

  const confirmed = await showFolderModal(msg);
  if (!confirmed) {
    resetDropState();
    return;
  }

  // Read toggle values AFTER user has had a chance to change them
  const includeRoot = includeRootEl.checked;
  const flatUpload = flatUploadEl.checked;

  // Determine root folder name(s) for "include root" option
  const rootNames = dirPaths.map(p =>
    p.replace(/\\/g, "/").split("/").filter(Boolean).pop()
  ).filter(Boolean);

  // Apply options to relative_dirs
  if (flatUpload && includeRoot) {
    // Flat inside root: all files go into root folder, no substructure
    for (const dirPath of dirPaths) {
      const rootName = dirPath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
      if (!rootName) continue;
      for (const f of allScanned) {
        if (f.absolute_path.startsWith(dirPath)) {
          f.relative_dir = rootName;
        }
      }
    }
  } else if (includeRoot) {
    // Full structure with root: prepend root folder name
    for (const dirPath of dirPaths) {
      const rootName = dirPath.replace(/\\/g, "/").split("/").filter(Boolean).pop();
      if (!rootName) continue;
      for (const f of allScanned) {
        if (f.absolute_path.startsWith(dirPath)) {
          f.relative_dir = f.relative_dir
            ? rootName + "/" + f.relative_dir
            : rootName;
        }
      }
    }
  } else if (flatUpload) {
    // Flat without root: clear all relative_dirs
    for (const f of allScanned) {
      f.relative_dir = "";
    }
  }
  // else: default — keep original relative_dirs (structure without root)

  // Collect unique subfolder paths including all intermediates (for proper revert)
  const leafDirs = new Set(
    allScanned.map(f => f.relative_dir).filter(d => d.length > 0)
  );
  const allPaths = new Set();
  for (const leaf of leafDirs) {
    const parts = leaf.split("/");
    for (let i = 1; i <= parts.length; i++) {
      allPaths.add(parts.slice(0, i).join("/"));
    }
  }
  const subfolders = [...allPaths];

  console.log("[folder-drop] Scanned:", allScanned.length, "files,", subfolders.length, "subfolders, flat:", flatUpload, "includeRoot:", includeRoot);

  // Create folders in Ergonode pre-flight
  if (subfolders.length > 0) {
    showInlineStatus(`Creating ${subfolders.length} folder(s) in Ergonode...`);
    console.log("[folder-drop] Creating folders:", subfolders);
    try {
      await invoke("create_folders_batch", {
        apiUrl: state.apiUrl,
        apiKey: state.apiKey,
        basePath: state.selectedFolder || null,
        relativePaths: subfolders,
      });
      console.log("[folder-drop] Folders created successfully");
    } catch (err) {
      showInlineError("Failed to create folders: " + err);
      return;
    }
    hideInlineStatus();

    // Remember ALL folders (including intermediates) for revert ledger
    state.pendingCreatedFolders = subfolders.map(rel => {
      return state.selectedFolder
        ? state.selectedFolder + "/" + rel
        : rel;
    });
  }

  // Add all files at once (size already included from Rust scan)
  console.log("[folder-drop] Queuing", allScanned.length, "files...");
  for (const scanned of allScanned) {
    if (state.files.some(f => f.path === scanned.absolute_path)) continue;

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

    if (scanned.size > MAX_FILE_SIZE) {
      file.status = "skipped";
      file.error = "File exceeds 100 MB limit";
    }

    state.files.push(file);
  }

  renderFileList();
  updateCounter();
}

// ---------- Google Drive Import ----------

async function handleGoogleDrivePicker() {
  // Show spinner
  dropZone.classList.add("hidden");
  scanSpinner.classList.remove("hidden");
  scanSpinnerText.textContent = "Waiting for Google authorization...";

  let result;
  try {
    result = await invoke("google_drive_pick_files");
  } catch (err) {
    scanSpinner.classList.add("hidden");
    dropZone.classList.remove("hidden");
    showInlineError("Google Drive: " + err);
    return;
  }

  const driveFiles = result.files;
  const accessToken = result.access_token;

  if (!driveFiles || driveFiles.length === 0) {
    scanSpinner.classList.add("hidden");
    dropZone.classList.remove("hidden");
    return;
  }

  scanSpinnerText.textContent = `Found ${driveFiles.length} file(s) from Google Drive`;

  // Check if any files have folder structure
  const hasStructure = driveFiles.some(f => f.relative_dir.length > 0);

  scanSpinner.classList.add("hidden");
  uploadControls.classList.remove("hidden");

  if (hasStructure) {
    // Show folder modal with options (reuse existing modal)
    folderModalOptions.classList.remove("hidden");

    const destName = state.selectedFolder
      ? state.selectedFolder.split("/").pop()
      : "/ (root)";

    const subfolderCount = new Set(
      driveFiles.map(f => f.relative_dir).filter(d => d.length > 0)
    ).size;

    const msg = `${driveFiles.length} file(s) from Google Drive will be uploaded to "${destName}".\n\n${subfolderCount} subfolder(s) detected.`;
    const confirmed = await showFolderModal(msg);
    if (!confirmed) {
      resetDropState();
      return;
    }

    // Read toggles after confirmation
    const includeRoot = includeRootEl.checked;
    const flatUpload = flatUploadEl.checked;

    // Apply flat upload — clear relative_dirs
    if (flatUpload && !includeRoot) {
      for (const f of driveFiles) f.relative_dir = "";
    } else if (flatUpload && includeRoot) {
      // Keep only root folder name (first segment)
      for (const f of driveFiles) {
        const root = f.relative_dir.split("/")[0];
        f.relative_dir = root || "";
      }
    }
    // includeRoot without flat: relative_dirs already have folder names from Rust

    // Collect subfolders and create in Ergonode
    const leafDirs = new Set(
      driveFiles.map(f => f.relative_dir).filter(d => d.length > 0)
    );
    const allPaths = new Set();
    for (const leaf of leafDirs) {
      const parts = leaf.split("/");
      for (let i = 1; i <= parts.length; i++) {
        allPaths.add(parts.slice(0, i).join("/"));
      }
    }
    const subfolders = [...allPaths];

    if (subfolders.length > 0) {
      showInlineStatus(`Creating ${subfolders.length} folder(s) in Ergonode...`);
      try {
        await invoke("create_folders_batch", {
          apiUrl: state.apiUrl,
          apiKey: state.apiKey,
          basePath: state.selectedFolder || null,
          relativePaths: subfolders,
        });
      } catch (err) {
        showInlineError("Failed to create folders: " + err);
        return;
      }
      hideInlineStatus();

      state.pendingCreatedFolders = subfolders.map(rel =>
        state.selectedFolder ? state.selectedFolder + "/" + rel : rel
      );
    }
  } else {
    folderModalOptions.classList.add("hidden");
  }

  // Queue files — download from Drive on upload (lazy download)
  for (const driveFile of driveFiles) {
    let targetFolder = null;
    if (driveFile.relative_dir) {
      targetFolder = state.selectedFolder
        ? state.selectedFolder + "/" + driveFile.relative_dir
        : driveFile.relative_dir;
    } else {
      targetFolder = state.selectedFolder || null;
    }

    const file = {
      id: state.nextFileId++,
      name: driveFile.name,
      path: "",                     // filled after download
      status: driveFile.size > MAX_FILE_SIZE ? "skipped" : "queued",
      error: driveFile.size > MAX_FILE_SIZE ? "File exceeds 100 MB limit" : null,
      targetFolder,
      relativeDir: driveFile.relative_dir,
      // Drive-specific fields
      driveFileId: driveFile.id,
      driveAccessToken: accessToken,
      isTempFile: false,
      tempPath: null,
    };

    state.files.push(file);
  }

  renderFileList();
  updateCounter();
  dropZone.classList.add("hidden");
}

// ---------- File List Rendering ----------

function renderFileList() {
  fileListEl.innerHTML = "";

  // During upload: only show uploading, failed, skipped (hide queued and done)
  const visibleFiles = state.uploading
    ? state.files.filter((f) => f.status === "uploading" || f.status === "failed" || f.status === "skipped")
    : state.files;

  for (const file of visibleFiles) {
    const row = document.createElement("div");
    row.className = "file-item";
    row.id = "file-" + file.id;

    // Relative directory prefix (for folder drops)
    if (file.relativeDir) {
      const pathEl = document.createElement("span");
      pathEl.className = "file-relative-dir";
      pathEl.textContent = file.relativeDir + "/";
      pathEl.title = file.relativeDir + "/" + file.name;
      row.appendChild(pathEl);
    }

    // File name
    const nameEl = document.createElement("span");
    nameEl.className = "file-name";
    nameEl.textContent = file.name;
    nameEl.title = file.path;
    row.appendChild(nameEl);

    // Progress bar
    const progressWrap = document.createElement("div");
    progressWrap.className = "file-progress-wrap";
    const progressOuter = document.createElement("div");
    progressOuter.className = "file-progress";
    const progressBar = document.createElement("div");
    progressBar.className = "file-progress-bar " + file.status;
    progressBar.id = "progress-" + file.id;
    progressOuter.appendChild(progressBar);
    progressWrap.appendChild(progressOuter);
    row.appendChild(progressWrap);

    // Status text
    const statusEl = document.createElement("span");
    statusEl.className = "file-status " + file.status;
    statusEl.id = "status-" + file.id;
    statusEl.textContent = statusLabel(file);
    if (file.error && file.status !== "skipped") {
      statusEl.title = file.error;
    }
    row.appendChild(statusEl);

    // Actions
    const actions = document.createElement("div");
    actions.className = "file-actions";

    if (file.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "btn btn-small btn-secondary";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => {
        file.status = "queued";
        file.error = null;
        renderFileList();
        updateCounter();
      });
      actions.appendChild(retryBtn);
    }

    if (file.status !== "uploading") {
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-small btn-danger";
      removeBtn.textContent = "\u00D7";
      removeBtn.title = "Remove";
      removeBtn.addEventListener("click", () => {
        state.files = state.files.filter((f) => f.id !== file.id);
        renderFileList();
        updateCounter();
        if (state.files.length === 0) {
          uploadControls.classList.add("hidden");
        }
      });
      actions.appendChild(removeBtn);
    }

    row.appendChild(actions);
    fileListEl.appendChild(row);
  }

  updateCounter();
}

function statusLabel(file) {
  switch (file.status) {
    case "queued":     return "Queued";
    case "uploading":  return "Uploading...";
    case "done":       return "Done";
    case "failed":     return file.error || "Failed";
    case "skipped":    return file.error || "Skipped";
    case "reverted":   return "Reverted";
    default:           return file.status;
  }
}

function updateFileRow(file) {
  const progressBar = document.getElementById("progress-" + file.id);
  const statusEl = document.getElementById("status-" + file.id);

  if (progressBar) {
    progressBar.className = "file-progress-bar " + file.status;
  }
  if (statusEl) {
    statusEl.className = "file-status " + file.status;
    statusEl.textContent = statusLabel(file);
    if (file.error) statusEl.title = file.error;
  }

  // Re-render for action buttons (retry/remove)
  if (file.status === "done" || file.status === "failed") {
    renderFileList();
  }
}

function updateCounter() {
  const total = state.files.length;
  const done = state.files.filter((f) => f.status === "done").length;
  uploadCounter.textContent = done + " / " + total + " complete";
}

function clearFiles() {
  if (state.uploading) return;
  // Clean up any remaining Drive temp files
  for (const file of state.files) {
    if (file.isTempFile && file.tempPath) {
      invoke("google_drive_delete_temp", { path: file.tempPath }).catch(() => {});
    }
  }
  state.files = [];
  state.uploadLedger = null;
  state.pendingCreatedFolders = [];
  exitRevertMode();
  fileListEl.innerHTML = "";
  uploadControls.classList.add("hidden");
  dropZone.classList.remove("hidden");
  updateCounter();
}

// ---------- Upload Queue ----------

function startUploadQueue() {
  if (state.uploading) return;

  const uploadable = state.files.filter((f) => f.status === "queued");
  if (uploadable.length === 0) return;

  state.uploading = true;
  state.stopping = false;
  state.paused = false;
  state.activeUploads = 0;
  state.uploadLedger = null;
  exitRevertMode();
  btnUpload.classList.add("hidden");
  btnClearFiles.classList.add("hidden");
  btnStop.classList.remove("hidden");
  rateLimitMsg.classList.add("hidden");
  singleConnectionEl.closest(".concurrency-toggle").classList.add("disabled");

  pumpQueue();
}

function stopUploadQueue() {
  state.stopping = true;
  btnStop.disabled = true;
  btnStop.textContent = "Stopping...";
}

function pumpQueue() {
  if (state.paused) return;
  if (state.stopping) {
    if (state.activeUploads === 0) finishQueue();
    return;
  }

  while (state.activeUploads < state.concurrency) {
    const next = state.files.find((f) => f.status === "queued");
    if (!next) break;

    state.activeUploads++;
    next.status = "uploading";
    updateFileRow(next);
    updateCounter();

    uploadSingleFile(next);
  }

  // Check if we're done
  if (state.activeUploads === 0) {
    finishQueue();
  }
}

async function uploadSingleFile(file) {
  // Download Drive files first
  if (file.driveFileId && !file.isTempFile) {
    try {
      const tempPath = await invoke("google_drive_download", {
        accessToken: file.driveAccessToken,
        fileId: file.driveFileId,
        fileName: file.name,
      });
      file.path = tempPath;
      file.tempPath = tempPath;
      file.isTempFile = true;
    } catch (err) {
      file.status = "failed";
      file.error = "Drive download failed: " + err;
      state.activeUploads--;
      updateFileRow(file);
      updateCounter();
      pumpQueue();
      return;
    }
  }

  try {
    const result = await invoke("upload_file", {
      apiUrl: state.apiUrl,
      apiKey: state.apiKey,
      filePath: file.path,
      fileName: file.name,
      folderPath: file.targetFolder !== null ? file.targetFolder : state.selectedFolder,
    });

    if (result.rate_limited) {
      // Rate limited: re-queue this file and pause
      file.status = "queued";
      updateFileRow(file);
      state.activeUploads--;
      handleRateLimit();
      return;
    }

    if (result.success) {
      file.status = "done";
      file.error = null;
      state.consecutiveSuccess++;
      // Clean up temp file for Drive downloads
      if (file.isTempFile && file.tempPath) {
        invoke("google_drive_delete_temp", { path: file.tempPath }).catch(() => {});
        file.tempPath = null;
      }
      updateFileRow(file);

      // After 10 consecutive successes, boost concurrency
      if (state.consecutiveSuccess >= 10 && state.concurrency < state.maxConcurrency) {
        state.concurrency++;
        state.backoff = 5000;
        state.consecutiveSuccess = 0;
      }
    } else {
      file.status = "failed";
      file.error = parseUploadError(result.error);
      state.consecutiveSuccess = 0;
      updateFileRow(file);
    }
  } catch (err) {
    file.status = "failed";
    file.error = parseUploadError(String(err));
    state.consecutiveSuccess = 0;
    updateFileRow(file);
  }

  state.activeUploads--;
  updateCounter();
  pumpQueue();
}

function handleRateLimit() {
  state.paused = true;
  state.consecutiveSuccess = 0;

  // Reduce concurrency (min 1)
  if (state.concurrency > 1) {
    state.concurrency--;
  }

  const delaySec = Math.round(state.backoff / 1000);
  let remaining = delaySec;

  const showCountdown = () => {
    rateLimitMsg.textContent = "Ergonode is busy, resuming in " + remaining + "s...";
    rateLimitMsg.classList.remove("hidden");
  };

  showCountdown();

  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      rateLimitMsg.classList.add("hidden");
      state.paused = false;

      // Exponential backoff: 5s -> 10s -> 20s -> 40s -> 60s cap
      state.backoff = Math.min(state.backoff * 2, 60000);

      pumpQueue();
    } else {
      showCountdown();
    }
  }, 1000);
}

function finishQueue() {
  state.uploading = false;
  state.stopping = false;
  state.paused = false;
  state.backoff = 5000;
  state.consecutiveSuccess = 0;
  state.concurrency = state.maxConcurrency;
  btnUpload.classList.remove("hidden");
  btnUpload.disabled = false;
  btnClearFiles.classList.remove("hidden");
  btnClearFiles.disabled = false;
  btnStop.classList.add("hidden");
  btnStop.disabled = false;
  btnStop.textContent = "Stop";
  rateLimitMsg.classList.add("hidden");
  singleConnectionEl.closest(".concurrency-toggle").classList.remove("disabled");

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

  // Switch Upload All button to Revert mode if ledger has content
  if (state.uploadLedger) {
    enterRevertMode();
  } else {
    exitRevertMode();
  }

  renderFileList();
  updateCounter();
}

// ---------- Revert Mode (swaps Upload All button) ----------

function enterRevertMode() {
  state.revertMode = true;
  btnUpload.textContent = "Revert Upload";
  btnUpload.className = "btn btn-revert";
  btnUpload.classList.remove("hidden");
}

function exitRevertMode() {
  state.revertMode = false;
  btnUpload.textContent = "Upload All";
  btnUpload.className = "btn btn-primary";
}

// ---------- Helpers ----------

function showStatus(el, msg, type) {
  el.textContent = msg;
  el.className = "status-message status-" + type;
  el.classList.remove("hidden");
}

function hideStatus(el) {
  el.classList.add("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Start ----------

init();
