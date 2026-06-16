//! Typed in-memory model of a WordprocessingML document. P1 covers body
//! paragraphs and runs; tables, images, headers, lists arrive in later phases.

/// OOXML measures page geometry in twips (1/1440 inch) and font sizes in
/// half-points. Layout works in points (1/72 inch).
pub fn twips_to_pt(twips: f32) -> f32 {
    twips / 20.0
}

/// Half-points (the `w:sz` unit) to points.
pub fn half_points_to_pt(half_points: f32) -> f32 {
    half_points / 2.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub page: PageMetrics,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(Paragraph),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Paragraph {
    pub props: ParaProps,
    pub runs: Vec<Run>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParaProps {
    pub align: Align,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Right,
    Center,
    Justify,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub props: RunProps,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunProps {
    pub bold: bool,
    pub italic: bool,
    /// Resolved size in points. Defaults to 11pt (Word body default) when the
    /// run carries no `w:sz`.
    pub size_pt: f32,
}

impl Default for RunProps {
    fn default() -> Self {
        Self { bold: false, italic: false, size_pt: 11.0 }
    }
}

/// Page geometry in points, converted from the section's twip values.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageMetrics {
    pub width: f32,
    pub height: f32,
    pub margin_top: f32,
    pub margin_right: f32,
    pub margin_bottom: f32,
    pub margin_left: f32,
}

impl PageMetrics {
    /// US Letter, 1-inch margins — the fallback when `sectPr` is absent.
    pub fn us_letter() -> Self {
        Self {
            width: twips_to_pt(12240.0),
            height: twips_to_pt(15840.0),
            margin_top: twips_to_pt(1440.0),
            margin_right: twips_to_pt(1440.0),
            margin_bottom: twips_to_pt(1440.0),
            margin_left: twips_to_pt(1440.0),
        }
    }

    /// Width available for text after horizontal margins.
    pub fn content_width(&self) -> f32 {
        self.width - self.margin_left - self.margin_right
    }
}

impl Default for PageMetrics {
    fn default() -> Self {
        Self::us_letter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_conversions() {
        assert_eq!(twips_to_pt(1440.0), 72.0); // 1 inch
        assert_eq!(twips_to_pt(12240.0), 612.0); // US Letter width
        assert_eq!(half_points_to_pt(22.0), 11.0); // Word default body size
    }

    #[test]
    fn us_letter_content_box() {
        let pm = PageMetrics::us_letter();
        assert_eq!(pm.content_width(), 612.0 - 144.0); // 468pt
    }

    #[test]
    fn default_run_is_11pt_regular() {
        let rp = RunProps::default();
        assert!(!rp.bold && !rp.italic);
        assert_eq!(rp.size_pt, 11.0);
    }
}
