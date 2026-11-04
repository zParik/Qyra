use lopdf::Document;
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Draw every form field into its page and remove the form, so the values
/// can no longer be changed.
#[tauri::command]
pub async fn flatten_pdf(
    path: String,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let _t = crate::utils::timing::Timer::start("flatten_pdf", String::new());
        let mut doc = Document::load(&path)?;
        let out = output.unwrap_or_else(|| temp_output_path(&path, "flattened"));
        super::forms::flatten_form(&mut doc)?;
        crate::utils::save_pdf(&mut doc, &out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
