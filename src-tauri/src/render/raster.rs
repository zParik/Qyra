//! MuPDF rasterization: display lists with Qyra's annotation rules, region
//! renders to RGBA, and image encoding.
use crate::error::AppResult;
use crate::render::geometry::{PageSizePt, TileRect};

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

/// Tightly packed 8-bit RGBA, row-major, `width * height * 4` bytes.
#[derive(Debug, Clone)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// Rasterize `rect` (device px, page origin at 0,0) of `list` at `scale`.
/// The page's own origin (MediaBox offset) is translated away first so tile
/// coordinates are always relative to the page's top-left.
pub fn render_region(list: &mupdf::DisplayList, scale: f64, rect: TileRect) -> AppResult<RgbaImage> {
    let b = list.bounds();
    let mut ctm = mupdf::Matrix::new_translate(-b.x0, -b.y0);
    ctm.concat(mupdf::Matrix::new_scale(scale as f32, scale as f32));

    let irect = mupdf::IRect { x0: rect.x0 as i32, y0: rect.y0 as i32, x1: rect.x1 as i32, y1: rect.y1 as i32 };
    let mut pixmap = mupdf::Pixmap::new_with_rect(&mupdf::Colorspace::device_rgb(), irect, false)?;
    pixmap.clear_with(0xff)?;
    {
        let device = mupdf::Device::from_pixmap(&pixmap)?;
        let area = mupdf::Rect { x0: rect.x0 as f32, y0: rect.y0 as f32, x1: rect.x1 as f32, y1: rect.y1 as f32 };
        list.run(&device, &ctm, area)?;
    } // device dropped: output flushed into the pixmap

    let (w, h) = (rect.width(), rect.height());
    let n = pixmap.n() as usize; // 3 for RGB without alpha
    let stride = pixmap.stride() as usize;
    let src = pixmap.samples();
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h as usize {
        let line = &src[row * stride..row * stride + w as usize * n];
        for px in line.chunks_exact(n) {
            data.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
    }
    Ok(RgbaImage { width: w, height: h, data })
}

/// `u32 LE width, u32 LE height` then pixels; `None` → 0×0 header only.
pub fn to_wire(img: Option<&RgbaImage>) -> Vec<u8> {
    match img {
        None => vec![0u8; 8],
        Some(img) => {
            let mut out = Vec::with_capacity(8 + img.data.len());
            out.extend_from_slice(&img.width.to_le_bytes());
            out.extend_from_slice(&img.height.to_le_bytes());
            out.extend_from_slice(&img.data);
            out
        }
    }
}

fn to_rgb(img: &RgbaImage) -> AppResult<image::RgbImage> {
    let rgb: Vec<u8> = img.data.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    image::RgbImage::from_raw(img.width, img.height, rgb)
        .ok_or_else(|| crate::error::AppError::Other("bad image buffer".into()))
}

/// Lossless PNG (fast compression — thumbnails and exports are rendered on demand).
pub fn encode_png(img: &RgbaImage) -> AppResult<Vec<u8>> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    let mut out = Vec::new();
    to_rgb(img)?.write_with_encoder(PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive))?;
    Ok(out)
}

pub fn encode_jpeg(img: &RgbaImage, quality: u8) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    to_rgb(img)?.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality))?;
    Ok(out)
}
