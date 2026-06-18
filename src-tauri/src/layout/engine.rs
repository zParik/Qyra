//! Flow a [`Document`] into pages. Wave 1: rich runs (per-word style + size),
//! paragraph spacing/indent, alignment, bullet lists, in-paragraph line breaks,
//! tabs, and pagination (auto + explicit page breaks).
//!
//! ponytail simplifications (later-hardening): tabs advance to a fixed 36pt grid
//! rather than document tab stops; all list items render a bullet (numbering.xml
//! parsing for ordered lists is a later wave); justify renders as left.

use crate::oxml::model::{Align, Block, Document, Inline, PageMetrics, Paragraph, RunProps};

use super::font::FontSet;

const TAB_PT: f32 = 36.0;
const LIST_INDENT_PT: f32 = 18.0; // text indent for bullet lists
const LIST_GAP_PT: f32 = 6.0; // gap between bullet and text

#[derive(Debug, Clone, PartialEq)]
pub struct LayoutResult {
    pub pages: Vec<LaidPage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaidPage {
    pub width: f32,
    pub height: f32,
    pub lines: Vec<Line>,
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

/// A laid-out word with its measured width plus whether a space precedes it.
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
}

/// Lay a document out into positioned pages.
pub fn layout_document(doc: &Document, font: &FontSet) -> LayoutResult {
    let mut lay = Layouter {
        font,
        page: doc.page,
        pages: Vec::new(),
        lines: Vec::new(),
        pen_y: doc.page.margin_top,
    };

    for block in &doc.blocks {
        match block {
            Block::Paragraph(p) => lay.paragraph(p),
            Block::PageBreak => lay.explicit_page_break(),
        }
    }

    lay.flush_page();
    if lay.pages.is_empty() {
        lay.pages.push(LaidPage { width: lay.page.width, height: lay.page.height, lines: vec![] });
    }
    LayoutResult { pages: lay.pages }
}

struct Layouter<'a> {
    font: &'a FontSet,
    page: PageMetrics,
    pages: Vec<LaidPage>,
    lines: Vec<Line>,
    pen_y: f32,
}

impl<'a> Layouter<'a> {
    fn content_bottom(&self) -> f32 {
        self.page.height - self.page.margin_bottom
    }

    fn flush_page(&mut self) {
        if !self.lines.is_empty() {
            self.pages.push(LaidPage {
                width: self.page.width,
                height: self.page.height,
                lines: std::mem::take(&mut self.lines),
            });
        }
    }

    fn explicit_page_break(&mut self) {
        self.flush_page();
        self.pen_y = self.page.margin_top;
    }

    fn space_w(&self, p: &RunProps) -> f32 {
        self.font.measure_width(" ", p.size_pt, p.bold, p.italic)
    }

    fn paragraph(&mut self, p: &Paragraph) {
        self.pen_y += p.props.space_before_pt;

        let is_list = p.props.list.is_some();
        let base_left = self.page.margin_left
            + p.props.indent_left_pt
            + if is_list { LIST_INDENT_PT } else { 0.0 };
        let content_w = self.page.content_width();

        let items = tokenize(&p.inlines, self.font);

        // Empty paragraph → one blank line.
        if items.is_empty() {
            let lh = self.font.line_height(11.0, false, false) * p.props.line_spacing.max(0.1);
            let asc = self.font.ascent(11.0, false, false);
            self.commit(Vec::new(), asc, lh);
            self.pen_y += p.props.space_after_pt;
            return;
        }

        let mut line: Vec<Slot> = Vec::new();
        let mut line_w = 0.0f32;
        let mut first_line = true;

        for item in items {
            match item {
                Item::Word { text, props, width, space_before } => {
                    let space = if space_before && !line.is_empty() { self.space_w(&props) } else { 0.0 };
                    let avail = self.avail(&p.props, first_line, is_list, content_w);
                    if !line.is_empty() && line_w + space + width > avail {
                        self.commit_line(&mut line, &p.props, base_left, first_line, is_list, content_w);
                        first_line = false;
                        line_w = width;
                        line.push(Slot { text, props, width, space_before: false, is_tab: false });
                    } else {
                        line_w += space + width;
                        line.push(Slot { text, props, width, space_before, is_tab: false });
                    }
                }
                Item::Tab => {
                    line_w = next_tab(line_w);
                    line.push(Slot { text: String::new(), props: RunProps::default(), width: 0.0, space_before: false, is_tab: true });
                }
                Item::Break => {
                    self.commit_line(&mut line, &p.props, base_left, first_line, is_list, content_w);
                    first_line = false;
                    line_w = 0.0;
                }
            }
        }
        if !line.is_empty() {
            self.commit_line(&mut line, &p.props, base_left, first_line, is_list, content_w);
        }

        self.pen_y += p.props.space_after_pt;
    }

    fn avail(&self, pp: &crate::oxml::model::ParaProps, first_line: bool, is_list: bool, content_w: f32) -> f32 {
        let mut a = content_w - pp.indent_left_pt - if is_list { LIST_INDENT_PT } else { 0.0 };
        if first_line {
            a -= pp.indent_first_pt;
        }
        a.max(1.0)
    }

    /// Place the accumulated slots, apply alignment + (first-line) bullet, and
    /// emit a [`Line`]. Clears `line`.
    fn commit_line(
        &mut self,
        line: &mut Vec<Slot>,
        pp: &crate::oxml::model::ParaProps,
        base_left: f32,
        first_line: bool,
        is_list: bool,
        content_w: f32,
    ) {
        // Build runs at relative x (line origin = 0).
        let mut runs: Vec<LineRun> = Vec::new();
        let mut pen = 0.0f32;
        let mut max_ascent = 0.0f32;
        let mut max_lh = 0.0f32;

        for slot in line.iter() {
            if slot.is_tab {
                pen = next_tab(pen);
                continue;
            }
            if slot.space_before && !runs.is_empty() {
                pen += self.space_w(&slot.props);
            }
            let asc = self.font.ascent(slot.props.size_pt, slot.props.bold, slot.props.italic);
            let lh = self.font.line_height(slot.props.size_pt, slot.props.bold, slot.props.italic);
            max_ascent = max_ascent.max(asc);
            max_lh = max_lh.max(lh);
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
            max_ascent = self.font.ascent(11.0, false, false);
            max_lh = self.font.line_height(11.0, false, false);
        }
        let total = pen;

        // Alignment within the content box.
        let content_left = self.page.margin_left;
        let start_x = match pp.align {
            Align::Left | Align::Justify => {
                base_left + if first_line { pp.indent_first_pt } else { 0.0 }
            }
            Align::Right => content_left + content_w - total,
            Align::Center => content_left + (content_w - total) / 2.0,
        };
        for r in runs.iter_mut() {
            r.x += start_x;
        }

        // First-line bullet for list paragraphs.
        if is_list && first_line {
            let marker_size = runs.first().map(|r| r.size_pt).unwrap_or(11.0);
            let marker_w = self.font.measure_width("\u{2022}", marker_size, false, false);
            let marker_x = (start_x - LIST_GAP_PT - marker_w).max(self.page.margin_left);
            runs.insert(
                0,
                LineRun {
                    x: marker_x,
                    width: marker_w,
                    text: "\u{2022}".to_string(),
                    bold: false,
                    italic: false,
                    underline: false,
                    strike: false,
                    size_pt: marker_size,
                    color: [0, 0, 0],
                },
            );
        }

        let advance = max_lh * pp.line_spacing.max(0.1);
        self.commit(runs, max_ascent, advance);
    }

    fn commit(&mut self, runs: Vec<LineRun>, max_ascent: f32, advance: f32) {
        if self.pen_y + max_ascent > self.content_bottom() && !self.lines.is_empty() {
            self.flush_page();
            self.pen_y = self.page.margin_top;
        }
        self.lines.push(Line { baseline_y: self.pen_y + max_ascent, runs });
        self.pen_y += advance;
    }
}

fn next_tab(pen: f32) -> f32 {
    ((pen / TAB_PT).floor() + 1.0) * TAB_PT
}

/// Flatten a paragraph's inlines into word/tab/break items, measuring each word
/// and tracking whether a space precedes it (preserving run-boundary spacing).
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
    use crate::oxml::model::{ListMarker, ParaProps, RunProps, TextRun};

    fn text_para(s: &str, align: Align) -> Block {
        Block::Paragraph(Paragraph {
            props: ParaProps { align, ..Default::default() },
            inlines: vec![Inline::Text(TextRun { props: RunProps::default(), text: s.into() })],
        })
    }

    fn doc(blocks: Vec<Block>) -> Document {
        Document { page: PageMetrics::us_letter(), blocks }
    }

    fn line_text(line: &Line) -> String {
        line.runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn short_paragraph_one_line() {
        let res = layout_document(&doc(vec![text_para("Hello world", Align::Left)]), &FontSet::default_set());
        assert_eq!(res.pages.len(), 1);
        assert_eq!(res.pages[0].lines.len(), 1);
        assert_eq!(line_text(&res.pages[0].lines[0]), "Helloworld"); // runs concatenated w/o spaces
    }

    #[test]
    fn long_paragraph_wraps_within_width() {
        let words = vec!["wrap"; 400].join(" ");
        let d = doc(vec![text_para(&words, Align::Left)]);
        let res = layout_document(&d, &FontSet::default_set());
        let total: usize = res.pages.iter().map(|p| p.lines.len()).sum();
        assert!(total > 1);
        let right = d.page.margin_left + d.page.content_width();
        for page in &res.pages {
            for line in &page.lines {
                for r in &line.runs {
                    assert!(r.x + r.width <= right + 1.0, "run overflows content width");
                }
            }
        }
    }

    #[test]
    fn explicit_page_break_forces_new_page() {
        let res = layout_document(
            &doc(vec![text_para("Top", Align::Left), Block::PageBreak, text_para("Next", Align::Left)]),
            &FontSet::default_set(),
        );
        assert_eq!(res.pages.len(), 2);
    }

    #[test]
    fn list_paragraph_gets_bullet() {
        let para = Block::Paragraph(Paragraph {
            props: ParaProps { list: Some(ListMarker { num_id: 1, level: 0 }), ..Default::default() },
            inlines: vec![Inline::Text(TextRun { props: RunProps::default(), text: "Item".into() })],
        });
        let res = layout_document(&doc(vec![para]), &FontSet::default_set());
        let first = &res.pages[0].lines[0];
        assert_eq!(first.runs[0].text, "\u{2022}");
    }
}
