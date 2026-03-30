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
  maxConcurrency: 4,
  concurrency: 4,
  activeUploads: 0,
  backoff: 5000,        // ms — current backoff delay
  consecutiveSuccess: 0,
  paused: false,
  pauseTimer: null,
};

const MAX_FILE_SIZE = 104857600; // 100 MB

// ---------- DOM refs ----------

const $ = (sel) => document.querySelector(sel);
const apiUrlInput     = $("#api-url");
const apiKeyInput     = $("#api-key");
const toggleKeyBtn    = $("#toggle-key");
const eyeIcon         = $("#eye-icon");
const btnConnect      = $("#btn-connect");
const btnClear        = $("#btn-clear");
const connStatus      = $("#connection-status");
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
const btnUpload       = $("#btn-upload");
const btnClearFiles   = $("#btn-clear-files");

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
  btnClearFiles.addEventListener("click", clearFiles);
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
    if (Array.isArray(paths) && paths.length > 0) {
      await addFilesByPath(paths);
    }
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
  apiUrlInput.value = "";
  apiKeyInput.value = "";
  state.apiUrl = "";
  state.apiKey = "";
  state.connected = false;
  state.selectedFolder = null;
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
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico"],
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
}

// ---------- File List Rendering ----------

function renderFileList() {
  fileListEl.innerHTML = "";

  for (const file of state.files) {
    const row = document.createElement("div");
    row.className = "file-item";
    row.id = "file-" + file.id;

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
    case "failed":     return "Failed";
    case "skipped":    return "Skipped";
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
  updateCounter();
}

// ---------- Upload Queue ----------

function startUploadQueue() {
  if (state.uploading) return;

  const uploadable = state.files.filter((f) => f.status === "queued");
  if (uploadable.length === 0) return;

  state.uploading = true;
  state.paused = false;
  state.activeUploads = 0;
  btnUpload.disabled = true;
  btnClearFiles.disabled = true;
  rateLimitMsg.classList.add("hidden");

  pumpQueue();
}

function pumpQueue() {
  if (state.paused) return;

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
      folderPath: state.selectedFolder,
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
      file.error = result.error || "Unknown error";
      state.consecutiveSuccess = 0;
      updateFileRow(file);
    }
  } catch (err) {
    file.status = "failed";
    file.error = String(err);
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
  state.paused = false;
  state.backoff = 5000;
  state.consecutiveSuccess = 0;
  state.concurrency = state.maxConcurrency;
  btnUpload.disabled = false;
  btnClearFiles.disabled = false;
  rateLimitMsg.classList.add("hidden");
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
