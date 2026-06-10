/// Per-image compression plan.
///
/// Built sequentially (with reader access) BEFORE the parallel transform pass,
/// so every indirect reference (ICC profiles, Indexed palettes, /SMask) is
/// resolved here once. The parallel pass then just executes a self-contained
/// `ImagePlan` per image — no shared reader, no locking.
use std::collections::HashMap;

use crate::pdf::parser::PdfReader;
use crate::pdf::rewriter::colorspace::{resolve_colorspace, ResolvedColorSpace};
use crate::pdf::rewriter::config::CompressConfig;
use crate::pdf::rewriter::placement::PlacementMap;
use crate::pdf::types::{ObjectId, PdfObject};

#[derive(Debug, Clone)]
pub struct ImagePlan {
    /// Fully resolved colour space (for decoding Flate sample data).
    pub cs: ResolvedColorSpace,
    /// Target pixel dimensions after DPI downsampling + caps (<= original).
    pub target_w: u32,
    pub target_h: u32,
    /// Force grayscale output (not used for GS parity; honoured if set).
    pub force_gray: bool,
}

pub type PlanMap = HashMap<ObjectId, ImagePlan>;

/// Largest source image (in pixels) we'll fully decode into RAM. A W×H image
/// costs ~W·H·4 bytes decoded before it can be downsampled, so this caps peak
/// memory. Phones get a tight budget to stay clear of the OOM killer; desktops
/// get a generous one. Images over budget are left untouched.
#[cfg(target_os = "android")]
const MAX_SOURCE_PIXELS: u64 = 16_000_000; // ~64 MB RGBA, ~4000×4000
#[cfg(not(target_os = "android"))]
const MAX_SOURCE_PIXELS: u64 = 120_000_000;

/// Walk every image XObject and produce its `ImagePlan`.
pub fn build_plans(
    reader: &mut PdfReader,
    config: &CompressConfig,
    placements: &PlacementMap,
) -> PlanMap {
    let mut plans = PlanMap::new();
    if !config.compress_images() {
        return plans;
    }

    // Scan every object (not just drawn ones): images can live in annotation
    // appearance streams / patterns we don't walk, and parity means compressing
    // those too. This pass is single-core and evicts each object's bytes right
    // after reading the dict, so it's cheap on memory and isn't the CPU hog.
    let ids = reader.all_object_ids();
    for id in ids {
        // Only stream objects can be images; read the dict, then immediately
        // drop the cached object (every object, not just images) so this
        // whole-document pass never holds more than one object's bytes at once.
        let dict = match reader.get_object(id) {
            Ok(PdfObject::Stream(s)) => Some(s.dict.clone()),
            _ => None,
        };
        reader.uncache(id);
        let dict = match dict {
            Some(d) => d,
            None => continue,
        };

        if dict.get_subtype() != Some(&b"Image"[..]) {
            continue;
        }

        // Skip image masks and 1-bit bilevel images: JPEG-encoding bilevel art
        // is catastrophic (huge + ugly). GS routes these through CCITT G4, which
        // we don't yet emit — leave them as-is (Flate).
        let is_mask = matches!(dict.get(b"ImageMask"), Some(PdfObject::Boolean(true)));
        let bpc = dict
            .get(b"BitsPerComponent")
            .and_then(|v| v.as_integer())
            .unwrap_or(8) as u32;
        if is_mask || bpc == 1 {
            continue;
        }

        let width = dict.get(b"Width").and_then(|v| v.as_integer()).unwrap_or(0) as u32;
        let height = dict.get(b"Height").and_then(|v| v.as_integer()).unwrap_or(0) as u32;
        if width == 0 || height == 0 {
            continue;
        }

        // Memory guard: we decode the WHOLE source image into RAM before
        // downsampling. Past the budget, leave it untouched rather than risk an
        // OOM — tight on phones, generous on desktop.
        if (width as u64) * (height as u64) > MAX_SOURCE_PIXELS {
            continue;
        }

        // Resolve the colour space (clone first so the closure can borrow reader).
        let cs_obj = dict.get(b"ColorSpace").cloned();
        let cs = match cs_obj {
            Some(o) => {
                let mut resolve = |rid: ObjectId| reader.get_object(rid).ok().cloned();
                resolve_colorspace(&o, &mut resolve)
            }
            None => ResolvedColorSpace::Unsupported,
        };

        let filter = filter_first_name(&dict);
        let is_dct = matches!(filter.as_deref(), Some(b"DCTDecode") | Some(b"DCT"));
        // We can decode DCT directly via the JPEG decoder even if the colour
        // space didn't resolve; Flate images need a resolved space.
        if !is_dct && !cs.is_supported() {
            continue;
        }

        // Compute the target resolution. `placements` gives the drawn footprint
        // (points); effective DPI = pixels / (footprint / 72).
        let (target_w, target_h) =
            target_dims(width, height, placements.get(&id).copied(), config);

        // For DCT images that need no downsampling, re-encoding only loses
        // quality for ~no size gain — skip them (matches the net GS outcome).
        if is_dct && target_w == width && target_h == height {
            continue;
        }

        plans.insert(
            id,
            ImagePlan {
                cs,
                target_w,
                target_h,
                force_gray: config.to_grayscale,
            },
        );
    }

    plans
}

/// First /Filter name of a stream dict (handles Name or Array-of-Name).
fn filter_first_name(dict: &crate::pdf::types::PdfDict) -> Option<Vec<u8>> {
    match dict.get(b"Filter")? {
        PdfObject::Name(n) => Some(n.clone()),
        PdfObject::Array(arr) => arr.first()?.as_name().map(|n| n.to_vec()),
        _ => None,
    }
}

/// Derive target pixel dimensions from the drawn footprint + DPI config.
fn target_dims(
    width: u32,
    height: u32,
    footprint_pt: Option<(f64, f64)>,
    config: &CompressConfig,
) -> (u32, u32) {
    let mut tw = width;
    let mut th = height;

    if let (Some(dpi), Some((fw, fh))) = (config.color_dpi, footprint_pt) {
        let dpi = dpi as f64;
        let thresh = config.dpi_threshold as f64;
        // Require a sane footprint (>= 1pt). A near-zero size means we failed to
        // find the image's `cm` — downsampling off that would destroy the image,
        // so leave native resolution and let the pixel cap (if any) decide.
        if fw >= 1.0 {
            let eff = width as f64 / (fw / 72.0);
            if eff > dpi * thresh {
                tw = ((width as f64) * (dpi / eff)).round().max(1.0) as u32;
            }
        }
        if fh >= 1.0 {
            let eff = height as f64 / (fh / 72.0);
            if eff > dpi * thresh {
                th = ((height as f64) * (dpi / eff)).round().max(1.0) as u32;
            }
        }
    }

    // Hard pixel cap (applies even without placement info).
    if let Some(cap) = config.max_image_pixels {
        let longest = tw.max(th);
        if longest > cap {
            let scale = cap as f64 / longest as f64;
            tw = ((tw as f64) * scale).round().max(1.0) as u32;
            th = ((th as f64) * scale).round().max(1.0) as u32;
        }
    }

    (tw.min(width).max(1), th.min(height).max(1))
}
