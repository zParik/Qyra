use lopdf::{Document, Object};
use image::DynamicImage;
use std::io::Cursor;
use crate::utils::paths::temp_output_path;

/// Compress a PDF at one of three levels:
///   0 = Low    — lossless object stream compression only
///   1 = High   — Low + strip XMP metadata, Info dict, page thumbnails
///   2 = Extreme — High + convert color images to grayscale JPEG (max size reduction)
#[tauri::command]
pub fn compress_pdf(path: String, output: Option<String>, level: Option<u8>) -> Result<String, String> {
    let mut doc = Document::load(&path).map_err(|e| e.to_string())?;
    let level = level.unwrap_or(0);

    if level >= 1 {
        strip_metadata(&mut doc);
    }
    if level >= 2 {
        convert_images_to_grayscale(&mut doc);
    }

    doc.compress();

    let out = output.unwrap_or_else(|| temp_output_path(&path, "compressed"));
    doc.save(&out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn strip_metadata(doc: &mut Document) {
    // Remove XMP metadata stream reference
    doc.trailer.remove(b"Metadata");

    // Clear the Info dict (Author, Creator, Producer, etc.)
    let info_id = doc.trailer.get(b"Info").ok().and_then(|o| {
        if let Object::Reference(id) = o { Some(*id) } else { None }
    });
    if let Some(id) = info_id {
        if let Some(obj) = doc.objects.get_mut(&id) {
            *obj = Object::Dictionary(lopdf::Dictionary::new());
        }
    }

    // Strip per-page thumbnail images (/Thumb)
    let page_ids: Vec<_> = doc.get_pages().values().cloned().collect();
    for page_id in page_ids {
        if let Some(Object::Dictionary(d)) = doc.objects.get_mut(&page_id) {
            d.remove(b"Thumb");
        }
    }
}

fn convert_images_to_grayscale(doc: &mut Document) {
    let image_ids: Vec<_> = doc.objects.iter()
        .filter_map(|(&id, obj)| {
            let stream = match obj { Object::Stream(s) => s, _ => return None };
            // Must be an Image XObject
            let subtype = stream.dict.get(b"Subtype").ok()?.as_name().ok()?;
            if subtype != b"Image" { return None; }
            // Skip masks and already-grayscale images
            if stream.dict.get(b"ImageMask").ok()
                .and_then(|o| o.as_bool().ok()).unwrap_or(false) { return None; }
            if let Ok(Object::Name(cs)) = stream.dict.get(b"ColorSpace") {
                if cs == b"DeviceGray" { return None; }
            }
            Some(id)
        })
        .collect();

    for id in image_ids {
        let _ = try_convert_image(doc, id);
    }
}

fn try_convert_image(doc: &mut Document, id: lopdf::ObjectId) -> Result<(), String> {
    // Gather what we need before mutating
    let (width, height, is_dct, is_raw_rgb, content) = {
        let stream = match doc.objects.get(&id) {
            Some(Object::Stream(s)) => s,
            _ => return Ok(()),
        };

        let width = stream.dict.get(b"Width").ok()
            .and_then(|o| o.as_i64().ok()).unwrap_or(0) as u32;
        let height = stream.dict.get(b"Height").ok()
            .and_then(|o| o.as_i64().ok()).unwrap_or(0) as u32;

        let is_dct = match stream.dict.get(b"Filter") {
            Ok(Object::Name(n)) => n == b"DCTDecode",
            Ok(Object::Array(a)) => a.iter().any(|o| {
                o.as_name().map(|n| n == b"DCTDecode").unwrap_or(false)
            }),
            _ => false,
        };

        // For non-DCT paths we only handle raw DeviceRGB (most common)
        let is_raw_rgb = !is_dct && matches!(
            stream.dict.get(b"ColorSpace"),
            Ok(Object::Name(n)) if n == b"DeviceRGB"
        );

        // DCT: keep compressed JPEG bytes; otherwise decompress
        let content = if is_dct {
            stream.content.clone()
        } else {
            stream.decompressed_content().map_err(|e| e.to_string())?
        };

        (width, height, is_dct, is_raw_rgb, content)
    };

    if width == 0 || height == 0 { return Ok(()); }
    if !is_dct && !is_raw_rgb { return Ok(()); }

    // Decode to a DynamicImage
    let img: DynamicImage = if is_dct {
        // Handles JPEG in RGB, CMYK, or grayscale
        image::load_from_memory(&content).map_err(|e| e.to_string())?
    } else {
        // Raw DeviceRGB bytes: 3 bytes per pixel
        let expected = (width * height * 3) as usize;
        if content.len() < expected { return Ok(()); }
        let rgb = image::RgbImage::from_raw(width, height, content[..expected].to_vec())
            .ok_or("Failed to parse raw RGB bytes")?;
        DynamicImage::ImageRgb8(rgb)
    };

    // Convert to grayscale and encode as JPEG at quality 72
    let gray = img.to_luma8();
    let mut jpeg = Vec::new();
    {
        let mut cursor = Cursor::new(&mut jpeg);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 72);
        gray.write_with_encoder(encoder).map_err(|e| e.to_string())?;
    }

    // Write back into the document
    if let Some(Object::Stream(stream)) = doc.objects.get_mut(&id) {
        stream.dict.set(b"ColorSpace", Object::Name(b"DeviceGray".to_vec()));
        stream.dict.set(b"Filter", Object::Name(b"DCTDecode".to_vec()));
        stream.dict.set(b"Length", Object::Integer(jpeg.len() as i64));
        stream.dict.remove(b"DecodeParms");
        stream.content = jpeg;
        stream.allows_compression = false; // JPEG must not be deflated again
    }

    Ok(())
}
