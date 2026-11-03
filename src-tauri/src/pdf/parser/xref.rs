/// PDF cross-reference table parser.
///
/// Handles:
/// - Traditional xref table + trailer (PDF ≤ 1.4)
/// - Xref streams with PNG predictor (PDF 1.5+)
/// - Incremental update /Prev chains (up to 512 deep)
/// - Hybrid: traditional table + /XRefStm pointer (xref stream wins on conflict)
use std::collections::HashMap;

use crate::pdf::error::PdfError;
use crate::pdf::parser::lexer::Lexer;
use crate::pdf::parser::object::{parse_dict_body, parse_indirect_object};
use crate::pdf::types::{
    ObjectId, PdfDict, PdfObject, XrefEntry, XrefTable,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Build the complete `XrefTable` by locating `startxref`, parsing the xref
/// (traditional or stream), and following any `/Prev` chain.
pub fn parse_xref(data: &[u8]) -> Result<XrefTable, PdfError> {
    let start_offset = find_startxref(data)?;

    // Check whether the object at that offset is a traditional xref table or
    // an xref stream.
    let mut merged = XrefTable::new();
    let mut offsets_to_process: Vec<u64> = vec![start_offset];
    let mut visited: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut depth = 0usize;
    const MAX_DEPTH: usize = 512;

    while let Some(offset) = offsets_to_process.pop() {
        if !visited.insert(offset) {
            continue; // cycle guard
        }
        depth += 1;
        if depth > MAX_DEPTH {
            return Err(PdfError::MalformedXref(
                "Xref /Prev chain exceeds 512 entries".into(),
            ));
        }

        let (partial, prev_offset) = if is_traditional_xref(data, offset) {
            parse_traditional_xref(data, offset)?
        } else {
            parse_xref_stream(data, offset)?
        };

        // Check for /XRefStm (hybrid) — xref stream wins on conflict, so load
        // it as an "older" table relative to the traditional one we just read.
        if let Some(xrefstm_obj) = partial.trailer.get(b"XRefStm") {
            if let Some(xrefstm_off) = xrefstm_obj.as_integer() {
                let (xrefstm_table, _) =
                    parse_xref_stream(data, xrefstm_off as u64)?;
                // xref stream entries should win over the traditional table,
                // so merge the *traditional* table into the xref-stream table,
                // then use that as the current partial.
                let mut combined = xrefstm_table;
                combined.merge_older(partial);
                merged.merge_older(combined);
            }
        } else {
            merged.merge_older(partial);
        }

        if let Some(prev) = prev_offset {
            offsets_to_process.push(prev);
        }
    }

    if merged.entries.is_empty() && merged.trailer.is_empty() {
        return Err(PdfError::XrefNotFound);
    }

    Ok(merged)
}

// ---------------------------------------------------------------------------
// Locate startxref
// ---------------------------------------------------------------------------

/// Search the last 1024 bytes for `startxref\n<number>`.
fn find_startxref(data: &[u8]) -> Result<u64, PdfError> {
    let search_from = data.len().saturating_sub(1024);
    let tail = &data[search_from..];

    // Search backwards for "startxref"
    let needle = b"startxref";
    let mut pos = tail.len().saturating_sub(needle.len());
    loop {
        if tail[pos..].starts_with(needle) {
            let after = &tail[pos + needle.len()..];
            // Skip whitespace
            let after = skip_ascii_whitespace(after);
            // Read the number
            let (num_str, _) = read_ascii_number(after);
            if num_str.is_empty() {
                // Keep searching backwards
            } else {
                let offset: u64 = std::str::from_utf8(num_str)
                    .ok()
                    .and_then(|s| s.trim().parse().ok())
                    .ok_or_else(|| {
                        PdfError::MalformedXref(
                            "startxref offset is not a valid integer".into(),
                        )
                    })?;
                return Ok(offset);
            }
        }
        if pos == 0 {
            break;
        }
        pos -= 1;
    }
    Err(PdfError::XrefNotFound)
}

fn skip_ascii_whitespace(data: &[u8]) -> &[u8] {
    let mut i = 0;
    while i < data.len() && matches!(data[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    &data[i..]
}

/// Returns `(digits, rest)` where `digits` is the leading decimal characters.
fn read_ascii_number(data: &[u8]) -> (&[u8], &[u8]) {
    let mut i = 0;
    while i < data.len() && data[i].is_ascii_digit() {
        i += 1;
    }
    (&data[..i], &data[i..])
}

// ---------------------------------------------------------------------------
// Traditional xref table
// ---------------------------------------------------------------------------

fn is_traditional_xref(data: &[u8], offset: u64) -> bool {
    let off = offset as usize;
    data.get(off..).map_or(false, |s| s.starts_with(b"xref"))
}

/// Parse a traditional xref table starting at `offset`.
///
/// Returns `(partial_table, prev_offset)`.
fn parse_traditional_xref(
    data: &[u8],
    offset: u64,
) -> Result<(XrefTable, Option<u64>), PdfError> {
    let mut lex = Lexer::new(data);
    lex.seek(offset as usize);

    // Expect "xref"
    let line = lex.read_line();
    if line.trim_ascii() != b"xref" {
        return Err(PdfError::MalformedXref(format!(
            "Expected 'xref' at offset {}, found {:?}",
            offset,
            String::from_utf8_lossy(&line)
        )));
    }

    let mut entries: HashMap<ObjectId, XrefEntry> = HashMap::new();

    // Read subsections: "first_obj count" followed by count entries
    // "offset gen n|f". Fields are split on any whitespace rather than read at
    // a fixed 20-byte stride: some writers end entries with a bare LF (19
    // bytes) or separate fields with tabs. Anything unexpected is an error;
    // retrying the same line used to loop forever.
    loop {
        lex.skip_whitespace_and_comments();
        let saved = lex.pos();

        if data.get(saved..).is_some_and(|rest| rest.starts_with(b"trailer")) {
            // The dictionary may follow on the same line (`trailer << ... >>`).
            lex.seek(saved + b"trailer".len());
            lex.skip_whitespace_and_comments();
            let trailer_dict = if lex.peek_bytes(2) == b"<<" {
                lex.seek(lex.pos() + 2); // consume <<
                parse_dict_body(&mut lex)?
            } else {
                return Err(PdfError::MalformedXref(
                    "Expected '<<' after 'trailer'".into(),
                ));
            };

            let prev = extract_prev(&trailer_dict);
            let table = XrefTable {
                entries,
                trailer: trailer_dict,
            };
            return Ok((table, prev));
        }

        let line = lex.read_line();
        let parts = fields(&line);
        if parts.len() != 2 {
            return Err(PdfError::MalformedXref(format!(
                "Expected an xref subsection header, got {:?}",
                String::from_utf8_lossy(&line)
            )));
        }

        let first_obj: u32 = parse_u32(parts[0]).map_err(|_| {
            PdfError::MalformedXref(format!(
                "Invalid xref subsection first-object: {:?}",
                String::from_utf8_lossy(parts[0])
            ))
        })?;
        let count: u32 = parse_u32(parts[1]).map_err(|_| {
            PdfError::MalformedXref(format!(
                "Invalid xref subsection count: {:?}",
                String::from_utf8_lossy(parts[1])
            ))
        })?;

        for i in 0..count {
            let obj_num = first_obj.checked_add(i).ok_or_else(|| {
                PdfError::MalformedXref("Xref object number overflows".into())
            })?;
            lex.skip_whitespace_and_comments();
            let entry_line = lex.read_line();
            let f = fields(&entry_line);
            if f.len() < 3 {
                return Err(PdfError::MalformedXref(format!(
                    "Malformed xref entry for obj {}",
                    obj_num
                )));
            }
            let offset_val = parse_u64(f[0]).map_err(|_| {
                PdfError::MalformedXref(format!("Invalid xref offset for obj {}", obj_num))
            })?;
            let gen_val = parse_u16(f[1]).map_err(|_| {
                PdfError::MalformedXref(format!(
                    "Invalid xref generation for obj {}",
                    obj_num
                ))
            })?;
            let entry = match f[2] {
                b"n" => XrefEntry::InUse {
                    offset: offset_val,
                },
                b"f" => XrefEntry::Free,
                other => {
                    return Err(PdfError::MalformedXref(format!(
                        "Invalid xref entry type {:?} for obj {}",
                        String::from_utf8_lossy(other),
                        obj_num
                    )))
                }
            };

            entries.insert((obj_num, gen_val), entry);
        }
    }

    Err(PdfError::MalformedXref(
        "Reached EOF without finding 'trailer'".into(),
    ))
}

// ---------------------------------------------------------------------------
// Xref stream (PDF 1.5+)
// ---------------------------------------------------------------------------

/// Parse an xref stream object at `offset`.
///
/// Returns `(partial_table, prev_offset)`.
fn parse_xref_stream(data: &[u8], offset: u64) -> Result<(XrefTable, Option<u64>), PdfError> {
    let (_, obj) = parse_indirect_object(data, offset as usize)?;

    let stream = match obj {
        PdfObject::Stream(s) => s,
        _ => {
            return Err(PdfError::MalformedXref(format!(
                "Expected stream object at xref stream offset {}, got something else",
                offset
            )))
        }
    };

    // Validate /Type /XRef
    let type_name = stream.dict.get_type();
    if type_name != Some(b"XRef") {
        return Err(PdfError::MalformedXref(format!(
            "Stream at offset {} has /Type {:?}, expected /XRef",
            offset,
            type_name.map(|n| String::from_utf8_lossy(n).into_owned())
        )));
    }

    let prev = extract_prev(&stream.dict);

    // /W array — field widths [type_width, field2_width, field3_width]
    let w = extract_w_array(&stream.dict)?;

    // /Size — highest object number + 1
    let _size = stream
        .dict
        .get(b"Size")
        .and_then(|v| v.as_integer())
        .unwrap_or(0) as u32;

    // /Index — defaults to [0 Size]
    let index_pairs = extract_index(&stream.dict, _size);

    // Decode the stream data
    let decoded = stream.decode()?;

    // Parse entries
    let entries = decode_xref_stream_data(&decoded, w, &index_pairs)?;

    let table = XrefTable {
        entries,
        trailer: stream.dict,
    };
    Ok((table, prev))
}

/// Extract /W as [w0, w1, w2].
fn extract_w_array(dict: &PdfDict) -> Result<[usize; 3], PdfError> {
    let arr = dict
        .get(b"W")
        .and_then(|v| v.as_array())
        .ok_or_else(|| PdfError::MalformedXref("/W array missing from xref stream".into()))?;

    if arr.len() < 3 {
        return Err(PdfError::MalformedXref(
            "/W array must have at least 3 elements".into(),
        ));
    }
    Ok([
        arr[0].as_integer().unwrap_or(1) as usize,
        arr[1].as_integer().unwrap_or(1) as usize,
        arr[2].as_integer().unwrap_or(1) as usize,
    ])
}

/// Extract /Index as `Vec<(first_obj, count)>` pairs.
fn extract_index(dict: &PdfDict, size: u32) -> Vec<(u32, u32)> {
    if let Some(arr) = dict.get(b"Index").and_then(|v| v.as_array()) {
        let mut pairs = Vec::new();
        let mut i = 0;
        while i + 1 < arr.len() {
            let first = arr[i].as_integer().unwrap_or(0) as u32;
            let count = arr[i + 1].as_integer().unwrap_or(0) as u32;
            pairs.push((first, count));
            i += 2;
        }
        pairs
    } else {
        vec![(0, size)]
    }
}

/// Decode the raw bytes of an xref stream into `HashMap<ObjectId, XrefEntry>`.
fn decode_xref_stream_data(
    data: &[u8],
    w: [usize; 3],
    index: &[(u32, u32)],
) -> Result<HashMap<ObjectId, XrefEntry>, PdfError> {
    let row_width = w[0] + w[1] + w[2];
    if row_width == 0 {
        return Ok(HashMap::new());
    }

    if data.len() % row_width != 0 {
        return Err(PdfError::MalformedXref(format!(
            "Xref stream data length {} is not a multiple of row_width {}",
            data.len(),
            row_width
        )));
    }

    let mut entries: HashMap<ObjectId, XrefEntry> = HashMap::new();
    let mut row_idx = 0usize;

    for &(first_obj, count) in index {
        for i in 0..count {
            let obj_num = first_obj + i;
            let off = row_idx * row_width;
            if off + row_width > data.len() {
                return Err(PdfError::MalformedXref(
                    "Xref stream data truncated".into(),
                ));
            }
            let row = &data[off..off + row_width];

            // Field 1: type (default = 1 if w[0] == 0)
            let entry_type = if w[0] == 0 {
                1u64
            } else {
                read_be_int(row, 0, w[0])
            };

            // Field 2
            let f2 = read_be_int(row, w[0], w[1]);

            // Field 3
            let f3 = read_be_int(row, w[0] + w[1], w[2]);

            let entry = match entry_type {
                0 => XrefEntry::Free,
                1 => XrefEntry::InUse { offset: f2 },
                2 => XrefEntry::Compressed {
                    obj_stream_id: f2 as u32,
                    index: f3 as u32,
                },
                _ => XrefEntry::Free,
            };

            // Generation is 0 for type 2, f3 for type 0/1 (spec: gen = field3 for free entries)
            let gen = match entry_type {
                2 => 0u16,
                _ => f3 as u16,
            };

            entries.insert((obj_num, gen), entry);
            row_idx += 1;
        }
    }

    Ok(entries)
}

fn read_be_int(row: &[u8], start: usize, len: usize) -> u64 {
    let mut val = 0u64;
    for i in 0..len {
        val = (val << 8) | row[start + i] as u64;
    }
    val
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_prev(dict: &PdfDict) -> Option<u64> {
    dict.get(b"Prev")?.as_integer().map(|n| n as u64)
}

/// Whitespace-separated fields of an xref line.
fn fields(line: &[u8]) -> Vec<&[u8]> {
    line.split(|b| b.is_ascii_whitespace()).filter(|f| !f.is_empty()).collect()
}

fn parse_u32(s: &[u8]) -> Result<u32, ()> {
    std::str::from_utf8(s)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .ok_or(())
}

fn parse_u64(s: &[u8]) -> Result<u64, ()> {
    std::str::from_utf8(s)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .ok_or(())
}

fn parse_u16(s: &[u8]) -> Result<u16, ()> {
    std::str::from_utf8(s)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .ok_or(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::apply_png_predictor;

    #[test]
    fn find_startxref_basic() {
        let data = b"...some pdf content...\nstartxref\n1234\n%%EOF\n";
        let off = find_startxref(data).unwrap();
        assert_eq!(off, 1234);
    }

    #[test]
    fn xref_entry_inuse() {
        // Simple xref table with one entry
        let data = b"xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n";
        let table = parse_xref(data).unwrap();
        assert!(matches!(
            table.entries.get(&(1, 0)),
            Some(XrefEntry::InUse { offset: 9 })
        ));
    }

    /// parse_xref on another thread; None if it has not returned within 5 s.
    fn parse_within(data: &'static [u8]) -> Option<Result<XrefTable, PdfError>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let _ = tx.send(parse_xref(data)); });
        rx.recv_timeout(std::time::Duration::from_secs(5)).ok()
    }

    #[test]
    fn xref_entries_with_lf_only_line_ends_parse() {
        // 19-byte entries (no space before the LF), as some writers produce.
        let data = b"xref\n0 2\n0000000000 65535 f\n0000000009 00000 n\ntrailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n";
        let table = parse_within(data).expect("must not hang").expect("parse");
        assert!(matches!(table.entries.get(&(1, 0)), Some(XrefEntry::InUse { offset: 9 })));
    }

    #[test]
    fn trailer_dictionary_on_the_trailer_line_parses() {
        let data = b"xref\n0 1\n0000000000 65535 f \ntrailer << /Size 1 >>\nstartxref\n0\n%%EOF\n";
        let table = parse_within(data).expect("must not hang").expect("parse");
        assert!(table.trailer.get(b"Size").is_some());
    }

    #[test]
    fn tab_separated_subsection_header_parses() {
        let data = b"xref\n0\t2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n";
        let table = parse_within(data).expect("must not hang").expect("parse");
        assert_eq!(table.entries.len(), 2);
    }

    #[test]
    fn a_garbage_line_is_an_error_not_a_hang() {
        let data = b"xref\n0 1\n0000000000 65535 f \ngarbage\nstartxref\n0\n%%EOF\n";
        assert!(parse_within(data).expect("must not hang").is_err());
    }

    #[test]
    fn png_up_predictor_applied() {
        // Two rows, row_width=2, filter byte 2 (Up)
        // Row 0: [2, 10, 20]  → [10, 20]
        // Row 1: [2, 1, 2]    → [10+1, 20+2] = [11, 22]
        let data = [2u8, 10, 20, 2, 1, 2];
        let out = apply_png_predictor(&data, 2, 1).unwrap();
        assert_eq!(out, vec![10, 20, 11, 22]);
    }

    #[test]
    fn decode_xref_stream_type1() {
        // One entry: type=1, offset=100, gen=0  (w=[1,4,2])
        let w = [1usize, 4, 2];
        let row = [1u8, 0, 0, 0, 100, 0, 0]; // type=1, f2=100, f3=0
        let index = vec![(1u32, 1u32)];
        let entries = decode_xref_stream_data(&row, w, &index).unwrap();
        assert!(matches!(
            entries.get(&(1, 0)),
            Some(XrefEntry::InUse { offset: 100 })
        ));
    }

    #[test]
    fn decode_xref_stream_type2() {
        // One compressed entry: type=2, obj_stream_id=5, index=0  (w=[1,4,2])
        let w = [1usize, 4, 2];
        let row = [2u8, 0, 0, 0, 5, 0, 0]; // type=2, f2=5, f3=0
        let index = vec![(3u32, 1u32)];
        let entries = decode_xref_stream_data(&row, w, &index).unwrap();
        assert!(matches!(
            entries.get(&(3, 0)),
            Some(XrefEntry::Compressed {
                obj_stream_id: 5,
                index: 0
            })
        ));
    }
}
