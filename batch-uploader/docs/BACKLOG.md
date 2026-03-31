# Backlog

## Google Drive Integration

### Pending: Google OAuth App Verification

**Status:** Blocked — requires Google review

The app currently uses the `drive.readonly` scope (Internal app type). To make the app available to external users, it needs:

1. **Change OAuth consent screen app type to "External"** in [Google Cloud Console](https://console.cloud.google.com/auth/consent)
2. **Submit for Google verification** — required for restricted scopes like `drive.readonly`
3. **Verification timeline:** 4–6 weeks depending on scopes used

Once approved:
- External users can authorize without the "unverified app" warning
- Folder recursion in the Drive browser is already implemented and working

**Reference:** [Google OAuth verification docs](https://support.google.com/cloud/answer/9110914)

### Done: Runtime Client ID + Secret Input

**Status:** Done (unified-credentials branch)

Implemented as part of the unified credential management system. Users can enter Google Client ID and Secret in the Connection Settings card or via the "Set up Google Drive" inline form in the drop zone. Stored in the unified keychain blob. Build-time `option_env!()` kept as fallback.

### Done: Ergonode API Key Migration to Keychain

**Status:** Done (unified-credentials branch)

API key now stored in the unified keychain blob alongside all other credentials. Legacy config.json migration runs automatically on first launch. Config.json now only holds non-sensitive data (folder_path).

### Done: Clean up compiler warnings

**Status:** Done (v1.4.0 + unified-credentials branch)

Dead code removed in v1.4.0. One remaining warning for `set_ergonode_credentials` — intentionally kept as public API.

## Performance

### Shared reqwest::Client for connection pooling

**Status:** Planned

Every Ergonode API command (`test_connection`, `fetch_folders`, `upload_file`, etc.) creates a new `reqwest::Client` via `ErgonodeClient::new()`. This prevents HTTP connection reuse and pool sharing.

**Fix:** Create a single `reqwest::Client` in Tauri managed state or in `ErgonodeClient` as a shared instance. Pass it to all API commands. Improves upload throughput for batch operations.

**Scope:** Modify `ergonode.rs` to accept a shared client, or store one in Tauri state alongside `CredentialStore`.

## UX

### "Clear Settings" should offer to clear keychain

**Status:** Planned

Currently "Clear Settings" only clears the config.json and form fields. The keychain entry persists, so "Load from Keychain" still appears on next launch. Users who expect "clear" to mean "clear everything" may be confused.

**Fix:** Either add a separate "Delete saved credentials" button, or show a confirmation dialog asking whether to also clear the keychain entry.

### Refactor app.js into smaller modules

**Status:** Planned

`app.js` is ~1750 lines in a single file. Should be split into focused modules (e.g., `state.js`, `connection.js`, `upload.js`, `drive.js`, `modals.js`).

**Scope:** Split during next major frontend change. Use ES modules or a simple concatenation build step.

## Known Limitations

### Shutdown hook uses try_read() on tokio RwLock

**Status:** Known limitation

The `ExitRequested` shutdown hook calls `save_to_keychain_sync()` which uses `tokio::sync::RwLock::try_read()`. If a write lock is held at the exact moment of shutdown (e.g., token refresh in progress), the read fails and unsaved credentials are lost.

**Mitigation:** The window is extremely narrow (token refresh writes are sub-millisecond). A full fix would require switching to `std::sync::RwLock` or restructuring the shutdown hook to run in an async context.

### Unsigned dev builds trigger keychain prompts on startup

**Status:** Known limitation

On macOS, unsigned dev builds trigger a keychain authorization prompt when `keychain_has_credentials()` is called during `init()`. This contradicts the "user-initiated only" goal.

**Mitigation:** Signed production builds cache keychain access for the session — this only affects development. A possible fix is to use a local hint file instead of probing the keychain, but this adds complexity for marginal benefit.
