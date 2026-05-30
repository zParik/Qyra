use lopdf::{Dictionary, Document, Object, Stream};
use serde::Deserialize;
use tauri::Emitter;

use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;
use crate::utils::get_page_dims;
use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
pub struct OcrWord {
    pub text: String,
    /// Normalized horizontal position [0, 1] from left edge
    pub x: f64,
    /// Normalized vertical position [0, 1] from top edge (image coords)
    pub y: f64,
    /// Normalized width [0, 1]
    #[allow(dead_code)] // part of the deserialized JS contract
    pub w: f64,
    /// Normalized height [0, 1]
    pub h: f64,
}

#[derive(Deserialize)]
pub struct OcrPage {
    pub words: Vec<OcrWord>,
}

/// Embed an invisible OCR text layer into each page of the PDF, making it
/// searchable and copy-pasteable without altering the visual appearance.
#[tauri::command]
pub async fn make_searchable(
    path: String,
    pages: Vec<OcrPage>,
    output: Option<String>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        make_searchable_core(path, pages, output, |p| {
            let _ = app_handle.emit("operation-progress", p);
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Pure OCR text-layer core (no Tauri runtime). `progress` receives each step
/// so the command wrapper can forward it as an event; tests pass a no-op.
pub fn make_searchable_core(
    path: String,
    pages: Vec<OcrPage>,
    output: Option<String>,
    progress: impl Fn(Progress),
) -> AppResult<String> {
        let out = output.unwrap_or_else(|| temp_output_path(&path, "searchable"));

        let mut doc = Document::load(&path)?;

        // Collect page IDs in document order (BTreeMap is sorted by 1-based page number)
        let page_ids: Vec<lopdf::ObjectId> = doc.get_pages().into_values().collect();
        let total = page_ids.len();

        struct PagePatch {
            page_id: lopdf::ObjectId,
            font_id: lopdf::ObjectId,
            content_id: lopdf::ObjectId,
        }

        // Phase 1: create font + content stream objects
        let mut patches: Vec<PagePatch> = Vec::new();

        for (idx, &page_id) in page_ids.iter().enumerate() {
            progress(Progress::new(idx, total + 1, format!("OCR page {} / {}", idx + 1, total)));

            let ocr_page = match pages.get(idx) {
                Some(p) => p,
                None => break,
            };
            if ocr_page.words.is_empty() {
                continue;
            }

            let (pw, ph) = get_page_dims(&doc, page_id);
            let content = text_content(&ocr_page.words, pw, ph);
            if content.is_empty() {
                continue;
            }

            // Standard Helvetica — a PDF built-in font, no embedding needed
            let mut font = Dictionary::new();
            font.set("Type", Object::Name(b"Font".to_vec()));
            font.set("Subtype", Object::Name(b"Type1".to_vec()));
            font.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
            let font_id = doc.add_object(Object::Dictionary(font));

            let stream = Stream::new(Dictionary::new(), content);
            let content_id = doc.add_object(Object::Stream(stream));

            patches.push(PagePatch { page_id, font_id, content_id });
        }

        // Phase 2: patch page dictionaries
        progress(Progress::new(total, total + 1, "Saving PDF"));

        for patch in patches {
            patch_page(&mut doc, patch.page_id, patch.font_id, patch.content_id)
                .map_err(|e| AppError::Pdf(format!("Failed to patch page: {e}")))?;
        }

        doc.save(&out)?;
        Ok(out)
}

// ── helpers ──────────────────────────────────────────────────────────────────


/// Build a PDF content stream that places invisible (render mode 3) text at
/// each word's position so the document becomes searchable / copy-pasteable.
fn text_content(words: &[OcrWord], pw: f64, ph: f64) -> Vec<u8> {
    let mut buf = String::from("q\nBT\n/OcrF 1 Tf\n3 Tr\n");
    let mut any = false;

    for w in words {
        let t = escape_pdf(&w.text);
        if t.is_empty() {
            continue;
        }
        any = true;

        let x = w.x * pw;
        // PDF origin is bottom-left; OCR bbox y is from top-left → flip
        let y = ph - (w.y + w.h) * ph;
        // Font size = word height in points (minimum 4 pt for readability)
        let fs = (w.h * ph).max(4.0);

        // Tm sets the text matrix: scale x/y by fs, position at (x, y)
        buf.push_str(&format!("{fs:.3} 0 0 {fs:.3} {x:.3} {y:.3} Tm ({t}) Tj\n"));
    }

    buf.push_str("ET\nQ\n");
    if any { buf.into_bytes() } else { Vec::new() }
}

fn escape_pdf(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            c if c.is_ascii() && !c.is_control() => out.push(c),
            _ => {}
        }
    }
    out
}

/// Add the OCR font resource and append the content stream to an existing page.
fn patch_page(
    doc: &mut Document,
    page_id: lopdf::ObjectId,
    font_id: lopdf::ObjectId,
    content_id: lopdf::ObjectId,
) -> Result<(), String> {
    // Read Resources + Contents without holding a borrow on doc
    let (res_obj, contents_obj) = {
        let obj = doc.get_object(page_id).map_err(|e| e.to_string())?;
        let d = obj.as_dict().map_err(|e| e.to_string())?;
        (
            d.get(b"Resources").ok().cloned(),
            d.get(b"Contents").ok().cloned(),
        )
    };

    // Resolve Resources (may be inline dict or a reference)
    let (res_ref_id, mut res_dict) = resolve_dict(doc, res_obj)?;

    // Resolve Resources.Font and add our entry
    let font_sub = res_dict.get(b"Font").ok().cloned();
    let (_, mut font_dict) = resolve_dict(doc, font_sub)?;
    font_dict.set("OcrF", Object::Reference(font_id));
    res_dict.set("Font", Object::Dictionary(font_dict));

    // Write updated Resources back to its owner, or keep it for inlining
    let inline_res: Option<Dictionary> = if let Some(ref_id) = res_ref_id {
        let target = doc.get_object_mut(ref_id).map_err(|e| e.to_string())?;
        *target = Object::Dictionary(res_dict);
        None
    } else {
        Some(res_dict)
    };

    // Build the new Contents (append our stream to whatever was there)
    let new_contents = match contents_obj {
        Some(Object::Reference(id)) => {
            Object::Array(vec![Object::Reference(id), Object::Reference(content_id)])
        }
        Some(Object::Array(mut arr)) => {
            arr.push(Object::Reference(content_id));
            Object::Array(arr)
        }
        _ => Object::Reference(content_id),
    };

    // Write page dict changes
    let page_obj = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
    if let Object::Dictionary(d) = page_obj {
        if let Some(res) = inline_res {
            d.set("Resources", Object::Dictionary(res));
        }
        d.set("Contents", new_contents);
    }

    Ok(())
}

/// Resolve an optional Object into an owned Dictionary.
/// Returns `(Some(ref_id), dict)` if it was a Reference, `(None, dict)` otherwise.
fn resolve_dict(
    doc: &Document,
    obj: Option<Object>,
) -> Result<(Option<lopdf::ObjectId>, Dictionary), String> {
    match obj {
        Some(Object::Dictionary(d)) => Ok((None, d)),
        Some(Object::Reference(id)) => {
            let d = {
                let resolved = doc.get_object(id).map_err(|e| e.to_string())?;
                resolved.as_dict().map_err(|e| e.to_string())?.clone()
            };
            Ok((Some(id), d))
        }
        _ => Ok((None, Dictionary::new())),
    }
}
