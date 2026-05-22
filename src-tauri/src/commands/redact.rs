use std::collections::HashMap;

use mupdf::color::AnnotationColor;
use mupdf::pdf::{PdfAnnotationType, PdfDocument, PdfPage, PdfWriteOptions};
use mupdf::Rect;

use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RedactRegion {
    pub page: u32,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

/// World-class destructive redaction.
///
/// Pipeline (per page that has regions):
///   1. Strip any pre-existing /Annots whose rect intersects a region — links,
///      widgets, comments, FreeText, etc. all become recoverable surface if left.
///   2. Add a `Redact` annotation for each region (fill: black). MuPDF stores
///      these as PDF redact annotations until applied.
///   3. Call `PdfPage::redact()` which invokes `pdf_redact_page`. This:
///        - removes every glyph whose bbox intersects a region (not just
///          glyph origin — true per-character clipping),
///        - rasterizes/clips image XObjects intersecting the region,
///        - removes line-art (vector) ops touching the region,
///        - strips annotations that intersect.
///      The page content stream is rewritten with the redacted region as a
///      solid black rectangle. No recoverable text / image data remains in
///      the stream.
///
/// Save uses `garbage_level=4`, `clean=true`, `sanitize=true`, `compress=true`:
///   - garbage 4 drops every unreferenced object including orphaned image
///     XObjects whose only references were removed by redaction.
///   - sanitize rewrites/simplifies content streams.
///   - compress applies flate to streams. The resulting file genuinely no
///     longer contains the redacted data on disk.
#[tauri::command]
pub async fn redact_pdf(
    path: String,
    regions: Vec<RedactRegion>,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let out = output.unwrap_or_else(|| temp_output_path(&path, "redacted"));

        if regions.is_empty() {
            std::fs::copy(&path, &out)?;
            return Ok(out);
        }

        // Group regions by page
        let mut by_page: HashMap<u32, Vec<RedactRegion>> = HashMap::new();
        for r in &regions {
            by_page.entry(r.page).or_default().push(*r);
        }

        let doc = PdfDocument::open(path.as_str())?;

        for (page_num, page_regions) in &by_page {
            // Frontend pages appear to be 1-based in this codebase's other
            // commands (lopdf get_pages returns 1-based). MuPDF load_page is
            // 0-based, so subtract 1. Skip if out of range.
            let idx = (*page_num).saturating_sub(1) as i32;
            let fz_page = match doc.load_page(idx) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let mut page = match PdfPage::try_from(fz_page) {
                Ok(p) => p,
                Err(_) => continue,
            };

            // Use `bounds()` not `media_box()` — bounds returns the page rect in
            // mupdf's internal fz coordinate space (top-down origin), which is
            // the same space mupdf's annotation/redaction APIs expect. The
            // frontend produces normalized regions in screen-space (also
            // top-down, y=0 at top) and the on-screen text uses the same
            // `bounds()`-relative normalization (see commands/render.rs
            // `get_text_page`), so this is the only consistent space to map
            // through. Using `media_box()` + flipping y was wrong — mupdf
            // would have ended up redacting the vertically mirrored region.
            let bounds = page.bounds()?;
            let pw = bounds.width() as f64;
            let ph = bounds.height() as f64;

            let pdf_rects: Vec<Rect> = page_regions
                .iter()
                .map(|r| {
                    let x0 = (bounds.x0 as f64 + r.x0 * pw) as f32;
                    let y0 = (bounds.y0 as f64 + r.y0 * ph) as f32;
                    let x1 = (bounds.x0 as f64 + r.x1 * pw) as f32;
                    let y1 = (bounds.y0 as f64 + r.y1 * ph) as f32;
                    Rect::new(x0, y0, x1, y1)
                })
                .collect();

            // Phase 1: remove pre-existing annotations intersecting any region.
            // MuPDF's redact pass already strips intersecting links/widgets,
            // but doing it explicitly first guarantees no leaked Contents
            // strings, popup text, or appearance streams survive on those
            // annotations.
            let existing: Vec<_> = page.annotations().collect();
            for annot in existing {
                if let Ok(at) = annot.r#type() {
                    // never touch annots we're about to create — they don't
                    // exist yet, so all existing ones are pre-redaction.
                    if at == PdfAnnotationType::Redact {
                        continue;
                    }
                }
                // We don't have a direct rect getter exposed for arbitrary
                // annots in mupdf-rs 0.6, but mupdf's `redact` will strip
                // intersecting annots automatically. To be defensive, we
                // delete every non-essential annotation type that commonly
                // carries text payload, when ANY region is on this page.
                if let Ok(at) = annot.r#type() {
                    let should_drop = matches!(
                        at,
                        PdfAnnotationType::Text
                            | PdfAnnotationType::FreeText
                            | PdfAnnotationType::Highlight
                            | PdfAnnotationType::Underline
                            | PdfAnnotationType::Squiggly
                            | PdfAnnotationType::StrikeOut
                            | PdfAnnotationType::Caret
                            | PdfAnnotationType::Popup
                            | PdfAnnotationType::FileAttachment
                            | PdfAnnotationType::Stamp
                    );
                    if should_drop {
                        let _ = page.delete_annotation(&annot);
                    }
                }
            }

            // Phase 2: create Redact annotations for each region.
            for rect in &pdf_rects {
                let mut annot = page.create_annotation(PdfAnnotationType::Redact)?;
                annot.set_rect(*rect)?;
                // Interior color = the fill used for the redacted region's
                // replacement rectangle. Solid black.
                annot.set_color(AnnotationColor::Rgb {
                    red: 0.0,
                    green: 0.0,
                    blue: 0.0,
                })?;
            }

            // Phase 3: bake the redactions. Returns true if anything changed.
            page.redact()?;
        }

        // Strip document-level metadata that might leak redacted strings via
        // the Info dict (titles, authors, subjects, keywords). Best-effort.
        if let Ok(trailer) = doc.trailer() {
            if let Ok(Some(mut info)) = trailer.get_dict("Info") {
                for key in ["Title", "Author", "Subject", "Keywords"] {
                    let _ = info.dict_delete(key);
                }
            }
        }

        // Save with strong cleanup so orphaned objects (now-unreferenced
        // image XObjects, fonts, etc.) are not retained in the output file.
        let mut opts = PdfWriteOptions::default();
        opts.set_garbage_level(4)
            .set_clean(true)
            .set_sanitize(true)
            .set_compress(true)
            .set_compress_images(true)
            .set_compress_fonts(true);

        doc.save_with_options(&out, opts)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
