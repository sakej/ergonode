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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, clear_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
