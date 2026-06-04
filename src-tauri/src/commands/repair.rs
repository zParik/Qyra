use crate::error::{AppError, AppResult};
use crate::utils::paths::temp_output_path;
use lopdf::Document;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct RepairOptions {
    /// When true, fall back to rasterizing pages via MuPDF if the strict
    /// lopdf-based rewrite fails. The output keeps page geometry but loses
    /// text selection and links — last-resort recovery.
    pub allow_rasterize: bool,
    /// Rasterize DPI (only used if rasterize fallback runs). Defaults to 200.
    pub rasterize_dpi: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub output: String,
    pub mode: &'static str,
    pub page_count: usize,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

fn file_size(path: &str) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[cfg(not(target_os = "android"))]
fn rasterize_pages(path: &str, dpi: u32) -> AppResult<(String, usize)> {
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Dictionary, Object, Stream};

    let doc_src = mupdf::Document::open(path).map_err(|e| AppError::Pdf(e.to_string()))?;
    let page_count = doc_src.page_count().map_err(|e| AppError::Pdf(e.to_string()))? as usize;
    if page_count == 0 {
        return Err(AppError::Other("repair: source has 0 pages".into()));
    }

    let scale = dpi as f32 / 72.0;
    let matrix = mupdf::Matrix::new_scale(scale, scale);

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut page_ids: Vec<Object> = Vec::with_capacity(page_count);

    for i in 0..page_count {
        let page = doc_src.load_page(i as i32)
            .map_err(|e| AppError::Pdf(format!("page {}: {}", i, e)))?;
        let bounds = page.bounds().map_err(|e| AppError::Pdf(e.to_string()))?;
        let pw = (bounds.x1 - bounds.x0).abs();
        let ph = (bounds.y1 - bounds.y0).abs();
        if pw <= 0.0 || ph <= 0.0 { continue; }

        let pixmap = page
            .to_pixmap(&matrix, &mupdf::Colorspace::device_rgb(), false, false)
            .map_err(|e| AppError::Pdf(format!("rasterize {}: {}", i, e)))?;

        let width = pixmap.width();
        let height = pixmap.height();
        let samples = pixmap.samples().to_vec();
        let img = image::RgbImage::from_raw(width, height, samples)
            .ok_or_else(|| AppError::Pdf(format!("pixmap→RgbImage failed at page {}", i)))?;
        let mut jpeg: Vec<u8> = Vec::new();
        {
            let mut cursor = std::io::Cursor::new(&mut jpeg);
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85)
                .encode_image(&image::DynamicImage::ImageRgb8(img))
                .map_err(|e| AppError::Pdf(format!("jpeg encode {}: {}", i, e)))?;
        }

        let img_dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => pixmap.width() as i64,
            "Height" => pixmap.height() as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        };
        let img_id = doc.add_object(Stream::new(img_dict, jpeg));

        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new(
                "cm",
                vec![
                    Object::Real(pw), Object::Real(0.0),
                    Object::Real(0.0), Object::Real(ph),
                    Object::Real(0.0), Object::Real(0.0),
                ],
            ),
            Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
            Operation::new("Q", vec![]),
        ];
        let content = Content { operations: ops };
        let content_bytes = content.encode()
            .map_err(|e| AppError::Pdf(e.to_string()))?;
        let content_id = doc.add_object(Stream::new(Dictionary::new(), content_bytes));

        let mut xobj_dict = Dictionary::new();
        xobj_dict.set("Im0", Object::Reference(img_id));
        let mut resources = Dictionary::new();
        resources.set("XObject", Object::Dictionary(xobj_dict));

        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "Contents" => Object::Reference(content_id),
            "Resources" => Object::Dictionary(resources),
            "MediaBox" => Object::Array(vec![
                Object::Real(0.0), Object::Real(0.0),
                Object::Real(pw), Object::Real(ph),
            ]),
        });
        page_ids.push(Object::Reference(page_id));
    }

    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Count" => page_ids.len() as i64,
        "Kids" => Object::Array(page_ids),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let out = temp_output_path(path, "repaired");
    doc.save(&out)?;
    Ok((out, page_count))
}

#[cfg(target_os = "android")]
fn rasterize_pages(_path: &str, _dpi: u32) -> AppResult<(String, usize)> {
    Err(AppError::Other("rasterize repair unavailable on Android".into()))
}

#[tauri::command]
pub async fn repair_pdf(
    path: String,
    options: Option<RepairOptions>,
    output: Option<String>,
) -> AppResult<RepairReport> {
    let opts = options.unwrap_or_default();
    let bytes_before = file_size(&path);

    tokio::task::spawn_blocking(move || -> AppResult<RepairReport> {
        let _t = crate::utils::timing::Timer::start("repair_pdf", String::new());
        // Strict path: lopdf load auto-repairs xref + we rewrite cleanly.
        let strict_err: Option<AppError> = match Document::load(&path) {
            Ok(doc) => {
                let page_count = doc.get_pages().len();
                let mut doc = doc;
                let out = output.clone().unwrap_or_else(|| temp_output_path(&path, "repaired"));
                match doc.save(&out) {
                    Ok(_) => {
                        return Ok(RepairReport {
                            output: out.clone(),
                            mode: "strict",
                            page_count,
                            bytes_before,
                            bytes_after: file_size(&out),
                        });
                    }
                    Err(e) => Some(AppError::Pdf(e.to_string())),
                }
            }
            Err(e) => Some(AppError::Pdf(e.to_string())),
        };

        if !opts.allow_rasterize {
            return Err(strict_err.unwrap_or_else(||
                AppError::Other("repair: strict pass failed and rasterize disabled".into())));
        }

        let dpi = opts.rasterize_dpi.unwrap_or(200).clamp(72, 600);
        let (raster_out, page_count) = rasterize_pages(&path, dpi)?;
        let final_out = match output {
            Some(custom) => {
                std::fs::rename(&raster_out, &custom)
                    .map_err(|e| AppError::Other(format!("move output: {}", e)))?;
                custom
            }
            None => raster_out,
        };
        Ok(RepairReport {
            output: final_out.clone(),
            mode: "rasterize",
            page_count,
            bytes_before,
            bytes_after: file_size(&final_out),
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
