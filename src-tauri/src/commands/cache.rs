use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Per-session disk cache for rendered thumbnails and other transient data.
///
/// The cache lives in a subdirectory under the OS temp folder:
///   `<temp>/qyra-session-<pid>/`
///
/// It is automatically created on first use and cleaned up when the app exits
/// (via the `Drop` impl on SessionCacheState). Nothing survives across restarts,
/// so it behaves like a RAM cache that doesn't eat RAM.

/// Managed Tauri state that holds the session cache root + an in-memory index.
pub struct SessionCacheState {
    /// Root directory for this session's cache files.
    root: PathBuf,
    /// In-memory index: logical key → file path on disk.
    /// Avoids repeated filesystem probes for hot keys.
    index: Mutex<HashMap<String, PathBuf>>,
}

impl SessionCacheState {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("qyra-session-{}", std::process::id()));
        fs::create_dir_all(&root).ok();
        Self {
            root,
            index: Mutex::new(HashMap::new()),
        }
    }

    fn file_for_key(&self, key: &str) -> PathBuf {
        self.root.join(crate::utils::fnv1a_hex(key))
    }
}

impl Drop for SessionCacheState {
    fn drop(&mut self) {
        // Best-effort cleanup — remove the entire session directory.
        let _ = fs::remove_dir_all(&self.root);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────────────────────────────

/// Store a value in the session cache.
/// `value` is an arbitrary string (base64 data URL, JSON blob, etc.).
#[tauri::command]
pub fn cache_put(
    key: String,
    value: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<(), String> {
    let path = state.file_for_key(&key);
    fs::write(&path, value.as_bytes()).map_err(|e| e.to_string())?;
    state
        .index
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key, path);
    Ok(())
}

/// Retrieve a value from the session cache.
/// Returns `null` (JSON) if the key doesn't exist.
#[tauri::command]
pub fn cache_get(
    key: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<Option<String>, String> {
    // Fast path: check in-memory index
    let idx = state.index.lock().map_err(|e| e.to_string())?;
    if let Some(path) = idx.get(&key) {
        if path.exists() {
            let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
            return Ok(Some(data));
        }
    }
    drop(idx);

    // Slow path: probe the filesystem directly
    let path = state.file_for_key(&key);
    if path.exists() {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        state
            .index
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key, path);
        return Ok(Some(data));
    }

    Ok(None)
}

/// Check if a key exists in the session cache.
#[tauri::command]
pub fn cache_has(
    key: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<bool, String> {
    let idx = state.index.lock().map_err(|e| e.to_string())?;
    if let Some(path) = idx.get(&key) {
        return Ok(path.exists());
    }
    drop(idx);
    Ok(state.file_for_key(&key).exists())
}

/// Remove a single key from the session cache.
#[tauri::command]
pub fn cache_remove(
    key: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<(), String> {
    let path = state.file_for_key(&key);
    let _ = fs::remove_file(&path);
    state.index.lock().map_err(|e| e.to_string())?.remove(&key);
    Ok(())
}

/// Remove all entries whose key starts with `prefix`.
/// This is used to evict all thumbnails for a given PDF path when the file is modified.
#[tauri::command]
pub fn cache_evict_prefix(
    prefix: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<u32, String> {
    let mut idx = state.index.lock().map_err(|e| e.to_string())?;
    let matching: Vec<String> = idx
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    let count = matching.len() as u32;
    for key in &matching {
        if let Some(path) = idx.remove(key) {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(count)
}

/// Get cache statistics for debugging / dev tools.
#[derive(Serialize)]
pub struct CacheStats {
    pub root: String,
    pub entry_count: usize,
    pub total_bytes: u64,
}

#[tauri::command]
pub fn cache_stats(
    state: tauri::State<'_, SessionCacheState>,
) -> Result<CacheStats, String> {
    let idx = state.index.lock().map_err(|e| e.to_string())?;
    let mut total_bytes: u64 = 0;

    // Also scan directory for entries not in the index
    let entry_count = if state.root.exists() {
        let mut count = 0;
        if let Ok(entries) = fs::read_dir(&state.root) {
            for entry in entries.flatten() {
                count += 1;
                if let Ok(meta) = entry.metadata() {
                    total_bytes += meta.len();
                }
            }
        }
        count
    } else {
        idx.len()
    };

    Ok(CacheStats {
        root: state.root.to_string_lossy().to_string(),
        entry_count,
        total_bytes,
    })
}

/// Wipe the entire session cache.
#[tauri::command]
pub fn cache_clear(
    state: tauri::State<'_, SessionCacheState>,
) -> Result<(), String> {
    let mut idx = state.index.lock().map_err(|e| e.to_string())?;
    idx.clear();
    if state.root.exists() {
        let _ = fs::remove_dir_all(&state.root);
        let _ = fs::create_dir_all(&state.root);
    }
    Ok(())
}
