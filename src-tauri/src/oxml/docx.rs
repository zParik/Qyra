//! Parse `word/document.xml` into the typed [`Document`] model, resolving named
//! styles from `word/styles.xml`. Wave 1: paragraphs, runs (bold/italic/
//! underline/strike/size/color), alignment, paragraph spacing/indent, lists
//! (numPr), line breaks, tabs, and explicit page breaks.
//!
//! ponytail: matches the qualified `w:`-prefixed names real Word files use
//! rather than resolving XML namespaces — a later hardening task.

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use super::model::{
    twips_to_pt, Block, Document, Inline, ListMarker, PageMetrics, Paragraph, TextRun,
};
use super::styles::{
    apply_para_partial, apply_run_partial, attr_f32, attr_str, para_prop, run_prop,
    ParaPropsPartial, RunPropsPartial, Styles,
};
use super::{Package, PackageError};

#[derive(Debug, thiserror::Error)]
pub enum DocxError {
    #[error("package error: {0}")]
    Package(#[from] PackageError),
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("missing word/document.xml")]
    MissingDocument,
}

/// Load a `.docx` and parse its main document, resolving styles if present.
pub fn open(bytes: &[u8]) -> Result<Document, DocxError> {
    let pkg = Package::load(bytes)?;
    let styles = pkg
        .part("word/styles.xml")
        .and_then(|p| std::str::from_utf8(&p.data).ok())
        .map(Styles::parse)
        .unwrap_or_else(Styles::empty);
    let part = pkg.part("word/document.xml").ok_or(DocxError::MissingDocument)?;
    let xml = std::str::from_utf8(&part.data).map_err(|_| DocxError::MissingDocument)?;
    parse_document_xml(xml, &styles)
}

/// Parse document XML against a resolved style table. Separated from [`open`] so
/// it is testable without a ZIP.
pub fn parse_document_xml(xml: &str, styles: &Styles) -> Result<Document, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    let mut page = PageMetrics::us_letter();
    let mut blocks: Vec<Block> = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();

    // Paragraph-in-progress state.
    let mut in_para = false;
    let mut style_id: Option<String> = None;
    let mut para_direct = ParaPropsPartial::default();
    let mut list: Option<ListMarker> = None;
    let mut inlines: Vec<Inline> = Vec::new();
    // Run-in-progress state.
    let mut run_direct = RunPropsPartial::default();
    // Text-in-progress state.
    let mut in_text = false;
    let mut text = String::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                match name.as_slice() {
                    b"w:p" => {
                        in_para = true;
                        style_id = None;
                        para_direct = ParaPropsPartial::default();
                        list = None;
                        inlines.clear();
                        run_direct = RunPropsPartial::default();
                    }
                    b"w:r" => run_direct = RunPropsPartial::default(),
                    b"w:t" => {
                        in_text = true;
                        text.clear();
                    }
                    _ => {}
                }
                if !try_page_break(&name, &e, styles, &style_id, &para_direct, &list, &mut inlines, &mut blocks) {
                    apply_leaf(&name, &e, &stack, &mut page, &mut style_id, &mut para_direct, &mut run_direct, &mut list, &mut inlines, in_para);
                }
                stack.push(name);
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_vec();
                if name.as_slice() == b"w:p" {
                    // Empty paragraph → a blank line.
                    let mut pp = styles.para_for(None);
                    apply_para_partial(&mut pp, &ParaPropsPartial::default());
                    blocks.push(Block::Paragraph(Paragraph { props: pp, inlines: vec![] }));
                } else if !try_page_break(&name, &e, styles, &style_id, &para_direct, &list, &mut inlines, &mut blocks) {
                    apply_leaf(&name, &e, &stack, &mut page, &mut style_id, &mut para_direct, &mut run_direct, &mut list, &mut inlines, in_para);
                }
            }
            Event::Text(e) => {
                if in_text {
                    text.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Event::End(e) => {
                let name = e.name().as_ref().to_vec();
                match name.as_slice() {
                    b"w:t" => {
                        in_text = false;
                        if !text.is_empty() {
                            let mut rp = styles.run_for(style_id.as_deref());
                            apply_run_partial(&mut rp, &run_direct);
                            inlines.push(Inline::Text(TextRun { props: rp, text: std::mem::take(&mut text) }));
                        }
                    }
                    b"w:r" => run_direct = RunPropsPartial::default(),
                    b"w:p" => {
                        blocks.push(Block::Paragraph(build_paragraph(
                            styles, &style_id, &para_direct, &list, &mut inlines,
                        )));
                        in_para = false;
                    }
                    _ => {}
                }
                stack.pop();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(Document { page, blocks })
}

/// Build a paragraph from the current parser state (consuming its inlines).
fn build_paragraph(
    styles: &Styles,
    style_id: &Option<String>,
    para_direct: &ParaPropsPartial,
    list: &Option<ListMarker>,
    inlines: &mut Vec<Inline>,
) -> Paragraph {
    let mut pp = styles.para_for(style_id.as_deref());
    apply_para_partial(&mut pp, para_direct);
    pp.list = list.clone();
    pp.style_id = style_id.clone();
    Paragraph { props: pp, inlines: std::mem::take(inlines) }
}

/// If `<w:br w:type="page"/>`, finalize the current paragraph, emit a page
/// break, and start a fresh paragraph. Returns true if handled.
#[allow(clippy::too_many_arguments)]
fn try_page_break(
    name: &[u8],
    e: &BytesStart,
    styles: &Styles,
    style_id: &Option<String>,
    para_direct: &ParaPropsPartial,
    list: &Option<ListMarker>,
    inlines: &mut Vec<Inline>,
    blocks: &mut Vec<Block>,
) -> bool {
    if name != b"w:br" || attr_str(e, b"w:type").as_deref() != Some("page") {
        return false;
    }
    blocks.push(Block::Paragraph(build_paragraph(styles, style_id, para_direct, list, inlines)));
    blocks.push(Block::PageBreak);
    true
}

/// Route a leaf property element to page metrics, the run/paragraph partials,
/// the list marker, or an inline, based on element-stack context.
#[allow(clippy::too_many_arguments)]
fn apply_leaf(
    name: &[u8],
    e: &BytesStart,
    stack: &[Vec<u8>],
    page: &mut PageMetrics,
    style_id: &mut Option<String>,
    para_direct: &mut ParaPropsPartial,
    run_direct: &mut RunPropsPartial,
    list: &mut Option<ListMarker>,
    inlines: &mut Vec<Inline>,
    in_para: bool,
) {
    let has = |n: &[u8]| stack.iter().any(|x| x.as_slice() == n);

    match name {
        b"w:pStyle" if has(b"w:pPr") => *style_id = attr_str(e, b"w:val"),
        b"w:jc" | b"w:spacing" | b"w:ind" if has(b"w:pPr") && !has(b"w:rPr") => {
            para_prop(para_direct, name, e)
        }
        b"w:b" | b"w:i" | b"w:u" | b"w:strike" | b"w:sz" | b"w:color"
            if has(b"w:r") && has(b"w:rPr") =>
        {
            run_prop(run_direct, name, e)
        }
        b"w:numId" if has(b"w:numPr") => {
            let id = attr_f32(e, b"w:val").unwrap_or(0.0) as i32;
            list.get_or_insert(ListMarker { num_id: 0, level: 0 }).num_id = id;
        }
        b"w:ilvl" if has(b"w:numPr") => {
            let lv = attr_f32(e, b"w:val").unwrap_or(0.0) as u8;
            list.get_or_insert(ListMarker { num_id: 0, level: 0 }).level = lv;
        }
        b"w:pgSz" if has(b"w:sectPr") => {
            if let Some(w) = attr_f32(e, b"w:w") {
                page.width = twips_to_pt(w);
            }
            if let Some(h) = attr_f32(e, b"w:h") {
                page.height = twips_to_pt(h);
            }
        }
        b"w:pgMar" if has(b"w:sectPr") => {
            if let Some(v) = attr_f32(e, b"w:top") {
                page.margin_top = twips_to_pt(v);
            }
            if let Some(v) = attr_f32(e, b"w:right") {
                page.margin_right = twips_to_pt(v);
            }
            if let Some(v) = attr_f32(e, b"w:bottom") {
                page.margin_bottom = twips_to_pt(v);
            }
            if let Some(v) = attr_f32(e, b"w:left") {
                page.margin_left = twips_to_pt(v);
            }
        }
        b"w:tab" if in_para => inlines.push(Inline::Tab),
        b"w:br" if in_para => inlines.push(Inline::LineBreak),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oxml::model::Align;

    fn first_para(doc: &Document) -> &Paragraph {
        match &doc.blocks[0] {
            Block::Paragraph(p) => p,
            Block::PageBreak => panic!("unexpected page break"),
        }
    }

    fn run_texts(p: &Paragraph) -> Vec<&str> {
        p.inlines
            .iter()
            .filter_map(|i| match i {
                Inline::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn parses_runs_props_and_alignment() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr>
          <w:r><w:t xml:space="preserve">Hello </w:t></w:r>
          <w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="FF0000"/></w:rPr><w:t>World</w:t></w:r>
          </w:p></w:body></w:document>"#;
        let doc = parse_document_xml(xml, &Styles::empty()).expect("parse");
        let p = first_para(&doc);
        assert_eq!(p.props.align, Align::Center);
        assert_eq!(run_texts(p), vec!["Hello ", "World"]);
        let Inline::Text(bold) = &p.inlines[1] else { panic!() };
        assert!(bold.props.bold);
        assert_eq!(bold.props.size_pt, 14.0);
        assert_eq!(bold.props.color, [255, 0, 0]);
    }

    #[test]
    fn applies_paragraph_style_size() {
        let styles = Styles::parse(
            r#"<w:styles xmlns:w="x"><w:style w:type="paragraph" w:styleId="Heading1"><w:rPr><w:sz w:val="48"/></w:rPr></w:style></w:styles>"#,
        );
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = parse_document_xml(xml, &styles).expect("parse");
        let Inline::Text(t) = &first_para(&doc).inlines[0] else { panic!() };
        assert_eq!(t.props.size_pt, 24.0); // 48 half-points
    }

    #[test]
    fn explicit_page_break_produces_block() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:p><w:r><w:t>Before</w:t></w:r></w:p>
          <w:p><w:r><w:br w:type="page"/></w:r></w:p>
          <w:p><w:r><w:t>After</w:t></w:r></w:p>
          </w:body></w:document>"#;
        let doc = parse_document_xml(xml, &Styles::empty()).expect("parse");
        assert!(doc.blocks.iter().any(|b| matches!(b, Block::PageBreak)));
    }

    #[test]
    fn list_paragraph_captures_numpr() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = parse_document_xml(xml, &Styles::empty()).expect("parse");
        let lm = first_para(&doc).props.list.as_ref().expect("list marker");
        assert_eq!(lm.num_id, 3);
        assert_eq!(lm.level, 0);
    }
}
