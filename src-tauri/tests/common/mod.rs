//! Shared helpers for the integration test suite: fixture resolution, temp
//! output dirs, and PDF assertion utilities.
//!
//! Each test file pulls this in with `mod common;`, so not every binary uses
//! every helper — silence the resulting per-binary dead-code warnings.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Directory holding the generated fixture PDFs (built by `npm run fixtures`).
pub fn fixtures_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is .../src-tauri; the corpus lives at <repo>/tests/fixtures.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent (repo root)")
        .join("tests")
        .join("fixtures")
        .join("pdf")
        .join("generated")
}

/// Absolute path to a fixture, asserting it exists with a helpful hint.
pub fn fixture(name: &str) -> PathBuf {
    let p = fixtures_dir().join(name);
    assert!(
        p.exists(),
        "fixture `{}` not found at {} — run `npm run fixtures` first",
        name,
        p.display(),
    );
    p
}

/// Fixture path as the `String` the Tauri commands expect.
pub fn fixture_str(name: &str) -> String {
    fixture(name).to_string_lossy().into_owned()
}

/// A throwaway directory for command output, cleaned up when dropped.
pub fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("create temp dir")
}

/// Path inside a fresh temp dir; returns (dir guard, path string). Keep the
/// guard alive for the duration of the test.
pub fn temp_output(name: &str) -> (tempfile::TempDir, String) {
    let dir = temp_dir();
    let path = dir.path().join(name).to_string_lossy().into_owned();
    (dir, path)
}

// ── PDF assertion helpers (mupdf/lopdf) ─────────────────────────────────────

/// Page count via mupdf (matches what the app's renderer sees).
pub fn page_count(path: &str) -> usize {
    let doc = mupdf::Document::open(path).expect("open pdf with mupdf");
    doc.page_count().expect("page count") as usize
}

/// Concatenated extracted text of a page (0-indexed), via mupdf. Mirrors the
/// structured-text walk used by the export_pdf_to_text command.
pub fn page_text(path: &str, page: usize) -> String {
    let doc = mupdf::Document::open(path).expect("open pdf with mupdf");
    let p = doc.load_page(page as i32).expect("load page");
    let stext = p
        .to_text_page(mupdf::TextPageFlags::empty())
        .expect("structured text");
    let mut out = String::new();
    for block in stext.blocks() {
        if block.r#type() != mupdf::text_page::TextBlockType::Text {
            continue;
        }
        for line in block.lines() {
            for ch in line.chars() {
                if let Some(c) = ch.char() {
                    out.push(c);
                }
            }
            out.push('\n');
        }
    }
    out
}

/// Whether the document carries an /Encrypt entry in its trailer. Uses lopdf so
/// it does not depend on a password being supplied.
pub fn is_encrypted(path: &str) -> bool {
    match lopdf::Document::load(path) {
        Ok(doc) => doc.trailer.get(b"Encrypt").is_ok(),
        Err(_) => true, // could not load as plaintext => treat as locked
    }
}

/// Load a document with lopdf for structural assertions on objects/trailer.
pub fn load_lopdf(path: &str) -> lopdf::Document {
    lopdf::Document::load(path).expect("load pdf with lopdf")
}
