/// Pure transform functions — each takes an object and returns a new one.
/// Never mutates in place so they are individually testable.
use flate2::{write::ZlibEncoder, Compression};
use image::DynamicImage;
use std::io::{Cursor, Write};

use crate::pdf::error::PdfError;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject, PdfStream};

// ---------------------------------------------------------------------------
// Stream recompression (lossless)
// ---------------------------------------------------------------------------

/// Re-encode a stream at maximum zlib compression.
///
/// If the result is not smaller than the original `raw_bytes`, the original
/// stream is returned unchanged.
pub fn recompress_stream(stream: PdfStream) -> Result<PdfStream, PdfError> {
    let filter = stream.dict.get(b"Filter").cloned();

    let raw_decoded = match &filter {
        None => stream.raw_bytes.clone(),
        Some(PdfObject::Name(n)) if n == b"FlateDecode" || n == b"Fl" => {
            stream.decode()?
        }
        Some(PdfObject::Array(arr)) if arr.len() == 1 => {
            let is_flat = arr
                .first()
                .and_then(|o| o.as_name())
                .map(|n| n == b"FlateDecode" || n == b"Fl")
                .unwrap_or(false);
            if !is_flat {
                return Ok(stream); // can't help
            }
            stream.decode()?
        }
        _ => return Ok(stream), // DCT, JBIG2, LZW, etc — leave alone
    };

    let compressed = zlib_compress_best(&raw_decoded)?;
    if compressed.len() >= stream.raw_bytes.len() {
        return Ok(stream); // no benefit
    }

    let mut new_dict = stream.dict.clone();
    new_dict.set(b"Filter", PdfObject::Name(b"FlateDecode".to_vec()));
    new_dict.set(b"Length", PdfObject::Integer(compressed.len() as i64));
    new_dict.remove(b"DecodeParms");

    Ok(PdfStream {
        dict: new_dict,
        raw_bytes: compressed,
    })
}

// ---------------------------------------------------------------------------
// Image recompression (lossy)
// ---------------------------------------------------------------------------

/// Recompress an image XObject as JPEG.
///
/// Ported from `try_recompress_image` in the lopdf-based `compress.rs`.
/// Returns the original stream unchanged if:
/// - the image is a mask or has an SMask (transparency)
/// - the image is smaller than 64×64 (logos/icons)
/// - the new encoding is not smaller than the original
/// - the image format cannot be decoded
pub fn recompress_image(
    stream: PdfStream,
    quality: u8,
    to_grayscale: bool,
    max_dimension: Option<u32>,
) -> Result<PdfStream, PdfError> {
    if quality == 0 {
        return Ok(stream);
    }

    // Safety guards — same as lopdf version
    let is_mask = stream
        .dict
        .get(b"ImageMask")
        .and_then(|v| if let PdfObject::Boolean(b) = v { Some(*b) } else { None })
        .unwrap_or(false);
    if is_mask {
        return Ok(stream);
    }

    // Skip if there's an SMask reference (transparency channel)
    if stream.dict.get(b"SMask").is_some() {
        return Ok(stream);
    }

    let width = stream
        .dict
        .get(b"Width")
        .and_then(|v| v.as_integer())
        .unwrap_or(0) as u32;
    let height = stream
        .dict
        .get(b"Height")
        .and_then(|v| v.as_integer())
        .unwrap_or(0) as u32;

    if width < 64 || height < 64 {
        return Ok(stream); // preserve logos/icons
    }

    let filter_name = stream.filter_name().map(|n| n.to_vec());
    let is_dct = filter_name
        .as_deref()
        .map(|n| n == b"DCTDecode" || n == b"DCT")
        .unwrap_or(false);
    let is_flate = filter_name
        .as_deref()
        .map(|n| n == b"FlateDecode" || n == b"Fl")
        .unwrap_or(false);

    if !is_dct && !is_flate {
        return Ok(stream); // unsupported encoding
    }

    // Determine colour space / components
    let cs = stream.dict.get(b"ColorSpace").cloned();
    let components = colorspace_components(&cs);

    // Only handle supported component counts for FlateDecode raw images
    if !is_dct {
        match components {
            Some(1) | Some(3) => {}
            _ => return Ok(stream), // Indexed, CMYK, unknown — skip
        }
    }

    let is_already_gray = match &cs {
        Some(PdfObject::Name(n)) => n == b"DeviceGray",
        Some(PdfObject::Array(_)) => components == Some(1),
        _ => false,
    };

    let original_len = stream.raw_bytes.len();

    // Decode to pixel data
    let content = if is_dct {
        stream.raw_bytes.clone()
    } else {
        stream.decode().map_err(|e| PdfError::ImageDecodeError(e.to_string()))?
    };

    let mut img: DynamicImage = if is_dct {
        image::load_from_memory(&content)
            .map_err(|e| PdfError::ImageDecodeError(format!("JPEG decode: {}", e)))?
    } else {
        let comps = if is_already_gray { 1usize } else { 3usize };
        let expected = (width as usize) * (height as usize) * comps;
        if content.len() < expected {
            return Ok(stream); // corrupt / partial image
        }
        if comps == 1 {
            let gray = image::GrayImage::from_raw(width, height, content[..expected].to_vec())
                .ok_or_else(|| PdfError::ImageDecodeError("Raw Gray decode failed".into()))?;
            DynamicImage::ImageLuma8(gray)
        } else {
            let rgb = image::RgbImage::from_raw(width, height, content[..expected].to_vec())
                .ok_or_else(|| PdfError::ImageDecodeError("Raw RGB decode failed".into()))?;
            DynamicImage::ImageRgb8(rgb)
        }
    };

    // Downsample if needed
    if let Some(cap) = max_dimension {
        let (w, h) = (img.width(), img.height());
        if w > cap || h > cap {
            img = img.resize(cap, cap, image::imageops::FilterType::Lanczos3);
        }
    }

    #[cfg(debug_assertions)]
    eprintln!(
        "[compress] image {}x{} → reencoding at quality {}{}",
        img.width(),
        img.height(),
        quality,
        if to_grayscale { " (grayscale)" } else { "" }
    );

    // Re-encode as JPEG
    let mut new_bytes = Vec::new();
    let output_gray = to_grayscale || is_already_gray;
    {
        let mut cursor = Cursor::new(&mut new_bytes);
        if output_gray {
            let gray = img.to_luma8();
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
            gray.write_with_encoder(encoder)
                .map_err(|e| PdfError::ImageDecodeError(format!("JPEG encode: {}", e)))?;
        } else {
            let rgb = img.to_rgb8();
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
            rgb.write_with_encoder(encoder)
                .map_err(|e| PdfError::ImageDecodeError(format!("JPEG encode: {}", e)))?;
        }
    }

    // Only replace if smaller
    if new_bytes.len() >= original_len {
        return Ok(stream);
    }

    let color_space: &[u8] = if output_gray { b"DeviceGray" } else { b"DeviceRGB" };
    let mut new_dict = stream.dict.clone();
    new_dict.set(b"ColorSpace", PdfObject::Name(color_space.to_vec()));
    new_dict.set(b"Filter", PdfObject::Name(b"DCTDecode".to_vec()));
    new_dict.set(b"BitsPerComponent", PdfObject::Integer(8));
    new_dict.set(b"Width", PdfObject::Integer(img.width() as i64));
    new_dict.set(b"Height", PdfObject::Integer(img.height() as i64));
    new_dict.set(b"Length", PdfObject::Integer(new_bytes.len() as i64));
    new_dict.remove(b"DecodeParms");

    Ok(PdfStream {
        dict: new_dict,
        raw_bytes: new_bytes,
    })
}

// ---------------------------------------------------------------------------
// Metadata predicates
// ---------------------------------------------------------------------------

/// Return `true` if this object is an XMP metadata stream (`/Type /Metadata`).
pub fn is_metadata_stream(dict: &PdfDict) -> bool {
    dict.get_type() == Some(b"Metadata")
}

/// Return `true` if `id` is the /Info dictionary referenced in the trailer.
#[allow(dead_code)]
pub fn is_info_dict(id: ObjectId, trailer: &PdfDict) -> bool {
    trailer
        .get(b"Info")
        .and_then(|v| v.as_reference())
        .map(|ref_id| ref_id == id)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn zlib_compress_best(data: &[u8]) -> Result<Vec<u8>, PdfError> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::best());
    enc.write_all(data)
        .map_err(|e| PdfError::WriteError(format!("zlib write: {}", e)))?;
    enc.finish()
        .map_err(|e| PdfError::WriteError(format!("zlib finish: {}", e)))
}

/// Determine the number of colour components from a /ColorSpace value.
fn colorspace_components(cs: &Option<PdfObject>) -> Option<usize> {
    match cs.as_ref()? {
        PdfObject::Name(n) if n == b"DeviceRGB" => Some(3),
        PdfObject::Name(n) if n == b"DeviceGray" => Some(1),
        PdfObject::Name(n) if n == b"DeviceCMYK" => Some(4),
        PdfObject::Array(arr) => {
            let first = arr.first()?.as_name()?;
            if first == b"Indexed" {
                return None;
            }
            // For ICCBased we'd need to look up the profile — return None (safe skip)
            None
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::{PdfDict, PdfObject, PdfStream};

    fn make_uncompressed_stream(data: &[u8]) -> PdfStream {
        let mut dict = PdfDict::new();
        dict.set(b"Length".to_vec(), PdfObject::Integer(data.len() as i64));
        PdfStream {
            dict,
            raw_bytes: data.to_vec(),
        }
    }

    #[test]
    fn recompress_already_optimal_unchanged() {
        // A stream with no filter — compressing random data shouldn't expand it
        // Use highly compressible data to guarantee shrinkage
        let data = vec![0u8; 1000];
        let stream = make_uncompressed_stream(&data);
        let result = recompress_stream(stream).unwrap();
        // Should be FlateDecode now and smaller
        assert_eq!(result.filter_name(), Some(b"FlateDecode".as_ref()));
        assert!(result.raw_bytes.len() < 1000);
    }

    #[test]
    fn recompress_stream_dct_untouched() {
        let mut dict = PdfDict::new();
        dict.set(b"Filter".to_vec(), PdfObject::Name(b"DCTDecode".to_vec()));
        dict.set(b"Length".to_vec(), PdfObject::Integer(5));
        let stream = PdfStream {
            dict,
            raw_bytes: b"abcde".to_vec(),
        };
        let result = recompress_stream(stream.clone()).unwrap();
        // DCT streams must not be touched
        assert_eq!(result.filter_name(), Some(b"DCTDecode".as_ref()));
        assert_eq!(result.raw_bytes, b"abcde");
    }

    #[test]
    fn is_metadata_stream_detected() {
        let mut dict = PdfDict::new();
        dict.set(b"Type".to_vec(), PdfObject::Name(b"Metadata".to_vec()));
        assert!(is_metadata_stream(&dict));
    }

    #[test]
    fn is_info_dict_detected() {
        let mut trailer = PdfDict::new();
        trailer.set(
            b"Info".to_vec(),
            PdfObject::Reference((5, 0)),
        );
        assert!(is_info_dict((5, 0), &trailer));
        assert!(!is_info_dict((6, 0), &trailer));
    }

    #[test]
    fn recompress_image_mask_skipped() {
        let mut dict = PdfDict::new();
        dict.set(b"Subtype".to_vec(), PdfObject::Name(b"Image".to_vec()));
        dict.set(b"ImageMask".to_vec(), PdfObject::Boolean(true));
        dict.set(b"Width".to_vec(), PdfObject::Integer(100));
        dict.set(b"Height".to_vec(), PdfObject::Integer(100));
        dict.set(b"Length".to_vec(), PdfObject::Integer(5));
        let stream = PdfStream {
            dict,
            raw_bytes: b"abcde".to_vec(),
        };
        let result = recompress_image(stream.clone(), 72, false, None).unwrap();
        // ImageMask must be untouched
        assert_eq!(result.raw_bytes, b"abcde");
    }
}
