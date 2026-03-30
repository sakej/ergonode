use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone)]
pub struct ScannedFile {
    pub name: String,
    pub absolute_path: String,
    /// Path relative to the dropped folder root, e.g. "winter/photos"
    /// Empty string if the file is directly in the dropped folder (no subfolder).
    pub relative_dir: String,
    /// File size in bytes.
    pub size: u64,
}

/// Recursively walk `dir`, returning all files.
/// `root` is the originally dropped directory (used to compute relative paths).
pub fn scan_dir(dir: &Path, root: &Path) -> Result<Vec<ScannedFile>, String> {
    let mut results = Vec::new();
    scan_recursive(dir, root, &mut results)?;
    Ok(results)
}

fn scan_recursive(dir: &Path, root: &Path, results: &mut Vec<ScannedFile>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read directory {}: {}", dir.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        // Skip hidden files/dirs (starting with .)
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false)
        {
            continue;
        }

        if path.is_dir() {
            scan_recursive(&path, root, results)?;
        } else if path.is_file() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // relative_dir: path of the containing folder relative to root
            let containing_dir = path.parent().unwrap_or(root);
            let relative_dir = containing_dir
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default()
                .to_string();

            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

            results.push(ScannedFile {
                name,
                absolute_path: path.to_string_lossy().to_string(),
                relative_dir,
                size,
            });
        }
    }

    Ok(())
}
