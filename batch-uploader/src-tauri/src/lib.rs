mod config;
mod credential_store;
mod ergonode;
mod fs_utils;
mod google_drive;

use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use config::AppConfig;
use credential_store::{CredentialBlobDto, CredentialStore};
use ergonode::{ErgonodeClient, FolderInfo, UploadResult, BatchDeleteResult};

/// Holds the cancel sender for an in-progress Google Drive auth flow.
struct AuthCancelState(Mutex<Option<oneshot::Sender<()>>>);

// ---------- Non-sensitive config (folder_path) ----------

#[tauri::command]
fn load_settings() -> AppConfig {
    config::load_config()
}

#[tauri::command]
fn save_settings(folder_path: Option<String>) -> Result<(), String> {
    let cfg = AppConfig { folder_path };
    config::save_config(&cfg)
}

#[tauri::command]
fn clear_settings() -> Result<(), String> {
    config::clear_config()
}

// ---------- Credential management ----------

#[tauri::command]
fn keychain_has_credentials() -> bool {
    CredentialStore::keychain_has_credentials()
}

#[tauri::command]
async fn load_from_keychain(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<CredentialBlobDto, String> {
    store.load_from_keychain().await
}

#[tauri::command]
async fn save_to_keychain(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<(), String> {
    store.save_to_keychain().await
}

#[tauri::command]
async fn delete_keychain_entry(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<(), String> {
    CredentialStore::delete_keychain_entry()?;
    store.clear().await;
    Ok(())
}

#[tauri::command]
async fn set_credentials(
    store: tauri::State<'_, Arc<CredentialStore>>,
    api_url: String,
    api_key: String,
    google_client_id: Option<String>,
    google_client_secret: Option<String>,
) -> Result<(), String> {
    store.set_all(api_url, api_key, google_client_id, google_client_secret).await;
    Ok(())
}

#[tauri::command]
async fn get_credentials(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<CredentialBlobDto, String> {
    Ok(store.get_dto().await)
}

#[tauri::command]
fn get_platform_label() -> &'static str {
    CredentialStore::platform_label()
}

// ---------- Ergonode API (reads credentials from state) ----------

#[tauri::command]
async fn test_connection(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<(), String> {
    let (api_url, api_key) = store.get_ergonode_credentials().await;
    if api_url.is_empty() || api_key.is_empty() {
        return Err("No credentials configured".to_string());
    }
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.test_connection().await
}

#[tauri::command]
async fn fetch_folders(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<Vec<FolderInfo>, String> {
    let (api_url, api_key) = store.get_ergonode_credentials().await;
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.fetch_folders().await
}

#[tauri::command]
async fn create_folder(
    store: tauri::State<'_, Arc<CredentialStore>>,
    name: String,
    parent_path: Option<String>,
) -> Result<(), String> {
    let (api_url, api_key) = store.get_ergonode_credentials().await;
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.create_folder(&name, parent_path.as_deref()).await
}

#[tauri::command]
async fn upload_file(
    store: tauri::State<'_, Arc<CredentialStore>>,
    file_path: String,
    file_name: String,
    folder_path: Option<String>,
) -> Result<UploadResult, String> {
    let (api_url, api_key) = store.get_ergonode_credentials().await;
    let client = ErgonodeClient::new(&api_url, &api_key);
    Ok(client.upload_file(&file_path, &file_name, folder_path.as_deref()).await)
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<fs_utils::ScannedFile>, String> {
    let p = std::path::Path::new(&path);
    if !p.is_dir() {
        return Err(format!("{} is not a directory", path));
    }
    fs_utils::scan_dir(p, p)
}

#[tauri::command]
fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[tauri::command]
async fn create_folders_batch(
    store: tauri::State<'_, Arc<CredentialStore>>,
    base_path: Option<String>,
    relative_paths: Vec<String>,
) -> Result<(), String> {
    let (api_url, api_key) = store.get_ergonode_credentials().await;
    let client = ErgonodeClient::new(&api_url, &api_key);
    client
        .create_folders_batch(base_path.as_deref(), &relative_paths)
        .await
}

#[tauri::command]
async fn batch_delete(
    store: tauri::State<'_, Arc<CredentialStore>>,
    paths: Vec<String>,
    delete_type: String,
) -> Result<BatchDeleteResult, String> {
    let (api_url, api_key) = store.get_ergonode_credentials().await;
    let client = ErgonodeClient::new(&api_url, &api_key);
    client.batch_delete(&paths, &delete_type).await
}

// ---------- Google Drive ----------

#[tauri::command]
async fn is_google_drive_available(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<bool, String> {
    Ok(store.is_google_drive_available().await)
}

#[tauri::command]
async fn google_drive_auth(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, AuthCancelState>,
    cred_store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<google_drive::AuthResult, String> {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = cancel_state.0.lock().unwrap();
        // Cancel any in-flight auth before starting a new one
        if let Some(old_tx) = guard.take() {
            let _ = old_tx.send(());
        }
        *guard = Some(tx);
    }

    let store = Arc::clone(&cred_store);
    let result = google_drive::authenticate(app, rx, store).await;

    // Clear sender after auth completes (success or fail)
    *cancel_state.0.lock().unwrap() = None;

    let access_token = result?;
    Ok(google_drive::AuthResult { access_token })
}

#[tauri::command]
fn google_drive_auth_cancel(cancel_state: tauri::State<'_, AuthCancelState>) {
    if let Some(tx) = cancel_state.0.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

#[tauri::command]
async fn google_drive_list_folder(
    access_token: String,
    folder_id: String,
) -> Result<Vec<google_drive::DriveItem>, String> {
    google_drive::list_folder(&access_token, &folder_id).await
}

#[tauri::command]
async fn google_drive_list_folder_recursive(
    access_token: String,
    folder_id: String,
    folder_name: String,
) -> Result<Vec<google_drive::DriveFileInfo>, String> {
    google_drive::list_folder_recursive_flat(&access_token, &folder_id, &folder_name).await
}

#[tauri::command]
async fn google_drive_download(
    access_token: String,
    file_id: String,
    file_name: String,
) -> Result<String, String> {
    google_drive::download_file(&file_id, &file_name, &access_token).await
}

#[tauri::command]
fn google_drive_delete_temp(path: String) {
    google_drive::delete_temp_file(&path);
}

#[tauri::command]
async fn google_drive_is_signed_in(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<bool, String> {
    Ok(google_drive::is_signed_in(&store).await)
}

#[tauri::command]
async fn google_drive_sign_out(
    store: tauri::State<'_, Arc<CredentialStore>>,
) -> Result<(), String> {
    google_drive::sign_out(&store).await
}

// ---------- App entry point ----------

pub fn run() {
    let cred_store = Arc::new(CredentialStore::new());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(cred_store.clone())
        .manage(AuthCancelState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            // Config
            load_settings, save_settings, clear_settings,
            // Credentials
            keychain_has_credentials, load_from_keychain, save_to_keychain,
            delete_keychain_entry, set_credentials, get_credentials, get_platform_label,
            // Ergonode API
            test_connection, fetch_folders, create_folder, upload_file, get_file_size,
            scan_directory, is_directory, create_folders_batch, batch_delete,
            // Google Drive
            is_google_drive_available, google_drive_auth, google_drive_auth_cancel,
            google_drive_list_folder, google_drive_list_folder_recursive,
            google_drive_download, google_drive_delete_temp,
            google_drive_is_signed_in, google_drive_sign_out
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if cred_store.is_dirty() {
                eprintln!("[credentials] Persisting dirty credentials on shutdown");
                if let Err(e) = cred_store.save_to_keychain_sync() {
                    eprintln!("[credentials] Shutdown save failed: {e}");
                }
            }
        }
    });
}
