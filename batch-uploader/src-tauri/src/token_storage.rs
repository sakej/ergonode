use std::fs;
use std::path::PathBuf;

use async_trait::async_trait;
use google_drive3::yup_oauth2::storage::{TokenInfo, TokenStorage, TokenStorageError};

const KEYRING_SERVICE: &str = "com.ergonode.uploader";

/// Whether we're using keyring or file fallback.
enum Backend {
    Keyring,
    File(PathBuf),
}

/// Token storage backed by OS keychain, with file fallback.
pub struct KeychainTokenStorage {
    backend: Backend,
}

impl KeychainTokenStorage {
    /// Create a new token storage. Tries keychain first; falls back to file.
    pub fn new() -> Self {
        // Probe keychain availability
        let probe = keyring::Entry::new(KEYRING_SERVICE, "probe");
        match probe {
            Ok(entry) => {
                // Try a get — NotFound is fine (means keychain works), other errors mean fallback
                match entry.get_password() {
                    Ok(_) | Err(keyring::Error::NoEntry) => {
                        eprintln!("[token-storage] Using OS keychain");
                        Self { backend: Backend::Keyring }
                    }
                    Err(e) => {
                        eprintln!("[token-storage] Keychain unavailable ({e}), using file fallback");
                        Self { backend: Backend::File(Self::fallback_dir()) }
                    }
                }
            }
            Err(e) => {
                eprintln!("[token-storage] Keychain unavailable ({e}), using file fallback");
                Self { backend: Backend::File(Self::fallback_dir()) }
            }
        }
    }

    fn fallback_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ergonode-uploader")
    }

    fn scope_key(scopes: &[&str]) -> String {
        let mut sorted = scopes.to_vec();
        sorted.sort();
        format!("google-token:{}", sorted.join(","))
    }

    fn file_path(dir: &PathBuf, scopes: &[&str]) -> PathBuf {
        let key = Self::scope_key(scopes).replace([':', ',', '/'], "_");
        dir.join(format!("{key}.json"))
    }

    /// Check if a token exists in storage.
    pub fn has_token(&self, scopes: &[&str]) -> bool {
        match &self.backend {
            Backend::Keyring => {
                let key = Self::scope_key(scopes);
                keyring::Entry::new(KEYRING_SERVICE, &key)
                    .and_then(|e| e.get_password())
                    .is_ok()
            }
            Backend::File(dir) => Self::file_path(dir, scopes).exists(),
        }
    }

    /// Delete a token from storage. Returns the token data before deletion (for revocation).
    pub fn delete_token(&self, scopes: &[&str]) -> Option<TokenInfo> {
        let token = self.get_sync(scopes);

        match &self.backend {
            Backend::Keyring => {
                let key = Self::scope_key(scopes);
                if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key) {
                    let _ = entry.delete_credential();
                }
            }
            Backend::File(dir) => {
                let path = Self::file_path(dir, scopes);
                let _ = fs::remove_file(path);
            }
        }

        token
    }

    fn get_sync(&self, scopes: &[&str]) -> Option<TokenInfo> {
        match &self.backend {
            Backend::Keyring => {
                let key = Self::scope_key(scopes);
                let entry = keyring::Entry::new(KEYRING_SERVICE, &key).ok()?;
                let json = entry.get_password().ok()?;
                serde_json::from_str(&json).ok()
            }
            Backend::File(dir) => {
                let path = Self::file_path(dir, scopes);
                let json = fs::read_to_string(path).ok()?;
                serde_json::from_str(&json).ok()
            }
        }
    }
}

#[async_trait]
impl TokenStorage for KeychainTokenStorage {
    async fn set(&self, scopes: &[&str], token: TokenInfo) -> Result<(), TokenStorageError> {
        let json = serde_json::to_string(&token)
            .map_err(|e| TokenStorageError::Other(e.to_string().into()))?;

        match &self.backend {
            Backend::Keyring => {
                let key = Self::scope_key(scopes);
                let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
                    .map_err(|e| TokenStorageError::Other(e.to_string().into()))?;
                entry.set_password(&json)
                    .map_err(|e| TokenStorageError::Other(e.to_string().into()))?;
            }
            Backend::File(dir) => {
                fs::create_dir_all(dir).map_err(TokenStorageError::Io)?;
                let path = Self::file_path(dir, scopes);
                fs::write(path, json).map_err(TokenStorageError::Io)?;
            }
        }

        Ok(())
    }

    async fn get(&self, scopes: &[&str]) -> Option<TokenInfo> {
        self.get_sync(scopes)
    }
}
