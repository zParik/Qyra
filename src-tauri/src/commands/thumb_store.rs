use crate::error::{AppError, AppResult};
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;
use tauri::{AppHandle, Manager, State};

/// Persistent thumbnail cache — survives app restarts.
///
/// Lives in `app_cache_dir()/thumbs/`. Files are named:
///   `{fnv(path)}_{page}_{scale_int}_{mtime}.dat`
///
/// The mtime suffix means a modified PDF automatically misses and the stale
/// entry is cleaned up on the next get. No explicit invalidation needed.
#[derive(Clone)]
pub struct ThumbStore {
    root: PathBuf,
}

impl ThumbStore {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let root = app
            .path()
            .app_cache_dir()
            .map_err(|e| AppError::Other(format!("no app cache dir: {e}")))?
            .join("thumbs");
        fs::create_dir_all(&root).ok();
        Ok(Self { root })
    }

    fn filename(&self, path: &str, page: u32, scale_int: u32, mtime: u64) -> PathBuf {
        self.root
            .join(format!("{:016x}_{:04}_{:06}_{}.dat", crate::utils::fnv1a(path), page, scale_int, mtime))
    }

    fn stale_prefix(&self, path: &str, page: u32, scale_int: u32) -> String {
        format!("{:016x}_{:04}_{:06}_", crate::utils::fnv1a(path), page, scale_int)
    }

    fn delete_matching(&self, prefix: &str) {
        if let Ok(dir) = fs::read_dir(&self.root) {
            for entry in dir.flatten() {
                if entry.file_name().to_string_lossy().starts_with(prefix) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

fn mtime_secs(path: &str) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn scale_int(scale: f64) -> u32 {
    (scale * 10_000.0).round() as u32
}

#[tauri::command]
pub async fn thumb_get(
    store: State<'_, ThumbStore>,
    path: String,
    page: u32,
    scale: f64,
) -> AppResult<Option<String>> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || -> AppResult<Option<String>> {
        let mtime = match mtime_secs(&path) {
            Some(m) => m,
            None => return Ok(None),
        };
        let si = scale_int(scale);
        let file = store.filename(&path, page, si, mtime);
        if file.exists() {
            return Ok(Some(fs::read_to_string(&file)?));
        }
        // Clean up stale entries for this (path, page, scale)
        store.delete_matching(&store.stale_prefix(&path, page, si));
        Ok(None)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn thumb_put(
    store: State<'_, ThumbStore>,
    path: String,
    page: u32,
    scale: f64,
    data: String,
) -> AppResult<()> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let mtime = match mtime_secs(&path) {
            Some(m) => m,
            None => return Ok(()),
        };
        let si = scale_int(scale);
        store.delete_matching(&store.stale_prefix(&path, page, si));
        fs::write(store.filename(&path, page, si, mtime), data.as_bytes())?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn thumb_evict(store: State<'_, ThumbStore>, path: String) -> AppResult<()> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        store.delete_matching(&format!("{:016x}_", crate::utils::fnv1a(&path)));
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
