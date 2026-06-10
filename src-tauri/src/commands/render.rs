use std::path::Path;
use std::sync::{Arc, Mutex};
use base64::Engine;
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

/// Thread-safe active document tracker to cancel in-flight rendering tasks.
#[derive(Clone)]
pub struct ActiveDocument {
    pub path: Arc<Mutex<Option<String>>>,
}

impl ActiveDocument {
    pub fn new() -> Self {
        Self {
            path: Arc::new(Mutex::new(None)),
        }
    }

    /// True if `path` is the currently active document. Used by the render
    /// worker to drop jobs for a document the user has navigated away from.
    /// A poisoned lock returns false (treat as "not active" → cancel).
    pub fn is(&self, path: &str) -> bool {
        self.path
            .lock()
            .map(|p| p.as_deref() == Some(path))
            .unwrap_or(false)
    }
}

#[tauri::command]
pub fn set_active_document(state: tauri::State<'_, ActiveDocument>, path: Option<String>) {
    if let Ok(mut p) = state.path.lock() {
        *p = path;
    }
}

/// Reads a PDF file as base64 — kept for the OCR engine which needs a PDF.js document.
#[tauri::command]
pub async fn read_pdf_bytes(path: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let bytes = std::fs::read(&path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Render one PDF page via MuPDF. Returns base64 JPEG.
/// `page` is 1-indexed. `scale` multiplies the native 72-DPI resolution.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn render_page(
    worker: tauri::State<'_, crate::commands::render_worker::RenderWorker>,
    path: String,
    page: u32,
    scale: f32,
) -> AppResult<String> {
    // The render worker owns a cache of open MuPDF documents, so this no longer
    // reparses the whole PDF per call. `check_active = true` keeps the previous
    // behaviour of cancelling renders for a document the user navigated away from.
    let worker = worker.inner().clone();
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let bytes = worker.render(path, page, scale, true)?;
        Ok(crate::commands::render_worker::b64(&bytes))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Render a page from any PDF path, bypassing the ActiveDocument gate.
/// Used by compare/preview features that need two PDFs open simultaneously.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn render_page_uncached(
    worker: tauri::State<'_, crate::commands::render_worker::RenderWorker>,
    path: String,
    page: u32,
    scale: f32,
) -> AppResult<String> {
    // Compare/preview features render two PDFs at once; the worker's doc cache
    // holds several open documents, so both sides stay warm. `check_active =
    // false` bypasses the active-document gate (these are not the viewer's doc).
    let worker = worker.inner().clone();
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let bytes = worker.render(path, page, scale, false)?;
        Ok(crate::commands::render_worker::b64(&bytes))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn render_page_uncached(
    _path: String,
    _page: u32,
    _scale: f32,
) -> AppResult<String> {
    Err(AppError::Other("Not supported on Android".to_string()))
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn render_page(
    _state: tauri::State<'_, ActiveDocument>,
    path: String,
    page: u32,
    scale: f32,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        use crate::commands::android_pdf::{app_cache_dir, open_pfd, pdf_render_guard, safe_android_context};
        use jni::objects::{JObject, JValue};

        let _lock = pdf_render_guard();

        let ctx = safe_android_context()?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        // Run all JNI work in an inner block so we can always clear any pending
        // Java exception before the AttachGuard drops — otherwise DetachCurrentThread
        // with a pending exception causes a fatal crash on Android.
        let result: Result<String, String> = (|| {
            let pfd = open_pfd(&mut env, &context, &path)?;

            let renderer = env
                .new_object(
                    "android/graphics/pdf/PdfRenderer",
                    "(Landroid/os/ParcelFileDescriptor;)V",
                    &[JValue::Object(&pfd)],
                )
                .map_err(|e| e.to_string())?;

            let pdf_page = env
                .call_method(
                    &renderer,
                    "openPage",
                    "(I)Landroid/graphics/pdf/PdfRenderer$Page;",
                    &[JValue::Int((page as i32) - 1)],
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;

            let w = env
                .call_method(&pdf_page, "getWidth", "()I", &[])
                .map_err(|e| e.to_string())?
                .i()
                .map_err(|e| e.to_string())?;
            let h = env
                .call_method(&pdf_page, "getHeight", "()I", &[])
                .map_err(|e| e.to_string())?
                .i()
                .map_err(|e| e.to_string())?;

            let bmp_w = ((w as f32) * scale).round() as i32;
            let bmp_h = ((h as f32) * scale).round() as i32;

            let argb8888 = env
                .get_static_field(
                    "android/graphics/Bitmap$Config",
                    "ARGB_8888",
                    "Landroid/graphics/Bitmap$Config;",
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;

            let bitmap = env
                .call_static_method(
                    "android/graphics/Bitmap",
                    "createBitmap",
                    "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;",
                    &[JValue::Int(bmp_w), JValue::Int(bmp_h), JValue::Object(&argb8888)],
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;

            let canvas = env
                .new_object(
                    "android/graphics/Canvas",
                    "(Landroid/graphics/Bitmap;)V",
                    &[JValue::Object(&bitmap)],
                )
                .map_err(|e| e.to_string())?;
            let white = env
                .get_static_field("android/graphics/Color", "WHITE", "I")
                .map_err(|e| e.to_string())?
                .i()
                .map_err(|e| e.to_string())?;
            env.call_method(&canvas, "drawColor", "(I)V", &[JValue::Int(white)])
                .map_err(|e| e.to_string())?;

            let null = JObject::null();
            env.call_method(
                &pdf_page,
                "render",
                "(Landroid/graphics/Bitmap;Landroid/graphics/Rect;Landroid/graphics/Matrix;I)V",
                &[
                    JValue::Object(&bitmap),
                    JValue::Object(&null),
                    JValue::Object(&null),
                    JValue::Int(1),
                ],
            )
            .map_err(|e| e.to_string())?;

            env.call_method(&pdf_page, "close", "()V", &[]).ok();
            env.call_method(&renderer, "close", "()V", &[]).ok();
            env.call_method(&pfd, "close", "()V", &[]).ok();

            let cache_dir = app_cache_dir(&mut env, &context)?;
            let tmp_path = format!("{}/qyra_render_p{}_s{}.jpg", cache_dir, page, (scale * 1000.0) as u32);

            let j_tmp = env.new_string(&tmp_path).map_err(|e| e.to_string())?;
            let j_file = env
                .new_object("java/io/File", "(Ljava/lang/String;)V", &[JValue::Object(&j_tmp)])
                .map_err(|e| e.to_string())?;
            let fos = env
                .new_object(
                    "java/io/FileOutputStream",
                    "(Ljava/io/File;)V",
                    &[JValue::Object(&j_file)],
                )
                .map_err(|e| e.to_string())?;

            let jpeg_fmt = env
                .get_static_field(
                    "android/graphics/Bitmap$CompressFormat",
                    "JPEG",
                    "Landroid/graphics/Bitmap$CompressFormat;",
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;

            env.call_method(
                &bitmap,
                "compress",
                "(Landroid/graphics/Bitmap$CompressFormat;ILjava/io/OutputStream;)Z",
                &[JValue::Object(&jpeg_fmt), JValue::Int(90), JValue::Object(&fos)],
            )
            .map_err(|e| e.to_string())?;

            env.call_method(&fos, "close", "()V", &[]).map_err(|e| e.to_string())?;
            env.call_method(&bitmap, "recycle", "()V", &[]).ok();

            let bytes = std::fs::read(&tmp_path).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp_path);

            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        })();

        env.exception_clear().ok();
        result
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .map_err(AppError::Other)
}

/// Returns height/width aspect ratio of page 1.
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_page_aspect_ratio(
    worker: tauri::State<'_, crate::commands::render_worker::RenderWorker>,
    path: String,
) -> AppResult<f64> {
    let worker = worker.inner().clone();
    tokio::task::spawn_blocking(move || worker.aspect(path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_page_aspect_ratio(path: String) -> AppResult<f64> {
    tokio::task::spawn_blocking(move || -> Result<f64, String> {
        use crate::commands::android_pdf::{open_pfd, pdf_render_guard, safe_android_context};
        use jni::objects::{JObject, JValue};

        let _lock = pdf_render_guard();

        let ctx = safe_android_context()?;
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };

        let result: Result<f64, String> = (|| {
            let pfd = open_pfd(&mut env, &context, &path)?;
            let renderer = env
                .new_object(
                    "android/graphics/pdf/PdfRenderer",
                    "(Landroid/os/ParcelFileDescriptor;)V",
                    &[JValue::Object(&pfd)],
                )
                .map_err(|e| e.to_string())?;

            let pdf_page = env
                .call_method(
                    &renderer,
                    "openPage",
                    "(I)Landroid/graphics/pdf/PdfRenderer$Page;",
                    &[JValue::Int(0)],
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;

            let w = env
                .call_method(&pdf_page, "getWidth", "()I", &[])
                .map_err(|e| e.to_string())?
                .i()
                .map_err(|e| e.to_string())? as f64;
            let h = env
                .call_method(&pdf_page, "getHeight", "()I", &[])
                .map_err(|e| e.to_string())?
                .i()
                .map_err(|e| e.to_string())? as f64;

            env.call_method(&pdf_page, "close", "()V", &[]).ok();
            env.call_method(&renderer, "close", "()V", &[]).ok();
            env.call_method(&pfd, "close", "()V", &[]).ok();

            if w == 0.0 { Ok(1.4142) } else { Ok(h / w) }
        })();

        env.exception_clear().ok();
        result
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .map_err(AppError::Other)
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
    _state: tauri::State<'_, ActiveDocument>,
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

/// Legacy stub — kept so old callers don't get unresolved command errors.
#[tauri::command]
pub fn render_thumbnail(path: String, _page: u32, _dpi: Option<u32>) -> AppResult<String> {
    if !Path::new(&path).exists() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }
    Err(AppError::Other("Use render_page".to_string()))
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
        let scale = dpi.unwrap_or(150) as f32 / 72.0;
        let stem = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("page");
        let dir = output_dir
            .unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
        let matrix = mupdf::Matrix::new_scale(scale, scale);
        let cs = mupdf::Colorspace::device_rgb();
        let img_fmt = match fmt.as_str() {
            "jpg" | "jpeg" => image::ImageFormat::Jpeg,
            _ => image::ImageFormat::Png,
        };
        let mut paths = Vec::new();
        for i in 0..page_count {
            let page = doc.load_page(i)?;
            let pixmap = page.to_pixmap(&matrix, &cs, false, false)?;
            let img = image::RgbImage::from_raw(
                pixmap.width(),
                pixmap.height(),
                pixmap.samples().to_vec(),
            )
            .ok_or_else(|| AppError::Pdf("pixmap→image failed".to_string()))?;
            let out = format!("{}/{}_page{:04}.{}", dir, stem, i + 1, fmt);
            img.save_with_format(&out, img_fmt)?;
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
