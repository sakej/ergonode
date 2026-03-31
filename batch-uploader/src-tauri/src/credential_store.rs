use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use google_drive3::yup_oauth2::storage::{TokenInfo, TokenStorage, TokenStorageError};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

const KEYRING_SERVICE: &str = "com.ergonode.uploader";
const KEYRING_KEY: &str = "credentials";

// ---------- Data model ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CredentialBlob {
    #[serde(default)]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub google_tokens: HashMap<String, TokenInfo>,
}

/// DTO sent to frontend — exposes all fields except google_tokens
/// (replaced by has_google_token boolean). api_key and google_client_secret
/// are included so the frontend can populate form fields after keychain load.
#[derive(Serialize)]
pub struct CredentialBlobDto {
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
    pub has_google_token: bool,
}

impl From<&CredentialBlob> for CredentialBlobDto {
    fn from(blob: &CredentialBlob) -> Self {
        Self {
            api_url: blob.api_url.clone(),
            api_key: blob.api_key.clone(),
            google_client_id: blob.google_client_id.clone(),
            google_client_secret: blob.google_client_secret.clone(),
            has_google_token: !blob.google_tokens.is_empty(),
        }
    }
}

// ---------- Credential store ----------

pub struct CredentialStore {
    blob: RwLock<CredentialBlob>,
    dirty: AtomicBool,
    legacy_migrated: AtomicBool,
}

impl CredentialStore {
    pub fn new() -> Self {
        Self {
            blob: RwLock::new(CredentialBlob::default()),
            dirty: AtomicBool::new(false),
            legacy_migrated: AtomicBool::new(false),
        }
    }

    /// Load all credentials from OS keychain (single read).
    /// Falls back to file if keychain unavailable.
    /// Exactly one keychain access — legacy migration only runs on first
    /// save (not here) to avoid extra keychain prompts.
    pub async fn load_from_keychain(&self) -> Result<CredentialBlobDto, String> {
        let blob = Self::read_blob()?;
        let dto = CredentialBlobDto::from(&blob);
        *self.blob.write().await = blob;
        self.dirty.store(false, Ordering::Release);
        Ok(dto)
    }

    /// Save current in-memory blob to OS keychain (single write).
    /// Falls back to file if keychain unavailable.
    /// Also runs one-time legacy keychain cleanup (probe entry, old token entries)
    /// bundled with the save so it doesn't add extra prompts.
    pub async fn save_to_keychain(&self) -> Result<(), String> {
        // One-time legacy cleanup (runs in same keychain session as the write)
        if !self.legacy_migrated.load(Ordering::Acquire) {
            cleanup_legacy_probe();
            migrate_legacy_keychain_token_cleanup_only();
            self.legacy_migrated.store(true, Ordering::Release);
        }

        let blob = self.blob.read().await;
        Self::write_blob(&blob)?;
        self.dirty.store(false, Ordering::Release);
        Ok(())
    }

    /// Delete the keychain entry entirely.
    pub fn delete_keychain_entry() -> Result<(), String> {
        let mut errors = Vec::new();

        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY) {
            if let Err(e) = entry.delete_credential() {
                // NoEntry is fine — means already deleted
                if !matches!(e, keyring::Error::NoEntry) {
                    errors.push(format!("Keychain delete failed: {e}"));
                }
            }
        }

        // Also delete file fallback
        let path = Self::fallback_path();
        if path.exists() {
            if let Err(e) = fs::remove_file(&path) {
                errors.push(format!("File delete failed: {e}"));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    /// Get Ergonode credentials from memory.
    pub async fn get_ergonode_credentials(&self) -> (String, String) {
        let blob = self.blob.read().await;
        (
            blob.api_url.clone().unwrap_or_default(),
            blob.api_key.clone().unwrap_or_default(),
        )
    }

    /// Update Google client credentials in memory.
    pub async fn set_google_client(&self, client_id: Option<String>, client_secret: Option<String>) {
        let mut blob = self.blob.write().await;
        blob.google_client_id = client_id;
        blob.google_client_secret = client_secret;
        self.dirty.store(true, Ordering::Release);
    }

    /// Get Google client ID from memory, falling back to compile-time env var.
    pub async fn get_google_client_id(&self) -> Option<String> {
        let blob = self.blob.read().await;
        blob.google_client_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| {
                option_env!("GOOGLE_CLIENT_ID")
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            })
    }

    /// Get Google client secret from memory, falling back to compile-time env var.
    pub async fn get_google_client_secret(&self) -> String {
        let blob = self.blob.read().await;
        blob.google_client_secret
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(option_env!("GOOGLE_CLIENT_SECRET"))
            .unwrap_or("")
            .to_string()
    }

    /// Check if Google Drive is available (client ID exists from any source).
    pub async fn is_google_drive_available(&self) -> bool {
        self.get_google_client_id().await.is_some()
    }

    /// Check if a Google OAuth token exists in memory (no keychain access).
    pub async fn has_google_token(&self, scopes: &[&str]) -> bool {
        let key = Self::scope_key(scopes);
        let blob = self.blob.read().await;
        blob.google_tokens.contains_key(&key)
    }

    /// Delete Google OAuth token from memory. Returns token info for revocation.
    pub async fn delete_google_token(&self, scopes: &[&str]) -> Option<TokenInfo> {
        let key = Self::scope_key(scopes);
        let mut blob = self.blob.write().await;
        let token = blob.google_tokens.remove(&key);
        if token.is_some() {
            self.dirty.store(true, Ordering::Release);
        }
        token
    }

    /// Set full credentials from frontend (manual entry or loaded from keychain).
    pub async fn set_all(
        &self,
        api_url: String,
        api_key: String,
        google_client_id: Option<String>,
        google_client_secret: Option<String>,
    ) {
        let mut blob = self.blob.write().await;
        blob.version = 1;
        blob.api_url = Some(api_url);
        blob.api_key = Some(api_key);
        blob.google_client_id = google_client_id;
        blob.google_client_secret = google_client_secret;
        self.dirty.store(true, Ordering::Release);
    }

    /// Get DTO for frontend display.
    pub async fn get_dto(&self) -> CredentialBlobDto {
        let blob = self.blob.read().await;
        CredentialBlobDto::from(&*blob)
    }

    /// Save current in-memory blob to OS keychain (synchronous).
    /// Used for shutdown hook where async context may be unavailable.
    pub fn save_to_keychain_sync(&self) -> Result<(), String> {
        let blob = self.blob.try_read()
            .map_err(|_| "Could not acquire lock for shutdown save")?;
        Self::write_blob(&blob)?;
        self.dirty.store(false, Ordering::Release);
        Ok(())
    }

    /// Check if in-memory blob has unsaved changes.
    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::Acquire)
    }

    /// Load a pre-built blob into memory (used for migration).
    pub async fn load_migrated_blob(&self, blob: CredentialBlob) {
        *self.blob.write().await = blob;
        self.dirty.store(true, Ordering::Release);
    }

    /// Clear all in-memory credentials.
    pub async fn clear(&self) {
        *self.blob.write().await = CredentialBlob::default();
        self.dirty.store(false, Ordering::Release);
    }

    /// Platform-aware label for keychain storage.
    pub fn platform_label() -> &'static str {
        if cfg!(target_os = "macos") {
            "Keychain"
        } else if cfg!(target_os = "windows") {
            "Credential Manager"
        } else {
            "Saved credentials"
        }
    }

    // ---------- Internal ----------

    fn scope_key(scopes: &[&str]) -> String {
        let mut sorted = scopes.to_vec();
        sorted.sort();
        sorted.join(",")
    }

    fn fallback_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ergonode-uploader")
            .join("credentials.json")
    }

    fn read_blob() -> Result<CredentialBlob, String> {
        // Try keychain first — exactly one get_password() call
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY) {
            match entry.get_password() {
                Ok(json) => {
                    if let Ok(blob) = serde_json::from_str::<CredentialBlob>(&json) {
                        eprintln!("[credentials] Loaded from OS keychain");
                        return Ok(blob);
                    }
                }
                Err(e) => {
                    eprintln!("[credentials] Keychain read failed: {e}");
                }
            }
        }

        // Fall back to file
        let path = Self::fallback_path();
        if let Ok(json) = fs::read_to_string(&path) {
            if let Ok(blob) = serde_json::from_str::<CredentialBlob>(&json) {
                eprintln!("[credentials] Loaded from file fallback");
                return Ok(blob);
            }
        }

        Err("No saved credentials found".to_string())
    }

    fn write_blob(blob: &CredentialBlob) -> Result<(), String> {
        let json = serde_json::to_string(blob)
            .map_err(|e| format!("Serialize error: {e}"))?;

        // Try keychain first
        match keyring::Entry::new(KEYRING_SERVICE, KEYRING_KEY) {
            Ok(entry) => {
                entry.set_password(&json)
                    .map_err(|e| format!("Keychain write failed: {e}"))?;
                eprintln!("[credentials] Saved to OS keychain");
                Ok(())
            }
            Err(_) => {
                // Fall back to file
                let path = Self::fallback_path();
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&path, json).map_err(|e| e.to_string())?;
                // Restrict file permissions to owner-only on Unix
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
                }
                eprintln!("[credentials] Saved to file fallback");
                Ok(())
            }
        }
    }
}

// ---------- yup_oauth2 TokenStorage ----------

/// Newtype wrapper so we can implement the foreign `TokenStorage` trait.
pub struct CredentialTokenStorage(pub Arc<CredentialStore>);

#[async_trait]
impl TokenStorage for CredentialTokenStorage {
    async fn set(&self, scopes: &[&str], token: TokenInfo) -> Result<(), TokenStorageError> {
        let key = CredentialStore::scope_key(scopes);
        let mut blob = self.0.blob.write().await;
        blob.google_tokens.insert(key, token);
        self.0.dirty.store(true, Ordering::Release);
        // In-memory only — persisted on explicit save or app shutdown
        Ok(())
    }

    async fn get(&self, scopes: &[&str]) -> Option<TokenInfo> {
        let key = CredentialStore::scope_key(scopes);
        let blob = self.0.blob.read().await;
        blob.google_tokens.get(&key).cloned()
    }
}

// ---------- Legacy migration ----------

/// Migrate credentials from legacy config.json (has api_url, api_key fields).
pub fn migrate_legacy_config(legacy_path: &std::path::Path) -> Option<CredentialBlob> {
    let json = fs::read_to_string(legacy_path).ok()?;

    // Try to deserialize as the old format (has api_url, api_key, google_client_id, google_client_secret)
    #[derive(Deserialize)]
    struct LegacyConfig {
        #[serde(default)]
        api_url: Option<String>,
        #[serde(default)]
        api_key: Option<String>,
        #[serde(default)]
        google_client_id: Option<String>,
        #[serde(default)]
        google_client_secret: Option<String>,
    }

    let legacy: LegacyConfig = serde_json::from_str(&json).ok()?;

    // Only migrate if there are actual credentials
    if legacy.api_url.is_none() && legacy.api_key.is_none() {
        return None;
    }

    Some(CredentialBlob {
        version: 1,
        api_url: legacy.api_url,
        api_key: legacy.api_key,
        google_client_id: legacy.google_client_id,
        google_client_secret: legacy.google_client_secret,
        google_tokens: HashMap::new(),
    })
}

/// Delete legacy Google token keychain entry (cleanup only — does not read/migrate).
pub fn migrate_legacy_keychain_token_cleanup_only() {
    let scope = "https://www.googleapis.com/auth/drive.readonly";
    let legacy_key = format!("google-token:{}", scope);
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &legacy_key) {
        let _ = entry.delete_credential();
    }
}

/// Clean up the legacy "probe" keychain entry.
pub fn cleanup_legacy_probe() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, "probe") {
        let _ = entry.delete_credential();
    }
}
