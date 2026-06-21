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
pub fn set_paragraph_runs_in_package(bytes: &[u8], index: usize, runs: &[RunEdit]) -> Result<Vec<u8>, EditError> {
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
                        emit_runs(&mut main, &ppw, runs)?;
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
                        emit_runs(&mut main, &ppw, runs)?;
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
                        emit_runs(&mut main, &ppw, runs)?;
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
) -> Result<(), EditError> {
    let pp_bytes = ppw.get_ref().get_ref().clone();
    main.get_mut().write_all(&pp_bytes)?;
    for r in runs {
        write_run(main, r)?;
    }
    Ok(())
}

fn write_run(main: &mut Writer<Cursor<Vec<u8>>>, r: &RunEdit) -> Result<(), EditError> {
    let w = main.get_mut();
    w.write_all(b"<w:r>")?;
    if r.bold || r.italic || r.underline || r.color.is_some() || r.size_pt.is_some() {
        w.write_all(b"<w:rPr>")?;
        if r.bold {
            w.write_all(b"<w:b/>")?;
        }
        if r.italic {
            w.write_all(b"<w:i/>")?;
        }
        if r.underline {
            w.write_all(b"<w:u w:val=\"single\"/>")?;
        }
        if let Some(sz) = r.size_pt {
            w.write_all(format!("<w:sz w:val=\"{}\"/>", (sz * 2.0).round() as i32).as_bytes())?;
        }
        if let Some(c) = &r.color {
            w.write_all(format!("<w:color w:val=\"{}\"/>", c.trim_start_matches('#')).as_bytes())?;
        }
        w.write_all(b"</w:rPr>")?;
    }
    w.write_all(b"<w:t xml:space=\"preserve\">")?;
    w.write_all(xml_escape(&r.text).as_bytes())?;
    w.write_all(b"</w:t></w:r>")?;
    Ok(())
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
        let out = set_paragraph_runs_in_package(&docx_with(xml), 0, &runs).unwrap();
        let text = document_text(&out);
        assert!(text.contains("<w:b/>"), "bold run prop emitted");
        assert!(text.contains("<w:i/>"), "italic run prop emitted");
        assert!(text.contains("New "), "new text present");
        assert!(text.contains("<w:jc w:val=\"center\"/>"), "pPr preserved");
        assert!(!text.contains(">old<"), "old run text replaced");
        assert!(text.contains("keep"), "other paragraph untouched");
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
