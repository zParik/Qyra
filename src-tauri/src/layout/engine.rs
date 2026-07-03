//! Flow a [`Document`] into pages. Rich runs (per-word style/size/colour),
//! paragraph spacing/indent, alignment, bullet lists, line breaks, tabs, tables
//! (rows/cells/grid spans, nested content, borders), inline images, and
//! pagination.
//!
//! ponytail simplifications (later-hardening): tabs advance to a fixed 36pt grid;
//! all list items render a bullet (numbering.xml for ordered lists is pending);
//! justify renders as left; cells don't split across pages (whole row paginates);
//! each inline image is placed on its own line, left-aligned.

use crate::oxml::model::{Align, Block, Document, Inline, PageMetrics, ParaProps, Paragraph, RunProps, Row, Table};

use super::font::FontSet;

const TAB_PT: f32 = 36.0;
const LIST_INDENT_PT: f32 = 18.0;
const LIST_GAP_PT: f32 = 6.0;
const CELL_PAD_PT: f32 = 4.0;

#[derive(Debug, Clone, PartialEq)]
pub struct LayoutResult {
    pub pages: Vec<LaidPage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaidPage {
    pub width: f32,
    pub height: f32,
    pub lines: Vec<Line>,
    pub rects: Vec<LaidRect>,
    pub images: Vec<LaidImage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub baseline_y: f32,
    pub runs: Vec<LineRun>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LineRun {
    pub x: f32,
    pub width: f32,
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub size_pt: f32,
    pub color: [u8; 3],
}

/// A stroked rectangle (table cell border).
#[derive(Debug, Clone, PartialEq)]
pub struct LaidRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub color: [u8; 3],
}

/// A placed image with absolute top-left position and encoded bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct LaidImage {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub data: Vec<u8>,
}

struct PlacedImage {
    x: f32,
    w: f32,
    h: f32,
    data: Vec<u8>,
}

/// One laid line not yet assigned an absolute y.
struct LineBox {
    runs: Vec<LineRun>,
    ascent: f32,
    height: f32,
    images: Vec<PlacedImage>,
}

struct Slot {
    text: String,
    props: RunProps,
    width: f32,
    space_before: bool,
    is_tab: bool,
}

enum Item {
    Word { text: String, props: RunProps, width: f32, space_before: bool },
    Tab,
    Break,
    Image { width: f32, height: f32, data: Vec<u8> },
}

pub fn layout_document(doc: &Document, font: &FontSet) -> LayoutResult {
    let mut lay = Layouter {
        font,
        page_w: doc.page.width,
        page_h: doc.page.height,
        margin_left: doc.page.margin_left,
        content_w: doc.page.content_width(),
        content_bottom: doc.page.height - doc.page.margin_bottom,
        margin_top: doc.page.margin_top,
        pages: Vec::new(),
        lines: Vec::new(),
        rects: Vec::new(),
        images: Vec::new(),
        pen_y: doc.page.margin_top,
    };

    for block in &doc.blocks {
        match block {
            Block::Paragraph(p) => lay.flow_paragraph(p),
            Block::Table(t) => lay.flow_table(t),
        }
    }
    lay.flush_page();
    if lay.pages.is_empty() {
        lay.pages.push(LaidPage { width: lay.page_w, height: lay.page_h, lines: vec![], rects: vec![], images: vec![] });
    }
    stamp_strip(&mut lay.pages, &doc.header, font, &doc.page, true);
    stamp_strip(&mut lay.pages, &doc.footer, font, &doc.page, false);
    LayoutResult { pages: lay.pages }
}

/// Lay header/footer blocks once and stamp them onto every page, positioned in
/// the top/bottom margin.
fn stamp_strip(pages: &mut [LaidPage], blocks: &[Block], font: &FontSet, page: &PageMetrics, header: bool) {
    if blocks.is_empty() || pages.is_empty() {
        return;
    }
    let (mut lines, mut rects, mut images, h) = layout_column(blocks, font, page.margin_left, page.content_width());
    let top = if header {
        (page.margin_top - h).max(0.0) * 0.5
    } else {
        page.height - page.margin_bottom + (page.margin_bottom - h).max(0.0) * 0.5
    };
    for ln in &mut lines {
        ln.baseline_y += top;
    }
    for r in &mut rects {
        r.y += top;
    }
    for im in &mut images {
        im.y += top;
    }
    for pg in pages.iter_mut() {
        pg.lines.extend(lines.iter().cloned());
        pg.rects.extend(rects.iter().cloned());
        pg.images.extend(images.iter().cloned());
    }
}

struct Layouter<'a> {
    font: &'a FontSet,
    page_w: f32,
    page_h: f32,
    margin_left: f32,
    content_w: f32,
    content_bottom: f32,
    margin_top: f32,
    pages: Vec<LaidPage>,
    lines: Vec<Line>,
    rects: Vec<LaidRect>,
    images: Vec<LaidImage>,
    pen_y: f32,
}

impl<'a> Layouter<'a> {
    fn flush_page(&mut self) {
        if !self.lines.is_empty() || !self.rects.is_empty() || !self.images.is_empty() {
            self.pages.push(LaidPage {
                width: self.page_w,
                height: self.page_h,
                lines: std::mem::take(&mut self.lines),
                rects: std::mem::take(&mut self.rects),
                images: std::mem::take(&mut self.images),
            });
        }
    }

    fn page_break(&mut self) {
        self.flush_page();
        self.pen_y = self.margin_top;
    }

    fn flow_paragraph(&mut self, p: &Paragraph) {
        self.pen_y += p.props.space_before_pt;
        // A paragraph may carry inline page breaks; split it into segments and
        // advance a page between them.
        let mut segment: Vec<Inline> = Vec::new();
        let mut first = true;
        for inline in &p.inlines {
            if matches!(inline, Inline::PageBreak) {
                self.flow_segment(&segment, &p.props);
                segment.clear();
                self.page_break();
                first = false;
            } else {
                segment.push(inline.clone());
            }
        }
        // Skip a trailing empty segment left by a break at the paragraph's end
        // (e.g. a section break), but always lay out a genuinely empty paragraph.
        if first || !segment.is_empty() {
            self.flow_segment(&segment, &p.props);
        }
        self.pen_y += p.props.space_after_pt;
    }

    fn flow_segment(&mut self, inlines: &[Inline], pp: &ParaProps) {
        for lb in paragraph_lineboxes(inlines, pp, self.font, self.margin_left, self.content_w) {
            let LineBox { runs, ascent, height, images } = lb;
            if self.pen_y + ascent > self.content_bottom && !self.lines.is_empty() {
                self.flush_page();
                self.pen_y = self.margin_top;
            }
            let baseline = self.pen_y + ascent;
            for img in images {
                self.images.push(LaidImage { x: img.x, y: baseline - img.h, w: img.w, h: img.h, data: img.data });
            }
            self.lines.push(Line { baseline_y: baseline, runs });
            self.pen_y += height;
        }
    }

    fn flow_table(&mut self, t: &Table) {
        let cols = resolve_cols(t, self.content_w);
        for row in &t.rows {
            let (row_lines, row_rects, row_images, h) = layout_row(row, self.font, self.margin_left, &cols);
            if self.pen_y + h > self.content_bottom && !self.lines.is_empty() {
                self.flush_page();
                self.pen_y = self.margin_top;
            }
            for mut ln in row_lines {
                ln.baseline_y += self.pen_y;
                self.lines.push(ln);
            }
            for mut r in row_rects {
                r.y += self.pen_y;
                self.rects.push(r);
            }
            for mut im in row_images {
                im.y += self.pen_y;
                self.images.push(im);
            }
            self.pen_y += h;
        }
    }
}

fn resolve_cols(t: &Table, width: f32) -> Vec<f32> {
    if !t.col_widths_pt.is_empty() && t.col_widths_pt.iter().sum::<f32>() > 1.0 {
        return t.col_widths_pt.clone();
    }
    let n = t
        .rows
        .iter()
        .map(|r| r.cells.iter().map(|c| c.grid_span.max(1) as usize).sum::<usize>())
        .max()
        .unwrap_or(1)
        .max(1);
    vec![width / n as f32; n]
}

/// Lay one table row, returning lines/rects/images relative to the row top
/// (y = 0) and the row height.
fn layout_row(row: &Row, font: &FontSet, left: f32, cols: &[f32]) -> (Vec<Line>, Vec<LaidRect>, Vec<LaidImage>, f32) {
    let mut placed: Vec<(f32, f32, Vec<Line>, Vec<LaidRect>, Vec<LaidImage>)> = Vec::new();
    let mut col_idx = 0usize;
    let mut row_h = 0.0f32;

    for cell in &row.cells {
        let span = cell.grid_span.max(1) as usize;
        let end = (col_idx + span).min(cols.len());
        let cw: f32 = if col_idx < cols.len() { cols[col_idx..end].iter().sum() } else { 0.0 };
        let cx = left + cols[..col_idx.min(cols.len())].iter().sum::<f32>();
        let inner_w = (cw - 2.0 * CELL_PAD_PT).max(1.0);
        let (clines, crects, cimages, ch) = layout_column(&cell.blocks, font, cx + CELL_PAD_PT, inner_w);
        row_h = row_h.max(ch + 2.0 * CELL_PAD_PT);
        placed.push((cx, cw, clines, crects, cimages));
        col_idx += span;
    }

    let mut lines = Vec::new();
    let mut rects = Vec::new();
    let mut images = Vec::new();
    for (cx, cw, clines, crects, cimages) in placed {
        for mut ln in clines {
            ln.baseline_y += CELL_PAD_PT;
            lines.push(ln);
        }
        for mut r in crects {
            r.y += CELL_PAD_PT;
            rects.push(r);
        }
        for mut im in cimages {
            im.y += CELL_PAD_PT;
            images.push(im);
        }
        rects.push(LaidRect { x: cx, y: 0.0, w: cw, h: row_h, color: [150, 150, 150] });
    }
    (lines, rects, images, row_h)
}

/// Lay a list of blocks into a column (no pagination): lines/rects/images with
/// y from 0 and total height. Used for table cells (recurses on nested tables).
fn layout_column(blocks: &[Block], font: &FontSet, left: f32, width: f32) -> (Vec<Line>, Vec<LaidRect>, Vec<LaidImage>, f32) {
    let mut lines = Vec::new();
    let mut rects = Vec::new();
    let mut images = Vec::new();
    let mut y = 0.0f32;
    for block in blocks {
        match block {
            Block::Paragraph(p) => {
                y += p.props.space_before_pt;
                // Cells don't paginate, so page breaks inside a cell are ignored
                // (tokenize skips them); lay the paragraph as one segment.
                for lb in paragraph_lineboxes(&p.inlines, &p.props, font, left, width) {
                    let LineBox { runs, ascent, height, images: imgs } = lb;
                    let baseline = y + ascent;
                    for img in imgs {
                        images.push(LaidImage { x: img.x, y: baseline - img.h, w: img.w, h: img.h, data: img.data });
                    }
                    lines.push(Line { baseline_y: baseline, runs });
                    y += height;
                }
                y += p.props.space_after_pt;
            }
            Block::Table(t) => {
                let cols = resolve_cols(t, width);
                for row in &t.rows {
                    let (rl, rr, ri, h) = layout_row(row, font, left, &cols);
                    for mut ln in rl {
                        ln.baseline_y += y;
                        lines.push(ln);
                    }
                    for mut r in rr {
                        r.y += y;
                        rects.push(r);
                    }
                    for mut im in ri {
                        im.y += y;
                        images.push(im);
                    }
                    y += h;
                }
            }
        }
    }
    (lines, rects, images, y)
}

fn paragraph_lineboxes(inlines: &[Inline], pp: &ParaProps, font: &FontSet, col_left: f32, col_width: f32) -> Vec<LineBox> {
    let is_list = pp.list.is_some();
    let items = tokenize(inlines, font);
    let mut boxes: Vec<LineBox> = Vec::new();

    if items.is_empty() {
        let asc = font.ascent(11.0, false, false);
        let lh = font.line_height(11.0, false, false) * pp.line_spacing.max(0.1);
        boxes.push(LineBox { runs: vec![], ascent: asc, height: lh, images: vec![] });
        return boxes;
    }

    let mut line: Vec<Slot> = Vec::new();
    let mut line_w = 0.0f32;
    let mut first_line = true;

    for item in items {
        match item {
            Item::Word { text, props, width, space_before } => {
                let space = if space_before && !line.is_empty() { space_w(font, &props) } else { 0.0 };
                let avail = avail_for(pp, first_line, is_list, col_width);
                if !line.is_empty() && line_w + space + width > avail {
                    boxes.push(commit_linebox(&mut line, pp, font, col_left, col_width, first_line, is_list, false));
                    first_line = false;
                    line_w = width;
                    line.push(Slot { text, props, width, space_before: false, is_tab: false });
                } else {
                    line_w += space + width;
                    line.push(Slot { text, props, width, space_before, is_tab: false });
                }
            }
            Item::Tab => {
                line_w = next_tab(line_w, &pp.tab_stops);
                line.push(Slot { text: String::new(), props: RunProps::default(), width: 0.0, space_before: false, is_tab: true });
            }
            Item::Break => {
                boxes.push(commit_linebox(&mut line, pp, font, col_left, col_width, first_line, is_list, false));
                first_line = false;
                line_w = 0.0;
            }
            Item::Image { width, height, data } => {
                if !line.is_empty() {
                    boxes.push(commit_linebox(&mut line, pp, font, col_left, col_width, first_line, is_list, false));
                    first_line = false;
                    line_w = 0.0;
                }
                let (mut iw, mut ih) = (width, height);
                if iw > col_width && iw > 0.0 {
                    let s = col_width / iw;
                    iw *= s;
                    ih *= s;
                }
                let x = col_left + pp.indent_left_pt;
                boxes.push(LineBox {
                    runs: vec![],
                    ascent: ih,
                    height: ih,
                    images: vec![PlacedImage { x, w: iw, h: ih, data }],
                });
            }
        }
    }
    if !line.is_empty() {
        boxes.push(commit_linebox(&mut line, pp, font, col_left, col_width, first_line, is_list, true));
    }

    // Prepend the list marker (bullet or resolved number) to the first line.
    if is_list {
        if let Some(first) = boxes.first_mut() {
            let marker = pp.list_marker.clone().unwrap_or_else(|| "\u{2022}".to_string());
            let marker_size = first.runs.first().map(|r| r.size_pt).unwrap_or(11.0);
            let marker_w = font.measure_width(&marker, marker_size, false, false);
            let anchor_x = first
                .runs
                .first()
                .map(|r| r.x)
                .unwrap_or(col_left + pp.indent_left_pt + LIST_INDENT_PT);
            let marker_x = (anchor_x - LIST_GAP_PT - marker_w).max(col_left);
            first.runs.insert(
                0,
                LineRun {
                    x: marker_x,
                    width: marker_w,
                    text: marker,
                    bold: false,
                    italic: false,
                    underline: false,
                    strike: false,
                    size_pt: marker_size,
                    color: [0, 0, 0],
                },
            );
        }
    }
    boxes
}

fn avail_for(pp: &ParaProps, first_line: bool, is_list: bool, col_width: f32) -> f32 {
    let mut a = col_width - pp.indent_left_pt - if is_list { LIST_INDENT_PT } else { 0.0 };
    if first_line {
        a -= pp.indent_first_pt;
    }
    a.max(1.0)
}

fn space_w(font: &FontSet, p: &RunProps) -> f32 {
    font.measure_width(" ", p.size_pt, p.bold, p.italic)
}

#[allow(clippy::too_many_arguments)]
fn commit_linebox(
    line: &mut Vec<Slot>,
    pp: &ParaProps,
    font: &FontSet,
    col_left: f32,
    col_width: f32,
    first_line: bool,
    is_list: bool,
    is_last: bool,
) -> LineBox {
    let mut runs: Vec<LineRun> = Vec::new();
    let mut pen = 0.0f32;
    let mut max_ascent = 0.0f32;
    let mut max_lh = 0.0f32;

    for slot in line.iter() {
        if slot.is_tab {
            pen = next_tab(pen, &pp.tab_stops);
            continue;
        }
        if slot.space_before && !runs.is_empty() {
            pen += space_w(font, &slot.props);
        }
        max_ascent = max_ascent.max(font.ascent(slot.props.size_pt, slot.props.bold, slot.props.italic));
        max_lh = max_lh.max(font.line_height(slot.props.size_pt, slot.props.bold, slot.props.italic));
        runs.push(LineRun {
            x: pen,
            width: slot.width,
            text: slot.text.clone(),
            bold: slot.props.bold,
            italic: slot.props.italic,
            underline: slot.props.underline,
            strike: slot.props.strike,
            size_pt: slot.props.size_pt,
            color: slot.props.color,
        });
        pen += slot.width;
    }
    line.clear();

    if max_ascent == 0.0 {
        max_ascent = font.ascent(11.0, false, false);
        max_lh = font.line_height(11.0, false, false);
    }
    let total = pen;

    let text_left = col_left + pp.indent_left_pt + if is_list { LIST_INDENT_PT } else { 0.0 };
    let start_x = match pp.align {
        Align::Left | Align::Justify => text_left + if first_line { pp.indent_first_pt } else { 0.0 },
        Align::Right => col_left + col_width - total,
        Align::Center => col_left + (col_width - total) / 2.0,
    };
    for r in runs.iter_mut() {
        r.x += start_x;
    }

    // Justify non-final lines by spreading slack across word gaps.
    if matches!(pp.align, Align::Justify) && !is_last && runs.len() > 1 {
        let slack = (col_left + col_width) - (start_x + total);
        if slack > 0.0 {
            let n = runs.len();
            for (i, r) in runs.iter_mut().enumerate() {
                r.x += slack * (i as f32) / ((n - 1) as f32);
            }
        }
    }

    let _ = is_list; // indent already applied via text_left; marker added by caller
    LineBox { runs, ascent: max_ascent, height: max_lh * pp.line_spacing.max(0.1), images: vec![] }
}

/// Next tab position after `pen`: the first document tab stop beyond it, else
/// the next 36pt default-grid stop.
fn next_tab(pen: f32, stops: &[f32]) -> f32 {
    for &s in stops {
        if s > pen + 0.01 {
            return s;
        }
    }
    ((pen / TAB_PT).floor() + 1.0) * TAB_PT
}

fn tokenize(inlines: &[Inline], font: &FontSet) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    let mut pending_space = false;

    for inline in inlines {
        match inline {
            Inline::Text(run) => {
                let mut word = String::new();
                let mut word_space = pending_space;
                for ch in run.text.chars() {
                    if ch.is_whitespace() {
                        if !word.is_empty() {
                            push_word(&mut out, &word, &run.props, word_space, font);
                            word.clear();
                        }
                        pending_space = true;
                    } else {
                        if word.is_empty() {
                            word_space = pending_space;
                            pending_space = false;
                        }
                        word.push(ch);
                    }
                }
                if !word.is_empty() {
                    push_word(&mut out, &word, &run.props, word_space, font);
                }
            }
            Inline::Tab => {
                out.push(Item::Tab);
                pending_space = false;
            }
            Inline::LineBreak => {
                out.push(Item::Break);
                pending_space = false;
            }
            // Page breaks are handled a level up (flow_paragraph splits on them);
            // within a single segment / a table cell they carry no line box.
            Inline::PageBreak => {}
            Inline::Image(img) => {
                out.push(Item::Image { width: img.width_pt, height: img.height_pt, data: img.data.clone() });
                pending_space = false;
            }
        }
    }
    out
}

fn push_word(out: &mut Vec<Item>, word: &str, props: &RunProps, space_before: bool, font: &FontSet) {
    let width = font.measure_width(word, props.size_pt, props.bold, props.italic);
    out.push(Item::Word { text: word.to_string(), props: props.clone(), width, space_before });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oxml::model::{Cell, ImageRef, ListMarker, PageMetrics, ParaProps, Row, TextRun};

    fn text_para(s: &str, align: Align) -> Block {
        Block::Paragraph(Paragraph {
            props: ParaProps { align, ..Default::default() },
            inlines: vec![Inline::Text(TextRun { props: RunProps::default(), text: s.into(), link: None })],
        })
    }

    fn doc(blocks: Vec<Block>) -> Document {
        Document { page: PageMetrics::us_letter(), blocks, header: vec![], footer: vec![] }
    }

    #[test]
    fn short_paragraph_one_line() {
        let res = layout_document(&doc(vec![text_para("Hello world", Align::Left)]), &FontSet::default_set());
        assert_eq!(res.pages.len(), 1);
        assert_eq!(res.pages[0].lines.len(), 1);
    }

    #[test]
    fn long_document_paginates() {
        let blocks: Vec<Block> = (0..300)
            .map(|i| text_para(&format!("Paragraph {i} with enough words to fill a full line across the page width nicely"), Align::Left))
            .collect();
        let res = layout_document(&doc(blocks), &FontSet::default_set());
        println!("LONG_DOC_PAGES: {}", res.pages.len());
        let bottom = PageMetrics::us_letter().height - PageMetrics::us_letter().margin_bottom;
        for page in &res.pages {
            for line in &page.lines {
                assert!(line.baseline_y <= bottom + 1.0, "line past content bottom: {}", line.baseline_y);
            }
        }
        assert!(res.pages.len() > 1, "300 paragraphs must span multiple pages");
    }

    #[test]
    fn explicit_page_break_forces_new_page() {
        // A paragraph carrying an inline page break splits across two pages.
        let para = Block::Paragraph(Paragraph {
            props: ParaProps::default(),
            inlines: vec![
                Inline::Text(TextRun { props: RunProps::default(), text: "Top".into(), link: None }),
                Inline::PageBreak,
                Inline::Text(TextRun { props: RunProps::default(), text: "Next".into(), link: None }),
            ],
        });
        let res = layout_document(&doc(vec![para]), &FontSet::default_set());
        assert_eq!(res.pages.len(), 2);
    }

    #[test]
    fn list_paragraph_gets_bullet() {
        let para = Block::Paragraph(Paragraph {
            props: ParaProps { list: Some(ListMarker { num_id: 1, level: 0 }), ..Default::default() },
            inlines: vec![Inline::Text(TextRun { props: RunProps::default(), text: "Item".into(), link: None })],
        });
        let res = layout_document(&doc(vec![para]), &FontSet::default_set());
        assert_eq!(res.pages[0].lines[0].runs[0].text, "\u{2022}");
    }

    #[test]
    fn table_emits_lines_and_border_rects() {
        let cell = |s: &str| Cell { blocks: vec![text_para(s, Align::Left)], grid_span: 1, shading: None };
        let table = Block::Table(Table {
            col_widths_pt: vec![100.0, 100.0],
            rows: vec![Row { cells: vec![cell("A"), cell("B")] }],
        });
        let res = layout_document(&doc(vec![table]), &FontSet::default_set());
        assert!(!res.pages[0].rects.is_empty());
        assert!(res.pages[0].lines.len() >= 2);
    }

    #[test]
    fn image_inline_is_placed() {
        let para = Block::Paragraph(Paragraph {
            props: ParaProps::default(),
            inlines: vec![Inline::Image(ImageRef { width_pt: 72.0, height_pt: 48.0, data: vec![1, 2, 3] })],
        });
        let res = layout_document(&doc(vec![para]), &FontSet::default_set());
        assert_eq!(res.pages[0].images.len(), 1);
        assert_eq!(res.pages[0].images[0].w, 72.0);
    }
}
