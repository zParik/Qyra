use lopdf::Document;
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Remove password protection from a PDF (requires the current password).
#[tauri::command]
pub fn unlock_pdf(
    path: String,
    password: String,
    output: Option<String>,
) -> AppResult<String> {
    let mut doc = Document::load_with_password(&path, &password)
        .map_err(|e| AppError::Pdf(format!("Failed to unlock (wrong password?): {}", e)))?;

    // Remove the Encrypt entry from trailer so the saved file is unencrypted
    doc.trailer.remove(b"Encrypt");

    let out = output.unwrap_or_else(|| temp_output_path(&path, "unlocked"));
    doc.save(&out)?;
    Ok(out)
}
