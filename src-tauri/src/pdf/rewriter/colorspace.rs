/// Colour-space resolution + raw-sample decoding.
///
/// Ghostscript can downsample/recompress images in *any* colour space because
/// it fully decodes them to device colour first. The old Rust path only knew
/// DeviceRGB/DeviceGray and skipped ICCBased, CMYK and Indexed images — which
/// are the bulk of real-world (Acrobat/scanner) PDFs, so most images survived
/// untouched. This module resolves the colour space (following indirect ICC and
/// Indexed lookup references) and unpacks the raw samples into an 8-bit
/// RGB/Gray `DynamicImage` the JPEG encoder can consume.
use image::{DynamicImage, GrayImage, RgbImage};

use crate::pdf::types::{ObjectId, PdfObject};

/// A colour space resolved down to a device family we can decode.
#[derive(Debug, Clone)]
pub enum ResolvedColorSpace {
    Gray,
    Rgb,
    Cmyk,
    Indexed {
        base: Box<ResolvedColorSpace>,
        hival: usize,
        lookup: Vec<u8>,
    },
    /// Lab / Separation / DeviceN / Pattern / unknown — leave the image alone.
    Unsupported,
}

impl ResolvedColorSpace {
    /// Number of colour components in the *sample stream* for this space.
    /// Indexed images store one index per pixel regardless of the base space.
    pub fn sample_components(&self) -> usize {
        match self {
            ResolvedColorSpace::Gray => 1,
            ResolvedColorSpace::Rgb => 3,
            ResolvedColorSpace::Cmyk => 4,
            ResolvedColorSpace::Indexed { .. } => 1,
            ResolvedColorSpace::Unsupported => 0,
        }
    }

    pub fn is_supported(&self) -> bool {
        !matches!(self, ResolvedColorSpace::Unsupported)
    }

    /// True if the decoded output is single-channel grayscale.
    pub fn is_gray_output(&self) -> bool {
        match self {
            ResolvedColorSpace::Gray => true,
            ResolvedColorSpace::Indexed { base, .. } => {
                matches!(base.as_ref(), ResolvedColorSpace::Gray)
            }
            _ => false,
        }
    }
}

/// Resolve a `/ColorSpace` value into a `ResolvedColorSpace`.
///
/// `resolve` dereferences indirect objects (used for ICC profile streams and
/// Indexed lookup streams). It is `&mut` so it can wrap `PdfReader::get_object`.
pub fn resolve_colorspace(
    cs: &PdfObject,
    resolve: &mut dyn FnMut(ObjectId) -> Option<PdfObject>,
) -> ResolvedColorSpace {
    match cs {
        PdfObject::Reference(id) => match resolve(*id) {
            Some(obj) => resolve_colorspace(&obj, resolve),
            None => ResolvedColorSpace::Unsupported,
        },
        PdfObject::Name(n) => name_to_cs(n),
        PdfObject::Array(arr) => resolve_array_cs(arr, resolve),
        _ => ResolvedColorSpace::Unsupported,
    }
}

fn name_to_cs(n: &[u8]) -> ResolvedColorSpace {
    match n {
        b"DeviceGray" | b"CalGray" | b"G" => ResolvedColorSpace::Gray,
        b"DeviceRGB" | b"CalRGB" | b"RGB" => ResolvedColorSpace::Rgb,
        b"DeviceCMYK" | b"CMYK" => ResolvedColorSpace::Cmyk,
        _ => ResolvedColorSpace::Unsupported,
    }
}

fn resolve_array_cs(
    arr: &[PdfObject],
    resolve: &mut dyn FnMut(ObjectId) -> Option<PdfObject>,
) -> ResolvedColorSpace {
    let head = match arr.first().and_then(|o| match o {
        PdfObject::Name(n) => Some(n.as_slice()),
        _ => None,
    }) {
        Some(h) => h,
        None => return ResolvedColorSpace::Unsupported,
    };

    match head {
        b"ICCBased" => {
            // [/ICCBased <stream ref>] — the stream dict carries /N (component
            // count) and an /Alternate fallback colour space.
            let stream_obj = match arr.get(1) {
                Some(PdfObject::Reference(id)) => resolve(*id),
                Some(other) => Some(other.clone()),
                None => None,
            };
            let dict = stream_obj.as_ref().and_then(|o| o.as_dict());
            if let Some(d) = dict {
                if let Some(alt) = d.get(b"Alternate") {
                    let alt = alt.clone();
                    let r = resolve_colorspace(&alt, resolve);
                    if r.is_supported() {
                        return r;
                    }
                }
                match d.get(b"N").and_then(|v| v.as_integer()) {
                    Some(1) => ResolvedColorSpace::Gray,
                    Some(3) => ResolvedColorSpace::Rgb,
                    Some(4) => ResolvedColorSpace::Cmyk,
                    _ => ResolvedColorSpace::Unsupported,
                }
            } else {
                ResolvedColorSpace::Unsupported
            }
        }
        b"CalGray" => ResolvedColorSpace::Gray,
        b"CalRGB" => ResolvedColorSpace::Rgb,
        b"Indexed" | b"I" => resolve_indexed(arr, resolve),
        // Separation/DeviceN/Lab/Pattern: decoding needs a tint transform or
        // PostScript function evaluator — leave the image untouched.
        _ => ResolvedColorSpace::Unsupported,
    }
}

fn resolve_indexed(
    arr: &[PdfObject],
    resolve: &mut dyn FnMut(ObjectId) -> Option<PdfObject>,
) -> ResolvedColorSpace {
    // [/Indexed base hival lookup]
    if arr.len() < 4 {
        return ResolvedColorSpace::Unsupported;
    }
    let base = resolve_colorspace(&arr[1], resolve);
    if !base.is_supported() || matches!(base, ResolvedColorSpace::Indexed { .. }) {
        return ResolvedColorSpace::Unsupported;
    }
    let hival = match arr[2].as_integer() {
        Some(h) if h >= 0 => h as usize,
        _ => return ResolvedColorSpace::Unsupported,
    };
    let lookup = match &arr[3] {
        PdfObject::StringLiteral(b) | PdfObject::HexString(b) => b.clone(),
        PdfObject::Reference(id) => match resolve(*id) {
            Some(PdfObject::Stream(s)) => match s.decode() {
                Ok(bytes) => bytes,
                Err(_) => return ResolvedColorSpace::Unsupported,
            },
            Some(PdfObject::StringLiteral(b)) | Some(PdfObject::HexString(b)) => b,
            _ => return ResolvedColorSpace::Unsupported,
        },
        PdfObject::Stream(s) => match s.decode() {
            Ok(bytes) => bytes,
            Err(_) => return ResolvedColorSpace::Unsupported,
        },
        _ => return ResolvedColorSpace::Unsupported,
    };
    ResolvedColorSpace::Indexed {
        base: Box::new(base),
        hival,
        lookup,
    }
}

// ---------------------------------------------------------------------------
// Sample decoding
// ---------------------------------------------------------------------------

/// MSB-first bit reader over one image row.
struct BitReader<'a> {
    data: &'a [u8],
    byte: usize,
    bit: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, byte: 0, bit: 0 }
    }
    #[inline]
    fn read(&mut self, bits: u32) -> u32 {
        // Byte-aligned fast paths — the overwhelmingly common 8/16-bit cases.
        if self.bit == 0 {
            if bits == 8 {
                let v = self.data.get(self.byte).copied().unwrap_or(0) as u32;
                self.byte += 1;
                return v;
            }
            if bits == 16 {
                let hi = self.data.get(self.byte).copied().unwrap_or(0) as u32;
                let lo = self.data.get(self.byte + 1).copied().unwrap_or(0) as u32;
                self.byte += 2;
                return (hi << 8) | lo;
            }
        }
        let mut v = 0u32;
        for _ in 0..bits {
            let b = if self.byte < self.data.len() {
                (self.data[self.byte] >> (7 - self.bit)) & 1
            } else {
                0
            };
            v = (v << 1) | b as u32;
            self.bit += 1;
            if self.bit == 8 {
                self.bit = 0;
                self.byte += 1;
            }
        }
        v
    }
}

#[inline]
fn cmyk_to_rgb(c: f32, m: f32, y: f32, k: f32) -> [u8; 3] {
    let r = 255.0 * (1.0 - c) * (1.0 - k);
    let g = 255.0 * (1.0 - m) * (1.0 - k);
    let b = 255.0 * (1.0 - y) * (1.0 - k);
    [r as u8, g as u8, b as u8]
}

/// Decode raw image samples into an 8-bit RGB or Gray `DynamicImage`.
///
/// Returns `None` for unsupported spaces, malformed dimensions, or data that is
/// too short — the caller then leaves the image stream unchanged.
pub fn decode_image_to_dynimage(
    samples: &[u8],
    width: u32,
    height: u32,
    bpc: u32,
    cs: &ResolvedColorSpace,
    decode: Option<&[f64]>,
) -> Option<DynamicImage> {
    if width == 0 || height == 0 || !cs.is_supported() {
        return None;
    }
    if !matches!(bpc, 1 | 2 | 4 | 8 | 16) {
        return None;
    }

    let sample_comps = cs.sample_components();
    let maxval = ((1u32 << bpc) - 1) as f32;
    let row_bits = width as usize * sample_comps * bpc as usize;
    let row_bytes = (row_bits + 7) / 8;
    if samples.len() < row_bytes * height as usize {
        return None;
    }

    let gray_out = cs.is_gray_output();

    if gray_out {
        let mut out = vec![0u8; (width * height) as usize];
        fill_pixels(samples, width, height, bpc, row_bytes, cs, decode, maxval, |i, rgb| {
            // Luma from the resolved colour.
            out[i] = rgb[0];
        })?;
        let g = GrayImage::from_raw(width, height, out)?;
        Some(DynamicImage::ImageLuma8(g))
    } else {
        let mut out = vec![0u8; (width * height * 3) as usize];
        fill_pixels(samples, width, height, bpc, row_bytes, cs, decode, maxval, |i, rgb| {
            out[i * 3] = rgb[0];
            out[i * 3 + 1] = rgb[1];
            out[i * 3 + 2] = rgb[2];
        })?;
        let r = RgbImage::from_raw(width, height, out)?;
        Some(DynamicImage::ImageRgb8(r))
    }
}

/// Walk every pixel, resolve it to an `[r,g,b]` (gray = r==g==b channel 0) and
/// hand the linear pixel index + colour to `sink`.
#[allow(clippy::too_many_arguments)]
fn fill_pixels(
    samples: &[u8],
    width: u32,
    height: u32,
    bpc: u32,
    row_bytes: usize,
    cs: &ResolvedColorSpace,
    decode: Option<&[f64]>,
    maxval: f32,
    mut sink: impl FnMut(usize, [u8; 3]),
) -> Option<()> {
    for y in 0..height as usize {
        let row = &samples[y * row_bytes..(y + 1) * row_bytes];
        let mut br = BitReader::new(row);
        for x in 0..width as usize {
            let idx = y * width as usize + x;
            let rgb = match cs {
                ResolvedColorSpace::Gray => {
                    let v = decode_channel(br.read(bpc), maxval, decode, 0);
                    [v, v, v]
                }
                ResolvedColorSpace::Rgb => {
                    let r = decode_channel(br.read(bpc), maxval, decode, 0);
                    let g = decode_channel(br.read(bpc), maxval, decode, 1);
                    let b = decode_channel(br.read(bpc), maxval, decode, 2);
                    [r, g, b]
                }
                ResolvedColorSpace::Cmyk => {
                    let c = br.read(bpc) as f32 / maxval;
                    let m = br.read(bpc) as f32 / maxval;
                    let yv = br.read(bpc) as f32 / maxval;
                    let k = br.read(bpc) as f32 / maxval;
                    cmyk_to_rgb(c, m, yv, k)
                }
                ResolvedColorSpace::Indexed { base, hival, lookup } => {
                    let raw = br.read(bpc) as usize;
                    let i = raw.min(*hival);
                    index_lookup(base, *hival, lookup, i)
                }
                ResolvedColorSpace::Unsupported => return None,
            };
            sink(idx, rgb);
        }
    }
    Some(())
}

/// Apply the /Decode remap (default identity) and scale to 8-bit.
#[inline]
fn decode_channel(sample: u32, maxval: f32, decode: Option<&[f64]>, comp: usize) -> u8 {
    let n = sample as f32 / maxval;
    let v = match decode {
        Some(d) if d.len() >= (comp + 1) * 2 => {
            let dmin = d[comp * 2] as f32;
            let dmax = d[comp * 2 + 1] as f32;
            dmin + n * (dmax - dmin)
        }
        _ => n,
    };
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Resolve one palette entry to RGB.
fn index_lookup(
    base: &ResolvedColorSpace,
    _hival: usize,
    lookup: &[u8],
    index: usize,
) -> [u8; 3] {
    let bc = base.sample_components().max(1);
    let off = index * bc;
    let get = |k: usize| -> u8 { lookup.get(off + k).copied().unwrap_or(0) };
    match base {
        ResolvedColorSpace::Gray => {
            let v = get(0);
            [v, v, v]
        }
        ResolvedColorSpace::Rgb => [get(0), get(1), get(2)],
        ResolvedColorSpace::Cmyk => cmyk_to_rgb(
            get(0) as f32 / 255.0,
            get(1) as f32 / 255.0,
            get(2) as f32 / 255.0,
            get(3) as f32 / 255.0,
        ),
        _ => [0, 0, 0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_spaces() {
        let mut noop = |_: ObjectId| -> Option<PdfObject> { None };
        assert!(matches!(
            resolve_colorspace(&PdfObject::Name(b"DeviceRGB".to_vec()), &mut noop),
            ResolvedColorSpace::Rgb
        ));
        assert!(matches!(
            resolve_colorspace(&PdfObject::Name(b"DeviceCMYK".to_vec()), &mut noop),
            ResolvedColorSpace::Cmyk
        ));
    }

    #[test]
    fn decode_8bit_rgb() {
        // 2x1 RGB image, red then green.
        let samples = [255u8, 0, 0, 0, 255, 0];
        let img = decode_image_to_dynimage(&samples, 2, 1, 8, &ResolvedColorSpace::Rgb, None)
            .expect("decodes");
        let rgb = img.to_rgb8();
        assert_eq!(rgb.get_pixel(0, 0).0, [255, 0, 0]);
        assert_eq!(rgb.get_pixel(1, 0).0, [0, 255, 0]);
    }

    #[test]
    fn decode_1bit_indexed() {
        // 2-colour palette: black, white. 1bpc, 8 px wide alternating not needed;
        // test 2px: index 0 then 1 packed in one byte (0b01000000 -> 0,1).
        let cs = ResolvedColorSpace::Indexed {
            base: Box::new(ResolvedColorSpace::Rgb),
            hival: 1,
            lookup: vec![0, 0, 0, 255, 255, 255],
        };
        let samples = [0b0100_0000u8];
        let img = decode_image_to_dynimage(&samples, 2, 1, 1, &cs, None).expect("decodes");
        let rgb = img.to_rgb8();
        assert_eq!(rgb.get_pixel(0, 0).0, [0, 0, 0]);
        assert_eq!(rgb.get_pixel(1, 0).0, [255, 255, 255]);
    }
}
