//! Flow a [`Document`] into pages: greedy line-breaking within the content
//! width, vertical stacking by line height, and pagination by content height.
//! Output is a positioned box tree consumed by the renderer.

use crate::oxml::model::{Align, Block, Document, PageMetrics, Paragraph};

use super::font::Font;

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
    /// Baseline y, in points from the page top.
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
    pub size_pt: f32,
}

/// A measured word plus the styling of the run it came from.
struct Word {
    text: String,
    width: f32,
    size_pt: f32,
    bold: bool,
    italic: bool,
}

/// Lay a document out into positioned pages using a single font.
pub fn layout_document(doc: &Document, font: &Font) -> LayoutResult {
    let page = &doc.page;
    let content_width = page.content_width();

    let mut pages: Vec<LaidPage> = Vec::new();
    let mut lines: Vec<Line> = Vec::new();
    let mut pen_y = page.margin_top; // top of the next line

    for block in &doc.blocks {
        let p = match block {
            Block::Paragraph(p) => p,
        };
        let align = p.props.align;
        let size = para_size(p);
        let space_w = font.measure_width(" ", size);
        let words = paragraph_words(p, font);

        if words.is_empty() {
            // Empty paragraph still advances one blank line.
            advance_blank_line(font, page, size, &mut pen_y, &mut lines, &mut pages);
            continue;
        }

        let mut cur: Vec<Word> = Vec::new();
        let mut cur_w = 0.0f32;
        for w in words {
            let add = if cur.is_empty() { w.width } else { space_w + w.width };
            if !cur.is_empty() && cur_w + add > content_width {
                commit_line(&mut cur, &mut cur_w, &mut pen_y, &mut lines, &mut pages, font, page, align);
            }
            let add = if cur.is_empty() { w.width } else { space_w + w.width };
            cur_w += add;
            cur.push(w);
        }
        commit_line(&mut cur, &mut cur_w, &mut pen_y, &mut lines, &mut pages, font, page, align);
    }

    if !lines.is_empty() {
        pages.push(LaidPage { width: page.width, height: page.height, lines: std::mem::take(&mut lines) });
    }
    if pages.is_empty() {
        pages.push(LaidPage { width: page.width, height: page.height, lines: vec![] });
    }
    LayoutResult { pages }
}

fn para_size(p: &Paragraph) -> f32 {
    p.runs.first().map(|r| r.props.size_pt).unwrap_or(11.0)
}

/// Split every run's text on whitespace, measuring each word with its run size.
fn paragraph_words(p: &Paragraph, font: &Font) -> Vec<Word> {
    let mut out = Vec::new();
    for run in &p.runs {
        for piece in run.text.split_whitespace() {
            out.push(Word {
                text: piece.to_string(),
                width: font.measure_width(piece, run.props.size_pt),
                size_pt: run.props.size_pt,
                bold: run.props.bold,
                italic: run.props.italic,
            });
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn commit_line(
    words: &mut Vec<Word>,
    line_w: &mut f32,
    pen_y: &mut f32,
    lines: &mut Vec<Line>,
    pages: &mut Vec<LaidPage>,
    font: &Font,
    page: &PageMetrics,
    align: Align,
) {
    if words.is_empty() {
        return;
    }
    let content_width = page.content_width();
    let max_y = page.height - page.margin_bottom;
    let size = words[0].size_pt;
    let lh = font.line_height(size);
    let asc = font.ascent(size);

    // Page break if this line's baseline would fall below the content box.
    if *pen_y + asc > max_y && !lines.is_empty() {
        pages.push(LaidPage { width: page.width, height: page.height, lines: std::mem::take(lines) });
        *pen_y = page.margin_top;
    }

    let used = *line_w;
    let start_x = match align {
        Align::Left | Align::Justify => page.margin_left,
        Align::Right => page.margin_left + (content_width - used),
        Align::Center => page.margin_left + (content_width - used) / 2.0,
    };
    let runs = pack_line(words, start_x, font);
    lines.push(Line { baseline_y: *pen_y + asc, runs });
    *pen_y += lh;
    words.clear();
    *line_w = 0.0;
}

fn advance_blank_line(
    font: &Font,
    page: &PageMetrics,
    size: f32,
    pen_y: &mut f32,
    lines: &mut Vec<Line>,
    pages: &mut Vec<LaidPage>,
) {
    let lh = font.line_height(size);
    let asc = font.ascent(size);
    let max_y = page.height - page.margin_bottom;
    if *pen_y + asc > max_y && !lines.is_empty() {
        pages.push(LaidPage { width: page.width, height: page.height, lines: std::mem::take(lines) });
        *pen_y = page.margin_top;
    }
    lines.push(Line { baseline_y: *pen_y + asc, runs: vec![] });
    *pen_y += lh;
}

/// Combine words on a committed line into LineRuns, grouping adjacent words with
/// matching styling and inserting single spaces between words.
fn pack_line(words: &[Word], start_x: f32, font: &Font) -> Vec<LineRun> {
    let mut runs: Vec<LineRun> = Vec::new();
    let mut x = start_x;
    for (i, w) in words.iter().enumerate() {
        let text = if i == 0 { w.text.clone() } else { format!(" {}", w.text) };
        let width = font.measure_width(&text, w.size_pt);
        if let Some(last) = runs.last_mut() {
            if last.bold == w.bold && last.italic == w.italic && (last.size_pt - w.size_pt).abs() < 0.01 {
                last.text.push_str(&text);
                last.width += width;
                x += width;
                continue;
            }
        }
        runs.push(LineRun { x, width, text, bold: w.bold, italic: w.italic, size_pt: w.size_pt });
        x += width;
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oxml::model::{ParaProps, Run, RunProps};

    fn para(text: &str, align: Align) -> Block {
        Block::Paragraph(Paragraph {
            props: ParaProps { align },
            runs: vec![Run { props: RunProps::default(), text: text.into() }],
        })
    }

    fn doc(blocks: Vec<Block>) -> Document {
        Document { page: PageMetrics::us_letter(), blocks }
    }

    fn line_text(line: &Line) -> String {
        line.runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn short_paragraph_is_one_line_one_page() {
        let d = doc(vec![para("Hello world", Align::Left)]);
        let res = layout_document(&d, &Font::default_font());
        assert_eq!(res.pages.len(), 1);
        assert_eq!(res.pages[0].lines.len(), 1);
        assert_eq!(line_text(&res.pages[0].lines[0]), "Hello world");
        assert!((res.pages[0].lines[0].runs[0].x - d.page.margin_left).abs() < 0.01);
    }

    #[test]
    fn long_paragraph_wraps() {
        let words = vec!["wrap"; 400].join(" ");
        let d = doc(vec![para(&words, Align::Left)]);
        let res = layout_document(&d, &Font::default_font());
        let total: usize = res.pages.iter().map(|p| p.lines.len()).sum();
        assert!(total > 1, "400 words must wrap");
        let cw = d.page.content_width();
        for page in &res.pages {
            for line in &page.lines {
                let used: f32 = line.runs.iter().map(|r| r.width).sum();
                assert!(used <= cw + 0.5, "line overflows content width");
            }
        }
    }

    #[test]
    fn enough_text_paginates() {
        let words = vec!["page"; 4000].join(" ");
        let d = doc(vec![para(&words, Align::Left)]);
        let res = layout_document(&d, &Font::default_font());
        assert!(res.pages.len() > 1, "4000 words must spill onto >1 page");
        let max_baseline = d.page.height - d.page.margin_bottom;
        for page in &res.pages {
            for line in &page.lines {
                assert!(line.baseline_y <= max_baseline + 0.5);
            }
        }
    }

    #[test]
    fn center_offsets_x() {
        let d = doc(vec![para("Centered", Align::Center)]);
        let res = layout_document(&d, &Font::default_font());
        let line = &res.pages[0].lines[0];
        assert!(line.runs[0].x > d.page.margin_left + 1.0);
    }
}
