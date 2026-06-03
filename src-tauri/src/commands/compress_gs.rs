// commands/compress_gs.rs
//
// Ghostscript-based compression. Spawns the vendored `gs` sidecar with
// `-dPDFSETTINGS=/<preset>` to do real image downsampling (JPEG2000/JBIG2 +
// DCT recompression), which the pure-Rust zlib path in compress.rs cannot do.
// Typical savings on scanned PDFs: 60-80% vs ~10% from zlib alone.
//
// Sidecar lookup order:
//   1. Bundled: next to the main executable, named `gs(.exe)`.
//      Tauri's `externalBin` config places binaries with the target-triple
//      suffix stripped at bundle time.
//   2. Dev:     CARGO_MANIFEST_DIR/binaries/gs-<target-triple>(.exe).
//      Populated by scripts/fetch-gs.{ps1,sh}.
//
// Two commands are exposed:
//   - compress_pdf_gs           — single GS invocation. Lossless on metadata,
//                                  best compression ratio, slowest wall-clock.
//   - compress_pdf_gs_parallel  — split into chunks, compress in parallel,
//                                  merge. Faster wall-clock on multicore at
//                                  the cost of bookmarks/outline/cross-page
//                                  image deduplication. Same total CPU work.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use lopdf::Document;
use rayon::prelude::*;
use serde::Serialize;
use tauri::Emitter;

use crate::commands::merge::merge_documents;
use crate::error::{AppError, AppResult};
use crate::utils::paths::{temp_dir_str, temp_output_path};
use crate::utils::progress::Progress;

#[derive(Serialize)]
pub struct GsCompressResult {
    pub path: String,
    pub original_bytes: u64,
    pub compressed_bytes: u64,
    pub preset: String,
}

const VALID_PRESETS: &[&str] = &["screen", "ebook", "printer", "prepress"];

// ──────────────────────────────────────────────────────────────────────────
// Process spawning helpers
// ──────────────────────────────────────────────────────────────────────────

/// Apply OS-specific low-priority scheduling to a Command before spawn so the
/// Ghostscript process does not starve the UI thread, audio thread, or other
/// apps on the box. Total CPU work is unchanged — only kernel scheduling
/// priority drops.
///
/// Windows: IDLE_PRIORITY_CLASS so GS only gets CPU when nothing else wants
/// it. BELOW_NORMAL was still high enough to glitch real-time audio threads
/// on multicore systems.
///
/// Unix: nice +19 (lowest, equivalent to `nice -n 19`).
/// `turbo = false` (default): run GS de-prioritised so the UI/audio stay smooth
/// while it works. `turbo = true`: run at normal priority on all cores — much
/// faster wall-clock, but the box will feel busy. The console window is always
/// suppressed on Windows regardless of mode.
#[cfg(windows)]
fn configure_scheduling(cmd: &mut Command, turbo: bool) {
    use std::os::windows::process::CommandExt;
    const IDLE_PRIORITY_CLASS: u32 = 0x00000040;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let flags = if turbo { CREATE_NO_WINDOW } else { IDLE_PRIORITY_CLASS | CREATE_NO_WINDOW };
    cmd.creation_flags(flags);
}

#[cfg(unix)]
fn configure_scheduling(cmd: &mut Command, turbo: bool) {
    if turbo {
        return; // normal priority
    }
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::nice(19);
            Ok(())
        });
    }
}

/// After spawn, pin the process to all cores EXCEPT the first two so the
/// audio thread and UI thread on the reserved cores cannot be preempted by
/// Ghostscript. No-op if fewer than 4 logical processors are available, since
/// dropping 2 of them would leave too little to run on.
#[cfg(windows)]
fn restrict_cpu_affinity(pid: u32) {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    const PROCESS_SET_INFORMATION: u32 = 0x0200;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    extern "system" {
        fn OpenProcess(desired: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn SetProcessAffinityMask(h: Handle, mask: usize) -> i32;
    }
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    if cores < 4 {
        return;
    }
    let total_mask: usize = if cores >= usize::BITS as usize {
        usize::MAX
    } else {
        (1usize << cores) - 1
    };
    // Mask off the bottom two bits → reserve logical CPUs 0 and 1 for audio/UI.
    let mask = total_mask & !0b11;
    if mask == 0 {
        return;
    }
    unsafe {
        let h = OpenProcess(
            PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION,
            0,
            pid,
        );
        if !h.is_null() {
            let _ = SetProcessAffinityMask(h, mask);
            CloseHandle(h);
        }
    }
}

#[cfg(unix)]
fn restrict_cpu_affinity(_pid: u32) {
    // libc::sched_setaffinity is Linux-only and the cost of getting it right
    // cross-platform (macOS uses thread_policy_set) is not worth it given
    // nice 19 already de-prioritises us aggressively enough on Unix audio
    // stacks (PulseAudio/CoreAudio run their own real-time threads).
}

fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        ""
    }
}

fn find_gs_binary() -> Option<PathBuf> {
    let ext = if cfg!(windows) { ".exe" } else { "" };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(format!("gs{ext}"));
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }

    let triple = current_target_triple();
    if !triple.is_empty() {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("gs-{triple}{ext}"));
        if dev.exists() {
            return Some(dev);
        }
    }

    None
}

/// Run Ghostscript once on a single input → output pair. In the default
/// (non-turbo) mode it spawns at idle priority and restricts CPU affinity to
/// keep audio/UI threads responsive; `turbo` runs at normal priority on all
/// cores for maximum speed.
fn run_gs_on(gs: &Path, input: &Path, output: &Path, preset: &str, turbo: bool) -> AppResult<()> {
    let mut cmd = Command::new(gs);
    cmd.arg("-sDEVICE=pdfwrite")
        .arg("-dCompatibilityLevel=1.7")
        .arg(format!("-dPDFSETTINGS=/{preset}"))
        .arg("-dNOPAUSE")
        .arg("-dQUIET")
        .arg("-dBATCH")
        .arg("-dSAFER")
        .arg(format!("-sOutputFile={}", output.display()))
        .arg(input);
    configure_scheduling(&mut cmd, turbo);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn ghostscript: {e}")))?;
    if !turbo {
        restrict_cpu_affinity(child.id());
    }
    let status = child
        .wait()
        .map_err(|e| AppError::Other(format!("ghostscript wait failed: {e}")))?;
    if !status.success() {
        return Err(AppError::Other(format!(
            "ghostscript exited with status {status}"
        )));
    }
    Ok(())
}

fn validate_preset(preset: &str) -> AppResult<()> {
    if !VALID_PRESETS.contains(&preset) {
        return Err(AppError::Invalid(format!(
            "Invalid Ghostscript preset '{preset}'. Allowed: {}",
            VALID_PRESETS.join(", ")
        )));
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// Single-shot command
// ──────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn compress_pdf_gs(
    path: String,
    output: Option<String>,
    preset: Option<String>,
    turbo: Option<bool>,
    app_handle: tauri::AppHandle,
) -> AppResult<GsCompressResult> {
    let preset = preset.unwrap_or_else(|| "ebook".to_string());
    validate_preset(&preset)?;
    let turbo = turbo.unwrap_or(false);

    tokio::task::spawn_blocking(move || -> AppResult<GsCompressResult> {
        let _t = crate::utils::timing::Timer::start("compress_pdf_gs", format!("/{preset}{}", if turbo { " turbo" } else { "" }));
        let gs = find_gs_binary().ok_or_else(|| {
            AppError::Other(
                "Ghostscript binary not found. Run scripts/fetch-gs.ps1 (Windows) \
                 or scripts/fetch-gs.sh (mac/linux) to vendor it."
                    .to_string(),
            )
        })?;

        let original_bytes = fs::metadata(&path)?.len();
        let out = output.unwrap_or_else(|| temp_output_path(&path, "gs-compressed"));

        let _ = app_handle.emit(
            "operation-progress",
            Progress::new(0, 1, format!("Ghostscript /{preset} ...")),
        );

        run_gs_on(&gs, Path::new(&path), Path::new(&out), &preset, turbo)?;

        let compressed_bytes = fs::metadata(&out)?.len();
        let compressed_bytes = if compressed_bytes >= original_bytes {
            fs::copy(&path, &out)?;
            original_bytes
        } else {
            compressed_bytes
        };

        let _ = app_handle.emit(
            "operation-progress",
            Progress::new(1, 1, format!("Ghostscript /{preset} done")),
        );

        Ok(GsCompressResult {
            path: out,
            original_bytes,
            compressed_bytes,
            preset,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

// ──────────────────────────────────────────────────────────────────────────
// Chunk-parallel command
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_PAGES: u32 = 25;
/// Worker count for the parallel path. Default caps at half the cores (min 2,
/// max 8) so the box stays usable; `turbo` uses all-but-one core for maximum
/// throughput at the cost of responsiveness.
fn parallel_workers(turbo: bool) -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    if turbo {
        cores.saturating_sub(1).max(1)
    } else {
        (cores / 2).max(2).min(8)
    }
}

/// Split `doc` into N temp PDFs, each containing `chunk_size` consecutive pages
/// (last one may be shorter). Returns the on-disk paths of the chunks.
fn split_into_chunks(doc: &Document, chunk_size: u32, dir: &str) -> AppResult<Vec<PathBuf>> {
    let total = doc.get_pages().len() as u32;
    let mut chunks = Vec::new();
    let mut start = 1u32;
    let mut idx = 0u32;
    while start <= total {
        let end = (start + chunk_size - 1).min(total);
        let mut part = doc.clone();
        let to_delete: Vec<u32> = (1..=total).filter(|&p| p < start || p > end).collect();
        part.delete_pages(&to_delete);

        let out = PathBuf::from(format!("{dir}/qyra-gs-chunk-{idx:04}.pdf"));
        part.save(&out)?;
        chunks.push(out);

        idx += 1;
        start = end + 1;
    }
    Ok(chunks)
}

#[tauri::command]
pub async fn compress_pdf_gs_parallel(
    path: String,
    output: Option<String>,
    preset: Option<String>,
    chunk_pages: Option<u32>,
    turbo: Option<bool>,
    app_handle: tauri::AppHandle,
) -> AppResult<GsCompressResult> {
    let preset = preset.unwrap_or_else(|| "ebook".to_string());
    validate_preset(&preset)?;
    let chunk_size = chunk_pages.unwrap_or(DEFAULT_CHUNK_PAGES).max(1);
    let turbo = turbo.unwrap_or(false);

    tokio::task::spawn_blocking(move || -> AppResult<GsCompressResult> {
        let _t = crate::utils::timing::Timer::start("compress_pdf_gs_parallel", format!("/{preset}{}", if turbo { " turbo" } else { "" }));
        let gs = find_gs_binary().ok_or_else(|| {
            AppError::Other(
                "Ghostscript binary not found. Run scripts/fetch-gs.ps1 (Windows) \
                 or scripts/fetch-gs.sh (mac/linux) to vendor it."
                    .to_string(),
            )
        })?;

        let original_bytes = fs::metadata(&path)?.len();
        let out = output.unwrap_or_else(|| temp_output_path(&path, "gs-compressed"));

        let doc = Document::load(&path)?;
        let total_pages = doc.get_pages().len() as u32;

        // Below 2× chunk size the overhead beats the parallelism — go single-shot.
        if total_pages <= chunk_size * 2 {
            let _ = app_handle.emit(
                "operation-progress",
                Progress::new(0, 1, format!("Ghostscript /{preset} (small doc, single pass) ...")),
            );
            run_gs_on(&gs, Path::new(&path), Path::new(&out), &preset, turbo)?;
        } else {
            let _ = app_handle.emit(
                "operation-progress",
                Progress::new(0, 3, "Splitting into chunks ...".to_string()),
            );
            let dir = temp_dir_str();
            let chunk_paths = split_into_chunks(&doc, chunk_size, &dir)?;
            drop(doc);
            let num_chunks = chunk_paths.len();

            let _ = app_handle.emit(
                "operation-progress",
                Progress::new(
                    1,
                    3,
                    format!(
                        "Compressing {num_chunks} chunks in parallel ({} workers) ...",
                        parallel_workers(turbo)
                    ),
                ),
            );

            // Build a dedicated rayon pool with capped workers so we don't
            // outrun the global pool's defaults.
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(parallel_workers(turbo))
                .build()
                .map_err(|e| AppError::Other(format!("rayon pool: {e}")))?;

            let done = Mutex::new(0usize);
            let app = app_handle.clone();
            let compressed_chunks: AppResult<Vec<PathBuf>> = pool.install(|| {
                chunk_paths
                    .par_iter()
                    .map(|chunk| -> AppResult<PathBuf> {
                        let mut out_path = chunk.clone();
                        let fname = chunk
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("chunk.pdf")
                            .to_string();
                        out_path.set_file_name(format!("c-{fname}"));
                        run_gs_on(&gs, chunk, &out_path, &preset, turbo)?;

                        if let Ok(mut g) = done.lock() {
                            *g += 1;
                            let _ = app.emit(
                                "operation-progress",
                                Progress::new(
                                    1,
                                    3,
                                    format!("Compressed {} of {} chunks", *g, num_chunks),
                                ),
                            );
                        }
                        Ok(out_path)
                    })
                    .collect()
            });
            let compressed_chunks = compressed_chunks?;

            let _ = app_handle.emit(
                "operation-progress",
                Progress::new(2, 3, "Merging chunks ...".to_string()),
            );

            let docs: Vec<Document> = compressed_chunks
                .iter()
                .map(|p| Document::load(p).map_err(AppError::from))
                .collect::<AppResult<Vec<_>>>()?;
            let mut merged = merge_documents(docs)?;
            merged.save(&out)?;

            // Cleanup intermediate files (input chunks + compressed chunks).
            for p in chunk_paths.iter().chain(compressed_chunks.iter()) {
                let _ = fs::remove_file(p);
            }
        }

        let compressed_bytes = fs::metadata(&out)?.len();
        let compressed_bytes = if compressed_bytes >= original_bytes {
            fs::copy(&path, &out)?;
            original_bytes
        } else {
            compressed_bytes
        };

        let _ = app_handle.emit(
            "operation-progress",
            Progress::new(3, 3, format!("Ghostscript /{preset} done")),
        );

        Ok(GsCompressResult {
            path: out,
            original_bytes,
            compressed_bytes,
            preset,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
