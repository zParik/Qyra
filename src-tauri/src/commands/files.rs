use std::fs;
use tauri_plugin_opener::OpenerExt;
use crate::error::{AppError, AppResult};

#[tauri::command]
pub fn copy_file(src: String, dst: String) -> AppResult<()> {
    fs::copy(&src, &dst).map(|_| ())?;
    Ok(())
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
#[tauri::command]
pub fn write_bytes(path: String, data: Vec<u8>) -> AppResult<()> {
    fs::write(&path, &data)?;
    Ok(())
}

