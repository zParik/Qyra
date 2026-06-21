//! Tauri commands for the Word (.docx) viewer: open a document (parse + lay it
//! out, cached) and render a page to a base64 PNG. Mirrors the PDF render
//! commands' shape (`AppResult<String>` of a base64 image).

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::layout::engine::{layout_document, LayoutResult};
use crate::layout::font::FontSet;
use crate::layout::render::render_page;

/// Shared Word engine state: one layout font plus a cache of laid-out documents
/// keyed by path. Layout is point-based and scale-independent, so a document is
/// laid out once and rasterized per zoom level.
pub struct WordEngine {
    font: Arc<FontSet>,
    docs: Mutex<HashMap<String, Arc<LayoutResult>>>,
}

impl WordEngine {
    pub fn new() -> Self {
        Self {
            font: Arc::new(FontSet::default_set()),
            docs: Mutex::new(HashMap::new()),
        }
    }

    /// Drop the cached layout for a path (after the file changes on disk).
    pub fn invalidate(&self, path: &str) {
        if let Ok(mut map) = self.docs.lock() {
            map.remove(path);
        }
    }
}

impl Default for WordEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDocInfo {
    pub page_count: usize,
    pub pages: Vec<PageSize>,
}

#[derive(Serialize, Clone, Copy)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

/// Return the cached layout for `path`, parsing + laying it out on a cache miss.
fn load_layout(engine: &WordEngine, path: &str) -> AppResult<Arc<LayoutResult>> {
    if let Ok(map) = engine.docs.lock() {
        if let Some(l) = map.get(path) {
            return Ok(l.clone());
        }
    }
    let bytes = std::fs::read(path)?;
    let doc = crate::oxml::docx::open(&bytes).map_err(|e| AppError::Invalid(e.to_string()))?;
    let layout = Arc::new(layout_document(&doc, &engine.font));
    eprintln!(
        "[docx] {} body blocks, page {:.0}x{:.0}pt, header={} footer={} -> {} pages",
        doc.blocks.len(),
        doc.page.width,
        doc.page.height,
        doc.header.len(),
        doc.footer.len(),
        layout.pages.len(),
    );
    if let Ok(mut map) = engine.docs.lock() {
        map.insert(path.to_string(), layout.clone());
    }
    Ok(layout)
}

/// Open a `.docx`: parse + lay it out (cached) and report the page sizes.
#[tauri::command]
pub async fn open_word(
    engine: tauri::State<'_, WordEngine>,
    path: String,
) -> AppResult<WordDocInfo> {
    let layout = load_layout(&engine, &path)?;
    let pages: Vec<PageSize> = layout
        .pages
        .iter()
        .map(|p| PageSize { width: p.width, height: p.height })
        .collect();
    Ok(WordDocInfo { page_count: pages.len(), pages })
}

/// Render one page (0-indexed) of a `.docx` to a base64 PNG at `scale` device
/// pixels per point.
#[tauri::command]
pub async fn render_word_page(
    engine: tauri::State<'_, WordEngine>,
    path: String,
    page: usize,
    scale: f32,
) -> AppResult<String> {
    let layout = load_layout(&engine, &path)?;
    let font = engine.font.clone();
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let p = layout
            .pages
            .get(page)
            .ok_or_else(|| AppError::NotFound(format!("page {page}")))?;
        let (w, h, rgba) = render_page(p, &font, scale);
        let img = image::RgbaImage::from_raw(w, h, rgba)
            .ok_or_else(|| AppError::Other("pixel buffer → image failed".into()))?;
        let mut png: Vec<u8> = Vec::new();
        img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&png))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Basic editing: replace `find` with `replace` in the document body text and
/// write the result to `output` (may equal `path` to edit in place). Lossless —
/// only `w:t` text changes. Returns the output path.
#[tauri::command]
pub async fn replace_in_word(
    engine: tauri::State<'_, WordEngine>,
    path: String,
    find: String,
    replace: String,
    output: String,
) -> AppResult<String> {
    let in_path = path.clone();
    let out_path = output.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let bytes = std::fs::read(&in_path)?;
        let out = crate::oxml::editor::replace_in_package(&bytes, &find, &replace)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        std::fs::write(&out_path, &out)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    // The on-disk file changed; drop stale cached layouts.
    engine.invalidate(&path);
    engine.invalidate(&output);
    Ok(output)
}

/// Rich edit: replace body paragraph `index`'s runs (formatting-preserving) and
/// save to `output`. Untouched paragraphs stay byte-identical.
#[tauri::command]
pub async fn set_word_paragraph_runs(
    engine: tauri::State<'_, WordEngine>,
    path: String,
    index: usize,
    runs: Vec<crate::oxml::editor::RunEdit>,
    align: Option<String>,
    output: String,
) -> AppResult<String> {
    let in_path = path.clone();
    let out_path = output.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let bytes = std::fs::read(&in_path)?;
        let out = crate::oxml::editor::set_paragraph_runs_in_package(&bytes, index, &runs, align.as_deref())
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        std::fs::write(&out_path, &out)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    engine.invalidate(&path);
    engine.invalidate(&output);
    Ok(output)
}

/// Structural save: regenerate the whole body from `paras` (supports adding/
/// removing/reordering paragraphs), preserving page geometry. Refuses docs with
/// tables. Returns the output path.
#[tauri::command]
pub async fn save_word_body(
    engine: tauri::State<'_, WordEngine>,
    path: String,
    paras: Vec<crate::oxml::editor::ParaEdit>,
    output: String,
) -> AppResult<String> {
    let in_path = path.clone();
    let out_path = output.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let bytes = std::fs::read(&in_path)?;
        let out = crate::oxml::editor::save_body_in_package(&bytes, &paras)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        std::fs::write(&out_path, &out)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    engine.invalidate(&path);
    engine.invalidate(&output);
    Ok(output)
}

/// Render the document body to styled HTML for the in-place editor surface.
#[tauri::command]
pub async fn get_word_html(path: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let bytes = std::fs::read(&path)?;
        let doc = crate::oxml::docx::open(&bytes).map_err(|e| AppError::Invalid(e.to_string()))?;
        Ok(crate::oxml::html::to_html(&doc))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// The text of each top-level body paragraph, for paragraph-level editing.
#[tauri::command]
pub async fn get_word_paragraphs(path: String) -> AppResult<Vec<String>> {
    tokio::task::spawn_blocking(move || -> AppResult<Vec<String>> {
        let bytes = std::fs::read(&path)?;
        crate::oxml::editor::paragraph_texts_in_package(&bytes)
            .map_err(|e| AppError::Invalid(e.to_string()))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Replace body paragraph `index`'s text and save to `output` (lossless).
#[tauri::command]
pub async fn set_word_paragraph(
    engine: tauri::State<'_, WordEngine>,
    path: String,
    index: usize,
    text: String,
    output: String,
) -> AppResult<String> {
    let in_path = path.clone();
    let out_path = output.clone();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let bytes = std::fs::read(&in_path)?;
        let out = crate::oxml::editor::set_paragraph_in_package(&bytes, index, &text)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        std::fs::write(&out_path, &out)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;

    engine.invalidate(&path);
    engine.invalidate(&output);
    Ok(output)
}
