/// Pure transform functions — each takes an object and returns a new one.
/// Never mutates in place so they are individually testable.
use flate2::{write::ZlibEncoder, Compression};
use image::DynamicImage;
use std::io::{Cursor, Write};

use crate::pdf::error::PdfError;
use crate::pdf::rewriter::colorspace::{decode_image_to_dynimage, ResolvedColorSpace};
use crate::pdf::rewriter::plan::ImagePlan;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject, PdfStream};

// ---------------------------------------------------------------------------
// Stream recompression (lossless)
// ---------------------------------------------------------------------------

/// Re-encode a stream at maximum zlib compression.
///
/// If the result is not smaller than the original `raw_bytes`, the original
/// stream is returned unchanged.
pub fn recompress_stream(stream: PdfStream, zlib_level: u32) -> Result<PdfStream, PdfError> {
    let filter = stream.dict.get(b"Filter").cloned();

    // Skip the decode+re-encode for tiny streams already in Flate — the cost
    // outweighs the negligible gain (matters a lot on object-heavy PDFs).
    let already_flate = match &filter {
        Some(PdfObject::Name(n)) => n == b"FlateDecode" || n == b"Fl",
        Some(PdfObject::Array(a)) => a
            .first()
            .and_then(|o| o.as_name())
            .map(|n| n == b"FlateDecode" || n == b"Fl")
            .unwrap_or(false),
        _ => false,
    };
    if already_flate && stream.raw_bytes.len() < 1024 {
        return Ok(stream);
    }

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

    let compressed = zlib_compress(&raw_decoded, zlib_level)?;
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

/// Recompress an image XObject as JPEG, following its precomputed `ImagePlan`.
///
/// The plan (built in the sequential pre-pass) carries the fully resolved colour
/// space and the target pixel dimensions derived from the image's drawn DPI —
/// this is what lets the engine match Ghostscript on ICCBased/CMYK/Indexed
/// images and on resolution-based downsampling, instead of skipping them.
///
/// Returns the original stream unchanged on any decode/encode failure or when
/// the result is not smaller — never corrupts.
pub fn recompress_image(
    stream: PdfStream,
    plan: &ImagePlan,
    quality: u8,
) -> Result<PdfStream, PdfError> {
    if quality == 0 {
        return Ok(stream);
    }

    let width = stream.dict.get(b"Width").and_then(|v| v.as_integer()).unwrap_or(0) as u32;
    let height = stream.dict.get(b"Height").and_then(|v| v.as_integer()).unwrap_or(0) as u32;
    if width == 0 || height == 0 {
        return Ok(stream);
    }
    let bpc = stream
        .dict
        .get(b"BitsPerComponent")
        .and_then(|v| v.as_integer())
        .unwrap_or(8) as u32;

    let filter_name = stream.filter_name().map(|n| n.to_vec());
    let is_dct = filter_name
        .as_deref()
        .map(|n| n == b"DCTDecode" || n == b"DCT")
        .unwrap_or(false);

    // CMYK JPEGs carry an Adobe APP14 transform; the decoder can silently
    // invert them. Re-encoding risks wrong colours, so leave them untouched.
    if is_dct && matches!(plan.cs, ResolvedColorSpace::Cmyk) {
        return Ok(stream);
    }

    let original_len = stream.raw_bytes.len();

    // ---- decode to pixels -------------------------------------------------
    let mut img: DynamicImage = if is_dct {
        match image::load_from_memory(&stream.raw_bytes) {
            Ok(i) => i,
            Err(_) => return Ok(stream), // CMYK/odd JPEG we can't decode — leave it
        }
    } else {
        let samples = match stream.decode() {
            Ok(s) => s,
            Err(_) => return Ok(stream),
        };
        let decode_arr = decode_array(&stream.dict);
        match decode_image_to_dynimage(&samples, width, height, bpc, &plan.cs, decode_arr.as_deref())
        {
            Some(i) => i,
            None => return Ok(stream),
        }
    };

    // ---- downsample to the planned resolution -----------------------------
    if plan.target_w < img.width() || plan.target_h < img.height() {
        // Triangle (bilinear) is much cheaper than Lanczos3 and visually fine
        // for downscaling photos to 72/150 DPI — the right speed/quality trade.
        img = img.resize_exact(
            plan.target_w.max(1),
            plan.target_h.max(1),
            image::imageops::FilterType::Triangle,
        );
    }

    // ---- re-encode as JPEG ------------------------------------------------
    let output_gray = plan.force_gray
        || plan.cs.is_gray_output()
        || matches!(img, DynamicImage::ImageLuma8(_) | DynamicImage::ImageLumaA8(_));

    let mut new_bytes = Vec::new();
    {
        let mut cursor = Cursor::new(&mut new_bytes);
        let res = if output_gray {
            let gray = img.to_luma8();
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
            gray.write_with_encoder(encoder)
        } else {
            let rgb = img.to_rgb8();
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
            rgb.write_with_encoder(encoder)
        };
        if res.is_err() {
            return Ok(stream);
        }
    }

    if new_bytes.len() >= original_len {
        return Ok(stream); // no benefit
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
    // We baked the /Decode remap into the pixels; a stale array would re-apply it.
    new_dict.remove(b"Decode");

    Ok(PdfStream {
        dict: new_dict,
        raw_bytes: new_bytes,
    })
}

/// Read an image's /Decode array into floats, if present.
fn decode_array(dict: &PdfDict) -> Option<Vec<f64>> {
    let arr = dict.get(b"Decode")?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for o in arr {
        match o {
            PdfObject::Integer(i) => out.push(*i as f64),
            PdfObject::Real(r) => out.push(*r),
            _ => return None,
        }
    }
    Some(out)
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

fn zlib_compress(data: &[u8], level: u32) -> Result<Vec<u8>, PdfError> {
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::new(level));
    enc.write_all(data)
        .map_err(|e| PdfError::WriteError(format!("zlib write: {}", e)))?;
    enc.finish()
        .map_err(|e| PdfError::WriteError(format!("zlib finish: {}", e)))
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
        let result = recompress_stream(stream, 6).unwrap();
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
        let result = recompress_stream(stream.clone(), 6).unwrap();
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

    fn rgb_plan(w: u32, h: u32) -> ImagePlan {
        ImagePlan {
            cs: crate::pdf::rewriter::colorspace::ResolvedColorSpace::Rgb,
            target_w: w,
            target_h: h,
            force_gray: false,
        }
    }

    #[test]
    fn recompress_image_quality_zero_noop() {
        let mut dict = PdfDict::new();
        dict.set(b"Subtype", PdfObject::Name(b"Image".to_vec()));
        dict.set(b"Width", PdfObject::Integer(8));
        dict.set(b"Height", PdfObject::Integer(8));
        let stream = PdfStream { dict, raw_bytes: vec![0u8; 8 * 8 * 3] };
        let r = recompress_image(stream.clone(), &rgb_plan(8, 8), 0).unwrap();
        assert_eq!(r.raw_bytes, stream.raw_bytes); // untouched at quality 0
    }

    #[test]
    fn recompress_raw_rgb_becomes_dct() {
        // 64x64 RGB gradient, stored uncompressed → JPEG should be smaller.
        let (w, h) = (64u32, 64u32);
        let mut raw = Vec::with_capacity((w * h * 3) as usize);
        for i in 0..(w * h) {
            raw.push((i % 256) as u8);
            raw.push((i.wrapping_mul(2) % 256) as u8);
            raw.push((i.wrapping_mul(3) % 256) as u8);
        }
        let mut dict = PdfDict::new();
        dict.set(b"Subtype", PdfObject::Name(b"Image".to_vec()));
        dict.set(b"Width", PdfObject::Integer(w as i64));
        dict.set(b"Height", PdfObject::Integer(h as i64));
        dict.set(b"ColorSpace", PdfObject::Name(b"DeviceRGB".to_vec()));
        dict.set(b"BitsPerComponent", PdfObject::Integer(8));
        let stream = PdfStream { dict, raw_bytes: raw };
        let r = recompress_image(stream.clone(), &rgb_plan(w, h), 50).unwrap();
        assert_eq!(r.filter_name(), Some(b"DCTDecode".as_ref()));
        assert!(r.raw_bytes.len() < stream.raw_bytes.len());
    }

    #[test]
    fn recompress_image_downsamples() {
        let (w, h) = (64u32, 64u32);
        let raw = vec![128u8; (w * h * 3) as usize];
        let mut dict = PdfDict::new();
        dict.set(b"Subtype", PdfObject::Name(b"Image".to_vec()));
        dict.set(b"Width", PdfObject::Integer(w as i64));
        dict.set(b"Height", PdfObject::Integer(h as i64));
        dict.set(b"ColorSpace", PdfObject::Name(b"DeviceRGB".to_vec()));
        dict.set(b"BitsPerComponent", PdfObject::Integer(8));
        let stream = PdfStream { dict, raw_bytes: raw };
        let r = recompress_image(stream, &rgb_plan(16, 16), 50).unwrap();
        // Solid colour JPEG of 16x16 is tiny — must have shrunk + resized.
        assert_eq!(r.dict.get(b"Width").and_then(|v| v.as_integer()), Some(16));
        assert_eq!(r.dict.get(b"Height").and_then(|v| v.as_integer()), Some(16));
    }
}
