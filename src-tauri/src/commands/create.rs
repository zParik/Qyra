// Images (PNG/JPEG/WebP) to PDF: one A4 page per image, fitted inside a 10 mm
// margin and centred. JPEGs are embedded as-is (DCTDecode), so they are not
// decoded or re-encoded; other formats are stored losslessly with Flate.
use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// A4 in points.
const PAGE_W: f32 = 595.276;
const PAGE_H: f32 = 841.89;
/// The image fits inside 190 x 270 mm.
const MAX_W: f32 = 538.583;
const MAX_H: f32 = 765.354;

/// Convert a list of images (PNG/JPG/WebP) to a PDF.
#[tauri::command]
pub fn images_to_pdf(
    image_paths: Vec<String>,
    output: Option<String>,
) -> AppResult<String> {
    if image_paths.is_empty() {
        return Err(AppError::Invalid("No images provided".to_string()));
    }

    let out = output.unwrap_or_else(|| temp_output_path(&image_paths[0], "converted"));

    let _t = crate::utils::timing::Timer::start("images_to_pdf", format!("{} imgs", image_paths.len()));
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids: Vec<Object> = Vec::with_capacity(image_paths.len());

    for img_path in &image_paths {
        let bytes = std::fs::read(img_path)?;
        let (image, w, h) = image_xobject(&mut doc, &bytes)
            .map_err(|e| AppError::Other(format!("Failed to open image {}: {}", img_path, e)))?;
        let image_id = doc.add_object(image);

        let aspect = w as f32 / h as f32;
        let (dw, dh) = if aspect > MAX_W / MAX_H {
            (MAX_W, MAX_W / aspect)
        } else {
            (MAX_H * aspect, MAX_H)
        };
        let x = (PAGE_W - dw) / 2.0;
        let y = (PAGE_H - dh) / 2.0;

        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new("cm", vec![dw.into(), 0.into(), 0.into(), dh.into(), x.into(), y.into()]),
                Operation::new("Do", vec!["Im0".into()]),
                Operation::new("Q", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode()?));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), PAGE_W.into(), PAGE_H.into()],
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image_id } },
            "Contents" => content_id,
        });
        kids.push(page_id.into());
    }

    let count = kids.len() as i64;
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    doc.save(&out)?;
    Ok(out)
}

/// The image XObject for `bytes`, plus its pixel size. Any alpha channel is
/// added to `doc` as a soft mask.
fn image_xobject(doc: &mut Document, bytes: &[u8]) -> Result<(Stream, u32, u32), String> {
    if let Some((w, h, components)) = jpeg_header(bytes) {
        // CMYK JPEGs often store inverted ink values (Adobe), which a plain
        // DCTDecode embed would show as a negative, so they take the decode path.
        let space = match components {
            1 => Some("DeviceGray"),
            3 => Some("DeviceRGB"),
            _ => None,
        };
        if let Some(space) = space {
            let dict = dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => w as i64,
                "Height" => h as i64,
                "ColorSpace" => space,
                "BitsPerComponent" => 8,
                "Interpolate" => true,
                "Filter" => "DCTDecode",
            };
            return Ok((Stream::new(dict, bytes.to_vec()), w, h));
        }
    }

    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => w as i64,
        "Height" => h as i64,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
        "Interpolate" => true,
        "Filter" => "FlateDecode",
    };
    if img.color().has_alpha() {
        let alpha: Vec<u8> = img.to_rgba8().pixels().map(|p| p[3]).collect();
        let mask = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => w as i64,
            "Height" => h as i64,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
            "Filter" => "FlateDecode",
        };
        let mask_id = doc.add_object(Stream::new(mask, deflate(&alpha)?));
        dict.set("SMask", mask_id);
    }
    Ok((Stream::new(dict, deflate(img.to_rgb8().as_raw())?), w, h))
}

fn deflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

/// Width, height and component count from a baseline or progressive JPEG's
/// start-of-frame marker; None if `bytes` is not a JPEG that can be read.
fn jpeg_header(bytes: &[u8]) -> Option<(u32, u32, u8)> {
    if bytes.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1; // fill byte
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
            let sof = bytes.get(i + 4..i + 10)?;
            let h = u16::from_be_bytes([sof[1], sof[2]]) as u32;
            let w = u16::from_be_bytes([sof[3], sof[4]]) as u32;
            return (w > 0 && h > 0).then_some((w, h, sof[5]));
        }
        if marker == 0xDA {
            return None; // start of scan before any frame header
        }
        i += 2 + len;
    }
    None
}
