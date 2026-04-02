# Changelog

## v1.6.1

### Improvements
- Browse button now offers separate "files" and "folders" options — folder picker opens native directory dialog
- Folder scanning shows spinner with "Scanning folder structure..." instead of misleading "Creating in Ergonode" message

### Docs
- Updated README: Google Drive setup instructions clarified, backlog removed from repo

## v1.6.0

### Security Hardening
- OAuth access token moved to Rust-side state — no longer exposed to frontend JS (C-2)
- Windows credential file restricted to owner-only via `icacls` ACL, matching Unix `0o600` behavior (H-3)
- GraphQL string escaping now handles `\n`, `\r`, `\t` characters (H-1)
- `open_url` command restricted to `https://` scheme only (H-2)
- Directory scan limited to 32 levels deep with symlink detection and skip (M-1)
- Google Drive recursive listing limited to 32 levels deep (M-2)
- Stale Google Drive temp files cleaned up on app startup and exit (M-3)
- OAuth authorization URL redacted from stderr logs (L-auth)

### Bug Fixes
- Fixed Load from Keychain populating form fields with masked values instead of real credentials

## v1.5.0

### Unified Credential Management
- All credentials (API URL, API key, Google Client ID/Secret, OAuth tokens) stored as a single encrypted blob in the OS keychain
- Legacy migration from old per-entry keychain storage and config.json
- Keychain consent modal — prompted to save on first successful connection
- "Load from Keychain" button to restore credentials after disconnect

### Google Drive Improvements
- Enter Google Client ID and Secret at runtime via the drop zone ("Set up Google Drive") or the Connection Settings card — no rebuild needed
- Token removal now persisted to keychain on Google sign-out (fixes 401 on reload)
- "Open manually" link in auth overlay now works in Tauri webview

### Bug Fixes
- Disabled native password manager autofill (WebKit, 1Password, Bitwarden) on all credential inputs
- Legacy keychain cleanup runs only once per session, eliminating redundant OS prompts
- Clicking Google Drive setup inputs no longer opens the file picker
- Form fields cleared on disconnect

### Other
- External help links open in system browser via `open_url` command
- Debug logging for keychain read/write operations

## v1.4.0

### Google Auth Persistence
- OAuth tokens stored in OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) with file fallback
- Silent re-auth using cached tokens — no browser prompt on reconnect
- Google sign-out button in connected bar (revokes token)

### Security
- Content Security Policy added to webview
- GraphQL string escaping hardened
- Temp file deletion restricted to OS temp directory

### UX
- In-app auth overlay with spinner, cancel button, and fallback "Open manually" link
- OAuth cancel support (aborts in-flight auth flow)

## v1.3.0

### Google Drive Import
- In-app Drive browser — navigate folders, select files, import to Ergonode
- OAuth authentication with Client ID injection at build time
- Download Drive files to temp dir, upload to Ergonode, clean up

### Improvements
- Revert summary shown in counter label instead of inline status
- Downloading state indicator for Drive files during upload
- Backlog tracking document added

## v1.2.0

### Folder Structure Recreation
- Drop a folder and recreate its directory tree in Ergonode automatically
- Confirmation modal with options: flat upload, include root folder
- Per-file target folder tracking

### Revert Upload
- Undo the last upload batch — delete uploaded files and/or created folders
- Batched GraphQL deletions (up to 50 items per request)
- Revert confirmation modal with checkboxes for files and folders
- Upload ledger tracks all created files and folders for accurate revert

### Bug Fixes
- Robust file matching for revert, clear stale tooltips
- Guards for batch_delete: empty paths, 50-item limit, strict delete_type

## v1.1

### Features
- Single connection toggle (limit to 1 upload at a time)
- Support for all 53 Ergonode file types (expanded from images only)
- Proper app icon
- DMG installer with clean layout

### Infrastructure
- Multi-platform CI release workflow (macOS, Windows, Linux)
- Monorepo structure with batch-uploader subfolder

## v1.0

Initial release.

- Drag & drop files with native file picker
- Ergonode API connection with API key authentication
- Folder tree browser with destination selection
- File upload with rate limit handling and exponential backoff
- Concurrent uploads (up to 4 parallel)
- Per-file progress tracking with error messages
- Settings persistence (API URL and key)
- Cross-platform: macOS, Windows, Linux
