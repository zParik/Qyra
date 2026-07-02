//! Typed in-memory model of a WordprocessingML document. Wave 1 covers body
//! paragraphs with rich run formatting, named-style resolution, paragraph
//! spacing/indent, lists, line breaks and tabs. Tables and images follow.

/// twips (1/1440 inch) → points (1/72 inch).
pub fn twips_to_pt(twips: f32) -> f32 {
    twips / 20.0
}

/// half-points (the `w:sz` unit) → points.
pub fn half_points_to_pt(half_points: f32) -> f32 {
    half_points / 2.0
}

/// EMUs (914400 per inch, the DrawingML unit) → points.
pub fn emu_to_pt(emu: f32) -> f32 {
    emu / 12700.0
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub page: PageMetrics,
    pub blocks: Vec<Block>,
    /// Default-section header/footer block content (rendered on every page).
    pub header: Vec<Block>,
    pub footer: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(Paragraph),
    Table(Table),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub rows: Vec<Row>,
    /// Column widths in points from `w:tblGrid`; empty → distribute equally.
    pub col_widths_pt: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub cells: Vec<Cell>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub blocks: Vec<Block>,
    /// Horizontal cell span (`w:gridSpan`); 1 = no span.
    pub grid_span: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Paragraph {
    pub props: ParaProps,
    pub inlines: Vec<Inline>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParaProps {
    pub align: Align,
    pub space_before_pt: f32,
    pub space_after_pt: f32,
    /// Line spacing as a multiple of the natural line height (1.0 = single).
    pub line_spacing: f32,
    pub indent_left_pt: f32,
    /// Extra first-line indent (negative = hanging indent).
    pub indent_first_pt: f32,
    pub list: Option<ListMarker>,
    /// Resolved list-marker text (bullet or ordered number); set by the parser.
    pub list_marker: Option<String>,
    /// Tab-stop positions in points (sorted), from `w:tabs`.
    pub tab_stops: Vec<f32>,
    pub style_id: Option<String>,
}

impl Default for ParaProps {
    fn default() -> Self {
        Self {
            align: Align::Left,
            space_before_pt: 0.0,
            space_after_pt: 0.0,
            line_spacing: 1.0,
            indent_left_pt: 0.0,
            indent_first_pt: 0.0,
            list: None,
            list_marker: None,
            tab_stops: Vec::new(),
            style_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Right,
    Center,
    Justify,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListMarker {
    pub num_id: i32,
    pub level: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Inline {
    Text(TextRun),
    /// In-paragraph line break (`<w:br/>` without `w:type="page"`).
    LineBreak,
    /// Page break (`<w:br w:type="page"/>`) or an in-`pPr` section break. Kept as
    /// an inline (not a separate block) so one source `<w:p>` maps to exactly one
    /// editable block — the invariant the editor's block reconciliation relies on.
    PageBreak,
    Tab,
    Image(ImageRef),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageRef {
    pub width_pt: f32,
    pub height_pt: f32,
    /// Encoded image bytes (PNG/JPEG/…), embedded from the package media part.
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextRun {
    pub props: RunProps,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunProps {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub size_pt: f32,
    pub color: [u8; 3],
}

impl Default for RunProps {
    fn default() -> Self {
        Self {
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            size_pt: 11.0,
            color: [0, 0, 0],
        }
    }
}

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

    pub fn content_width(&self) -> f32 {
        self.width - self.margin_left - self.margin_right
    }

    pub fn content_height(&self) -> f32 {
        self.height - self.margin_top - self.margin_bottom
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
        assert_eq!(twips_to_pt(1440.0), 72.0);
        assert_eq!(half_points_to_pt(22.0), 11.0);
        assert_eq!(emu_to_pt(914400.0), 72.0);
    }

    #[test]
    fn default_run_is_11pt_black() {
        let rp = RunProps::default();
        assert_eq!(rp.size_pt, 11.0);
        assert_eq!(rp.color, [0, 0, 0]);
    }
}
