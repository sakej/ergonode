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

  // Upload controls
  btnUpload.addEventListener("click", startUploadQueue);
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
  // Show scanning indicator immediately
  dropZone.classList.add("hidden");
  uploadControls.classList.remove("hidden");
  showInlineStatus("Scanning folders...");

  // Scan all dropped directories
  let allScanned = [];
  for (const dirPath of dirPaths) {
    try {
      const scanned = await invoke("scan_directory", { path: dirPath });
      allScanned = allScanned.concat(scanned);
      showInlineStatus(`Scanning... ${allScanned.length} files found`);
    } catch (err) {
      hideInlineStatus();
      showInlineError("Failed to read folder: " + err);
      resetDropState();
      return;
    }
  }

  if (allScanned.length === 0) {
    hideInlineStatus();
    resetDropState();
    return;
  }

  hideInlineStatus();

  // Collect unique relative subfolder paths (non-empty)
  const subfolders = [...new Set(
    allScanned
      .map(f => f.relative_dir)
      .filter(d => d.length > 0)
  )];

  // Compute display destination
  const destName = state.selectedFolder
    ? state.selectedFolder.split("/").pop()
    : "/ (root)";

  // Build modal message
  let msg = `This will create the folder structure inside "${destName}".`;
  if (subfolders.length > 0) msg += `\n\n${subfolders.length} subfolder(s) and `;
  else msg += `\n\n`;
  msg += `${allScanned.length} file(s) will be uploaded.`;

  console.log("[folder-drop] Scanned:", allScanned.length, "files,", subfolders.length, "subfolders");

  const confirmed = await showFolderModal(msg);
  if (!confirmed) {
    resetDropState();
    return;
  }

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

    // Remember folders for revert ledger
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
  state.files = [];
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

  renderFileList();
  updateCounter();
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
