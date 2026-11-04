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

/// Prefix of the per-output directories `temp_output_path` creates.
const WORKING_DIR_PREFIX: &str = "qyra-";

/// Generate an output path in the OS temp directory:
/// `<tmp>/qyra-XXXXXX/<stem>_<suffix>.pdf`.
/// Use this as the default output when no explicit path is provided, so that
/// operations don't auto-save into the user's folder before they choose Save/Save As.
///
/// Each call gets its own directory, so two open files with the same name never
/// share (and overwrite) one working copy. When `input` is itself a working
/// copy, its previous suffix is dropped, so chained edits keep one readable name
/// instead of growing it until the OS rejects it.
pub fn temp_output_path(input: &str, suffix: &str) -> String {
    let p = Path::new(input);
    let mut stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output")
        .to_string();
    if is_working_copy(p) {
        if let Some(i) = stem.rfind('_') {
            stem.truncate(i);
        }
    }
    let tmp = std::env::temp_dir();
    let dir = tempfile::Builder::new()
        .prefix(WORKING_DIR_PREFIX)
        .tempdir_in(&tmp)
        .map(|d| d.keep())
        .unwrap_or(tmp);
    dir.join(format!("{}_{}.pdf", stem, suffix))
        .to_string_lossy()
        .to_string()
}

/// True for a file `temp_output_path` produced.
fn is_working_copy(p: &Path) -> bool {
    let Some(dir) = p.parent() else { return false };
    let named = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(WORKING_DIR_PREFIX));
    named && dir.parent() == Some(std::env::temp_dir().as_path())
}

/// Copy `src` over `dst` without ever leaving `dst` half-written: a no-op when
/// both name the same file (a plain copy would truncate it to nothing first),
/// otherwise written to a temp file beside `dst`, flushed to disk, and renamed
/// over it. `before_replace` runs just before the rename, to release open
/// handles on `dst` (Windows refuses to rename over an open file).
pub fn replace_file_with_copy(src: &Path, dst: &Path, before_replace: impl FnOnce()) -> std::io::Result<()> {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(src), std::fs::canonicalize(dst)) {
        if a == b {
            return Ok(());
        }
    }
    replace_file_with(dst, |f| std::io::copy(&mut std::fs::File::open(src)?, f).map(|_| ()), before_replace)
}

/// Write `dst` through `write` atomically: into a temp file beside it, flushed
/// to disk, then renamed over it, so a crash or full disk mid-write never
/// leaves the user's file truncated. See `replace_file_with_copy`.
pub fn replace_file_with(
    dst: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
    before_replace: impl FnOnce(),
) -> std::io::Result<()> {
    let dir = dst.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let mut tmp = tempfile::Builder::new().prefix(".qyra-save-").suffix(".tmp").tempfile_in(dir)?;
    write(tmp.as_file_mut())?;
    tmp.as_file().sync_all()?;
    before_replace();
    match tmp.persist(dst) {
        Ok(_) => Ok(()),
        // Still locked (another app has it open on Windows): fall back to an
        // in-place copy rather than failing the save.
        Err(e) if e.error.kind() == std::io::ErrorKind::PermissionDenied => {
            std::fs::copy(e.file.path(), dst).map(|_| ())
        }
        Err(e) => Err(e.error),
    }
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
