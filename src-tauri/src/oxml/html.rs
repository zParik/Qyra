//! Render a parsed [`Document`] to styled HTML for the in-place editor. The
//! webview shows this in a `contenteditable` surface so the user gets a real
//! caret and types directly in the document (Word-style), instead of separate
//! text boxes.
//!
//! Every top-level block (paragraph or table) carries `data-block="N"` (N = its
//! index in `Document::blocks`, matching the order `editor::reconcile_body_in_package`
//! walks the source `<w:p>`/`<w:tbl>` children). Table cells carry `data-r`/`data-c`
//! (row index, cell-ordinal within the row) so cell edits can be mapped back. This
//! shared key is the spine of the lossless, structure-preserving save.

use base64::Engine;

use super::model::{Align, Block, Cell, Document, Inline, Paragraph, RunProps, Table};

/// Render the document body to an HTML fragment for the editor surface.
pub fn to_html(doc: &Document) -> String {
    let mut out = String::new();
    for (i, block) in doc.blocks.iter().enumerate() {
        match block {
            Block::Paragraph(p) => paragraph_html(p, &mut out, Some(i)),
            Block::Table(t) => table_html(t, &mut out, Some(i)),
        }
    }
    out
}

/// Render header/footer blocks to an HTML fragment (no `data-block` keys — this is
/// page chrome, not editable body content).
pub fn chrome_html(blocks: &[Block]) -> String {
    let mut out = String::new();
    for block in blocks {
        match block {
            Block::Paragraph(p) => paragraph_html(p, &mut out, None),
            Block::Table(t) => table_html(t, &mut out, None),
        }
    }
    out
}

/// Render a paragraph. `block_idx` is `Some` for a top-level body block (emits
/// `data-block`) and `None` for a paragraph nested in a table cell.
fn paragraph_html(p: &Paragraph, out: &mut String, block_idx: Option<usize>) {
    let key = block_idx.map(|i| format!(" data-block=\"{i}\"")).unwrap_or_default();
    // Word's recorded page-break-before, so the editor can start a fresh page here.
    let brk = if p.props.break_before { " data-break-before=\"1\"" } else { "" };
    out.push_str(&format!("<p{}{}{}>", key, brk, para_style(p)));
    if let Some(marker) = &p.props.list_marker {
        out.push_str(&format!("<span class=\"qyra-marker\">{}\u{00a0}</span>", esc(marker)));
    }
    // A block with no visible content still needs a caret target.
    if p.inlines.iter().all(|i| matches!(i, Inline::PageBreak)) {
        out.push_str("<br>");
    }
    for inline in &p.inlines {
        inline_html(inline, out);
    }
    out.push_str("</p>");
}

fn table_html(t: &Table, out: &mut String, block_idx: Option<usize>) {
    let key = block_idx.map(|i| format!(" data-block=\"{i}\"")).unwrap_or_default();
    out.push_str(&format!("<table{} class=\"qyra-table\" style=\"border-collapse:collapse\">", key));
    for (ri, row) in t.rows.iter().enumerate() {
        out.push_str("<tr>");
        for (ci, cell) in row.cells.iter().enumerate() {
            cell_html(cell, out, ri, ci);
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
}

fn cell_html(cell: &Cell, out: &mut String, ri: usize, ci: usize) {
    let span = if cell.grid_span > 1 {
        format!(" colspan=\"{}\"", cell.grid_span)
    } else {
        String::new()
    };
    out.push_str(&format!(
        "<td data-r=\"{ri}\" data-c=\"{ci}\"{span} style=\"border:1px solid #aaa;padding:4px;vertical-align:top\">"
    ));
    for b in &cell.blocks {
        match b {
            Block::Paragraph(p) => paragraph_html(p, out, None),
            Block::Table(t) => table_html(t, out, None),
        }
    }
    out.push_str("</td>");
}

fn inline_html(inline: &Inline, out: &mut String) {
    match inline {
        Inline::Text(run) => {
            out.push_str(&format!("<span style=\"{}\">{}</span>", run_style(&run.props), esc(&run.text)));
        }
        Inline::Tab => out.push_str("<span class=\"qyra-tab\">\u{2003}</span>"),
        Inline::LineBreak => out.push_str("<br>"),
        Inline::PageBreak => out.push_str("<hr class=\"qyra-pagebreak\" contenteditable=\"false\">"),
        Inline::Image(img) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&img.data);
            // Format guessed by the browser from the data; png/jpeg both decode.
            out.push_str(&format!(
                "<img src=\"data:image;base64,{}\" style=\"width:{:.0}px;height:{:.0}px\" contenteditable=\"false\">",
                b64,
                img.width_pt * 1.333,
                img.height_pt * 1.333,
            ));
        }
    }
}

fn para_style(p: &Paragraph) -> String {
    let align = match p.props.align {
        Align::Left => "left",
        Align::Right => "right",
        Align::Center => "center",
        Align::Justify => "justify",
    };
    format!(
        " style=\"text-align:{};margin:{:.1}pt 0 {:.1}pt {:.1}pt;text-indent:{:.1}pt;line-height:{}\"",
        align,
        p.props.space_before_pt,
        p.props.space_after_pt,
        p.props.indent_left_pt,
        p.props.indent_first_pt,
        p.props.line_spacing.max(0.1),
    )
}

fn run_style(rp: &RunProps) -> String {
    let mut s = format!("font-size:{:.1}pt;color:#{:02x}{:02x}{:02x}", rp.size_pt, rp.color[0], rp.color[1], rp.color[2]);
    if let Some(font) = &rp.font {
        s.push_str(&format!(";font-family:'{}'", font.replace('\'', "")));
    }
    if rp.bold {
        s.push_str(";font-weight:bold");
    }
    if rp.italic {
        s.push_str(";font-style:italic");
    }
    if let Some(h) = rp.highlight {
        s.push_str(&format!(";background-color:#{:02x}{:02x}{:02x}", h[0], h[1], h[2]));
    }
    if rp.superscript {
        s.push_str(";vertical-align:super;font-size:0.7em");
    } else if rp.subscript {
        s.push_str(";vertical-align:sub;font-size:0.7em");
    }
    let mut deco = String::new();
    if rp.underline {
        deco.push_str("underline ");
    }
    if rp.strike {
        deco.push_str("line-through");
    }
    if !deco.trim().is_empty() {
        s.push_str(&format!(";text-decoration:{}", deco.trim()));
    }
    s
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oxml::model::{ParaProps, PageMetrics, TextRun};

    #[test]
    fn paragraph_gets_data_index_and_styled_run() {
        let doc = Document {
            page: PageMetrics::us_letter(),
            blocks: vec![Block::Paragraph(Paragraph {
                props: ParaProps::default(),
                inlines: vec![Inline::Text(TextRun {
                    props: RunProps { bold: true, ..Default::default() },
                    text: "Hi <there>".into(),
                })],
            })],
            header: vec![],
            footer: vec![],
        };
        let html = to_html(&doc);
        assert!(html.contains("data-block=\"0\""));
        assert!(html.contains("font-weight:bold"));
        assert!(html.contains("Hi &lt;there&gt;"), "text must be escaped");
    }
}
