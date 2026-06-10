#![allow(dead_code)] // path helpers kept as a utility API; not all are wired yet

use std::path::Path;
use tempfile::TempDir;

pub fn output_path(input: &str, suffix: &str) -> String {
    let p = Path::new(input);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let dir = p.parent().unwrap_or(Path::new("."));
    dir.join(format!("{}_{}.pdf", stem, suffix))
        .to_string_lossy()
        .to_string()
}

/// Generate an output path in the OS temp directory.
/// Use this as the default output when no explicit path is provided, so that
/// operations don't auto-save into the user's folder before they choose Save/Save As.
pub fn temp_output_path(input: &str, suffix: &str) -> String {
    let stem = Path::new(input)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    std::env::temp_dir()
        .join(format!("{}_{}.pdf", stem, suffix))
        .to_string_lossy()
        .to_string()
}

/// Return the OS temp directory as a string, for commands that produce multiple files.
pub fn temp_dir_str() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

/// Sibling path `<dir>/<stem><suffix>.<ext>`, bumping `-1`, `-2`, … until it
/// names a file that does not yet exist. Lets compression always write a NEW
/// file next to the original without ever overwriting anything.
pub fn unique_sibling_path(input: &str, suffix: &str) -> String {
    let p = Path::new(input);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("pdf");
    let dir = p.parent().unwrap_or(Path::new("."));

    let mut candidate = dir.join(format!("{stem}{suffix}.{ext}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}{suffix}-{n}.{ext}"));
        n += 1;
    }
    candidate.to_string_lossy().to_string()
}

pub fn output_path_with_ext(input: &str, suffix: &str, ext: &str) -> String {
    let p = Path::new(input);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
    let dir = p.parent().unwrap_or(Path::new("."));
    dir.join(format!("{}_{}.{}", stem, suffix, ext))
        .to_string_lossy()
        .to_string()
}

pub fn temp_dir() -> std::io::Result<TempDir> {
    tempfile::tempdir()
}

pub fn ensure_output_dir(path: &str) -> std::io::Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}
