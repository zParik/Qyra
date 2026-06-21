//! Render a parsed [`Document`] to styled HTML for the in-place editor. The
//! webview shows this in a `contenteditable` surface so the user gets a real
//! caret and types directly in the document (Word-style), instead of separate
//! text boxes.
//!
//! Top-level body paragraphs carry `data-p="N"` (N = body-paragraph index,
//! matching `editor::paragraph_texts_in_package`) so the frontend can map edited
//! text back to the right paragraph for the lossless save path. Tables/images
//! render for fidelity but are not yet mapped back on save.

use base64::Engine;

use super::model::{Align, Block, Document, Inline, Paragraph, RunProps};

/// Render the document body to an HTML fragment for the editor surface.
pub fn to_html(doc: &Document) -> String {
    let mut out = String::new();
    let mut body_idx = 0usize;
    for block in &doc.blocks {
        block_html(block, &mut out, &mut body_idx, true);
    }
    out
}

fn block_html(block: &Block, out: &mut String, body_idx: &mut usize, top_level: bool) {
    match block {
        Block::Paragraph(p) => {
            let idx_attr = if top_level {
                let a = format!(" data-p=\"{}\"", *body_idx);
                *body_idx += 1;
                a
            } else {
                String::new()
            };
            out.push_str(&format!("<p{}{}>", idx_attr, para_style(p)));
            if let Some(marker) = &p.props.list_marker {
                out.push_str(&format!("<span class=\"qyra-marker\">{}\u{00a0}</span>", esc(marker)));
            }
            if p.inlines.is_empty() {
                out.push_str("<br>");
            }
            for inline in &p.inlines {
                inline_html(inline, out);
            }
            out.push_str("</p>");
        }
        Block::Table(t) => {
            out.push_str("<table class=\"qyra-table\" style=\"border-collapse:collapse\">");
            for row in &t.rows {
                out.push_str("<tr>");
                for cell in &row.cells {
                    let span = if cell.grid_span > 1 {
                        format!(" colspan=\"{}\"", cell.grid_span)
                    } else {
                        String::new()
                    };
                    out.push_str(&format!(
                        "<td{} style=\"border:1px solid #aaa;padding:4px;vertical-align:top\">",
                        span
                    ));
                    let mut dummy = 0usize;
                    for b in &cell.blocks {
                        block_html(b, out, &mut dummy, false);
                    }
                    out.push_str("</td>");
                }
                out.push_str("</tr>");
            }
            out.push_str("</table>");
        }
        Block::PageBreak => out.push_str("<hr class=\"qyra-pagebreak\">"),
    }
}

fn inline_html(inline: &Inline, out: &mut String) {
    match inline {
        Inline::Text(run) => {
            out.push_str(&format!("<span style=\"{}\">{}</span>", run_style(&run.props), esc(&run.text)));
        }
        Inline::Tab => out.push_str("<span class=\"qyra-tab\">\u{2003}</span>"),
        Inline::LineBreak => out.push_str("<br>"),
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
    if rp.bold {
        s.push_str(";font-weight:bold");
    }
    if rp.italic {
        s.push_str(";font-style:italic");
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
        assert!(html.contains("data-p=\"0\""));
        assert!(html.contains("font-weight:bold"));
        assert!(html.contains("Hi &lt;there&gt;"), "text must be escaped");
    }
}
