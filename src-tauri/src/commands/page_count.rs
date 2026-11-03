use crate::error::{AppError, AppResult};

/// Count pages with MuPDF, reusing the render worker's open-document cache when
/// the app is running. Falls back to opening directly (e.g. in tests).
fn count_pages(path: String) -> AppResult<usize> {
    let read = |doc: &mupdf::Document| {
        doc.page_count()
            .map(|c| c as usize)
            .map_err(|e| AppError::Pdf(e.to_string()))
    };
    match crate::commands::render_worker::global() {
        Some(worker) => worker.with(path, read),
        None => {
            let doc = mupdf::Document::open(&path).map_err(|e| AppError::Pdf(e.to_string()))?;
            read(&doc)
        }
    }
}

#[tauri::command]
pub async fn get_page_count(path: String) -> AppResult<usize> {
    tokio::task::spawn_blocking(move || count_pages(path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn get_file_size(path: String) -> AppResult<u64> {
    tokio::task::spawn_blocking(move || -> AppResult<u64> {
        Ok(std::fs::metadata(&path).map(|m| m.len())?)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
