use std::future::Future;
use std::pin::Pin;

use google_drive3::DriveHub;
use google_drive3::hyper_rustls;
use google_drive3::hyper_util;
use google_drive3::yup_oauth2;
use serde::Serialize;

/// Custom delegate that opens the browser for OAuth.
/// yup_oauth2 only prints the URL to stdout by default.
struct BrowserDelegate;

impl yup_oauth2::authenticator_delegate::InstalledFlowDelegate for BrowserDelegate {
    fn present_user_url<'a>(
        &'a self,
        url: &'a str,
        _need_code: bool,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            eprintln!("[google-drive] Opening browser for auth: {url}");
            if let Err(e) = open::that(url) {
                eprintln!("[google-drive] Failed to open browser: {e}");
                eprintln!("[google-drive] Please open this URL manually: {url}");
            } else {
                eprintln!("[google-drive] Browser opened successfully");
            }
            // For HTTPRedirect flow, the return value is not used
            Ok(String::new())
        })
    }
}

/// Compile-time Client ID and Secret (set via env vars at build time)
const CLIENT_ID: Option<&str> = option_env!("GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_CLIENT_SECRET");

/// Type alias for the connector used throughout this module.
type HttpsConnector = hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>;

/// File info returned to the frontend
#[derive(Serialize, Clone, Debug)]
pub struct DriveFileInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
    /// Relative folder path, e.g. "photos/winter". Empty = top level.
    pub relative_dir: String,
}

/// Result from the picker flow — files + access token for subsequent downloads
#[derive(Serialize)]
pub struct PickerResult {
    pub files: Vec<DriveFileInfo>,
    pub access_token: String,
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

/// Run the full OAuth + file listing flow.
/// Returns a list of files ready for download.
pub async fn pick_and_list_files() -> Result<PickerResult, String> {
    eprintln!("[google-drive] pick_and_list_files called");
    let client_id = CLIENT_ID.ok_or("Google Drive is not configured")?;
    eprintln!("[google-drive] Client ID present: {}", !client_id.is_empty());
    if client_id.is_empty() {
        return Err("Google Drive Client ID is empty".to_string());
    }

    // Build ApplicationSecret for yup-oauth2
    let secret = yup_oauth2::ApplicationSecret {
        client_id: client_id.to_string(),
        client_secret: CLIENT_SECRET.unwrap_or("").to_string(),
        token_uri: "https://oauth2.googleapis.com/token".to_string(),
        auth_uri: "https://accounts.google.com/o/oauth2/v2/auth?prompt=consent&trigger_onepick=true&allow_multiple=true".to_string(),
        redirect_uris: Vec::new(),
        project_id: None,
        client_email: None,
        auth_provider_x509_cert_url: None,
        client_x509_cert_url: None,
    };

    // Build authenticator — opens browser, listens on localhost
    let auth_connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_native_roots()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .https_or_http()
        .enable_http2()
        .build();
    let auth_client = hyper_util::client::legacy::Client::builder(
        hyper_util::rt::TokioExecutor::new(),
    )
    .build(auth_connector);

    let auth = yup_oauth2::InstalledFlowAuthenticator::with_client(
        secret,
        yup_oauth2::InstalledFlowReturnMethod::HTTPRedirect,
        yup_oauth2::client::CustomHyperClientBuilder::from(auth_client),
    )
    .flow_delegate(Box::new(BrowserDelegate))
    .build()
    .await
    .map_err(|e| format!("OAuth setup failed: {e}"))?;

    eprintln!("[google-drive] Auth built, building DriveHub...");

    // Build the Drive API hub (separate client instance)
    let hub_connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_native_roots()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .https_or_http()
        .enable_http2()
        .build();
    let hub_client = hyper_util::client::legacy::Client::builder(
        hyper_util::rt::TokioExecutor::new(),
    )
    .build(hub_connector);

    let hub = DriveHub::new(hub_client, auth);

    eprintln!("[google-drive] DriveHub built, listing files...");

    // List all files the user granted access to (paginated)
    let mut all_files: Vec<DriveFileInfo> = Vec::new();
    let mut page_token: Option<String> = None;
    let mut total_raw = 0usize;
    let mut skipped_native = 0usize;
    let mut skipped_folder = 0usize;
    let mut skipped_ext = 0usize;

    loop {
        let mut req = hub
            .files()
            .list()
            .q("mimeType != 'application/vnd.google-apps.folder' and 'me' in owners and trashed = false")
            .page_size(1000)
            .param("fields", "nextPageToken,files(id,name,size,mimeType)")
            .add_scope("https://www.googleapis.com/auth/drive.readonly");

        if let Some(ref token) = page_token {
            req = req.page_token(token);
        }

        eprintln!("[google-drive] Calling files().list().doit()...");
        let doit_result = req.doit().await;
        if let Err(ref e) = doit_result {
            eprintln!("[google-drive] doit() error: {e:?}");
        }
        let (_, file_list) = doit_result
            .map_err(|e| format!("Failed to list Drive files: {e}"))?;

        if let Some(files) = file_list.files {
            eprintln!("[google-drive] Page returned {} files", files.len());
            for file in files {
                total_raw += 1;
                let name = file.name.unwrap_or_default();
                let mime_type = file.mime_type.clone().unwrap_or_default();
                let id = file.id.unwrap_or_default();

                eprintln!("[google-drive]   file: {name} | mime: {mime_type} | id: {id}");

                if is_google_native_format(&mime_type) {
                    skipped_native += 1;
                    eprintln!("[google-drive]     -> skipped (Google native format)");
                    continue;
                }

                if mime_type == "application/vnd.google-apps.folder" {
                    // Skip folders for now — listing all Drive files is already slow.
                    // TODO: add Drive folder browser UI so user picks a specific folder to import
                    continue;
                }

                if !is_supported_extension(&name) {
                    skipped_ext += 1;
                    eprintln!("[google-drive]     -> skipped (unsupported extension)");
                    continue;
                }

                let size = file.size.unwrap_or(0) as u64;

                all_files.push(DriveFileInfo {
                    id,
                    name,
                    size,
                    mime_type,
                    relative_dir: String::new(),
                });
            }
        }

        page_token = file_list.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    eprintln!(
        "[google-drive] Done. Total raw: {total_raw}, accepted: {}, skipped: native={skipped_native} folder={skipped_folder} ext={skipped_ext}",
        all_files.len()
    );

    // Get the access token for later downloads (auth already happened via files().list())
    let scopes = &["https://www.googleapis.com/auth/drive.readonly"];
    let access_token = hub
        .auth
        .get_token(scopes)
        .await
        .map_err(|e| format!("Failed to get access token: {e}"))?
        .ok_or_else(|| "No access token returned".to_string())?;

    eprintln!("[google-drive] Got access token for downloads");

    Ok(PickerResult { files: all_files, access_token })
}

/// Recursively list all files in a Drive folder, building relative_dir paths.
/// Uses Box::pin to allow async recursion.
fn list_folder_recursive<'a>(
    hub: &'a DriveHub<HttpsConnector>,
    folder_id: &'a str,
    folder_path: &'a str,
) -> Pin<Box<dyn Future<Output = Result<Vec<DriveFileInfo>, String>> + Send + 'a>> {
    Box::pin(async move {
        let mut results = Vec::new();
        let mut page_token: Option<String> = None;

        loop {
            let query = format!("'{}' in parents and trashed = false", folder_id);
            let mut req = hub
                .files()
                .list()
                .q(&query)
                .page_size(1000)
                .param("fields", "nextPageToken,files(id,name,size,mimeType)")
                .add_scope("https://www.googleapis.com/auth/drive.readonly");

            if let Some(ref token) = page_token {
                req = req.page_token(token);
            }

            let (_, file_list) = req
                .doit()
                .await
                .map_err(|e| format!("Failed to list folder '{}': {}", folder_path, e))?;

            if let Some(files) = file_list.files {
                for file in files {
                    let name = file.name.unwrap_or_default();
                    let mime_type = file.mime_type.clone().unwrap_or_default();
                    let id = file.id.unwrap_or_default();

                    if is_google_native_format(&mime_type) {
                        continue;
                    }

                    if mime_type == "application/vnd.google-apps.folder" {
                        let sub_path = format!("{}/{}", folder_path, name);
                        let sub_files = list_folder_recursive(hub, &id, &sub_path).await?;
                        results.extend(sub_files);
                        continue;
                    }

                    if !is_supported_extension(&name) {
                        continue;
                    }

                    let size = file.size.unwrap_or(0) as u64;

                    results.push(DriveFileInfo {
                        id,
                        name,
                        size,
                        mime_type,
                        relative_dir: folder_path.to_string(),
                    });
                }
            }

            page_token = file_list.next_page_token;
            if page_token.is_none() {
                break;
            }
        }

        Ok(results)
    })
}

/// Download a Drive file to OS temp directory.
/// Returns the absolute path of the downloaded temp file.
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

/// Delete a temp file (silently ignore if not found).
pub fn delete_temp_file(path: &str) {
    let _ = std::fs::remove_file(path);
}
