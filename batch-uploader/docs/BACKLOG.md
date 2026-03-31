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

### Runtime Client ID + Secret Input

**Status:** Up next

Allow users to enter their own Google Client ID and Client Secret in the app UI. Store securely in OS keychain (same mechanism as OAuth token persistence). Remove the `.env` / build-time `option_env!()` dependency entirely.

**Scope:**
- Add Client ID + Client Secret fields to the app UI
- Store in OS keychain via `keyring` crate (infrastructure added by token persistence task)
- Runtime credentials are the only source — no more build-time env vars
- If no credentials configured, Drive link stays hidden
- Consider supporting import from Google Cloud Console JSON export

### Ergonode API Key Migration to Keychain

**Status:** Planned

Move the Ergonode API key from plaintext `config.json` to the OS keychain for consistency with Google credential storage. The config file would keep only non-secret data (API URL, folder path).

**Scope:**
- Migrate existing plaintext API key to keychain on first run
- Remove `api_key` from `config.json` after migration
- Fallback to config file if keychain unavailable (same pattern as token storage)

### Clean up compiler warnings

**Status:** Planned

The Rust build produces 4 warnings:

1. **`ImportResult` struct (google_drive.rs:336)** — dead code, leftover from the original "dump all files" approach. Was replaced by the in-app Drive browser which returns files individually via `list_folder` + `list_folder_recursive`. Safe to delete.
2. **3 dead code warnings in ergonode.rs** — pre-existing unused fields/functions. Need to audit and remove.
