# AGENT_CONTEXT — LLM Coding Agent Operational Document
<!-- Not human-facing. Optimized for LLM token efficiency and rapid context loading. -->

## UPDATE_PROTOCOL (MANDATORY — read first)
```
WHEN: After completing any task that changes architecture, routes, config, tests, or open issues
HOW: Edit inline (don't append notes — mutate the relevant section). Append one-liner to CHANGELOG.
STALE_CHECK: Before acting on any claim in this doc, verify against current code. This doc is a cache, not a source of truth for code state.
SOURCE_OF_TRUTH_HIERARCHY:
  1. Current code (always wins)
  2. .agentrules.md (quality rules — immutable unless user changes)
  3. This file (operational cache — update freely)
```

## TASK_ENTRY_PROTOCOL (run on every new task)
```
1. Read this file + .agentrules.md (quality rules live there, not here)
2. Scan related files + dependencies BEFORE coding (ContextPreFetch)
3. Check TRAPS section below for landmines in the area you're touching
4. Run QUALITY_WORKFLOW from .agentrules.md for the change
5. After completing: update OPEN_ISSUES, TEST_STATE, CHANGELOG in this file
```

## IDENTITY
```
project: ergonode-uploader v1.6.1 (part of Ergonode Community Tools monorepo)
purpose: Desktop app for bulk-uploading files to Ergonode PIM media library, with Google Drive integration
runtime: Tauri 2.x (Rust backend + JS frontend), cross-platform (macOS, Windows, Linux)
stack:   Rust (reqwest, tokio, serde, keyring, google-drive3) + vanilla HTML/CSS/JS frontend
```

## QUALITY_RULES → .agentrules.md
```
Full quality workflow, 3-phase rules, zero-tolerance metrics live in .agentrules.md (immutable constitution).
This file does NOT duplicate them. Read .agentrules.md at session start.
Quick recall — ZERO_TOLERANCE: any=0, type-ignore=0, unhandled_promise=0, dead_code=0
```

## TRAPS_AND_GOTCHAS (read before touching related areas)
```
TAURI_IPC:      Tauri commands use invoke() from JS — async boundary. Errors must be serialized properly.
KEYRING:        keyring crate uses platform-specific backends (apple-native, windows-native, sync-secret-service).
                Test on all platforms — behavior differs per OS.
GOOGLE_DRIVE:   OAuth flow requires browser redirect. Token refresh must be handled gracefully.
DMG_LAYOUT:     macOS DMG builds can have hidden files (.DS_Store, .fseventsd). Clean before release.
MULTIPART:      Large file uploads via reqwest multipart — capped at 100MB (MAX_UPLOAD_SIZE). Watch for timeouts.
MIME_GUESS:     mime_guess crate may return wrong MIME for edge-case extensions. Verify for media files.
HTTP_CLIENT:    Shared reqwest::Client in Tauri state (HttpClient). Do NOT create new clients — reuse for pooling.
SSRF:           validate_api_url() checks HTTPS + rejects private IPs. Does NOT resolve hostnames (DNS rebinding is low risk for desktop).
NO_PLAINTEXT:   Plaintext credential fallback was removed. If keychain is unavailable, save/load returns
                a structured error with platform-specific fix instructions. Credentials live in memory only for that session.
DRIVE_LIMITS:   Recursive folder listing: max 10K files, 500 folder visits, 32 levels deep. api_count tracks folder visits, not HTTP calls.
```

## COMMANDS
```
npm run tauri dev      — start dev (Rust + UI hot reload)
npm run tauri build    — production build (generates installer)
cargo test             — run Rust unit tests (from src-tauri/)
cargo clippy           — Rust lint (from src-tauri/)
cargo fmt --check      — Rust format check (from src-tauri/)
```

## ARCHITECTURE
```
ENTRY:          src-tauri/src/main.rs → Tauri app init, registers commands
MODULES:
  lib.rs              — Tauri command definitions (invoke bridge)
  ergonode.rs         — Ergonode API client (upload, auth, media management)
  google_drive.rs     — Google Drive API integration (OAuth, file listing, download)
  credential_store.rs — OS keyring wrapper for secure credential storage
  config.rs           — User configuration (API URLs, tokens, preferences)
  fs_utils.rs         — File system helpers (path resolution, temp files)
FRONTEND:
  ui/index.html       — Single-page app entry
  ui/app.js           — Application logic, Tauri invoke calls
  ui/styles.css       — Styling
IPC:            JS calls Rust via Tauri invoke() → Rust returns Result<T, E> → JS handles response
AUTH:           Ergonode: API token stored in OS keyring. Google Drive: OAuth2 with token refresh.
```

## TEST_STATE
```
passing: [TODO: verify current test count]
runner:  cargo test (Rust)
coverage_areas: [TODO: document tested modules]

HELPERS:
  [TODO: list test helper files if any]

PATTERNS:
  Rust unit tests in-module (#[cfg(test)] mod tests)
```

## OPEN_ISSUES (priority order)
```
(none)
```

## DECISIONS_LOG (settled — do not re-debate without new evidence)
```
VANILLA_JS:     Chose vanilla JS over React/Vue for UI — minimal complexity, fast load, no build step for frontend.
TAURI_V2:       Tauri 2.x over Electron — smaller binary, better security sandbox, native performance.
KEYRING:        OS-native keyring over config file — security requirement, no plaintext credentials.
MONOREPO:       Tools live under one repo (ergonode/) with batch-uploader as first tool — room for more tools.
CROSS_PLATFORM: macOS + Windows + Linux from day one — Tauri's cross-compile makes this feasible.
SHARED_CLIENT:  Single reqwest::Client in Tauri state — connection pooling, TLS reuse. connect=10s, request=300s.
ASYNC_MUTEX:    AuthCancelState + DriveTokenState use tokio::sync::Mutex (not std) to avoid blocking runtime.
SSRF_GUARD:     ErgonodeClient::new() validates URL (HTTPS + no private IPs) before any request.
UPLOAD_CAP:     100MB max upload enforced before file read (prevents OOM).
STREAM_DL:      Google Drive downloads stream to disk (no in-memory buffering).
NO_PLAINTEXT:   Plaintext file fallback eliminated entirely. Keychain-only storage — fail with helpful error if unavailable.
ZEROIZE:        CredentialBlob implements Zeroize + Drop — sensitive fields zeroed on drop. TokenInfo is foreign, only drained.
```

## KEY_FILES
```
src-tauri/src/main.rs              — Tauri entry, command registration
src-tauri/src/lib.rs               — Tauri command definitions
src-tauri/src/ergonode.rs           — Ergonode API client
src-tauri/src/google_drive.rs       — Google Drive integration
src-tauri/src/credential_store.rs   — Keyring-backed credential storage
src-tauri/src/config.rs             — App configuration
src-tauri/src/fs_utils.rs           — File system utilities
ui/app.js                           — Frontend application logic
ui/index.html                       — UI entry point
ui/styles.css                       — UI styles
```

## ENV_VARS
```
REQUIRED: None (app uses GUI config + keyring for credentials)
OPTIONAL: RUST_LOG (logging verbosity for development)
```

## AUTHORITATIVE_DOCS
```
.agentrules.md    — quality rules (immutable)
README.md         — user-facing app documentation
CHANGELOG.md      — release history
```

## CHANGELOG
```
2026-04-05: StaffMode initialized — scaffolded .agentrules.md, CLAUDE.md, docs/AGENT_CONTEXT.md
2026-04-05: Quality audit of hardening changeset — fixed: keychain error logging, clippy warning, rustfmt.
            Logged open issue: using_file_fallback not surfaced in UI. Updated traps + decisions.
2026-04-05: Eliminated plaintext credential fallback — keychain-only storage, removed using_file_fallback
            field, frontend now surfaces save errors. Closed open issue #1.
2026-04-05: Added zeroize crate — CredentialBlob fields zeroed on drop for memory hardening.
2026-04-05: Production hardening — auth retry cancel (watch channel), rate-limit interval leak,
            silent error logging (4 sites), temp file canonicalize fix (macOS), pagination page size 50.
```
