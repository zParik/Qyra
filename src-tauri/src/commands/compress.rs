use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::Emitter;

use crate::pdf::{Bytes, PdfError, Rewriter};
use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;
use crate::error::{AppError, AppResult};

/// Process-global cancel flag for the Native compressor. The frontend calls
/// `cancel_compress` to set it; the rewriter checks it between objects/phases.
static COMPRESS_CANCEL: AtomicBool = AtomicBool::new(false);

/// Signal the in-flight Native compression (if any) to abort.
#[tauri::command]
pub fn cancel_compress() {
    COMPRESS_CANCEL.store(true, Ordering::Relaxed);
}

/// Move a freshly-compressed temp file next to `original` as a NEW file
/// (`<name>-compressed.pdf`, auto-numbered to avoid collisions). Compression
/// must never overwrite the source, so this always creates a fresh file and
/// returns its path. `src` is consumed (moved/removed).
#[tauri::command]
pub fn save_compressed_copy(src: String, original: String) -> AppResult<String> {
    let dest = crate::utils::paths::unique_sibling_path(&original, "-compressed");
    // Rename when on the same filesystem (atomic, free); copy+delete across the
    // temp-dir → user-dir boundary.
    if fs::rename(&src, &dest).is_err() {
        fs::copy(&src, &dest)?;
        let _ = fs::remove_file(&src);
    }
    Ok(dest)
}

#[derive(Serialize)]
pub struct CompressResult {
    pub path: String,
    pub original_bytes: u64,
    pub compressed_bytes: u64,
}

/// Compress a PDF at one of three levels:
///   0 = Low     — lossless: re-encode streams at best zlib, prune objects
///   1 = High    — Ghostscript /ebook parity: strip metadata + downsample images
///                 to 150 DPI (from their drawn size) + DCT re-encode at q78
///   2 = Extreme — Ghostscript /screen parity: same pipeline at 72 DPI + q65
#[tauri::command]
pub async fn compress_pdf(
    path: String,
    output: Option<String>,
    level: Option<u8>,
    app_handle: tauri::AppHandle,
) -> AppResult<CompressResult> {
    tokio::task::spawn_blocking(move || -> AppResult<CompressResult> {
        compress_core(path, output, level, |p| {
            let _ = app_handle.emit("operation-progress", p);
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Pure compression core (no Tauri runtime). `progress` receives each step so
/// the command wrapper can forward it as an event; tests pass a no-op.
pub fn compress_core(
    path: String,
    output: Option<String>,
    level: Option<u8>,
    progress: impl Fn(Progress) + Send + Sync,
) -> AppResult<CompressResult> {
    // Fresh run — clear any stale cancel signal.
    COMPRESS_CANCEL.store(false, Ordering::Relaxed);

    let _t = crate::utils::timing::Timer::start("compress_pdf", format!("lvl{}", level.unwrap_or(0)));
    let original_bytes = fs::metadata(&path)?.len();
    let out = output.unwrap_or_else(|| temp_output_path(&path, "compressed"));

    // Stream into a sibling temp first, then move into place. The input is
    // mmap'd, so writing straight to `out` would corrupt the mapping if a caller
    // ever set output == input; the temp also makes `out` appear atomically and
    // leaves nothing behind on error/cancel.
    let tmp = format!("{out}.qyra-tmp");

    // Memory-map the input so a large file is never read into the heap (no OOM
    // at read, especially on phones). The engine streams its output straight to
    // disk, so the compressed document never lives fully in memory either.
    let source = Bytes::open(Path::new(&path))?;

    let rewriter = Rewriter::new(level.unwrap_or(0));

    let written = rewriter
        .run(
            source,
            Path::new(&tmp),
            |current, total, msg| {
                progress(Progress::new(current, total, msg));
            },
            &COMPRESS_CANCEL,
        )
        .map_err(|e| {
            let _ = fs::remove_file(&tmp); // don't leak a partial temp
            match e {
                PdfError::EncryptedDocument => {
                    AppError::Invalid("Cannot compress encrypted PDF. Please unlock it first.".to_string())
                }
                PdfError::Cancelled => AppError::Other("Compression cancelled".to_string()),
                other => AppError::Pdf(other.to_string()),
            }
        })?;

    // Size guard: if we didn't beat the original, ship the original unchanged.
    let compressed_bytes = if written >= original_bytes {
        let _ = fs::remove_file(&tmp);
        fs::copy(&path, &out)?;
        original_bytes
    } else {
        // Move temp → out: rename when same filesystem (atomic, free), else copy.
        if fs::rename(&tmp, &out).is_err() {
            fs::copy(&tmp, &out)?;
            let _ = fs::remove_file(&tmp);
        }
        written
    };

    Ok(CompressResult { path: out, original_bytes, compressed_bytes })
}
