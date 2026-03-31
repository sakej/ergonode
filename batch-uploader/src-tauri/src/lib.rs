mod config;
mod ergonode;
mod fs_utils;
mod google_drive;
mod token_storage;

use std::sync::Mutex;
use tokio::sync::oneshot;

use config::AppConfig;
use ergonode::{ErgonodeClient, FolderInfo, UploadResult, BatchDeleteResult};

/// Holds the cancel sender for an in-progress Google Drive auth flow.
struct AuthCancelState(Mutex<Option<oneshot::Sender<()>>>);

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

#[tauri::command]
fn is_google_drive_available() -> bool {
    google_drive::is_available()
}

#[tauri::command]
async fn google_drive_auth(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, AuthCancelState>,
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

    let result = google_drive::authenticate(app, rx).await;

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AuthCancelState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_settings, save_settings, clear_settings,
            test_connection, fetch_folders, create_folder, upload_file, get_file_size,
            scan_directory, is_directory, create_folders_batch, batch_delete,
            is_google_drive_available, google_drive_auth, google_drive_auth_cancel,
            google_drive_list_folder, google_drive_list_folder_recursive,
            google_drive_download, google_drive_delete_temp
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
