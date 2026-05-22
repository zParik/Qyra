use lopdf::Document;
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Remove pages from a PDF. Pages are 1-indexed.
#[tauri::command]
pub fn remove_pages(
    path: String,
    pages: Vec<u32>,
    output: Option<String>,
) -> AppResult<String> {
    if pages.is_empty() {
        return Err(AppError::Invalid("No pages specified".to_string()));
    }

    let mut doc = Document::load(&path)?;
    doc.delete_pages(&pages);

    let out = output.unwrap_or_else(|| temp_output_path(&path, "removed"));
    doc.save(&out)?;
    Ok(out)
}
