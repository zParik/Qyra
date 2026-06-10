/// Compression configuration derived from a level integer.
///
/// Levels 1 and 2 mirror Ghostscript `-dPDFSETTINGS` presets so the pure-Rust
/// engine reaches the same output size GS does:
///   - Level 1 == GS `/ebook`  (150 DPI colour/gray, 300 DPI mono)
///   - Level 2 == GS `/screen` ( 72 DPI colour/gray, 300 DPI mono)
/// Level 0 stays lossless (streams only, images untouched).
#[derive(Debug, Clone)]
pub struct CompressConfig {
    /// JPEG quality (0 = don't JPEG-encode images).
    pub jpeg_quality: u8,
    /// Target resolution (DPI) for colour/gray images. None = never downsample.
    pub color_dpi: Option<u32>,
    /// Target resolution (DPI) for 1-bit / image-mask images. None = leave.
    pub mono_dpi: Option<u32>,
    /// Only downsample when the effective DPI exceeds `target * threshold`.
    /// GS uses 1.5 for every preset — match it so we don't resample images that
    /// are already close to the target (which only loses quality for no gain).
    pub dpi_threshold: f32,
    /// Force colour images to grayscale (NOT a GS preset; off for parity).
    pub to_grayscale: bool,
    /// Hard pixel cap on the longest image edge, applied even when the content
    /// stream gives no placement (so a giant unreferenced image can't survive).
    pub max_image_pixels: Option<u32>,
    /// Strip XMP metadata, /Info dict, and /Thumb thumbnails.
    pub strip_metadata: bool,
    /// Recompress all FlateDecode streams at zlib best.
    pub recompress_streams: bool,
    /// zlib compression level for stream re-encoding (6 = fast/near-best,
    /// 9 = max but markedly slower on object-heavy PDFs).
    pub zlib_level: u32,
}

impl CompressConfig {
    /// Build a config from a compression level (0 = lossless, 1 = ebook, 2 = screen).
    pub fn from_level(level: u8) -> Self {
        match level {
            0 => Self {
                jpeg_quality: 0,
                color_dpi: None,
                mono_dpi: None,
                dpi_threshold: 1.5,
                to_grayscale: false,
                max_image_pixels: None,
                strip_metadata: false,
                recompress_streams: true,
                zlib_level: 6,
            },
            // GS /ebook parity.
            1 => Self {
                jpeg_quality: 78,
                color_dpi: Some(150),
                mono_dpi: Some(300),
                dpi_threshold: 1.5,
                to_grayscale: false,
                max_image_pixels: Some(3000),
                strip_metadata: true,
                recompress_streams: true,
                // 6 not 9: images now drive the size reduction, so max-zlib on
                // text/content streams just burns CPU for a negligible gain.
                zlib_level: 6,
            },
            // GS /screen parity.
            _ => Self {
                jpeg_quality: 65,
                color_dpi: Some(72),
                mono_dpi: Some(300),
                dpi_threshold: 1.5,
                to_grayscale: false,
                max_image_pixels: Some(2000),
                strip_metadata: true,
                recompress_streams: true,
                zlib_level: 6,
            },
        }
    }

    pub fn compress_images(&self) -> bool {
        self.jpeg_quality > 0
    }
}
