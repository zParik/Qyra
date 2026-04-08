use std::fs;

use serde::Serialize;
use tauri::Emitter;

use crate::pdf::{PdfError, Rewriter};
use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;

#[derive(Serialize)]
pub struct CompressResult {
    pub path: String,
    pub original_bytes: u64,
    pub compressed_bytes: u64,
}

/// Compress a PDF at one of three levels:
///   0 = Low     — lossless: re-encode streams at best zlib, prune objects
///   1 = High    — Low + strip metadata + recompress photos to JPEG at 72% + downsample to 2048px
///   2 = Extreme — High + recompress to grayscale JPEG at 50% + downsample to 1440px
#[tauri::command]
pub async fn compress_pdf(
    path: String,
    output: Option<String>,
    level: Option<u8>,
    app_handle: tauri::AppHandle,
) -> Result<CompressResult, String> {
    tokio::task::spawn_blocking(move || {
        let input_bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let original_bytes = input_bytes.len() as u64;

        let rewriter = Rewriter::new(level.unwrap_or(0));

        let output_bytes = rewriter
            .run(input_bytes, |current, total, msg| {
                let _ = app_handle.emit(
                    "operation-progress",
                    Progress::new(current, total, msg),
                );
            })
            .map_err(|e| match e {
                PdfError::EncryptedDocument => {
                    "Cannot compress encrypted PDF. Please unlock it first.".to_string()
                }
                other => other.to_string(),
            })?;

        let out = output.unwrap_or_else(|| temp_output_path(&path, "compressed"));

        let compressed_bytes = if output_bytes.len() as u64 >= original_bytes {
            // Output is larger — copy the original unchanged
            fs::copy(&path, &out).map_err(|e| e.to_string())?;
            original_bytes
        } else {
            let len = output_bytes.len() as u64;
            fs::write(&out, &output_bytes).map_err(|e| e.to_string())?;
            len
        };

        Ok(CompressResult {
            path: out,
            original_bytes,
            compressed_bytes,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
