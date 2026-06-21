//! Parse `word/document.xml` into the typed [`Document`] model, resolving named
//! styles from `word/styles.xml`. Covers paragraphs, rich runs, alignment,
//! spacing/indent, lists, line breaks, tabs, explicit page breaks, and tables
//! (rows / cells / grid spans, with nested block content).
//!
//! ponytail: matches the qualified `w:`-prefixed names real Word files use
//! rather than resolving XML namespaces — a later hardening task.

use std::collections::HashMap;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;

use super::model::{
    emu_to_pt, twips_to_pt, Block, Cell, Document, ImageRef, Inline, ListMarker, PageMetrics,
    Paragraph, Row, Table, TextRun,
};
use super::numbering::Numbering;
use super::styles::{
    apply_para_partial, apply_run_partial, attr_f32, attr_str, para_prop, run_prop,
    ParaPropsPartial, RunPropsPartial, Styles,
};
use super::{Package, PackageError};

/// Running list counters keyed by (numId, level).
type Counters = HashMap<(i32, u8), i32>;

/// Relationship-id → encoded image bytes, resolved from the package.
type MediaMap = HashMap<String, Vec<u8>>;

#[derive(Debug, thiserror::Error)]
pub enum DocxError {
    #[error("package error: {0}")]
    Package(#[from] PackageError),
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("missing word/document.xml")]
    MissingDocument,
}

/// In-progress table being assembled from the event stream.
#[derive(Default)]
struct TableB {
    col_widths: Vec<f32>,
    rows: Vec<Row>,
    cur_row: Option<Vec<Cell>>,
    cur_cell: Option<CellB>,
}

#[derive(Default)]
struct CellB {
    blocks: Vec<Block>,
    grid_span: u32,
}

/// Load a `.docx` and parse its main document, resolving styles, media,
/// numbering, and default header/footer.
pub fn open(bytes: &[u8]) -> Result<Document, DocxError> {
    let pkg = Package::load(bytes)?;
    let styles = pkg
        .part("word/styles.xml")
        .and_then(|p| std::str::from_utf8(&p.data).ok())
        .map(Styles::parse)
        .unwrap_or_else(Styles::empty);
    let rels = load_rels(&pkg);
    let media = load_media(&pkg, &rels);
    let numbering = pkg
        .part("word/numbering.xml")
        .and_then(|p| std::str::from_utf8(&p.data).ok())
        .map(Numbering::parse)
        .unwrap_or_else(Numbering::empty);
    let part = pkg.part("word/document.xml").ok_or(DocxError::MissingDocument)?;
    let xml = std::str::from_utf8(&part.data).map_err(|_| DocxError::MissingDocument)?;

    let mut doc = parse_document_xml(xml, &styles, &media, &numbering)?;
    let (hdr, ftr) = scan_section_refs(xml);
    if let Some(b) = hdr.and_then(|rid| part_blocks(&pkg, &rels, &rid, &styles, &media, &numbering)) {
        doc.header = b;
    }
    if let Some(b) = ftr.and_then(|rid| part_blocks(&pkg, &rels, &rid, &styles, &media, &numbering)) {
        doc.footer = b;
    }
    Ok(doc)
}

/// Parse `word/_rels/document.xml.rels` into a relationship-id → package-path map.
fn load_rels(pkg: &Package) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(rels) = pkg
        .part("word/_rels/document.xml.rels")
        .and_then(|p| std::str::from_utf8(&p.data).ok())
    else {
        return map;
    };
    let mut reader = Reader::from_str(rels);
    let mut buf = Vec::new();
    loop {
        let ev = match reader.read_event_into(&mut buf) {
            Ok(ev) => ev,
            Err(_) => break,
        };
        match ev {
            Event::Empty(e) | Event::Start(e) if e.name().as_ref() == b"Relationship" => {
                if let (Some(id), Some(target)) = (attr_str(&e, b"Id"), attr_str(&e, b"Target")) {
                    map.insert(id, normalize_rel_target(&target));
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    map
}

/// Relationship-id → image bytes, for media parts only.
fn load_media(pkg: &Package, rels: &HashMap<String, String>) -> MediaMap {
    let mut map = MediaMap::new();
    for (rid, path) in rels {
        if path.starts_with("word/media/") {
            if let Some(part) = pkg.part(path) {
                map.insert(rid.clone(), part.data.clone());
            }
        }
    }
    map
}

/// Find the default-section header/footer relationship ids in the document.
fn scan_section_refs(xml: &str) -> (Option<String>, Option<String>) {
    let (mut header_any, mut footer_any) = (None, None);
    let (mut header_def, mut footer_def) = (None, None);
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        let ev = match reader.read_event_into(&mut buf) {
            Ok(ev) => ev,
            Err(_) => break,
        };
        match ev {
            Event::Empty(e) | Event::Start(e) => match e.name().as_ref() {
                b"w:headerReference" => {
                    let id = attr_str(&e, b"r:id");
                    if attr_str(&e, b"w:type").as_deref() == Some("default") {
                        header_def = id.clone();
                    }
                    if header_any.is_none() {
                        header_any = id;
                    }
                }
                b"w:footerReference" => {
                    let id = attr_str(&e, b"r:id");
                    if attr_str(&e, b"w:type").as_deref() == Some("default") {
                        footer_def = id.clone();
                    }
                    if footer_any.is_none() {
                        footer_any = id;
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    (header_def.or(header_any), footer_def.or(footer_any))
}

/// Parse a referenced part (header/footer) into its block content.
fn part_blocks(
    pkg: &Package,
    rels: &HashMap<String, String>,
    rid: &str,
    styles: &Styles,
    media: &MediaMap,
    numbering: &Numbering,
) -> Option<Vec<Block>> {
    let path = rels.get(rid)?;
    let part = pkg.part(path)?;
    let xml = std::str::from_utf8(&part.data).ok()?;
    parse_document_xml(xml, styles, media, numbering).ok().map(|d| d.blocks)
}

/// Resolve a relationship `Target` (relative to `word/`) to a package path.
fn normalize_rel_target(target: &str) -> String {
    let t = target.trim_start_matches('/');
    if let Some(rest) = t.strip_prefix("../") {
        rest.to_string() // e.g. "../media/x.png" → "media/x.png" (rare)
    } else {
        format!("word/{t}")
    }
}

/// Parse document XML against a resolved style table, media map, and numbering.
pub fn parse_document_xml(
    xml: &str,
    styles: &Styles,
    media: &MediaMap,
    numbering: &Numbering,
) -> Result<Document, DocxError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    let mut page = PageMetrics::us_letter();
    let mut blocks: Vec<Block> = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut tables: Vec<TableB> = Vec::new();
    let mut cur_ext: Option<(f32, f32)> = None;
    let mut counters: Counters = Counters::new();
    // Set when the current paragraph's pPr holds a sectPr (a section break →
    // page break after the paragraph). ponytail: treats every in-pPr section
    // break as next-page; the rarer "continuous" type also breaks here.
    let mut para_sectpr_break = false;
    let mut cur_tab_stops: Vec<f32> = Vec::new();

    // Paragraph-in-progress state.
    let mut style_id: Option<String> = None;
    let mut para_direct = ParaPropsPartial::default();
    let mut list: Option<ListMarker> = None;
    let mut inlines: Vec<Inline> = Vec::new();
    let mut in_para = false;
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
                    b"w:tbl" => tables.push(TableB::default()),
                    b"w:tr" => {
                        if let Some(tb) = tables.last_mut() {
                            tb.cur_row = Some(Vec::new());
                        }
                    }
                    b"w:tc" => {
                        if let Some(tb) = tables.last_mut() {
                            tb.cur_cell = Some(CellB { blocks: Vec::new(), grid_span: 1 });
                        }
                    }
                    b"w:p" => {
                        in_para = true;
                        style_id = None;
                        para_direct = ParaPropsPartial::default();
                        list = None;
                        inlines.clear();
                        run_direct = RunPropsPartial::default();
                        para_sectpr_break = false;
                        cur_tab_stops.clear();
                    }
                    b"w:sectPr" if stack.iter().any(|n| n.as_slice() == b"w:pPr") => {
                        para_sectpr_break = true;
                    }
                    b"w:r" => run_direct = RunPropsPartial::default(),
                    b"w:t" => {
                        in_text = true;
                        text.clear();
                    }
                    _ => {}
                }
                if !handle_table_leaf(&name, &e, &mut tables)
                    && !handle_image_leaf(&name, &e, media, &mut cur_ext, &mut inlines, in_para)
                    && !try_page_break(&name, &e, styles, &style_id, &para_direct, &list, &mut inlines, &mut tables, &mut blocks, numbering, &mut counters, &cur_tab_stops)
                {
                    apply_leaf(&name, &e, &stack, &mut page, &mut style_id, &mut para_direct, &mut run_direct, &mut list, &mut inlines, &mut cur_tab_stops, in_para);
                }
                stack.push(name);
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_vec();
                if name.as_slice() == b"w:p" {
                    let pp = styles.para_for(None);
                    emit_block(Block::Paragraph(Paragraph { props: pp, inlines: vec![] }), &mut tables, &mut blocks);
                } else if !handle_table_leaf(&name, &e, &mut tables)
                    && !handle_image_leaf(&name, &e, media, &mut cur_ext, &mut inlines, in_para)
                    && !try_page_break(&name, &e, styles, &style_id, &para_direct, &list, &mut inlines, &mut tables, &mut blocks, numbering, &mut counters, &cur_tab_stops)
                {
                    apply_leaf(&name, &e, &stack, &mut page, &mut style_id, &mut para_direct, &mut run_direct, &mut list, &mut inlines, &mut cur_tab_stops, in_para);
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
                            // A run inside <w:hyperlink> renders as a link.
                            if stack.iter().any(|n| n.as_slice() == b"w:hyperlink") {
                                rp.color = [0, 0, 238];
                                rp.underline = true;
                            }
                            inlines.push(Inline::Text(TextRun { props: rp, text: std::mem::take(&mut text) }));
                        }
                    }
                    b"w:r" => run_direct = RunPropsPartial::default(),
                    b"w:p" => {
                        let para = build_paragraph(styles, &style_id, &para_direct, &list, &mut inlines, numbering, &mut counters, &cur_tab_stops);
                        emit_block(Block::Paragraph(para), &mut tables, &mut blocks);
                        if para_sectpr_break {
                            emit_block(Block::PageBreak, &mut tables, &mut blocks);
                            para_sectpr_break = false;
                        }
                        in_para = false;
                    }
                    b"w:tc" => {
                        if let Some(tb) = tables.last_mut() {
                            if let Some(cell) = tb.cur_cell.take() {
                                if let Some(row) = tb.cur_row.as_mut() {
                                    row.push(Cell { blocks: cell.blocks, grid_span: cell.grid_span.max(1) });
                                }
                            }
                        }
                    }
                    b"w:tr" => {
                        if let Some(tb) = tables.last_mut() {
                            if let Some(row) = tb.cur_row.take() {
                                tb.rows.push(Row { cells: row });
                            }
                        }
                    }
                    b"w:tbl" => {
                        if let Some(tb) = tables.pop() {
                            let table = Table { rows: tb.rows, col_widths_pt: tb.col_widths };
                            emit_block(Block::Table(table), &mut tables, &mut blocks);
                        }
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

    Ok(Document { page, blocks, header: Vec::new(), footer: Vec::new() })
}

/// Route a finished block into the current table cell, or the document body.
fn emit_block(block: Block, tables: &mut [TableB], blocks: &mut Vec<Block>) {
    if let Some(tb) = tables.last_mut() {
        if let Some(cell) = tb.cur_cell.as_mut() {
            cell.blocks.push(block);
            return;
        }
    }
    blocks.push(block);
}

/// Handle DrawingML image leaves: `wp:extent` (size in EMUs) then `a:blip`
/// (`r:embed` relationship). On a resolvable blip, push an inline image into the
/// current paragraph. Returns true if consumed.
fn handle_image_leaf(
    name: &[u8],
    e: &BytesStart,
    media: &MediaMap,
    cur_ext: &mut Option<(f32, f32)>,
    inlines: &mut Vec<Inline>,
    in_para: bool,
) -> bool {
    match name {
        b"wp:extent" => {
            if let (Some(cx), Some(cy)) = (attr_f32(e, b"cx"), attr_f32(e, b"cy")) {
                *cur_ext = Some((emu_to_pt(cx), emu_to_pt(cy)));
            }
            true
        }
        b"a:blip" => {
            if let Some(rid) = attr_str(e, b"r:embed") {
                if let Some(bytes) = media.get(&rid) {
                    let (w, h) = cur_ext.take().unwrap_or((96.0, 96.0));
                    if in_para {
                        inlines.push(Inline::Image(ImageRef { width_pt: w, height_pt: h, data: bytes.clone() }));
                    }
                }
            }
            true
        }
        _ => false,
    }
}

/// Handle table-grid leaves (`w:gridCol` widths, `w:gridSpan`). Returns true if
/// consumed.
fn handle_table_leaf(name: &[u8], e: &BytesStart, tables: &mut [TableB]) -> bool {
    match name {
        b"w:gridCol" => {
            if let Some(tb) = tables.last_mut() {
                if let Some(w) = attr_f32(e, b"w:w") {
                    tb.col_widths.push(twips_to_pt(w));
                }
            }
            true
        }
        b"w:gridSpan" => {
            if let Some(tb) = tables.last_mut() {
                if let Some(cell) = tb.cur_cell.as_mut() {
                    if let Some(v) = attr_f32(e, b"w:val") {
                        cell.grid_span = v as u32;
                    }
                }
            }
            true
        }
        _ => false,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_paragraph(
    styles: &Styles,
    style_id: &Option<String>,
    para_direct: &ParaPropsPartial,
    list: &Option<ListMarker>,
    inlines: &mut Vec<Inline>,
    numbering: &Numbering,
    counters: &mut Counters,
    tab_stops: &[f32],
) -> Paragraph {
    let mut pp = styles.para_for(style_id.as_deref());
    apply_para_partial(&mut pp, para_direct);
    pp.list = list.clone();
    if let Some(lm) = list {
        pp.list_marker = Some(compute_marker(numbering, counters, lm.num_id, lm.level));
    }
    pp.tab_stops = tab_stops.to_vec();
    pp.tab_stops.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    pp.style_id = style_id.clone();
    Paragraph { props: pp, inlines: std::mem::take(inlines) }
}

/// Resolve the marker string for a list item, advancing ordered counters.
fn compute_marker(numbering: &Numbering, counters: &mut Counters, num_id: i32, level: u8) -> String {
    let Some(fmt) = numbering.level(num_id, level) else {
        return "\u{2022}".to_string();
    };
    if !fmt.ordered {
        return "\u{2022}".to_string();
    }
    let next = counters.get(&(num_id, level)).copied().unwrap_or(fmt.start - 1) + 1;
    counters.insert((num_id, level), next);
    // Restarting a shallower level resets the deeper ones.
    for d in (level + 1)..=8u8 {
        counters.remove(&(num_id, d));
    }
    let mut s = fmt.lvl_text.clone();
    for k in 0..=level {
        let val = counters.get(&(num_id, k)).copied().unwrap_or(1);
        s = s.replace(&format!("%{}", k + 1), &val.to_string());
    }
    if s.is_empty() {
        s.push('\u{2022}');
    }
    s
}

#[allow(clippy::too_many_arguments)]
fn try_page_break(
    name: &[u8],
    e: &BytesStart,
    styles: &Styles,
    style_id: &Option<String>,
    para_direct: &ParaPropsPartial,
    list: &Option<ListMarker>,
    inlines: &mut Vec<Inline>,
    tables: &mut Vec<TableB>,
    blocks: &mut Vec<Block>,
    numbering: &Numbering,
    counters: &mut Counters,
    tab_stops: &[f32],
) -> bool {
    // Only a manual page break is a hard break. <w:lastRenderedPageBreak/> is
    // just a hint of where Word last broke; honoring it double-breaks against our
    // own height-based pagination (blank pages), so it is deliberately ignored.
    if name != b"w:br" || attr_str(e, b"w:type").as_deref() != Some("page") {
        return false;
    }
    let para = build_paragraph(styles, style_id, para_direct, list, inlines, numbering, counters, tab_stops);
    emit_block(Block::Paragraph(para), tables, blocks);
    emit_block(Block::PageBreak, tables, blocks);
    true
}

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
    tab_stops: &mut Vec<f32>,
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
        // A tab-stop definition inside <w:tabs> (not a tab character).
        b"w:tab" if has(b"w:tabs") => {
            if let Some(pos) = attr_f32(e, b"w:pos") {
                tab_stops.push(twips_to_pt(pos));
            }
        }
        // A tab character inside a run.
        b"w:tab" if has(b"w:r") => inlines.push(Inline::Tab),
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
            _ => panic!("expected paragraph"),
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
        let doc = parse_document_xml(xml, &Styles::empty(), &MediaMap::new(), &Numbering::empty()).expect("parse");
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
        let doc = parse_document_xml(xml, &styles, &MediaMap::new(), &Numbering::empty()).expect("parse");
        let Inline::Text(t) = &first_para(&doc).inlines[0] else { panic!() };
        assert_eq!(t.props.size_pt, 24.0);
    }

    #[test]
    fn explicit_page_break_produces_block() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:p><w:r><w:t>Before</w:t></w:r></w:p>
          <w:p><w:r><w:br w:type="page"/></w:r></w:p>
          <w:p><w:r><w:t>After</w:t></w:r></w:p>
          </w:body></w:document>"#;
        let doc = parse_document_xml(xml, &Styles::empty(), &MediaMap::new(), &Numbering::empty()).expect("parse");
        assert!(doc.blocks.iter().any(|b| matches!(b, Block::PageBreak)));
    }

    #[test]
    fn section_break_produces_page_break() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:p><w:r><w:t>Section one</w:t></w:r></w:p>
          <w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr></w:p>
          <w:p><w:r><w:t>Section two</w:t></w:r></w:p>
          <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
        </w:body></w:document>"#;
        let doc = parse_document_xml(xml, &Styles::empty(), &MediaMap::new(), &Numbering::empty()).expect("parse");
        assert!(
            doc.blocks.iter().any(|b| matches!(b, Block::PageBreak)),
            "in-paragraph sectPr must produce a page break"
        );
    }

    #[test]
    fn parses_table_rows_cells_and_grid() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:tbl>
          <w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>
          <w:tr>
            <w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>
            <w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>
          </w:tr>
          <w:tr>
            <w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc>
          </w:tr>
        </w:tbl></w:body></w:document>"#;
        let doc = parse_document_xml(xml, &Styles::empty(), &MediaMap::new(), &Numbering::empty()).expect("parse");
        let Block::Table(t) = &doc.blocks[0] else { panic!("expected table") };
        assert_eq!(t.col_widths_pt.len(), 2);
        assert_eq!(t.col_widths_pt[0], twips_to_pt(2880.0)); // 144pt
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0].cells.len(), 2);
        let Block::Paragraph(p) = &t.rows[0].cells[0].blocks[0] else { panic!() };
        assert_eq!(p.inlines.len(), 1);
    }
}
