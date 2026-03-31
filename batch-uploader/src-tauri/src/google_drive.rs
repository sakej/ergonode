use std::future::Future;
use std::pin::Pin;

use google_drive3::hyper_rustls;
use google_drive3::hyper_util;
use google_drive3::yup_oauth2;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::token_storage::KeychainTokenStorage;

/// Custom delegate that opens the browser for OAuth and emits the URL to the frontend.
struct BrowserDelegate {
    app: AppHandle,
}

impl yup_oauth2::authenticator_delegate::InstalledFlowDelegate for BrowserDelegate {
    fn present_user_url<'a>(
        &'a self,
        url: &'a str,
        _need_code: bool,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        let app = self.app.clone();
        Box::pin(async move {
            eprintln!("[google-drive] Opening browser for auth: {url}");

            // Emit URL to frontend for the fallback link
            let _ = app.emit("google-drive-auth-url", url);

            if let Err(e) = open::that(url) {
                eprintln!("[google-drive] Failed to open browser: {e}");
            }
            Ok(String::new())
        })
    }
}

/// Compile-time Client ID and Secret (set via env vars at build time)
const CLIENT_ID: Option<&str> = option_env!("GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_CLIENT_SECRET");

const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly";

/// A single item (file or folder) in a Drive listing
#[derive(Serialize, Clone, Debug)]
pub struct DriveItem {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub is_folder: bool,
}

/// Check if the Google Drive feature is available (Client ID is embedded)
pub fn is_available() -> bool {
    CLIENT_ID.map(|s| !s.is_empty()).unwrap_or(false)
}

/// Supported file extensions (same as the app's file picker filter)
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "3ds", "dwf", "dwg", "dxf", "fbx", "glb", "obj", "skp", "stp", "igs", "plt", "hpgl",
    "ai", "eps", "svg", "cdr",
    "bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp", "avif", "heic", "hdr",
    "mkv", "mov", "mp4", "webm", "wmv", "hevc",
    "doc", "docx", "odt", "pdf", "txt",
    "csv", "ods", "xls", "xlsx",
    "ppt", "pptx", "key",
    "psd", "indd", "indt",
    "ggpkg", "zip",
    "max", "usdz", "vrm",
];

fn is_supported_extension(name: &str) -> bool {
    name.rsplit('.')
        .next()
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_google_native_format(mime_type: &str) -> bool {
    mime_type.starts_with("application/vnd.google-apps.")
        && mime_type != "application/vnd.google-apps.folder"
}

// ---------- OAuth ----------

/// Run OAuth flow — uses cached token if available, otherwise opens browser.
/// Supports cancellation via the provided oneshot receiver.
pub async fn authenticate(app: AppHandle, cancel_rx: oneshot::Receiver<()>) -> Result<String, String> {
    let client_id = CLIENT_ID.ok_or("Google Drive is not configured")?;
    if client_id.is_empty() {
        return Err("Google Drive Client ID is empty".to_string());
    }

    // Build first authenticator with persistent storage
    let auth = build_auth(client_id, app.clone()).await?;

    // Race: auth token vs cancel signal.
    // Dropping auth.token() on cancel is safe — yup_oauth2's internal HTTP
    // server runs in a spawned task that shuts itself down when its channels close.
    let token_result = tokio::select! {
        result = auth.token(&[DRIVE_SCOPE]) => result,
        _ = cancel_rx => {
            return Err("Auth cancelled".to_string());
        }
    };

    // If failed with a cached token, clear and retry once (stale refresh token)
    let token = match token_result {
        Ok(t) => t,
        Err(e) => {
            let checker = KeychainTokenStorage::new();
            if checker.has_token(&[DRIVE_SCOPE]) {
                eprintln!("[google-drive] Token refresh failed ({e}), clearing cache and retrying");
                checker.delete_token(&[DRIVE_SCOPE]);
                let auth2 = build_auth(client_id, app.clone()).await?;
                auth2.token(&[DRIVE_SCOPE]).await
                    .map_err(|e| format!("OAuth failed: {e}"))?
            } else {
                return Err(format!("OAuth failed: {e}"));
            }
        }
    };

    let access_token = token
        .token()
        .ok_or("No access token returned")?
        .to_string();

    // Bring the app to the foreground
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    eprintln!("[google-drive] Auth complete, got access token");
    Ok(access_token)
}

/// Build a fresh yup_oauth2 authenticator with keychain-backed storage.
async fn build_auth(client_id: &str, app: AppHandle) -> Result<
    yup_oauth2::authenticator::Authenticator<
        hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
    >,
    String,
> {
    let secret = yup_oauth2::ApplicationSecret {
        client_id: client_id.to_string(),
        client_secret: CLIENT_SECRET.unwrap_or("").to_string(),
        token_uri: "https://oauth2.googleapis.com/token".to_string(),
        auth_uri: "https://accounts.google.com/o/oauth2/v2/auth?prompt=consent".to_string(),
        redirect_uris: Vec::new(),
        project_id: None,
        client_email: None,
        auth_provider_x509_cert_url: None,
        client_x509_cert_url: None,
    };

    let connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_native_roots()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .https_or_http()
        .enable_http2()
        .build();
    let client = hyper_util::client::legacy::Client::builder(
        hyper_util::rt::TokioExecutor::new(),
    )
    .build(connector);

    yup_oauth2::InstalledFlowAuthenticator::with_client(
        secret,
        yup_oauth2::InstalledFlowReturnMethod::HTTPRedirect,
        yup_oauth2::client::CustomHyperClientBuilder::from(client),
    )
    .with_storage(Box::new(KeychainTokenStorage::new()))
    .flow_delegate(Box::new(BrowserDelegate { app }))
    .build()
    .await
    .map_err(|e| format!("OAuth setup failed: {e}"))
}

// ---------- Drive API via reqwest ----------

#[derive(Deserialize)]
struct FileListResponse {
    files: Option<Vec<FileResource>>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct FileResource {
    id: Option<String>,
    name: Option<String>,
    size: Option<String>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

/// List contents of a Drive folder (or root if folder_id is "root").
/// Returns folders + supported files. Skips Google-native formats.
pub async fn list_folder(access_token: &str, folder_id: &str) -> Result<Vec<DriveItem>, String> {
    let client = reqwest::Client::new();
    let mut all_items: Vec<DriveItem> = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let q = format!("'{}' in parents and trashed = false", folder_id);
        let mut params = vec![
            ("q", q.as_str()),
            ("pageSize", "1000"),
            ("fields", "nextPageToken,files(id,name,size,mimeType)"),
            ("orderBy", "folder,name"),
        ];

        let pt_string;
        if let Some(ref token) = page_token {
            pt_string = token.clone();
            params.push(("pageToken", &pt_string));
        }

        let resp = client
            .get("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(access_token)
            .query(&params)
            .send()
            .await
            .map_err(|e| format!("Drive API error: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Drive API failed ({status}): {body}"));
        }

        let file_list: FileListResponse = resp
            .json()
            .await
            .map_err(|e| format!("Drive API parse error: {e}"))?;

        if let Some(files) = file_list.files {
            for file in files {
                let name = file.name.unwrap_or_default();
                let mime_type = file.mime_type.unwrap_or_default();
                let id = file.id.unwrap_or_default();

                // Skip Google-native formats (Docs, Sheets, etc.)
                if is_google_native_format(&mime_type) {
                    continue;
                }

                let is_folder = mime_type == "application/vnd.google-apps.folder";

                // Skip unsupported file extensions (but keep folders)
                if !is_folder && !is_supported_extension(&name) {
                    continue;
                }

                let size: u64 = file
                    .size
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);

                all_items.push(DriveItem {
                    id,
                    name,
                    size,
                    mime_type,
                    is_folder,
                });
            }
        }

        page_token = file_list.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    Ok(all_items)
}

/// Recursively list all files in a folder, building relative_dir paths.
/// Used when user selects a folder for import.
pub async fn list_folder_recursive_flat(
    access_token: &str,
    folder_id: &str,
    folder_path: &str,
) -> Result<Vec<DriveFileInfo>, String> {
    let items = list_folder(access_token, folder_id).await?;
    let mut results: Vec<DriveFileInfo> = Vec::new();

    for item in items {
        if item.is_folder {
            let sub_path = if folder_path.is_empty() {
                item.name.clone()
            } else {
                format!("{}/{}", folder_path, item.name)
            };
            let sub_files = Box::pin(list_folder_recursive_flat(access_token, &item.id, &sub_path)).await?;
            results.extend(sub_files);
        } else {
            results.push(DriveFileInfo {
                id: item.id,
                name: item.name,
                size: item.size,
                mime_type: item.mime_type,
                relative_dir: folder_path.to_string(),
            });
        }
    }

    Ok(results)
}

// ---------- Types for the frontend ----------

/// File info with relative_dir for folder structure
#[derive(Serialize, Clone, Debug)]
pub struct DriveFileInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    pub relative_dir: String,
}

/// Auth result
#[derive(Serialize)]
pub struct AuthResult {
    pub access_token: String,
}

/// Import result — files ready for download + upload
#[derive(Serialize)]
pub struct ImportResult {
    pub files: Vec<DriveFileInfo>,
    pub access_token: String,
}

// ---------- Download ----------

/// Download a Drive file to OS temp directory.
pub async fn download_file(
    file_id: &str,
    file_name: &str,
    access_token: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://www.googleapis.com/drive/v3/files/{}?alt=media",
        file_id
    );

    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Drive download error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Drive download failed ({status}): {body}"));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Download read error: {e}"))?;

    let safe_name = file_name.replace(['/', '\\', ':'], "_");
    let temp_path = std::env::temp_dir().join(format!("ergonode_drive_{}_{}", file_id, safe_name));
    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| format!("Cannot write temp file: {e}"))?;

    Ok(temp_path.to_string_lossy().to_string())
}

// ---------- Sign out ----------

/// Check if a Google OAuth token exists in storage.
pub fn is_signed_in() -> bool {
    let storage = KeychainTokenStorage::new();
    storage.has_token(&[DRIVE_SCOPE])
}

/// Sign out of Google Drive — delete cached token and revoke it.
pub async fn sign_out() -> Result<(), String> {
    let storage = KeychainTokenStorage::new();
    let token_info = storage.delete_token(&[DRIVE_SCOPE]);

    // Best-effort revoke — try access token, fall back to refresh token
    if let Some(info) = token_info {
        let revoke_token = info.access_token.as_deref()
            .or(info.refresh_token.as_deref());

        if let Some(token) = revoke_token {
            let client = reqwest::Client::new();
            let _ = client
                .post("https://oauth2.googleapis.com/revoke")
                .form(&[("token", token)])
                .send()
                .await;
            eprintln!("[google-drive] Token revoked");
        }
    }

    eprintln!("[google-drive] Signed out");
    Ok(())
}

/// Delete a temp file (silently ignore if not found).
/// Only deletes files within the OS temp directory that were created by this app.
pub fn delete_temp_file(path: &str) {
    let path = std::path::Path::new(path);
    if let Ok(canonical) = path.canonicalize() {
        if canonical.starts_with(std::env::temp_dir())
            && canonical
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("ergonode_drive_"))
                .unwrap_or(false)
        {
            let _ = std::fs::remove_file(canonical);
        }
    }
}
