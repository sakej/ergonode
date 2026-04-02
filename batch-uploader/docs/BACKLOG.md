# Backlog

## Performance

### Shared reqwest::Client for connection pooling

**Status:** Planned

Every Ergonode API command (`test_connection`, `fetch_folders`, `upload_file`, etc.) creates a new `reqwest::Client` via `ErgonodeClient::new()`. This prevents HTTP connection reuse and pool sharing.

**Fix:** Create a single `reqwest::Client` in Tauri managed state or in `ErgonodeClient` as a shared instance. Pass it to all API commands. Improves upload throughput for batch operations.

**Scope:** Modify `ergonode.rs` to accept a shared client, or store one in Tauri state alongside `CredentialStore`.

### Refactor app.js into smaller modules

**Status:** Planned

`app.js` is ~1900 lines in a single file. Should be split into focused modules (e.g., `state.js`, `connection.js`, `upload.js`, `drive.js`, `modals.js`).

**Scope:** Split during next major frontend change. Use ES modules or a simple concatenation build step.

## Known Limitations

### Shutdown hook uses try_read() on tokio RwLock

**Status:** Known limitation

The `ExitRequested` shutdown hook calls `save_to_keychain_sync()` which uses `tokio::sync::RwLock::try_read()`. If a write lock is held at the exact moment of shutdown (e.g., token refresh in progress), the read fails and unsaved credentials are lost.

**Mitigation:** The window is extremely narrow (token refresh writes are sub-millisecond). A full fix would require switching to `std::sync::RwLock` or restructuring the shutdown hook to run in an async context.

## Completed

### v1.6.0

- **OAuth token in Rust state** — access token no longer passes through frontend JS
- **Windows credential file ACL** — owner-only permissions via `icacls`
- **GraphQL escape hardening** — `\n`, `\r`, `\t` now escaped in `escape_gql`
- **URL scheme allowlist** — `open_url` restricted to `https://` only
- **Directory scan depth limit** — max 32 levels, symlinks detected and skipped
- **Drive recursive depth limit** — max 32 levels for `list_folder_recursive_flat`
- **Temp file cleanup** — stale `ergonode_drive_*` files cleaned on startup and exit
- **Auth URL redaction** — OAuth URL no longer logged to stderr in full

### v1.5.0

- **Unified credential management** — all credentials in a single keychain blob with legacy migration
- **Runtime Google Client ID/Secret entry** — via drop zone form or Connection Settings card
- **Autofill suppression** — disabled WebKit, 1Password, Bitwarden autofill on credential inputs
- **Legacy migration guard** — runs once per session, not on every save
- **Google sign-out persists to keychain** — fixes 401 on reload after sign-out
- **"Open manually" auth link fixed** — uses `open_url` command in Tauri webview
- **File picker guard** — clicking Drive setup inputs no longer opens file picker
- **No keychain access on startup** — removed probe; "Load from Keychain" always visible, keychain accessed only on explicit click
- **Clear Settings offers keychain clear** — modal asks whether to also delete saved credentials
- **Removed dead `set_ergonode_credentials`** — eliminated compiler warning
- **Cleaned up debug logging** — removed troubleshooting noise, kept operational diagnostics

### v1.4.0

- **OAuth token persistence** — stored in OS keychain with file fallback
- **Silent re-auth** — cached tokens reused without browser prompt
- **Google sign-out** — revoke token from connected bar
- **CSP and security hardening** — GraphQL escaping, restricted temp file deletion
- **Auth overlay** — spinner, cancel, fallback link
- **Compiler warnings cleaned up** — dead code removed
