//! Page → image file, rendered at the exact requested DPI (no size cap).
use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::render::geometry::{page_px, PageSizePt, TileRect};
use crate::render::raster::{build_display_list, encode_jpeg, encode_png, render_region};

/// Write 1-based `page` of `doc` to `out` as `"png"` (lossless) or `"jpg"` (q92).
pub fn export_page_image(doc: &mupdf::Document, page: u32, dpi: u32, format: &str, out: &Path) -> AppResult<()> {
    let list = build_display_list(doc, page as i32 - 1)?;
    let b = list.bounds();
    let scale = dpi as f64 / 72.0;
    let px = page_px(PageSizePt { w: (b.x1 - b.x0) as f64, h: (b.y1 - b.y0) as f64 }, scale);
    let img = render_region(&list, scale, TileRect { x0: 0, y0: 0, x1: px.0, y1: px.1 })?;
    let bytes = match format {
        "png" => encode_png(&img)?,
        "jpg" | "jpeg" => encode_jpeg(&img, 92)?,
        other => return Err(AppError::Invalid(format!("unsupported image format: {other}"))),
    };
    std::fs::write(out, bytes)?;
    Ok(())
}
