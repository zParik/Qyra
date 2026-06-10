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

    let _t = crate::utils::timing::Timer::start("remove_pages", format!("{} pages", pages.len()));
    let mut doc = Document::load(&path)?;
    let total = doc.get_pages().len() as u32;

    for &p in &pages {
        if p < 1 || p > total {
            return Err(AppError::Invalid(format!("Page {} out of range (1-{})", p, total)));
        }
    }

    let unique_count = {
        let mut s = std::collections::HashSet::new();
        pages.iter().for_each(|&p| { s.insert(p); });
        s.len() as u32
    };
    if unique_count >= total {
        return Err(AppError::Invalid("Cannot remove all pages from a PDF".to_string()));
    }

    doc.delete_pages(&pages);

    let out = output.unwrap_or_else(|| temp_output_path(&path, "removed"));
    doc.save(&out)?;
    Ok(out)
}
