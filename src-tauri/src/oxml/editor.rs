//! Lossless text editing of a `.docx`: rewrite the text inside `w:t` elements of
//! `word/document.xml` while leaving every other part and byte untouched, so the
//! saved file round-trips in Word. This is the spine of editing — the editable
//! surface (find/replace now, richer edits later) grows on top of it.

use std::io::{Cursor, Write};

use quick_xml::events::{BytesText, Event};
use quick_xml::reader::Reader;
use quick_xml::Writer;

use super::{Package, PackageError};

/// A run as edited in the WYSIWYG surface, for rich (formatting-preserving) save.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RunEdit {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    /// "RRGGBB" hex (with or without leading '#').
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub size_pt: Option<f32>,
}

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error("package error: {0}")]
    Package(#[from] PackageError),
    #[error("xml error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("missing word/document.xml")]
    MissingDocument,
    #[error("unsupported: {0}")]
    Unsupported(String),
}

/// A paragraph as edited in the WYSIWYG surface (for structural/full-body save).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ParaEdit {
    pub runs: Vec<RunEdit>,
    #[serde(default)]
    pub align: Option<String>,
}

/// One top-level body block in the editor's save order. This is the frontend's
/// view of the document after editing: the ordered list of `<p>`/`<table>`
/// surfaces, each tagged with how to reproduce it. See
/// [`reconcile_body_in_package`].
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BlockEdit {
    /// An untouched block — re-emit its original source bytes verbatim (works for
    /// paragraphs, tables, or anything else we captured). `orig` indexes the
    /// original block list.
    Verbatim { orig: usize },
    /// A paragraph. `orig = Some(i)` preserves block `i`'s `<w:p>` attributes and
    /// `pPr` (only the runs change); `None` is a newly inserted paragraph.
    Para {
        #[serde(default)]
        orig: Option<usize>,
        runs: Vec<RunEdit>,
        #[serde(default)]
        align: Option<String>,
    },
}

/// A captured original top-level body block: its byte span in `document.xml` and
/// whether it is a table (so a stray paragraph edit can't corrupt it).
struct CapturedBlock {
    start: usize,
    end: usize,
    is_table: bool,
}

/// Replace every occurrence of `find` with `replace` in the document body text,
/// returning the repackaged `.docx` bytes. Only `w:t` text nodes change.
///
/// Matches are confined to a single `w:t` node, so text Word split across runs
/// won't match across the boundary — acceptable for basic editing.
pub fn replace_in_package(bytes: &[u8], find: &str, replace: &str) -> Result<Vec<u8>, EditError> {
    let mut pkg = Package::load(bytes)?;
    if find.is_empty() {
        return Ok(pkg.save()?); // no-op, but still a clean round trip
    }
    let idx = pkg
        .parts
        .iter()
        .position(|p| p.name == "word/document.xml")
        .ok_or(EditError::MissingDocument)?;
    let xml = std::str::from_utf8(&pkg.parts[idx].data).map_err(|_| EditError::MissingDocument)?;
    let new_xml = rewrite_text(xml, |t| t.replace(find, replace))?;
    pkg.parts[idx].data = new_xml.into_bytes();
    Ok(pkg.save()?)
}

/// The concatenated text of each top-level body paragraph (paragraphs inside
/// tables are skipped). Index = position in this list, matching
/// [`set_paragraph_in_package`].
pub fn paragraph_texts_in_package(bytes: &[u8]) -> Result<Vec<String>, EditError> {
    let pkg = Package::load(bytes)?;
    let part = pkg.part("word/document.xml").ok_or(EditError::MissingDocument)?;
    let xml = std::str::from_utf8(&part.data).map_err(|_| EditError::MissingDocument)?;

    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut tbl_depth = 0i32;
    let mut in_p = false;
    let mut in_t = false;
    let mut cur = String::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match e.name().as_ref() {
                b"w:tbl" => tbl_depth += 1,
                b"w:p" if tbl_depth == 0 => {
                    in_p = true;
                    cur.clear();
                }
                b"w:t" if in_p => in_t = true,
                _ => {}
            },
            Event::Empty(e) if e.name().as_ref() == b"w:p" && tbl_depth == 0 => {
                out.push(String::new());
            }
            Event::Text(e) if in_t => {
                cur.push_str(&e.unescape().unwrap_or_default());
            }
            Event::End(e) => match e.name().as_ref() {
                b"w:tbl" => tbl_depth -= 1,
                b"w:t" => in_t = false,
                b"w:p" if tbl_depth == 0 && in_p => {
                    out.push(std::mem::take(&mut cur));
                    in_p = false;
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// Replace the text of top-level body paragraph `index` with `text`: the new
/// text goes into the paragraph's first `w:t`, later `w:t`s are emptied.
/// Lossless for everything except intra-paragraph run formatting (which collapses
/// to the first run). Returns the repackaged `.docx` bytes.
pub fn set_paragraph_in_package(bytes: &[u8], index: usize, text: &str) -> Result<Vec<u8>, EditError> {
    let mut pkg = Package::load(bytes)?;
    let idx = pkg
        .parts
        .iter()
        .position(|p| p.name == "word/document.xml")
        .ok_or(EditError::MissingDocument)?;
    let xml = std::str::from_utf8(&pkg.parts[idx].data).map_err(|_| EditError::MissingDocument)?;

    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();
    let mut tbl_depth = 0i32;
    let mut p_index = 0usize;
    let mut in_target = false;
    let mut in_t = false;
    let mut first_t_done = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                match e.name().as_ref() {
                    b"w:tbl" => tbl_depth += 1,
                    b"w:p" if tbl_depth == 0 => {
                        in_target = p_index == index;
                        p_index += 1;
                        first_t_done = false;
                    }
                    b"w:t" if in_target => in_t = true,
                    _ => {}
                }
                writer.write_event(Event::Start(e))?;
            }
            Event::End(e) => {
                match e.name().as_ref() {
                    b"w:tbl" => tbl_depth -= 1,
                    b"w:t" => in_t = false,
                    b"w:p" if tbl_depth == 0 => in_target = false,
                    _ => {}
                }
                writer.write_event(Event::End(e))?;
            }
            Event::Text(_) if in_t => {
                // First w:t of the target paragraph carries all the new text;
                // the original text is dropped.
                let replacement = if first_t_done { "" } else { text };
                first_t_done = true;
                writer.write_event(Event::Text(BytesText::new(replacement)))?;
            }
            Event::Eof => break,
            other => writer.write_event(other)?,
        }
        buf.clear();
    }

    pkg.parts[idx].data = writer.into_inner().into_inner();
    Ok(pkg.save()?)
}

/// Replace top-level body paragraph `index`'s runs with `runs`, preserving the
/// paragraph's `pPr` and every other paragraph/part. Formatting-preserving (the
/// new runs carry bold/italic/underline/size/color), so a WYSIWYG edit round-
/// trips its styling. Other run-level content of the edited paragraph
/// (bookmarks, fields, hyperlinks) is dropped — acceptable for an edited
/// paragraph; untouched paragraphs stay byte-identical.
pub fn set_paragraph_runs_in_package(
    bytes: &[u8],
    index: usize,
    runs: &[RunEdit],
    align: Option<&str>,
) -> Result<Vec<u8>, EditError> {
    let mut pkg = Package::load(bytes)?;
    let idx = pkg
        .parts
        .iter()
        .position(|p| p.name == "word/document.xml")
        .ok_or(EditError::MissingDocument)?;
    let xml = std::str::from_utf8(&pkg.parts[idx].data).map_err(|_| EditError::MissingDocument)?;

    let mut reader = Reader::from_str(xml);
    let mut main = Writer::new(Cursor::new(Vec::new()));
    let mut ppw = Writer::new(Cursor::new(Vec::new())); // captures the target's pPr
    let mut buf = Vec::new();
    let mut tbl_depth = 0i32;
    let mut p_index = 0usize;
    let mut in_target = false;
    let mut in_pp = 0i32;
    let mut skip_depth = 0i32;
    let mut emitted = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let n = e.name().as_ref().to_vec();
                if !in_target {
                    if n == b"w:tbl" {
                        tbl_depth += 1;
                    }
                    if n == b"w:p" && tbl_depth == 0 {
                        in_target = p_index == index;
                        p_index += 1;
                        if in_target {
                            ppw = Writer::new(Cursor::new(Vec::new()));
                            in_pp = 0;
                            skip_depth = 0;
                            emitted = false;
                        }
                    }
                    main.write_event(Event::Start(e))?;
                } else if in_pp > 0 {
                    in_pp += 1;
                    ppw.write_event(Event::Start(e))?;
                } else if n == b"w:pPr" {
                    in_pp = 1;
                    ppw.write_event(Event::Start(e))?;
                } else if skip_depth > 0 {
                    skip_depth += 1;
                } else {
                    if !emitted {
                        emit_runs(&mut main, &ppw, runs, align)?;
                        emitted = true;
                    }
                    skip_depth = 1;
                }
            }
            Event::End(e) => {
                let n = e.name().as_ref().to_vec();
                if !in_target {
                    if n == b"w:tbl" {
                        tbl_depth -= 1;
                    }
                    main.write_event(Event::End(e))?;
                } else if in_pp > 0 {
                    ppw.write_event(Event::End(e))?;
                    in_pp -= 1;
                } else if skip_depth > 0 {
                    skip_depth -= 1;
                } else if n == b"w:p" {
                    if !emitted {
                        emit_runs(&mut main, &ppw, runs, align)?;
                        emitted = true;
                    }
                    main.write_event(Event::End(e))?;
                    in_target = false;
                }
            }
            Event::Empty(e) => {
                if !in_target {
                    main.write_event(Event::Empty(e))?;
                } else if in_pp > 0 {
                    ppw.write_event(Event::Empty(e))?;
                } else if skip_depth == 0 {
                    if !emitted {
                        emit_runs(&mut main, &ppw, runs, align)?;
                        emitted = true;
                    }
                }
            }
            Event::Text(e) => {
                if !in_target {
                    main.write_event(Event::Text(e))?;
                } else if in_pp > 0 {
                    ppw.write_event(Event::Text(e))?;
                }
            }
            Event::Eof => break,
            other => {
                if !in_target {
                    main.write_event(other)?;
                }
            }
        }
        buf.clear();
    }

    pkg.parts[idx].data = main.into_inner().into_inner();
    Ok(pkg.save()?)
}

fn emit_runs(
    main: &mut Writer<Cursor<Vec<u8>>>,
    ppw: &Writer<Cursor<Vec<u8>>>,
    runs: &[RunEdit],
    align: Option<&str>,
) -> Result<(), EditError> {
    let pp_bytes = ppw.get_ref().get_ref();
    let ppr = build_ppr(pp_bytes, align);
    main.get_mut().write_all(&ppr)?;
    for r in runs {
        write_run(main, r)?;
    }
    Ok(())
}

/// Return the paragraph's `pPr` bytes, setting/replacing `w:jc` when `align` is
/// given (creating a `pPr` if there wasn't one).
fn build_ppr(pp_bytes: &[u8], align: Option<&str>) -> Vec<u8> {
    let Some(a) = align else {
        return pp_bytes.to_vec();
    };
    let val = match a {
        "center" => "center",
        "right" => "right",
        "justify" | "both" => "both",
        _ => "left",
    };
    let mut s = String::from_utf8_lossy(pp_bytes).into_owned();
    // Drop any existing <w:jc .../>.
    while let Some(start) = s.find("<w:jc") {
        if let Some(rel) = s[start..].find("/>") {
            s.replace_range(start..start + rel + 2, "");
        } else {
            break;
        }
    }
    let jc = format!("<w:jc w:val=\"{val}\"/>");
    if s.is_empty() {
        s = format!("<w:pPr>{jc}</w:pPr>");
    } else if let Some(open_end) = s.find('>') {
        s.insert_str(open_end + 1, &jc);
    }
    s.into_bytes()
}

fn write_run(main: &mut Writer<Cursor<Vec<u8>>>, r: &RunEdit) -> Result<(), EditError> {
    main.get_mut().write_all(run_xml(r).as_bytes())?;
    Ok(())
}

/// Serialize one run to `<w:r>…</w:r>` with its run properties.
fn run_xml(r: &RunEdit) -> String {
    let mut s = String::from("<w:r>");
    if r.bold || r.italic || r.underline || r.color.is_some() || r.size_pt.is_some() {
        s.push_str("<w:rPr>");
        if r.bold {
            s.push_str("<w:b/>");
        }
        if r.italic {
            s.push_str("<w:i/>");
        }
        if r.underline {
            s.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(sz) = r.size_pt {
            s.push_str(&format!("<w:sz w:val=\"{}\"/>", (sz * 2.0).round() as i32));
        }
        if let Some(c) = &r.color {
            s.push_str(&format!("<w:color w:val=\"{}\"/>", c.trim_start_matches('#')));
        }
        s.push_str("</w:rPr>");
    }
    s.push_str("<w:t xml:space=\"preserve\">");
    s.push_str(&xml_escape(&r.text));
    s.push_str("</w:t></w:r>");
    s
}

fn jc_val(align: &str) -> &'static str {
    match align {
        "center" => "center",
        "right" => "right",
        "justify" | "both" => "both",
        _ => "left",
    }
}

/// Regenerate the whole `<w:body>` from `paras` (for structural edits: adding/
/// removing/reordering paragraphs), preserving the document root (namespaces)
/// and the body's trailing `sectPr` (page size/margins). Refuses if the body
/// contains a table, to avoid silently dropping it.
///
/// This rebuilds the body from the visible runs only, so paragraph styles,
/// bookmarks, fields, and other body content are not preserved — it is the
/// heavier save used only when paragraph structure changed.
pub fn save_body_in_package(bytes: &[u8], paras: &[ParaEdit]) -> Result<Vec<u8>, EditError> {
    let mut pkg = Package::load(bytes)?;
    let idx = pkg
        .parts
        .iter()
        .position(|p| p.name == "word/document.xml")
        .ok_or(EditError::MissingDocument)?;
    let xml = std::str::from_utf8(&pkg.parts[idx].data).map_err(|_| EditError::MissingDocument)?;

    let body_open = xml.find("<w:body").ok_or(EditError::MissingDocument)?;
    let body_open_end = body_open + xml[body_open..].find('>').ok_or(EditError::MissingDocument)? + 1;
    let body_close = xml.rfind("</w:body>").ok_or(EditError::MissingDocument)?;
    let middle = &xml[body_open_end..body_close];

    if middle.contains("<w:tbl") {
        return Err(EditError::Unsupported(
            "structural editing of documents with tables is not supported yet".into(),
        ));
    }

    // Preserve the trailing body-level sectPr (page geometry).
    let sectpr = middle
        .rfind("<w:sectPr")
        .map(|s| {
            let rest = &middle[s..];
            if let Some(e) = rest.find("</w:sectPr>") {
                &rest[..e + "</w:sectPr>".len()]
            } else if let Some(e) = rest.find("/>") {
                &rest[..e + 2]
            } else {
                ""
            }
        })
        .unwrap_or("");

    let mut body = String::new();
    body.push_str(&xml[..body_open_end]);
    for p in paras {
        body.push_str("<w:p>");
        if let Some(a) = &p.align {
            body.push_str(&format!("<w:pPr><w:jc w:val=\"{}\"/></w:pPr>", jc_val(a)));
        }
        for r in &p.runs {
            body.push_str(&run_xml(r));
        }
        body.push_str("</w:p>");
    }
    body.push_str(sectpr);
    body.push_str(&xml[body_close..]);

    pkg.parts[idx].data = body.into_bytes();
    Ok(pkg.save()?)
}

/// Structure-preserving save. Rebuilds `<w:body>` from `blocks` (the editor's
/// ordered view of the document), re-emitting every untouched block **byte-for-
/// byte** from the original source and re-serializing only the paragraphs that
/// changed. Handles add / remove / reorder of paragraphs and preserves tables,
/// paragraph styles, and body geometry (trailing `sectPr`) — the lossless
/// foundation the editor's save rides on.
///
/// Limitations: an edited paragraph's own run-level bookmarks / fields /
/// hyperlink targets collapse to plain runs (its `pPr` survives); body-level
/// structured-document-tags / bookmarks (rare — Word keeps those inside
/// paragraphs) are not preserved across a structural edit.
pub fn reconcile_body_in_package(bytes: &[u8], blocks: &[BlockEdit]) -> Result<Vec<u8>, EditError> {
    let mut pkg = Package::load(bytes)?;
    let idx = pkg
        .parts
        .iter()
        .position(|p| p.name == "word/document.xml")
        .ok_or(EditError::MissingDocument)?;
    let xml = std::str::from_utf8(&pkg.parts[idx].data)
        .map_err(|_| EditError::MissingDocument)?
        .to_owned();

    let cap = capture_body(&xml)?;

    let mut body = String::with_capacity(xml.len());
    body.push_str(&xml[..cap.body_open_end]);
    for be in blocks {
        match be {
            BlockEdit::Verbatim { orig } => {
                let c = cap.blocks.get(*orig).ok_or_else(|| {
                    EditError::Unsupported(format!("verbatim block {orig} out of range"))
                })?;
                body.push_str(&xml[c.start..c.end]);
            }
            BlockEdit::Para { orig, runs, align } => {
                match orig {
                    Some(i) => {
                        let c = cap.blocks.get(*i).ok_or_else(|| {
                            EditError::Unsupported(format!("paragraph block {i} out of range"))
                        })?;
                        // A table can't be re-serialized as a paragraph; keep it.
                        if c.is_table {
                            body.push_str(&xml[c.start..c.end]);
                        } else {
                            let (start_tag, ppr) = split_paragraph(&xml[c.start..c.end]);
                            emit_paragraph(&mut body, &start_tag, ppr.as_bytes(), runs, align.as_deref());
                        }
                    }
                    None => emit_paragraph(&mut body, "<w:p>", b"", runs, align.as_deref()),
                }
            }
        }
    }
    body.push_str(&cap.sectpr);
    body.push_str(&xml[cap.body_close..]);

    pkg.parts[idx].data = body.into_bytes();
    Ok(pkg.save()?)
}

/// Captured original body: byte-slice offsets, the top-level blocks, and the
/// trailing body-level `sectPr`.
struct BodyCapture {
    body_open_end: usize,
    body_close: usize,
    blocks: Vec<CapturedBlock>,
    sectpr: String,
}

/// Walk `document.xml`, recording each direct child of `<w:body>` (`w:p` / `w:tbl`
/// as blocks, the trailing `w:sectPr` kept aside) by exact byte span.
fn capture_body(xml: &str) -> Result<BodyCapture, EditError> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();

    let mut in_body = false;
    let mut child_open = 0i32; // nesting depth within the current direct child
    let mut cur_start = 0usize;
    let mut cur_name: Vec<u8> = Vec::new();

    let mut body_open_end = 0usize;
    let mut body_close = xml.len();
    let mut blocks: Vec<CapturedBlock> = Vec::new();
    let mut sectpr = String::new();

    let finish = |name: &[u8], start: usize, end: usize, blocks: &mut Vec<CapturedBlock>, sectpr: &mut String| {
        match name {
            b"w:p" | b"w:tbl" => blocks.push(CapturedBlock { start, end, is_table: name == b"w:tbl" }),
            b"w:sectPr" => *sectpr = xml[start..end].to_string(),
            _ => {} // body-level bookmark / sdt / etc.: dropped (rare)
        }
    };

    loop {
        let pos = reader.buffer_position() as usize;
        let ev = reader.read_event_into(&mut buf)?;
        let after = reader.buffer_position() as usize;
        match ev {
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                if !in_body && name == b"w:body" {
                    in_body = true;
                    body_open_end = after;
                } else if in_body {
                    if child_open == 0 {
                        cur_start = pos;
                        cur_name = name;
                        child_open = 1;
                    } else {
                        child_open += 1;
                    }
                }
            }
            Event::Empty(e) => {
                if in_body && child_open == 0 {
                    let name = e.name().as_ref().to_vec();
                    finish(&name, pos, after, &mut blocks, &mut sectpr);
                }
            }
            Event::End(e) => {
                let name = e.name().as_ref().to_vec();
                if in_body && child_open == 0 && name == b"w:body" {
                    body_close = pos;
                    in_body = false;
                } else if in_body && child_open > 0 {
                    child_open -= 1;
                    if child_open == 0 {
                        let cn = std::mem::take(&mut cur_name);
                        finish(&cn, cur_start, after, &mut blocks, &mut sectpr);
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if body_open_end == 0 {
        return Err(EditError::MissingDocument);
    }
    Ok(BodyCapture { body_open_end, body_close, blocks, sectpr })
}

/// Emit a `<w:p>`: the (open) start tag, its `pPr` (with `align` applied), then
/// the edited runs.
fn emit_paragraph(body: &mut String, start_tag: &str, ppr: &[u8], runs: &[RunEdit], align: Option<&str>) {
    body.push_str(start_tag);
    body.push_str(&String::from_utf8_lossy(&build_ppr(ppr, align)));
    for r in runs {
        body.push_str(&run_xml(r));
    }
    body.push_str("</w:p>");
}

/// Split a captured `<w:p …>…</w:p>` (or self-closing `<w:p …/>`) into its
/// re-openable start tag `<w:p …>` and its `pPr` bytes (`""` if none). A
/// top-level paragraph never contains a nested `pPr`, so the first match is the
/// paragraph's own.
fn split_paragraph(block: &str) -> (String, String) {
    let open_end = block.find('>').unwrap_or(block.len().saturating_sub(1));
    let start_tag = if block[..open_end].ends_with('/') {
        // "<w:p …/>" → "<w:p …>"
        format!("{}>", block[..open_end].trim_end_matches('/').trim_end())
    } else {
        block[..=open_end.min(block.len() - 1)].to_string()
    };
    (start_tag, extract_ppr(block))
}

/// The paragraph's `<w:pPr>…</w:pPr>` (or self-closing `<w:pPr/>`) bytes, or "".
fn extract_ppr(block: &str) -> String {
    let start = match block.find("<w:pPr>").or_else(|| block.find("<w:pPr ")).or_else(|| block.find("<w:pPr/>")) {
        Some(s) => s,
        None => return String::new(),
    };
    let rest = &block[start..];
    if let Some(e) = rest.find("</w:pPr>") {
        return rest[..e + "</w:pPr>".len()].to_string();
    }
    if let Some(e) = rest.find("/>") {
        return rest[..e + 2].to_string();
    }
    String::new()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Echo `document.xml`, transforming the text inside each `w:t` with `f`.
fn rewrite_text(xml: &str, f: impl Fn(&str) -> String) -> Result<String, EditError> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();
    let mut in_t = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                if e.name().as_ref() == b"w:t" {
                    in_t = true;
                }
                writer.write_event(Event::Start(e))?;
            }
            Event::End(e) => {
                if e.name().as_ref() == b"w:t" {
                    in_t = false;
                }
                writer.write_event(Event::End(e))?;
            }
            Event::Text(e) if in_t => {
                let original = e.unescape().unwrap_or_default().into_owned();
                let replaced = f(&original);
                writer.write_event(Event::Text(BytesText::new(&replaced)))?;
            }
            Event::Eof => break,
            other => writer.write_event(other)?,
        }
        buf.clear();
    }

    let bytes = writer.into_inner().into_inner();
    String::from_utf8(bytes).map_err(|_| EditError::MissingDocument)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn docx_with(document_xml: &str) -> Vec<u8> {
        let parts: &[(&str, &[u8])] = &[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", document_xml.as_bytes()),
        ];
        let mut buf = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (name, data) in parts {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        buf
    }

    fn document_text(bytes: &[u8]) -> String {
        let pkg = Package::load(bytes).unwrap();
        let part = pkg.part("word/document.xml").unwrap();
        String::from_utf8(part.data.clone()).unwrap()
    }

    #[test]
    fn replaces_only_w_t_text() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>"#;
        let out = replace_in_package(&docx_with(xml), "world", "Qyra").unwrap();
        let text = document_text(&out);
        assert!(text.contains("Hello Qyra"));
        // Structure/tag names preserved.
        assert!(text.contains("<w:t>") && text.contains("<w:document"));
    }

    #[test]
    fn rewrites_paragraph_runs_with_formatting() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>old</w:t></w:r></w:p>
          <w:p><w:r><w:t>keep</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let runs = vec![
            RunEdit { text: "New ".into(), bold: true, italic: false, underline: false, color: None, size_pt: None },
            RunEdit { text: "text".into(), bold: false, italic: true, underline: false, color: None, size_pt: None },
        ];
        let out = set_paragraph_runs_in_package(&docx_with(xml), 0, &runs, None).unwrap();
        let text = document_text(&out);
        assert!(text.contains("<w:b/>"), "bold run prop emitted");
        assert!(text.contains("<w:i/>"), "italic run prop emitted");
        assert!(text.contains("New "), "new text present");
        assert!(text.contains("<w:jc w:val=\"center\"/>"), "pPr preserved");
        assert!(!text.contains(">old<"), "old run text replaced");
        assert!(text.contains("keep"), "other paragraph untouched");
    }

    #[test]
    fn full_body_save_rebuilds_paragraphs_and_keeps_sectpr() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>one</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>"#;
        let paras = vec![
            ParaEdit { runs: vec![RunEdit { text: "one".into(), bold: false, italic: false, underline: false, color: None, size_pt: None }], align: None },
            ParaEdit { runs: vec![RunEdit { text: "two".into(), bold: true, italic: false, underline: false, color: None, size_pt: None }], align: Some("center".into()) },
        ];
        let out = save_body_in_package(&docx_with(xml), &paras).unwrap();
        let text = document_text(&out);
        assert_eq!(text.matches("<w:p>").count(), 2, "two paragraphs rebuilt");
        assert!(text.contains("two"));
        assert!(text.contains("<w:jc w:val=\"center\"/>"), "alignment on new paragraph");
        assert!(text.contains("<w:pgSz"), "trailing sectPr preserved");
    }

    #[test]
    fn full_body_save_refuses_tables() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>"#;
        assert!(matches!(save_body_in_package(&docx_with(xml), &[]), Err(EditError::Unsupported(_))));
    }

    #[test]
    fn sets_paragraph_alignment() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>"#;
        let runs = vec![RunEdit { text: "x".into(), bold: false, italic: false, underline: false, color: None, size_pt: None }];
        let out = set_paragraph_runs_in_package(&docx_with(xml), 0, &runs, Some("center")).unwrap();
        assert!(document_text(&out).contains("<w:jc w:val=\"center\"/>"), "alignment injected into pPr");
    }

    fn run(text: &str, bold: bool) -> RunEdit {
        RunEdit { text: text.into(), bold, italic: false, underline: false, color: None, size_pt: None }
    }

    #[test]
    fn reconcile_all_verbatim_is_byte_identical() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>"#;
        let out = reconcile_body_in_package(
            &docx_with(xml),
            &[BlockEdit::Verbatim { orig: 0 }, BlockEdit::Verbatim { orig: 1 }],
        )
        .unwrap();
        // The lossless gate: an all-verbatim reconcile reproduces document.xml exactly.
        assert_eq!(document_text(&out), xml);
    }

    #[test]
    fn reconcile_edits_paragraph_keeps_table_verbatim() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>old</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>"#;
        let edit = vec![
            BlockEdit::Para { orig: Some(0), runs: vec![run("New", true)], align: None },
            BlockEdit::Verbatim { orig: 1 },
        ];
        let out = reconcile_body_in_package(&docx_with(xml), &edit).unwrap();
        let text = document_text(&out);
        assert!(text.contains("<w:jc w:val=\"center\"/>"), "edited paragraph's pPr preserved");
        assert!(text.contains("<w:b/>") && text.contains("New"), "new bold run emitted");
        assert!(!text.contains(">old<"), "old run text replaced");
        assert!(
            text.contains("<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"),
            "table re-emitted byte-for-byte"
        );
    }

    #[test]
    fn reconcile_reorders_inserts_and_deletes() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>first</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p></w:body></w:document>"#;
        // Keep the second paragraph, drop the first, append a new right-aligned one.
        let edit = vec![
            BlockEdit::Verbatim { orig: 1 },
            BlockEdit::Para { orig: None, runs: vec![run("fresh", false)], align: Some("right".into()) },
        ];
        let out = reconcile_body_in_package(&docx_with(xml), &edit).unwrap();
        let text = document_text(&out);
        assert!(!text.contains("first"), "deleted paragraph is gone");
        assert!(text.find("second").unwrap() < text.find("fresh").unwrap(), "order preserved");
        assert!(text.contains("<w:jc w:val=\"right\"/>"), "inserted paragraph alignment applied");
    }

    #[test]
    fn reconcile_preserves_self_closing_paragraph() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p/><w:sectPr/></w:body></w:document>"#;
        let out = reconcile_body_in_package(&docx_with(xml), &[BlockEdit::Verbatim { orig: 0 }]).unwrap();
        assert_eq!(document_text(&out), xml, "self-closing paragraph + sectPr reproduced exactly");
    }

    #[test]
    fn does_not_touch_tags_matching_query() {
        // "w:p" appears as a tag name; replacing text "p" must not corrupt tags.
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>apple</w:t></w:r></w:p></w:body></w:document>"#;
        let out = replace_in_package(&docx_with(xml), "p", "P").unwrap();
        let text = document_text(&out);
        assert!(text.contains("aPPle"));
        assert!(text.contains("<w:p>"), "paragraph tag must be intact");
    }
}
