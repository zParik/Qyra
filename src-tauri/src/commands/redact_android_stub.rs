//! Redact stub for Android.
//!
//! mupdf cross-compiles cleanly to Android via the CI env hacks, but the
//! redact path goes through mupdf's PdfWriteOptions/save_with_options paths
//! which have not been validated on Android yet and risk silent data loss
//! on partially-supported PDF features. Until that validation lands, redact
//! on Android returns a friendly "not yet supported" error so the UI can
//! surface it instead of crashing.

use crate::error::{AppError, AppResult};

#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RedactRegion {
    pub page: u32,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

#[tauri::command]
pub async fn redact_pdf(
    _path: String,
    _regions: Vec<RedactRegion>,
    _output: Option<String>,
) -> AppResult<String> {
    Err(AppError::Other(
        "Redact is not yet available on Android.".into(),
    ))
}
