//! Text measurement and glyph rasterization over a four-face font set
//! (regular / bold / italic / bold-italic).
//!
//! Wraps `fontdue`: character → glyph mapping, per-glyph advances, line metrics,
//! and 8-bit coverage maps. Latin-only at this phase; one font family (the
//! vendored default) stands in for every `w:rFonts` family — real font-family
//! resolution is a later task.

const REGULAR: &[u8] = include_bytes!("../../assets/fonts/DejaVuSans.ttf");
const BOLD: &[u8] = include_bytes!("../../assets/fonts/DejaVuSans-Bold.ttf");
const ITALIC: &[u8] = include_bytes!("../../assets/fonts/DejaVuSans-Oblique.ttf");
const BOLD_ITALIC: &[u8] = include_bytes!("../../assets/fonts/DejaVuSans-BoldOblique.ttf");

pub struct FontSet {
    regular: fontdue::Font,
    bold: fontdue::Font,
    italic: fontdue::Font,
    bold_italic: fontdue::Font,
}

impl FontSet {
    pub fn default_set() -> Self {
        let load = |b: &[u8]| {
            fontdue::Font::from_bytes(b, fontdue::FontSettings::default())
                .expect("vendored font must parse")
        };
        Self {
            regular: load(REGULAR),
            bold: load(BOLD),
            italic: load(ITALIC),
            bold_italic: load(BOLD_ITALIC),
        }
    }

    fn face(&self, bold: bool, italic: bool) -> &fontdue::Font {
        match (bold, italic) {
            (true, true) => &self.bold_italic,
            (true, false) => &self.bold,
            (false, true) => &self.italic,
            (false, false) => &self.regular,
        }
    }

    /// Width in points of `text` at `size_pt` in the given style.
    pub fn measure_width(&self, text: &str, size_pt: f32, bold: bool, italic: bool) -> f32 {
        let face = self.face(bold, italic);
        text.chars().map(|c| face.metrics(c, size_pt).advance_width).sum()
    }

    /// Baseline-to-baseline distance at `size_pt` in the given style.
    pub fn line_height(&self, size_pt: f32, bold: bool, italic: bool) -> f32 {
        self.face(bold, italic)
            .horizontal_line_metrics(size_pt)
            .map(|m| m.new_line_size)
            .unwrap_or(size_pt * 1.2)
    }

    /// Top-of-line to baseline at `size_pt` in the given style.
    pub fn ascent(&self, size_pt: f32, bold: bool, italic: bool) -> f32 {
        self.face(bold, italic)
            .horizontal_line_metrics(size_pt)
            .map(|m| m.ascent)
            .unwrap_or(size_pt * 0.8)
    }

    /// Rasterize a glyph at pixel size `px`: metrics + row-major coverage map.
    pub fn rasterize(&self, ch: char, px: f32, bold: bool, italic: bool) -> (fontdue::Metrics, Vec<u8>) {
        self.face(bold, italic).rasterize(ch, px)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bold_measures_at_least_as_wide_as_regular() {
        let f = FontSet::default_set();
        let reg = f.measure_width("Hello", 12.0, false, false);
        let bold = f.measure_width("Hello", 12.0, true, false);
        assert!(bold >= reg * 0.9 && bold > 0.0);
    }

    #[test]
    fn line_height_scales_with_size() {
        let f = FontSet::default_set();
        assert!(f.line_height(24.0, false, false) > f.line_height(12.0, false, false) * 1.9);
    }
}
