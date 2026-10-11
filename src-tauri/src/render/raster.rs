//! MuPDF rasterization: display lists with Qyra's annotation rules, region
//! renders to RGBA, and image encoding.
use crate::error::AppResult;
use crate::render::geometry::PageSizePt;

/// Size of every page in points, after /Rotate (MuPDF bounds are rotated).
pub fn page_sizes(doc: &mupdf::Document) -> AppResult<Vec<PageSizePt>> {
    let n = doc.page_count()?;
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let b = doc.load_page(i)?.bounds()?;
        out.push(PageSizePt { w: (b.x1 - b.x0).abs() as f64, h: (b.y1 - b.y0).abs() as f64 });
    }
    Ok(out)
}

/// Record page `page_idx` (0-based) into a display list in page space.
///
/// Same content rules as the old `rasterize_page`:
///  • form widgets are never baked (FormLayer draws live inputs on top);
///  • Text (sticky-note) and Popup annotations are hidden in memory, because
///    CommentLayer shows them as DOM pins.
/// Annotations without an /AP get one synthesized by `update()`.
pub fn build_display_list(doc: &mupdf::Document, page_idx: i32) -> AppResult<mupdf::DisplayList> {
    use mupdf::pdf::annotation::AnnotationFlags;
    use mupdf::pdf::{PdfAnnotationType, PdfPage};

    let page = doc.load_page(page_idx)?;
    let mut p = match PdfPage::try_from(page) {
        Ok(p) => p,
        // Non-PDF document (no annotation API): record everything.
        Err(_) => return Ok(doc.load_page(page_idx)?.to_display_list(true)?),
    };

    for mut annot in p.annotations() {
        if matches!(annot.r#type(), Ok(PdfAnnotationType::Text | PdfAnnotationType::Popup)) {
            let _ = annot.set_flags(AnnotationFlags::IS_HIDDEN);
        }
        // mupdf-rs 0.6: AnnotationIter yields borrowed pointers but Drop
        // releases a reference it never took (use-after-free). Forget it.
        std::mem::forget(annot);
    }
    let _ = p.update();

    let list = mupdf::DisplayList::new(p.bounds()?)?;
    {
        let device = mupdf::Device::from_display_list(&list)?;
        p.run_contents(&device, &mupdf::Matrix::IDENTITY)?;
        p.run_annotations(&device, &mupdf::Matrix::IDENTITY)?;
    } // device dropped: list closed
    Ok(list)
}
