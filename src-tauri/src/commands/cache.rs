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
pub async fn cache_put(
    key: String,
    value: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<(), String> {
    let path = state.file_for_key(&key);
    let path_clone = path.clone();
    
    // Heavy file I/O off the main thread
    tokio::task::spawn_blocking(move || {
        fs::write(&path_clone, value.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

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
pub async fn cache_get(
    key: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<Option<String>, String> {
    // Fast path: check in-memory index. Scoped block guarantees MutexGuard is dropped before await!
    let path_opt = {
        let idx = state.index.lock().map_err(|e| e.to_string())?;
        idx.get(&key).cloned()
    };

    if let Some(path) = path_opt {
        let path_clone = path.clone();
        let data = tokio::task::spawn_blocking(move || {
            if path_clone.exists() {
                fs::read_to_string(path_clone).map_err(|e| e.to_string()).map(Some)
            } else {
                Ok(None)
            }
        })
        .await
        .map_err(|e| e.to_string())??;
        
        if data.is_some() {
            return Ok(data);
        }
    }

    // Slow path: probe the filesystem directly
    let path = state.file_for_key(&key);
    let path_clone = path.clone();
    let data = tokio::task::spawn_blocking(move || {
        if path_clone.exists() {
            fs::read_to_string(path_clone).map_err(|e| e.to_string()).map(Some)
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    if data.is_some() {
        state
            .index
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key, path);
    }

    Ok(data)
}

/// Check if a key exists in the session cache.
#[tauri::command]
pub async fn cache_has(
    key: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<bool, String> {
    let path_opt = {
        let idx = state.index.lock().map_err(|e| e.to_string())?;
        idx.get(&key).cloned()
    };

    if let Some(path) = path_opt {
        let path_clone = path.clone();
        return tokio::task::spawn_blocking(move || Ok(path_clone.exists()))
            .await
            .map_err(|e| e.to_string())?;
    }
    
    let path = state.file_for_key(&key);
    tokio::task::spawn_blocking(move || Ok(path.exists()))
        .await
        .map_err(|e| e.to_string())?
}

/// Remove a single key from the session cache.
#[tauri::command]
pub async fn cache_remove(
    key: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<(), String> {
    let path = state.file_for_key(&key);
    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || {
        let _ = fs::remove_file(&path_clone);
    })
    .await
    .map_err(|e| e.to_string())?;

    state.index.lock().map_err(|e| e.to_string())?.remove(&key);
    Ok(())
}

/// Remove all entries whose key starts with `prefix`.
/// This is used to evict all thumbnails for a given PDF path when the file is modified.
#[tauri::command]
pub async fn cache_evict_prefix(
    prefix: String,
    state: tauri::State<'_, SessionCacheState>,
) -> Result<u32, String> {
    let (paths, count) = {
        let mut idx = state.index.lock().map_err(|e| e.to_string())?;
        let matching: Vec<String> = idx
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        let count = matching.len() as u32;
        
        let mut paths = Vec::new();
        for key in &matching {
            if let Some(path) = idx.remove(key) {
                paths.push(path);
            }
        }
        (paths, count)
    };

    tokio::task::spawn_blocking(move || {
        for path in paths {
            let _ = fs::remove_file(&path);
        }
    })
    .await
    .map_err(|e| e.to_string())?;

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
pub async fn cache_stats(
    state: tauri::State<'_, SessionCacheState>,
) -> Result<CacheStats, String> {
    let idx_len = {
        let idx = state.index.lock().map_err(|e| e.to_string())?;
        idx.len()
    };

    let root_clone = state.root.clone();
    let (entry_count, total_bytes) = tokio::task::spawn_blocking(move || {
        let mut total_bytes: u64 = 0;
        let entry_count = if root_clone.exists() {
            let mut count = 0;
            if let Ok(entries) = fs::read_dir(&root_clone) {
                for entry in entries.flatten() {
                    count += 1;
                    if let Ok(meta) = entry.metadata() {
                        total_bytes += meta.len();
                    }
                }
            }
            count
        } else {
            idx_len
        };
        (entry_count, total_bytes)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(CacheStats {
        root: state.root.to_string_lossy().to_string(),
        entry_count,
        total_bytes,
    })
}

/// Wipe the entire session cache.
#[tauri::command]
pub async fn cache_clear(
    state: tauri::State<'_, SessionCacheState>,
) -> Result<(), String> {
    {
        let mut idx = state.index.lock().map_err(|e| e.to_string())?;
        idx.clear();
    }

    let root_clone = state.root.clone();
    tokio::task::spawn_blocking(move || {
        if root_clone.exists() {
            let _ = fs::remove_dir_all(&root_clone);
            let _ = fs::create_dir_all(&root_clone);
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
