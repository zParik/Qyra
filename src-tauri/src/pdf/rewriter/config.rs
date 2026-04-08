/// Compression configuration derived from a level integer.
#[derive(Debug, Clone)]
pub struct CompressConfig {
    /// JPEG quality (0 = don't JPEG-encode images).
    pub jpeg_quality: u8,
    /// Convert colour images to grayscale.
    pub to_grayscale: bool,
    /// Downsample images to this maximum dimension (None = no downsampling).
    pub max_image_dimension: Option<u32>,
    /// Strip XMP metadata, /Info dict, and /Thumb thumbnails.
    pub strip_metadata: bool,
    /// Recompress all FlateDecode streams at zlib best.
    pub recompress_streams: bool,
}

impl CompressConfig {
    /// Build a config from a compression level (0 = lossless, 1 = lossy/high, 2 = aggressive).
    pub fn from_level(level: u8) -> Self {
        match level {
            0 => Self {
                jpeg_quality: 0,
                to_grayscale: false,
                max_image_dimension: None,
                strip_metadata: false,
                recompress_streams: true,
            },
            1 => Self {
                jpeg_quality: 72,
                to_grayscale: false,
                max_image_dimension: Some(2048),
                strip_metadata: true,
                recompress_streams: true,
            },
            _ => Self {
                jpeg_quality: 50,
                to_grayscale: true,
                max_image_dimension: Some(1440),
                strip_metadata: true,
                recompress_streams: true,
            },
        }
    }

    pub fn compress_images(&self) -> bool {
        self.jpeg_quality > 0
    }
}
