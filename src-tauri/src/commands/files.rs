use std::fs;
use tauri_plugin_opener::OpenerExt;
use crate::error::{AppError, AppResult};

/// Save `src` over `dst` (Save, Save As). Atomic: `dst` is never left
/// half-written, and copying a file onto itself is a no-op instead of
/// truncating it. Async so a large copy does not freeze the window.
#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || {
        let worker = crate::commands::render_worker::global();
        crate::utils::paths::replace_file_with_copy(src.as_ref(), dst.as_ref(), || {
            // Release MuPDF's handle on the file being replaced.
            if let Some(w) = &worker {
                w.close(&dst);
            }
        })
        .map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Open a file with the default OS application. Runs from Rust to bypass
/// frontend path-scope restrictions imposed by the opener plugin.
#[tauri::command]
pub fn open_file(path: String, app_handle: tauri::AppHandle) -> AppResult<()> {
    app_handle
        .opener()
        .open_path(&path, None::<String>)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Reveal a file in the system file manager (Explorer / Finder / Nautilus).
#[tauri::command]
pub fn show_in_folder(path: String, app_handle: tauri::AppHandle) -> AppResult<()> {
    app_handle
        .opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Write raw bytes to a file path. Used by the frontend to save rendered images.
// Off the main thread: a full parse and save of a large file froze the window.
#[tauri::command(async)]
pub fn write_bytes(path: String, data: Vec<u8>) -> AppResult<()> {
    fs::write(&path, &data)?;
    Ok(())
}

