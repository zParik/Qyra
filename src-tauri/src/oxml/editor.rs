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
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RunEdit {
    pub text: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default)]
    pub strike: bool,
    /// "RRGGBB" hex (with or without leading '#').
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub size_pt: Option<f32>,
    /// Font family (`w:rFonts`).
    #[serde(default)]
    pub font: Option<String>,
    /// Highlight fill, "RRGGBB".
    #[serde(default)]
    pub highlight: Option<String>,
    /// "super" | "sub" (`w:vertAlign`).
    #[serde(default)]
    pub vert: Option<String>,
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
    /// `pPr` (only the runs change); `None` is a newly inserted paragraph. `style`
    /// sets/replaces `w:pStyle` (paragraph style dropdown).
    Para {
        #[serde(default)]
        orig: Option<usize>,
        runs: Vec<RunEdit>,
        #[serde(default)]
        align: Option<String>,
        #[serde(default)]
        style: Option<String>,
        /// Left indent in points.
        #[serde(default)]
        indent: Option<f32>,
        /// Line spacing as a multiple of a single line.
        #[serde(default)]
        line: Option<f32>,
    },
    /// A table. `orig = Some(i)` reuses block `i`'s `tblPr`, column widths, per-row
    /// `trPr`, and per-cell `tcPr` from the source; `cols` is the current column
    /// count (grid regenerated to match) and `rows` the current grid.
    Table {
        #[serde(default)]
        orig: Option<usize>,
        cols: usize,
        rows: Vec<RowEdit>,
    },
}

/// One row in an edited table. `orig_row` maps to the source row for `trPr` reuse.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RowEdit {
    #[serde(default)]
    pub orig_row: Option<usize>,
    pub cells: Vec<CellEdit>,
}

/// One cell in an edited table.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CellEdit {
    /// Untouched cell — re-emit its original `<w:tc>` bytes (keeps shading, borders,
    /// nested content, everything).
    Verbatim { orig_row: usize, orig_col: usize },
    /// Changed / new cell — rebuild `<w:tc>` from the reused `tcPr` (when
    /// `orig_row`/`orig_col` are set) plus the current span/merge/shading/border and
    /// paragraph content.
    Cell {
        #[serde(default)]
        orig_row: Option<usize>,
        #[serde(default)]
        orig_col: Option<usize>,
        #[serde(default)]
        grid_span: Option<u32>,
        #[serde(default)]
        v_merge: Option<String>,
        /// Cell shading fill, "RRGGBB".
        #[serde(default)]
        shd: Option<String>,
        #[serde(default)]
        border: Option<CellBorder>,
        blocks: Vec<ParaEdit>,
    },
}

/// A uniform (all-sides) cell border applied from the shading/border UI.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct CellBorder {
    /// "single" to draw, "nil" to clear.
    pub style: String,
    /// "RRGGBB" or "auto".
    #[serde(default)]
    pub color: Option<String>,
    /// Eighth-points (`w:sz` unit); defaults to 4 (½pt).
    #[serde(default)]
    pub sz: Option<u32>,
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
    let ppr = build_ppr(pp_bytes, PpOverride { align, ..Default::default() });
    main.get_mut().write_all(&ppr)?;
    for r in runs {
        write_run(main, r)?;
    }
    Ok(())
}

/// Overrides applied to a paragraph's `pPr` on save (from the ribbon controls).
#[derive(Default, Clone, Copy)]
pub struct PpOverride<'a> {
    pub align: Option<&'a str>,
    pub style: Option<&'a str>,
    /// Left indent in points.
    pub indent_pt: Option<f32>,
    /// Line spacing as a multiple of a single line.
    pub line: Option<f32>,
}

/// Return the paragraph's `pPr` bytes with the given overrides set/replaced
/// (creating a `pPr` if there wasn't one). Emitted in WML schema order:
/// `pStyle`, `spacing`, `ind`, `jc`.
fn build_ppr(pp_bytes: &[u8], o: PpOverride) -> Vec<u8> {
    if o.align.is_none() && o.style.is_none() && o.indent_pt.is_none() && o.line.is_none() {
        return pp_bytes.to_vec();
    }
    let mut s = String::from_utf8_lossy(pp_bytes).into_owned();
    if s.is_empty() {
        s = "<w:pPr></w:pPr>".into();
    } else if let Some(i) = s.find("<w:pPr/>") {
        s.replace_range(i..i + "<w:pPr/>".len(), "<w:pPr></w:pPr>");
    }
    // Each insert goes right after the <w:pPr …> open tag, so insert in reverse
    // of the desired order → final order pStyle, spacing, ind, jc.
    if let Some(a) = o.align {
        drop_self_closing(&mut s, "<w:jc");
        insert_after_open(&mut s, &format!("<w:jc w:val=\"{}\"/>", jc_val(a)));
    }
    if let Some(pt) = o.indent_pt {
        drop_self_closing(&mut s, "<w:ind");
        insert_after_open(&mut s, &format!("<w:ind w:left=\"{}\"/>", (pt * 20.0).round() as i32));
    }
    if let Some(mult) = o.line {
        drop_self_closing(&mut s, "<w:spacing");
        insert_after_open(&mut s, &format!("<w:spacing w:line=\"{}\" w:lineRule=\"auto\"/>", (mult * 240.0).round() as i32));
    }
    if let Some(st) = o.style {
        drop_self_closing(&mut s, "<w:pStyle");
        insert_after_open(&mut s, &format!("<w:pStyle w:val=\"{}\"/>", xml_escape(st).replace('"', "")));
    }
    s.into_bytes()
}

/// Remove every self-closing element whose start tag begins with `prefix`.
fn drop_self_closing(s: &mut String, prefix: &str) {
    while let Some(start) = s.find(prefix) {
        match s[start..].find("/>") {
            Some(rel) => s.replace_range(start..start + rel + 2, ""),
            None => break,
        }
    }
}

/// Insert `frag` right after the first `>` (the `<w:pPr …>` open tag).
fn insert_after_open(s: &mut String, frag: &str) {
    if let Some(open_end) = s.find('>') {
        s.insert_str(open_end + 1, frag);
    }
}

fn write_run(main: &mut Writer<Cursor<Vec<u8>>>, r: &RunEdit) -> Result<(), EditError> {
    main.get_mut().write_all(run_xml(r).as_bytes())?;
    Ok(())
}

/// Serialize one run to `<w:r>…</w:r>` with its run properties (emitted in WML
/// `rPr` schema order: rFonts, b, i, strike, u, color, sz, shd, vertAlign).
fn run_xml(r: &RunEdit) -> String {
    let has_rpr = r.bold || r.italic || r.underline || r.strike || r.color.is_some()
        || r.size_pt.is_some() || r.font.is_some() || r.highlight.is_some() || r.vert.is_some();
    let mut s = String::from("<w:r>");
    if has_rpr {
        s.push_str("<w:rPr>");
        if let Some(f) = &r.font {
            let f = xml_escape(f).replace('"', "");
            s.push_str(&format!("<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:cs=\"{f}\"/>"));
        }
        if r.bold {
            s.push_str("<w:b/>");
        }
        if r.italic {
            s.push_str("<w:i/>");
        }
        if r.strike {
            s.push_str("<w:strike/>");
        }
        if r.underline {
            s.push_str("<w:u w:val=\"single\"/>");
        }
        if let Some(c) = &r.color {
            s.push_str(&format!("<w:color w:val=\"{}\"/>", c.trim_start_matches('#')));
        }
        if let Some(sz) = r.size_pt {
            s.push_str(&format!("<w:sz w:val=\"{}\"/>", (sz * 2.0).round() as i32));
        }
        if let Some(h) = &r.highlight {
            s.push_str(&format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>", h.trim_start_matches('#')));
        }
        match r.vert.as_deref() {
            Some("super") => s.push_str("<w:vertAlign w:val=\"superscript\"/>"),
            Some("sub") => s.push_str("<w:vertAlign w:val=\"subscript\"/>"),
            _ => {}
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
            BlockEdit::Para { orig, runs, align, style, indent, line } => {
                let o = PpOverride { align: align.as_deref(), style: style.as_deref(), indent_pt: *indent, line: *line };
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
                            emit_paragraph(&mut body, &start_tag, ppr.as_bytes(), runs, o);
                        }
                    }
                    None => emit_paragraph(&mut body, "<w:p>", b"", runs, o),
                }
            }
            BlockEdit::Table { orig, cols, rows } => {
                let skel = orig
                    .and_then(|i| cap.blocks.get(i))
                    .filter(|c| c.is_table)
                    .map(|c| parse_table_skeleton(&xml[c.start..c.end]));
                emit_table(&mut body, skel.as_ref(), *cols, rows);
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

/// Emit a `<w:p>`: the (open) start tag, its `pPr` (with the overrides applied),
/// then the edited runs.
fn emit_paragraph(body: &mut String, start_tag: &str, ppr: &[u8], runs: &[RunEdit], o: PpOverride) {
    body.push_str(start_tag);
    body.push_str(&String::from_utf8_lossy(&build_ppr(ppr, o)));
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

/// The original layout of a table, captured for lossless re-emission: its
/// `tblPr`, grid columns, and per-row `trPr` + per-cell (`tcPr`, full bytes).
struct TableSkeleton {
    tbl_pr: String,
    grid: Vec<String>,
    rows: Vec<RowSkel>,
}
struct RowSkel {
    tr_pr: String,
    cells: Vec<CellSkel>,
}
struct CellSkel {
    tc_pr: String,
    full: String,
}

/// Parse a captured `<w:tbl>…</w:tbl>` into its [`TableSkeleton`]. Only the outer
/// table's rows/cells are indexed; a nested table rides inside a cell's `full`
/// bytes untouched.
fn parse_table_skeleton(tbl: &str) -> TableSkeleton {
    let mut tbl_pr = String::new();
    let mut grid = Vec::new();
    let mut rows = Vec::new();
    for (name, s, e) in direct_children(tbl) {
        match name.as_slice() {
            b"w:tblPr" => tbl_pr = tbl[s..e].to_string(),
            b"w:tblGrid" => {
                let gx = &tbl[s..e];
                for (gn, gs, ge) in direct_children(gx) {
                    if gn == b"w:gridCol" {
                        grid.push(gx[gs..ge].to_string());
                    }
                }
            }
            b"w:tr" => {
                let rx = &tbl[s..e];
                let mut tr_pr = String::new();
                let mut cells = Vec::new();
                for (cn, cs, ce) in direct_children(rx) {
                    match cn.as_slice() {
                        b"w:trPr" => tr_pr = rx[cs..ce].to_string(),
                        b"w:tc" => {
                            let full = rx[cs..ce].to_string();
                            let mut tc_pr = String::new();
                            for (dn, ds, de) in direct_children(&full) {
                                if dn == b"w:tcPr" {
                                    tc_pr = full[ds..de].to_string();
                                    break;
                                }
                            }
                            cells.push(CellSkel { tc_pr, full });
                        }
                        _ => {}
                    }
                }
                rows.push(RowSkel { tr_pr, cells });
            }
            _ => {}
        }
    }
    TableSkeleton { tbl_pr, grid, rows }
}

/// Emit a `<w:tbl>` from the edited `rows`, reusing the source skeleton (`tblPr`,
/// grid, `trPr`, `tcPr`, verbatim cells) where the edit references it.
fn emit_table(body: &mut String, skel: Option<&TableSkeleton>, cols: usize, rows: &[RowEdit]) {
    body.push_str("<w:tbl>");
    match skel {
        Some(s) if !s.tbl_pr.is_empty() => body.push_str(&s.tbl_pr),
        _ => body.push_str(DEFAULT_TBL_PR),
    }
    body.push_str("<w:tblGrid>");
    for c in 0..cols.max(1) {
        match skel.and_then(|s| s.grid.get(c)) {
            Some(g) => body.push_str(g),
            None => body.push_str("<w:gridCol w:w=\"1440\"/>"),
        }
    }
    body.push_str("</w:tblGrid>");
    for row in rows {
        body.push_str("<w:tr>");
        if let Some(tr) = row.orig_row.and_then(|r| skel.and_then(|s| s.rows.get(r))) {
            body.push_str(&tr.tr_pr);
        }
        for cell in &row.cells {
            match cell {
                CellEdit::Verbatim { orig_row, orig_col } => {
                    match skel.and_then(|s| s.rows.get(*orig_row)).and_then(|r| r.cells.get(*orig_col)) {
                        Some(cs) => body.push_str(&cs.full),
                        None => body.push_str("<w:tc><w:p/></w:tc>"),
                    }
                }
                CellEdit::Cell { orig_row, orig_col, grid_span, v_merge, shd, border, blocks } => {
                    body.push_str("<w:tc>");
                    let base = (*orig_row)
                        .zip(*orig_col)
                        .and_then(|(r, c)| skel.and_then(|s| s.rows.get(r)).and_then(|rr| rr.cells.get(c)))
                        .map(|cs| cs.tc_pr.clone())
                        .unwrap_or_default();
                    let span = grid_span.unwrap_or(1);
                    body.push_str(&build_tcpr(&base, span, v_merge.as_deref(), shd.as_deref(), border.as_ref()));
                    if blocks.is_empty() {
                        body.push_str("<w:p/>"); // a cell must hold at least one block
                    } else {
                        for pe in blocks {
                            emit_paragraph(body, "<w:p>", b"", &pe.runs, PpOverride { align: pe.align.as_deref(), ..Default::default() });
                        }
                    }
                    body.push_str("</w:tc>");
                }
            }
        }
        body.push_str("</w:tr>");
    }
    body.push_str("</w:tbl>");
}

const DEFAULT_TBL_PR: &str = "<w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>\
<w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
</w:tblBorders></w:tblPr>";

/// Rebuild a `<w:tcPr>` from the source cell's `tcPr` (`base_tcpr`), replacing the
/// span / merge / shading / border we manage while preserving the rest (width,
/// margins, vertical alignment, …). Returns "" when the result is empty.
fn build_tcpr(base_tcpr: &str, grid_span: u32, v_merge: Option<&str>, shd: Option<&str>, border: Option<&CellBorder>) -> String {
    let mut inner = tcpr_inner(base_tcpr);
    // Keep tcW first (schema order); strip the elements we own.
    let tcw = extract_element(&inner, "w:tcW").map(|(s, e)| inner[s..e].to_string()).unwrap_or_default();
    for t in ["w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "w:tcBorders", "w:shd"] {
        remove_element(&mut inner, t);
    }
    let mut out = String::new();
    out.push_str(&tcw);
    if grid_span > 1 {
        out.push_str(&format!("<w:gridSpan w:val=\"{grid_span}\"/>"));
    }
    match v_merge {
        Some("restart") => out.push_str("<w:vMerge w:val=\"restart\"/>"),
        Some(_) => out.push_str("<w:vMerge/>"),
        None => {}
    }
    if let Some(b) = border {
        let color = b.color.as_deref().unwrap_or("auto");
        let color = color.trim_start_matches('#');
        let sz = b.sz.unwrap_or(4);
        out.push_str("<w:tcBorders>");
        for side in ["top", "left", "bottom", "right"] {
            out.push_str(&format!(
                "<w:{side} w:val=\"{}\" w:sz=\"{sz}\" w:space=\"0\" w:color=\"{color}\"/>",
                b.style
            ));
        }
        out.push_str("</w:tcBorders>");
    }
    if let Some(fill) = shd {
        out.push_str(&format!("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{}\"/>", fill.trim_start_matches('#')));
    }
    out.push_str(&inner);
    if out.is_empty() {
        String::new()
    } else {
        format!("<w:tcPr>{out}</w:tcPr>")
    }
}

/// The children of `<w:tcPr>…</w:tcPr>` (or "" for none / self-closing).
fn tcpr_inner(tcpr: &str) -> String {
    if let (Some(s), Some(e)) = (tcpr.find('>'), tcpr.rfind("</w:tcPr>")) {
        if s < e {
            return tcpr[s + 1..e].to_string();
        }
    }
    String::new()
}

/// Byte range of the first `<tag …/>` or `<tag …>…</tag>` element in `s`, matching
/// the tag name exactly (not a longer name with the same prefix).
fn extract_element(s: &str, tag: &str) -> Option<(usize, usize)> {
    let open = format!("<{tag}");
    let mut from = 0;
    while let Some(rel) = s[from..].find(&open) {
        let i = from + rel;
        let next = s.as_bytes().get(i + open.len()).copied();
        if matches!(next, Some(b' ') | Some(b'/') | Some(b'>')) {
            let rest = &s[i..];
            let open_end = rest.find('>')?;
            if rest.as_bytes()[open_end - 1] == b'/' {
                return Some((i, i + open_end + 1)); // self-closing
            }
            let close = format!("</{tag}>");
            return match rest.find(&close) {
                Some(ce) => Some((i, i + ce + close.len())),
                None => Some((i, i + open_end + 1)),
            };
        }
        from = i + open.len();
    }
    None
}

fn remove_element(s: &mut String, tag: &str) {
    while let Some((a, b)) = extract_element(s, tag) {
        s.replace_range(a..b, "");
    }
}

/// The direct child elements of the single outer element in `frag` (which is
/// `"<X …>…</X>"`), each as (qualified name, start, end) byte offsets into `frag`.
/// Empty (self-closing) children are included; text between elements is ignored.
fn direct_children(frag: &str) -> Vec<(Vec<u8>, usize, usize)> {
    let mut reader = Reader::from_str(frag);
    let mut buf = Vec::new();
    let mut children = Vec::new();
    let mut outer_open = false;
    let mut child_open = 0i32;
    let mut cur_start = 0usize;
    let mut cur_name: Vec<u8> = Vec::new();
    loop {
        let pos = reader.buffer_position() as usize;
        let ev = match reader.read_event_into(&mut buf) {
            Ok(ev) => ev,
            Err(_) => break,
        };
        let after = reader.buffer_position() as usize;
        match ev {
            Event::Start(e) => {
                let name = e.name().as_ref().to_vec();
                if !outer_open {
                    outer_open = true;
                } else if child_open == 0 {
                    cur_start = pos;
                    cur_name = name;
                    child_open = 1;
                } else {
                    child_open += 1;
                }
            }
            Event::Empty(e) => {
                if outer_open && child_open == 0 {
                    children.push((e.name().as_ref().to_vec(), pos, after));
                }
            }
            Event::End(_) => {
                if outer_open && child_open == 0 {
                    break; // closing the outer element
                } else if child_open > 0 {
                    child_open -= 1;
                    if child_open == 0 {
                        children.push((std::mem::take(&mut cur_name), cur_start, after));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    children
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
            RunEdit { text: "New ".into(), bold: true, italic: false, underline: false, color: None, size_pt: None, ..Default::default() },
            RunEdit { text: "text".into(), bold: false, italic: true, underline: false, color: None, size_pt: None, ..Default::default() },
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
            ParaEdit { runs: vec![RunEdit { text: "one".into(), bold: false, italic: false, underline: false, color: None, size_pt: None, ..Default::default() }], align: None },
            ParaEdit { runs: vec![RunEdit { text: "two".into(), bold: true, italic: false, underline: false, color: None, size_pt: None, ..Default::default() }], align: Some("center".into()) },
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
        let runs = vec![RunEdit { text: "x".into(), bold: false, italic: false, underline: false, color: None, size_pt: None, ..Default::default() }];
        let out = set_paragraph_runs_in_package(&docx_with(xml), 0, &runs, Some("center")).unwrap();
        assert!(document_text(&out).contains("<w:jc w:val=\"center\"/>"), "alignment injected into pPr");
    }

    fn run(text: &str, bold: bool) -> RunEdit {
        RunEdit { text: text.into(), bold, italic: false, underline: false, color: None, size_pt: None, ..Default::default() }
    }

    #[test]
    fn run_xml_emits_extended_props() {
        let r = RunEdit {
            text: "x".into(),
            strike: true,
            font: Some("Calibri".into()),
            highlight: Some("FFFF00".into()),
            vert: Some("super".into()),
            ..Default::default()
        };
        let out = run_xml(&r);
        assert!(out.contains("<w:rFonts w:ascii=\"Calibri\""), "font emitted");
        assert!(out.contains("<w:strike/>"), "strike emitted");
        assert!(out.contains("w:fill=\"FFFF00\""), "highlight emitted");
        assert!(out.contains("<w:vertAlign w:val=\"superscript\"/>"), "superscript emitted");
    }

    #[test]
    fn build_ppr_sets_style_and_align_in_order() {
        let out = build_ppr(b"<w:pPr><w:jc w:val=\"left\"/></w:pPr>", PpOverride { align: Some("center"), style: Some("Heading1"), ..Default::default() });
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("<w:pStyle w:val=\"Heading1\"/>"), "style set");
        assert!(s.contains("<w:jc w:val=\"center\"/>"), "align replaced");
        assert!(!s.contains("w:val=\"left\""), "old jc removed");
        assert!(s.find("<w:pStyle").unwrap() < s.find("<w:jc").unwrap(), "pStyle before jc");
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
            BlockEdit::Para { orig: Some(0), runs: vec![run("New", true)], align: None, style: None, indent: None, line: None },
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
            BlockEdit::Para { orig: None, runs: vec![run("fresh", false)], align: Some("right".into()), style: None, indent: None, line: None },
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

    const TABLE_XML: &str = r#"<w:document xmlns:w="x"><w:body><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#;

    fn cell_v(r: usize, c: usize) -> CellEdit {
        CellEdit::Verbatim { orig_row: r, orig_col: c }
    }

    #[test]
    fn reconcile_table_all_verbatim_cells_is_byte_identical() {
        let edit = vec![BlockEdit::Table {
            orig: Some(0),
            cols: 2,
            rows: vec![RowEdit { orig_row: Some(0), cells: vec![cell_v(0, 0), cell_v(0, 1)] }],
        }];
        let out = reconcile_body_in_package(&docx_with(TABLE_XML), &edit).unwrap();
        // Rebuilding a table from its skeleton + verbatim cells reproduces it exactly.
        assert_eq!(document_text(&out), TABLE_XML);
    }

    #[test]
    fn reconcile_table_edits_one_cell_keeps_others_and_tcpr() {
        let edit = vec![BlockEdit::Table {
            orig: Some(0),
            cols: 2,
            rows: vec![RowEdit {
                orig_row: Some(0),
                cells: vec![
                    CellEdit::Cell {
                        orig_row: Some(0),
                        orig_col: Some(0),
                        grid_span: None,
                        v_merge: None,
                        shd: None,
                        border: None,
                        blocks: vec![ParaEdit { runs: vec![run("Edited", true)], align: None }],
                    },
                    cell_v(0, 1),
                ],
            }],
        }];
        let out = reconcile_body_in_package(&docx_with(TABLE_XML), &edit).unwrap();
        let text = document_text(&out);
        assert!(text.contains("<w:tcW w:w=\"4680\" w:type=\"dxa\"/>"), "edited cell keeps its tcPr width");
        assert!(text.contains("<w:b/>") && text.contains("Edited"), "new cell content emitted");
        assert!(!text.contains("A1"), "old cell content replaced");
        assert!(text.contains("<w:t>B1</w:t>"), "sibling cell untouched");
    }

    #[test]
    fn reconcile_table_applies_span_shading_and_border() {
        let edit = vec![BlockEdit::Table {
            orig: Some(0),
            cols: 2,
            rows: vec![RowEdit {
                orig_row: Some(0),
                cells: vec![CellEdit::Cell {
                    orig_row: Some(0),
                    orig_col: Some(0),
                    grid_span: Some(2),
                    v_merge: None,
                    shd: Some("FFFF00".into()),
                    border: Some(CellBorder { style: "single".into(), color: None, sz: None }),
                    blocks: vec![ParaEdit { runs: vec![run("wide", false)], align: None }],
                }],
            }],
        }];
        let out = reconcile_body_in_package(&docx_with(TABLE_XML), &edit).unwrap();
        let text = document_text(&out);
        assert!(text.contains("<w:gridSpan w:val=\"2\"/>"), "horizontal span emitted");
        assert!(text.contains("w:fill=\"FFFF00\""), "shading fill emitted");
        assert!(text.contains("<w:tcBorders>"), "cell borders emitted");
        assert!(text.contains("<w:tcW w:w=\"4680\" w:type=\"dxa\"/>"), "base tcPr width preserved");
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
