//! Parse the main document part (`word/document.xml`) of a WordprocessingML
//! package into the typed [`Document`] model. P1 scope: body paragraphs, runs,
//! run bold/italic/size, paragraph alignment, and the section page metrics.

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use super::model::{
    half_points_to_pt, twips_to_pt, Align, Block, Document, PageMetrics, Paragraph, ParaProps, Run,
    RunProps,
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

/// Load a `.docx` from package bytes and parse its main document part.
pub fn open(bytes: &[u8]) -> Result<Document, DocxError> {
    let pkg = Package::load(bytes)?;
    let part = pkg.part("word/document.xml").ok_or(DocxError::MissingDocument)?;
    let xml = std::str::from_utf8(&part.data).map_err(|_| DocxError::MissingDocument)?;
    parse_document_xml(xml)
}

/// Parse the XML text of `word/document.xml`. Separated from [`open`] so it is
/// testable without building a ZIP.
///
/// ponytail: matches on the qualified `w:`-prefixed element/attribute names that
/// real Word files always use, rather than resolving XML namespaces. Namespace
/// resolution is a later hardening task, not P1.
pub fn parse_document_xml(xml: &str) -> Result<Document, DocxError> {
    // quick-xml does not trim text by default, so w:t whitespace is preserved.
    // We only capture text while inside a w:t element, so inter-element
    // indentation never leaks into runs.
    let mut reader = Reader::from_str(xml);

    let mut blocks: Vec<Block> = Vec::new();
    let mut page = PageMetrics::us_letter();

    let mut cur_para: Option<Paragraph> = None;
    let mut cur_run_props: Option<RunProps> = None;
    let mut cur_text = String::new();
    let mut in_text = false;

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match e.name().as_ref() {
                b"w:p" => cur_para = Some(Paragraph { props: ParaProps::default(), runs: Vec::new() }),
                b"w:r" => cur_run_props = Some(RunProps::default()),
                b"w:t" => {
                    in_text = true;
                    cur_text.clear();
                }
                _ => {}
            },
            Event::Empty(e) => match e.name().as_ref() {
                b"w:b" => {
                    if let Some(rp) = cur_run_props.as_mut() {
                        rp.bold = true;
                    }
                }
                b"w:i" => {
                    if let Some(rp) = cur_run_props.as_mut() {
                        rp.italic = true;
                    }
                }
                b"w:sz" => {
                    if let (Some(rp), Some(v)) = (cur_run_props.as_mut(), attr_f32(&e, b"w:val")) {
                        rp.size_pt = half_points_to_pt(v);
                    }
                }
                b"w:jc" => {
                    if let (Some(p), Some(val)) = (cur_para.as_mut(), attr_str(&e, b"w:val")) {
                        p.props.align = parse_align(&val);
                    }
                }
                b"w:pgSz" => {
                    if let Some(w) = attr_f32(&e, b"w:w") {
                        page.width = twips_to_pt(w);
                    }
                    if let Some(h) = attr_f32(&e, b"w:h") {
                        page.height = twips_to_pt(h);
                    }
                }
                b"w:pgMar" => {
                    if let Some(v) = attr_f32(&e, b"w:top") {
                        page.margin_top = twips_to_pt(v);
                    }
                    if let Some(v) = attr_f32(&e, b"w:right") {
                        page.margin_right = twips_to_pt(v);
                    }
                    if let Some(v) = attr_f32(&e, b"w:bottom") {
                        page.margin_bottom = twips_to_pt(v);
                    }
                    if let Some(v) = attr_f32(&e, b"w:left") {
                        page.margin_left = twips_to_pt(v);
                    }
                }
                _ => {}
            },
            Event::Text(e) => {
                if in_text {
                    // unescape's error type varies across quick-xml versions; a
                    // decode failure on body text is benign, so fall back to "".
                    cur_text.push_str(&e.unescape().unwrap_or_default());
                }
            }
            Event::End(e) => match e.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:r" => {
                    if let (Some(p), Some(props)) = (cur_para.as_mut(), cur_run_props.take()) {
                        p.runs.push(Run { props, text: std::mem::take(&mut cur_text) });
                    }
                }
                b"w:p" => {
                    if let Some(p) = cur_para.take() {
                        blocks.push(Block::Paragraph(p));
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(Document { page, blocks })
}

fn parse_align(val: &str) -> Align {
    match val {
        "center" => Align::Center,
        "right" | "end" => Align::Right,
        "both" | "distribute" => Align::Justify,
        _ => Align::Left,
    }
}

/// Read an attribute as a string by its qualified name (e.g. `b"w:val"`).
fn attr_str(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| a.unescape_value().ok().map(|c| c.into_owned()))
}

fn attr_f32(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<f32> {
    attr_str(e, key).and_then(|s| s.parse::<f32>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC_XML: &str = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>
<w:r><w:t xml:space="preserve">Hello </w:t></w:r>
<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>World</w:t></w:r>
</w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
</w:body>
</w:document>"#;

    #[test]
    fn parses_paragraph_runs_and_props() {
        let doc = parse_document_xml(DOC_XML).expect("parse");
        assert_eq!(doc.blocks.len(), 1);
        let p = match &doc.blocks[0] {
            Block::Paragraph(p) => p,
        };
        assert_eq!(p.props.align, Align::Center);
        assert_eq!(p.runs.len(), 2);
        assert_eq!(p.runs[0].text, "Hello ");
        assert!(!p.runs[0].props.bold);
        assert_eq!(p.runs[1].text, "World");
        assert!(p.runs[1].props.bold);
        assert_eq!(p.runs[1].props.size_pt, half_points_to_pt(28.0)); // 14pt
    }

    #[test]
    fn parses_page_metrics_from_sectpr() {
        let doc = parse_document_xml(DOC_XML).expect("parse");
        assert_eq!(doc.page.width, twips_to_pt(12240.0));
        assert_eq!(doc.page.margin_left, twips_to_pt(720.0)); // 0.5 inch
    }

    #[test]
    fn missing_sectpr_falls_back_to_us_letter() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = parse_document_xml(xml).expect("parse");
        assert_eq!(doc.page, PageMetrics::us_letter());
    }
}
