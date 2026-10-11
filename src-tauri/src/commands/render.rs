use std::path::Path;
use serde::Serialize;
use crate::error::{AppError, AppResult};

#[derive(Serialize, Clone)]
pub struct CharRect {
    pub c: String,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

#[derive(Serialize, Clone)]
pub struct TextLine {
    pub chars: Vec<CharRect>,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub page: u32,
    pub count: u32,
}

/// Extract per-character bounding boxes from a PDF page via MuPDF.
/// Returns coordinates normalised to [0, 1] relative to page dimensions.
/// `page` is 1-indexed.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_text_page(
    worker: tauri::State<'_, crate::commands::render_worker::RenderWorker>,
    path: String,
    page: u32,
) -> AppResult<Vec<TextLine>> {
    let worker = worker.inner().clone();
    tokio::task::spawn_blocking(move || worker.text(path, page))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_text_page(
    _path: String,
    _page: u32,
) -> AppResult<Vec<TextLine>> {
    Ok(vec![])
}

/// Full-document text search via MuPDF (case-insensitive).
/// Returns one entry per page that contains the query, with match count.
/// Runs all pages in a single spawn_blocking — no repeated document opens.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn search_pdf(path: String, query: String) -> AppResult<Vec<SearchHit>> {
    tokio::task::spawn_blocking(move || -> AppResult<Vec<SearchHit>> {
        let doc = mupdf::Document::open(&path)?;
        let page_count = doc.page_count()?;
        let q = query.to_lowercase();
        let mut results: Vec<SearchHit> = Vec::new();

        for i in 0..page_count {
            let page = doc.load_page(i)?;
            let stext = page.to_text_page(mupdf::TextPageFlags::empty())?;

            let mut text = String::new();
            for block in stext.blocks() {
                if block.r#type() != mupdf::text_page::TextBlockType::Text {
                    continue;
                }
                for line in block.lines() {
                    for ch in line.chars() {
                        if let Some(c) = ch.char() {
                            text.push(c);
                        }
                    }
                    text.push('\n');
                }
            }

            let count = text.to_lowercase().matches(q.as_str()).count() as u32;
            if count > 0 {
                results.push(SearchHit { page: (i + 1) as u32, count });
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn search_pdf(_path: String, _query: String) -> AppResult<Vec<SearchHit>> {
    Ok(vec![])
}

/// Extract link annotations from a PDF page via MuPDF.
/// Returns normalized [0, 1] coordinates and the URI string for each link.
/// `page` is 1-indexed.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_page_links(
    worker: tauri::State<'_, crate::commands::render_worker::RenderWorker>,
    path: String,
    page: u32,
) -> AppResult<Vec<PageLink>> {
    let worker = worker.inner().clone();
    tokio::task::spawn_blocking(move || worker.links(path, page))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_page_links(_path: String, _page: u32) -> AppResult<Vec<PageLink>> {
    Ok(vec![])
}

#[derive(Serialize)]
pub struct PageLink {
    pub uri: String,
    pub page: Option<u32>,  // 1-based page number for internal GoTo links
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

/// Export every page of a PDF as an image file using MuPDF.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn pdf_to_images(
    path: String,
    format: Option<String>,
    dpi: Option<u32>,
    output_dir: Option<String>,
) -> AppResult<Vec<String>> {
    tokio::task::spawn_blocking(move || -> AppResult<Vec<String>> {
        let _t = crate::utils::timing::Timer::start("pdf_to_images", String::new());
        let doc = mupdf::Document::open(&path)?;
        let page_count = doc.page_count()?;
        let fmt = format.unwrap_or_else(|| "png".to_string()).to_lowercase();
        let dpi = dpi.unwrap_or(150);
        let stem = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("page");
        let dir = output_dir
            .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
        // Unknown formats fall back to PNG data under the requested extension
        // (the previous behaviour).
        let encoding = if matches!(fmt.as_str(), "jpg" | "jpeg") { "jpg" } else { "png" };
        let mut paths = Vec::new();
        for i in 0..page_count {
            let out = format!("{}/{}_page{:04}.{}", dir, stem, i + 1, fmt);
            crate::render::export::export_page_image(&doc, i as u32 + 1, dpi, encoding, Path::new(&out))?;
            paths.push(out);
        }
        Ok(paths)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn pdf_to_images(
    _path: String,
    _format: Option<String>,
    _dpi: Option<u32>,
    _output_dir: Option<String>,
) -> AppResult<Vec<String>> {
    Err(AppError::Other("pdf_to_images not supported on Android".to_string()))
}

// ── Tiled render pipeline ─────────────────────────────────────────────────────

/// Page count, per-page sizes (pt) and a cache-busting version for `path`.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn doc_open(
    service: tauri::State<'_, crate::render::service::RenderService>,
    path: String,
) -> AppResult<crate::commands::render_worker::DocInfo> {
    let worker = service.worker().clone();
    tokio::task::spawn_blocking(move || worker.doc_info(path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// One 512 px tile as raw RGBA (8-byte LE w,h header). 0×0 = cancelled/outside.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn render_tile(
    service: tauri::State<'_, crate::render::service::RenderService>,
    req: crate::render::service::TileReq,
) -> AppResult<tauri::ipc::Response> {
    // Awaited, not blocked on: a queued tile holds no thread.
    let img = service.tile_async(req).await?;
    Ok(tauri::ipc::Response::new(crate::render::raster::to_wire(img.as_ref())))
}

/// A whole page as raw RGBA (same wire format) — OCR and print.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn render_page_rgba(
    service: tauri::State<'_, crate::render::service::RenderService>,
    path: String,
    page: u32,
    scale: f64,
) -> AppResult<tauri::ipc::Response> {
    let img = service
        .page_async(
            crate::render::service::internal_id(),
            path,
            page,
            scale,
            crate::render::scheduler::Priority::Visible,
        )
        .await?;
    Ok(tauri::ipc::Response::new(crate::render::raster::to_wire(img.as_ref())))
}

/// Drop queued tile jobs; a running one finishes and is discarded.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub fn cancel_renders(service: tauri::State<'_, crate::render::service::RenderService>, ids: Vec<u64>) {
    service.cancel(&ids);
}

/// Write one page to an image file at `dpi` — lossless PNG or JPEG (q92), no size cap.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn export_page_image(path: String, page: u32, dpi: u32, format: String, out: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || {
        let doc = mupdf::Document::open(&path)?;
        crate::render::export::export_page_image(&doc, page, dpi, &format, Path::new(&out))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
