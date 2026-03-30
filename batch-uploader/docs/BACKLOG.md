# Backlog

## Google Drive Integration

### Pending: Google OAuth App Verification

**Status:** Blocked — requires Google review

The app currently uses the `drive.file` scope, which only grants access to files the user explicitly picks (not folder contents). To enable folder recursion from Google Drive, the app needs:

1. **Change OAuth consent screen app type to "External"** in [Google Cloud Console](https://console.cloud.google.com/auth/consent)
2. **Submit for Google verification** — required for restricted scopes like `drive.readonly`
3. **Verification timeline:** 4–6 weeks depending on scopes used

Once approved:
- Switch scope from `drive.file` to `drive.readonly`
- Uncomment folder recursion in `src-tauri/src/google_drive.rs` (the `list_folder_recursive` function is preserved, just not called)
- Remove the `#[allow(dead_code)]` annotation
- The JS folder modal flow already handles Drive folders — no frontend changes needed

**Reference:** [Google OAuth verification docs](https://support.google.com/cloud/answer/9110914)

### Runtime Client ID Input

**Status:** Planned

Allow users to paste their own Google Client ID in the app settings instead of requiring a rebuild. This lets anyone use Google Drive import with their own OAuth credentials.

**Implementation approach:**
- Add a "Google Client ID" field to the Connection Settings card (or a separate settings section)
- Store in the existing JSON config (same as API URL/key)
- Runtime config takes priority over compile-time `GOOGLE_CLIENT_ID`
- If neither is set, Drive link stays hidden
- Optionally support importing from a `.json` file (Google Cloud Console exports credentials as JSON)

**Why:** The compile-time Client ID works for official releases but requires building from source for anyone who wants their own credentials. A runtime field removes that friction entirely.
