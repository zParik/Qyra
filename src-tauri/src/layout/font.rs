//! Text measurement and glyph rasterization over a single vendored face.
//!
//! Wraps `fontdue`: it maps characters to glyphs, exposes per-glyph advances and
//! line metrics, and rasterizes glyphs to 8-bit coverage maps. Latin-only at P1.
//!
//! ponytail: one regular face measures and rasterizes every run; bold/italic
//! flags are carried through the model for later face selection but do not yet
//! pick a distinct face. Per-character advances also skip kerning/ligatures.
//! Both are acceptable at P1 and are named later-hardening tasks.

/// The default layout font, vendored for deterministic metrics. Must exist at
/// build time (see the build note in the docx-render plan).
const DEFAULT_FONT: &[u8] = include_bytes!("../../assets/fonts/DejaVuSans.ttf");

pub struct Font {
    inner: fontdue::Font,
}

impl Font {
    /// Load the vendored default font.
    pub fn default_font() -> Self {
        let inner = fontdue::Font::from_bytes(DEFAULT_FONT, fontdue::FontSettings::default())
            .expect("vendored font must parse");
        Self { inner }
    }

    /// Width in points of `text` at `size_pt` (sum of per-character advances).
    pub fn measure_width(&self, text: &str, size_pt: f32) -> f32 {
        text.chars().map(|c| self.inner.metrics(c, size_pt).advance_width).sum()
    }

    /// Distance from one baseline to the next at `size_pt`.
    pub fn line_height(&self, size_pt: f32) -> f32 {
        self.inner
            .horizontal_line_metrics(size_pt)
            .map(|m| m.new_line_size)
            .unwrap_or(size_pt * 1.2)
    }

    /// Distance from the line's top to its baseline at `size_pt`.
    pub fn ascent(&self, size_pt: f32) -> f32 {
        self.inner
            .horizontal_line_metrics(size_pt)
            .map(|m| m.ascent)
            .unwrap_or(size_pt * 0.8)
    }

    /// Rasterize a single character at pixel size `px`: glyph metrics plus a
    /// row-major `width * height` coverage map (0 = transparent, 255 = solid).
    pub fn rasterize(&self, ch: char, px: f32) -> (fontdue::Metrics, Vec<u8>) {
        self.inner.rasterize(ch, px)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wider_text_measures_wider() {
        let f = Font::default_font();
        let short = f.measure_width("i", 11.0);
        let long = f.measure_width("iiiiiiiiii", 11.0);
        assert!(long > short * 5.0, "10x text should be far wider");
    }

    #[test]
    fn empty_is_zero_width() {
        let f = Font::default_font();
        assert_eq!(f.measure_width("", 11.0), 0.0);
    }

    #[test]
    fn line_height_scales_with_size() {
        let f = Font::default_font();
        assert!(f.line_height(22.0) > f.line_height(11.0) * 1.9);
    }
}
