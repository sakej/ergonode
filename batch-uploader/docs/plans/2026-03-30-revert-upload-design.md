# Revert Upload — Design Document

**Date:** 2026-03-30
**Goal:** Add a "Revert" action that undoes the last upload batch — deleting uploaded files and optionally the created folder structure from Ergonode.

---

## Constraints

- Ergonode will not delete a folder that contains files or subfolders. Deletion must go: files first, then folders leaf-to-root.
- `multimediaDelete(input: { path })` deletes a file by its full path (e.g. `"folder/subfolder/img.jpg"`).
- `multimediaFolderDelete(input: { path })` deletes a folder by path.
- Ergonode supports batched mutations — multiple aliased mutations in a single GraphQL request, executed synchronously in order.
- API timeout is 60 seconds. Batch size of 50 mutations per request fits comfortably.

---

## Data Model: Upload Ledger

Session-scoped JS state, populated after each upload batch completes:

```js
state.uploadLedger = {
  uploadedFiles: [
    // Only files with status === "done"
    { name: "img1.jpg", folderPath: "App_test/clothing/mens/shirts" },
    ...
  ],
  createdFolders: [
    // Folders created in pre-flight (empty for regular file drops)
    "App_test/clothing",
    "App_test/clothing/mens",
    "App_test/clothing/mens/shirts",
    ...
  ]
}
```

**Ledger cleared on:** disconnect, new upload start, or revert completion.

---

## Deletion Strategy

### Phase 1: Delete files
All `uploadedFiles` batched into requests of 50 aliased `multimediaDelete` mutations:

```graphql
mutation {
  d0: multimediaDelete(input: { path: "App_test/clothing/mens/shirts/img1.jpg" }) { __typename }
  d1: multimediaDelete(input: { path: "App_test/clothing/mens/shirts/img2.jpg" }) { __typename }
  ...
}
```

File path = `folderPath + "/" + name`. For root uploads (no folder): just `name`.

### Phase 2: Delete folders
`createdFolders` sorted by depth descending (deepest first). Batched 50 per request, depth order preserved within batches.

### Error handling
- If a file/folder delete fails, log it and continue with the rest.
- After completion, show a summary with full details on what failed and why.
- Never skip silently.

---

## Rust Backend

### New command: `batch_delete_multimedia`

Single generic command for both file and folder deletion.

**Input:**
```rust
{ paths: Vec<String>, delete_type: "file" | "folder" }
```

**Output:**
```rust
{
  results: Vec<{ path: String, success: bool, error: Option<String> }>
}
```

Constructs a GraphQL request with up to 50 aliased mutations (`multimediaDelete` or `multimediaFolderDelete`), parses per-alias results, returns success/failure for each.

JS handles chunking, ordering (files before folders, folders depth-sorted), and UI updates.

---

## UI

### Revert button
- Appears in upload controls after an upload batch completes (next to "Clear All")
- Styled as destructive action (red/warning)
- Hidden when no ledger exists

### Revert confirmation modal
Reuses existing modal component:
- **Checkbox:** Delete uploaded files (N files)
- **Checkbox:** Delete created folders (N folders) — only shown if folders were created
- At least one must be checked
- "Revert" button to confirm

### During revert
- Inline progress: "Deleting files... 50/300", "Deleting folders... 4/12"
- Revert / Upload All / Clear All buttons disabled

### After revert — Summary
- **Full success:** "Reverted: 300 files deleted, 12 folders deleted" (green)
- **Partial:** "Reverted: 298/300 files deleted, 10/12 folders deleted" (amber) with details listing failures and reasons
- **Failed:** Error message (red)

File list updated: successfully deleted files get status "reverted", failed ones stay "done".

Ledger cleared after revert completes (even partial).

---

## Scope exclusions

- No persistent history (session only)
- No multi-level undo (only last batch)
- No changes to existing upload pipeline (uploads stay one-per-request due to multipart)
- Batched mutations used for deletes only
