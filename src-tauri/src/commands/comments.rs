//! Comment persistence with two-way PDF interop.
//!
//! Qyra comments live in two places inside the working PDF:
//!
//!  1. A `qyra-comments.json` embedded-file attachment (the *sidecar*) —
//!     carries Qyra-only fields other viewers have no slot for (`resolved`,
//!     `quote`, exact `createdAt` millis).
//!  2. Standard `/Annots` **Text** (sticky-note) annotations — one per
//!     comment, keyed by `/NM` = comment id. This is what Acrobat, Edge and
//!     Firefox actually display, and was previously missing entirely: Qyra
//!     comments were invisible everywhere else.
//!
//! `save_comments` syncs both: creates/updates/deletes Text annotations to
//! mirror the comment list, then rewrites the sidecar. `load_comments` walks
//! the document's Text annotations (importing ones made in other viewers),
//! merges sidecar extras back in by id, and returns the combined list.
//!
//! Conflict rules on load: the annotation wins for text/position/color
//! (external edits are newer), the sidecar wins for resolved/quote/createdAt.
//! A sidecar entry whose annotation disappeared was deleted in another viewer
//! and is dropped — unless it was never synced to an annotation (legacy file),
//! in which case it is kept.

use std::collections::{HashMap, HashSet};

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde::{Deserialize, Serialize};

use crate::commands::pdf_annotations::{color_array_to_hex, hex_to_rgb_f32};
use crate::error::{AppError, AppResult};
use crate::utils::get_page_dims;

const ATTACHMENT_KEY: &[u8] = b"qyra-comments";
const ATTACHMENT_FILENAME: &[u8] = b"qyra-comments.json";

/// Sticky-note icon footprint in PDF points. The comment pin's tip maps to
/// the bottom-center of this rect.
const NOTE_W: f64 = 20.0;
const NOTE_H: f64 = 20.0;

const DEFAULT_COLOR: &str = "#f59e0b"; // amber — first entry of COMMENT_COLORS

/// Mirror of the frontend `Comment` shape (src/lib/schemas.ts).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub page_index: u32,
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub color: String,
    pub resolved: bool,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    /// True once this comment has been written to the PDF as a Text
    /// annotation. Lets load distinguish "legacy sidecar entry never synced"
    /// (keep) from "annotation deleted in another viewer" (drop).
    #[serde(default)]
    pub synced: bool,
}

// ---------------------------------------------------------------------------
// Object helpers
// ---------------------------------------------------------------------------

fn obj_as_ref(obj: &Object) -> Option<ObjectId> {
    match obj {
        Object::Reference(id) => Some(*id),
        _ => None,
    }
}

fn obj_as_dict(obj: &Object) -> Option<&Dictionary> {
    match obj {
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

fn obj_as_array(obj: &Object) -> Option<&Vec<Object>> {
    match obj {
        Object::Array(arr) => Some(arr),
        _ => None,
    }
}

fn get_dict<'a>(doc: &'a Document, id: ObjectId) -> Option<&'a Dictionary> {
    obj_as_dict(doc.get_object(id).ok()?)
}

// ---------------------------------------------------------------------------
// PDF text strings (UTF-16BE when needed) and dates
// ---------------------------------------------------------------------------

/// Encode a Rust string as a PDF text string: plain bytes when ASCII,
/// BOM-prefixed UTF-16BE otherwise (the form Acrobat expects for non-Latin
/// comment text).
fn pdf_text_encode(s: &str) -> Vec<u8> {
    if s.is_ascii() {
        return s.as_bytes().to_vec();
    }
    let mut out = vec![0xFE, 0xFF];
    for unit in s.encode_utf16() {
        out.extend_from_slice(&unit.to_be_bytes());
    }
    out
}

/// Decode a PDF text string: UTF-16BE when BOM-prefixed, else treat the bytes
/// as (lossy) UTF-8 — close enough to PDFDocEncoding for comment text.
fn pdf_text_decode(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Days-from-civil (Howard Hinnant's algorithm); days since 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of `days_from_civil`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Millis since epoch → PDF date string `D:YYYYMMDDHHMMSSZ` (UTC).
fn pdf_date(millis: f64) -> String {
    let secs = (millis / 1000.0).floor() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "D:{:04}{:02}{:02}{:02}{:02}{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem / 60) % 60,
        rem % 60
    )
}

/// Best-effort parse of a PDF date (`D:YYYYMMDDHHMMSS...`) into epoch millis.
/// The timezone suffix is ignored — comment ordering doesn't need it exact.
fn millis_from_pdf_date(s: &str) -> Option<f64> {
    let t = s.strip_prefix("D:").unwrap_or(s);
    let digits: Vec<u8> = t.bytes().take_while(|b| b.is_ascii_digit()).collect();
    if digits.len() < 4 {
        return None;
    }
    let num = |range: std::ops::Range<usize>, default: i64| -> i64 {
        if digits.len() >= range.end {
            std::str::from_utf8(&digits[range])
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(default)
        } else {
            default
        }
    };
    let y = num(0..4, 1970);
    let m = num(4..6, 1).clamp(1, 12);
    let d = num(6..8, 1).clamp(1, 31);
    let hh = num(8..10, 0).clamp(0, 23);
    let mm = num(10..12, 0).clamp(0, 59);
    let ss = num(12..14, 0).clamp(0, 59);
    let secs = days_from_civil(y, m, d) * 86400 + hh * 3600 + mm * 60 + ss;
    Some(secs as f64 * 1000.0)
}

fn now_millis() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn author_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Qyra".to_string())
}

// ---------------------------------------------------------------------------
// /Annots access
// ---------------------------------------------------------------------------

/// Object ids referenced by a page's /Annots array (inline or indirect).
/// Inline annotation dictionaries (no indirect ref) are skipped, matching
/// pdf_annotations.rs.
fn annot_refs(doc: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    let Some(page_dict) = get_dict(doc, page_id) else {
        return vec![];
    };
    match page_dict.get(b"Annots") {
        Ok(Object::Array(arr)) => arr.iter().filter_map(obj_as_ref).collect(),
        Ok(Object::Reference(r)) => match doc.get_object(*r) {
            Ok(Object::Array(arr)) => arr.iter().filter_map(obj_as_ref).collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

/// Append an annotation reference to a page's /Annots, handling the inline
/// array, indirect array, and missing cases.
fn push_annot_ref(doc: &mut Document, page_id: ObjectId, annot_id: ObjectId) -> AppResult<()> {
    // Determine the array's location with immutable borrows first.
    let indirect_arr: Option<ObjectId> = get_dict(doc, page_id)
        .and_then(|d| d.get(b"Annots").ok())
        .and_then(obj_as_ref);

    if let Some(arr_id) = indirect_arr {
        if let Ok(Object::Array(arr)) = doc.get_object_mut(arr_id) {
            arr.push(Object::Reference(annot_id));
            return Ok(());
        }
    }

    let page_obj = doc.get_object_mut(page_id)?;
    if let Object::Dictionary(page_dict) = page_obj {
        match page_dict.get_mut(b"Annots") {
            Ok(Object::Array(arr)) => arr.push(Object::Reference(annot_id)),
            _ => page_dict.set("Annots", Object::Array(vec![Object::Reference(annot_id)])),
        }
    }
    Ok(())
}

/// Remove an annotation reference from a page's /Annots (inline or indirect).
fn remove_annot_ref(doc: &mut Document, page_id: ObjectId, annot_id: ObjectId) {
    let indirect_arr: Option<ObjectId> = get_dict(doc, page_id)
        .and_then(|d| d.get(b"Annots").ok())
        .and_then(obj_as_ref);

    let target = Object::Reference(annot_id);
    if let Some(arr_id) = indirect_arr {
        if let Ok(Object::Array(arr)) = doc.get_object_mut(arr_id) {
            arr.retain(|o| *o != target);
        }
        return;
    }
    if let Ok(Object::Dictionary(page_dict)) = doc.get_object_mut(page_id) {
        if let Ok(Object::Array(arr)) = page_dict.get_mut(b"Annots") {
            arr.retain(|o| *o != target);
        }
    }
}

/// Stable comment id for a Text annotation: its /NM if present, otherwise a
/// synthetic id derived from the object id (stable across load/save because
/// lopdf preserves object numbers on save).
fn annot_comment_id(dict: &Dictionary, annot_id: ObjectId) -> String {
    match dict.get(b"NM") {
        Ok(Object::String(bytes, _)) if !bytes.is_empty() => pdf_text_decode(bytes),
        _ => format!("annot-{}-{}", annot_id.0, annot_id.1),
    }
}

fn dict_string(dict: &Dictionary, key: &[u8]) -> Option<String> {
    match dict.get(key) {
        Ok(Object::String(bytes, _)) => Some(pdf_text_decode(bytes)),
        _ => None,
    }
}

fn dict_subtype<'a>(dict: &'a Dictionary) -> Option<&'a [u8]> {
    match dict.get(b"Subtype") {
        Ok(Object::Name(n)) => Some(n.as_slice()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Sidecar attachment (qyra-comments.json)
// ---------------------------------------------------------------------------

/// Walk Catalog -> Names -> EmbeddedFiles -> Names array.
/// Returns the stream ObjectId of the embedded qyra-comments JSON, if present.
fn find_comments_stream(doc: &Document) -> Option<ObjectId> {
    let root_ref = obj_as_ref(doc.trailer.get(b"Root").ok()?)?;

    let names_ref = {
        let catalog = get_dict(doc, root_ref)?;
        obj_as_ref(catalog.get(b"Names").ok()?)?
    };

    let ef_ref = {
        let names_dict = get_dict(doc, names_ref)?;
        obj_as_ref(names_dict.get(b"EmbeddedFiles").ok()?)?
    };

    let filespec_ref = {
        let ef_dict = get_dict(doc, ef_ref)?;
        let arr = obj_as_array(ef_dict.get(b"Names").ok()?)?;

        let mut found: Option<ObjectId> = None;
        let mut i = 0;
        while i + 1 < arr.len() {
            if let Object::String(key, _) = &arr[i] {
                if key.as_slice() == ATTACHMENT_KEY {
                    found = obj_as_ref(&arr[i + 1]);
                    break;
                }
            }
            i += 2;
        }
        found?
    };

    {
        let filespec = get_dict(doc, filespec_ref)?;
        let ef_val = filespec.get(b"EF").ok()?;
        let ef_dict = match ef_val {
            Object::Dictionary(d) => d,
            Object::Reference(id) => get_dict(doc, *id)?,
            _ => return None,
        };
        obj_as_ref(ef_dict.get(b"F").ok()?)
    }
}

/// Sidecar JSON bytes, decompressed if needed. Empty list when absent.
fn read_sidecar(doc: &Document) -> Vec<Comment> {
    let Some(stream_id) = find_comments_stream(doc) else {
        return vec![];
    };
    let Ok(Object::Stream(stream)) = doc.get_object(stream_id) else {
        return vec![];
    };
    let bytes = match stream.dict.get(b"Filter") {
        Ok(Object::Name(name)) if name == b"FlateDecode" => {
            use flate2::read::ZlibDecoder;
            use std::io::Read;
            let mut decoder = ZlibDecoder::new(stream.content.as_slice());
            let mut out = Vec::new();
            if decoder.read_to_end(&mut out).is_err() {
                return vec![];
            }
            out
        }
        _ => stream.content.clone(),
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

struct NamesStructure {
    root_ref: ObjectId,
    names_ref: Option<ObjectId>,
    ef_names_ref: Option<ObjectId>,
}

fn collect_structure(doc: &Document) -> Option<NamesStructure> {
    let root_ref = obj_as_ref(doc.trailer.get(b"Root").ok()?)?;

    let names_ref = {
        let catalog = get_dict(doc, root_ref)?;
        catalog.get(b"Names").ok().and_then(obj_as_ref)
    };

    let ef_names_ref = names_ref.and_then(|nid| {
        let names_dict = get_dict(doc, nid)?;
        names_dict.get(b"EmbeddedFiles").ok().and_then(obj_as_ref)
    });

    Some(NamesStructure { root_ref, names_ref, ef_names_ref })
}

/// Create or update the embedded qyra-comments.json attachment (no save).
fn write_sidecar(doc: &mut Document, json_bytes: Vec<u8>) -> AppResult<()> {
    let json_len = json_bytes.len() as i64;

    // --- Case A: stream already exists → update in-place ---
    if let Some(stream_id) = find_comments_stream(doc) {
        let obj = doc.get_object_mut(stream_id)?;
        if let Object::Stream(stream) = obj {
            stream.dict.set("Length", Object::Integer(json_len));
            stream.dict.remove(b"Filter");
            stream.dict.remove(b"DecodeParms");
            stream.content = json_bytes;
        }
        return Ok(());
    }

    // --- Case B: need to add a new attachment ---
    let structure = collect_structure(doc)
        .ok_or_else(|| AppError::NotFound("Could not locate PDF Catalog".to_string()))?;

    let mut stream_dict = Dictionary::new();
    stream_dict.set("Type", Object::Name(b"EmbeddedFile".to_vec()));
    stream_dict.set("Subtype", Object::Name(b"application/json".to_vec()));
    stream_dict.set("Length", Object::Integer(json_len));
    let stream_id = doc.add_object(Object::Stream(Stream::new(stream_dict, json_bytes)));

    let mut ef_inner = Dictionary::new();
    ef_inner.set("F", Object::Reference(stream_id));

    let mut filespec = Dictionary::new();
    filespec.set("Type", Object::Name(b"Filespec".to_vec()));
    filespec.set(
        "F",
        Object::String(ATTACHMENT_FILENAME.to_vec(), StringFormat::Literal),
    );
    filespec.set("EF", Object::Dictionary(ef_inner));
    let filespec_id = doc.add_object(Object::Dictionary(filespec));

    let entry_key = Object::String(ATTACHMENT_KEY.to_vec(), StringFormat::Literal);
    let entry_ref = Object::Reference(filespec_id);

    if let Some(ef_id) = structure.ef_names_ref {
        let ef_obj = doc.get_object_mut(ef_id)?;
        if let Object::Dictionary(d) = ef_obj {
            match d.get_mut(b"Names") {
                Ok(Object::Array(arr)) => {
                    arr.push(entry_key);
                    arr.push(entry_ref);
                }
                _ => {
                    d.set("Names", Object::Array(vec![entry_key, entry_ref]));
                }
            }
        }
    } else if let Some(nid) = structure.names_ref {
        let mut ef_dict = Dictionary::new();
        ef_dict.set("Names", Object::Array(vec![entry_key, entry_ref]));
        let ef_obj_id = doc.add_object(Object::Dictionary(ef_dict));

        let names_obj = doc.get_object_mut(nid)?;
        if let Object::Dictionary(d) = names_obj {
            d.set("EmbeddedFiles", Object::Reference(ef_obj_id));
        }
    } else {
        let mut ef_dict = Dictionary::new();
        ef_dict.set("Names", Object::Array(vec![entry_key, entry_ref]));
        let ef_obj_id = doc.add_object(Object::Dictionary(ef_dict));

        let mut names_dict = Dictionary::new();
        names_dict.set("EmbeddedFiles", Object::Reference(ef_obj_id));
        let names_obj_id = doc.add_object(Object::Dictionary(names_dict));

        let catalog_obj = doc.get_object_mut(structure.root_ref)?;
        if let Object::Dictionary(d) = catalog_obj {
            d.set("Names", Object::Reference(names_obj_id));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Text-annotation sync
// ---------------------------------------------------------------------------

struct ExistingNote {
    annot_id: ObjectId,
    page_id: ObjectId,
    /// Popup annotation tied to this note (deleted along with it).
    popup_id: Option<ObjectId>,
}

/// All Text annotations in the document, keyed by comment id, plus each
/// note's popup child if it has one.
fn collect_text_annots(doc: &Document) -> HashMap<String, ExistingNote> {
    let mut notes: HashMap<String, ExistingNote> = HashMap::new();
    // Popup → parent links discovered while walking; resolved afterwards.
    let mut popups: Vec<(ObjectId, ObjectId)> = Vec::new(); // (parent, popup)

    for (_page_num, page_id) in doc.get_pages() {
        for annot_id in annot_refs(doc, page_id) {
            let Some(dict) = get_dict(doc, annot_id) else { continue };
            match dict_subtype(dict) {
                Some(b"Text") => {
                    let id = annot_comment_id(dict, annot_id);
                    notes.insert(id, ExistingNote { annot_id, page_id, popup_id: None });
                }
                Some(b"Popup") => {
                    if let Some(parent) = dict.get(b"Parent").ok().and_then(obj_as_ref) {
                        popups.push((parent, annot_id));
                    }
                }
                _ => {}
            }
        }
    }

    for (parent, popup) in popups {
        if let Some(note) = notes.values_mut().find(|n| n.annot_id == parent) {
            note.popup_id = Some(popup);
        }
    }
    notes
}

/// Build a fresh Text-annotation dictionary for a comment.
fn build_note_dict(comment: &Comment, pw: f64, ph: f64) -> Dictionary {
    // Pin tip (normalized, top-left origin) → PDF coords (bottom-left origin).
    let tip_x = comment.x.clamp(0.0, 1.0) * pw;
    let tip_y = (1.0 - comment.y.clamp(0.0, 1.0)) * ph;
    let (r, g, b) = hex_to_rgb_f32(&comment.color);

    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"Annot".to_vec()));
    d.set("Subtype", Object::Name(b"Text".to_vec()));
    d.set(
        "Rect",
        Object::Array(vec![
            Object::Real((tip_x - NOTE_W / 2.0) as f32),
            Object::Real(tip_y as f32),
            Object::Real((tip_x + NOTE_W / 2.0) as f32),
            Object::Real((tip_y + NOTE_H) as f32),
        ]),
    );
    d.set(
        "Contents",
        Object::String(pdf_text_encode(&comment.text), StringFormat::Literal),
    );
    d.set(
        "C",
        Object::Array(vec![Object::Real(r), Object::Real(g), Object::Real(b)]),
    );
    d.set("F", Object::Integer(4)); // Print
    d.set("Name", Object::Name(b"Comment".to_vec()));
    d.set(
        "NM",
        Object::String(pdf_text_encode(&comment.id), StringFormat::Literal),
    );
    d.set(
        "T",
        Object::String(pdf_text_encode(&author_name()), StringFormat::Literal),
    );
    d.set(
        "CreationDate",
        Object::String(pdf_date(comment.created_at).into_bytes(), StringFormat::Literal),
    );
    d.set(
        "M",
        Object::String(pdf_date(now_millis()).into_bytes(), StringFormat::Literal),
    );
    d.set("Open", Object::Boolean(false));
    d
}

/// Mirror `comments` into the document's Text annotations. Marks each synced
/// comment, creates missing notes, updates changed ones, and removes notes
/// whose comment is gone.
fn sync_text_annots(doc: &mut Document, comments: &mut [Comment]) {
    let pages = doc.get_pages(); // BTreeMap<u32 (1-based), ObjectId>
    let existing = collect_text_annots(doc);
    let mut keep: HashSet<ObjectId> = HashSet::new();

    for comment in comments.iter_mut() {
        if let Some(note) = existing.get(&comment.id) {
            keep.insert(note.annot_id);
            comment.synced = true;

            // Read current state first (immutable), then patch what changed.
            let (cur_text, cur_color) = match get_dict(doc, note.annot_id) {
                Some(d) => (
                    dict_string(d, b"Contents").unwrap_or_default(),
                    match d.get(b"C") {
                        Ok(Object::Array(arr)) => color_array_to_hex(arr),
                        _ => None,
                    },
                ),
                None => continue,
            };
            let text_changed = cur_text != comment.text;
            let color_changed =
                !cur_color.as_deref().unwrap_or("").eq_ignore_ascii_case(&comment.color);
            if !text_changed && !color_changed {
                continue;
            }

            let now = pdf_date(now_millis());
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(note.annot_id) {
                if text_changed {
                    d.set(
                        "Contents",
                        Object::String(pdf_text_encode(&comment.text), StringFormat::Literal),
                    );
                }
                if color_changed {
                    let (r, g, b) = hex_to_rgb_f32(&comment.color);
                    d.set(
                        "C",
                        Object::Array(vec![
                            Object::Real(r),
                            Object::Real(g),
                            Object::Real(b),
                        ]),
                    );
                    // Stale icon appearance would override the new color.
                    d.remove(b"AP");
                }
                d.set("M", Object::String(now.into_bytes(), StringFormat::Literal));
            }
        } else {
            let Some(&page_id) = pages.get(&comment.page_index) else {
                // Page out of range (stale comment) — keep in sidecar only.
                continue;
            };
            let (pw, ph) = get_page_dims(doc, page_id);
            let note_dict = build_note_dict(comment, pw, ph);
            let annot_id = doc.add_object(note_dict);
            if push_annot_ref(doc, page_id, annot_id).is_ok() {
                comment.synced = true;
            }
        }
    }

    // Comments deleted in Qyra → remove their annotations (and popups).
    for note in existing.values() {
        if keep.contains(&note.annot_id) {
            continue;
        }
        remove_annot_ref(doc, note.page_id, note.annot_id);
        doc.objects.remove(&note.annot_id);
        if let Some(popup_id) = note.popup_id {
            remove_annot_ref(doc, note.page_id, popup_id);
            doc.objects.remove(&popup_id);
        }
    }
}

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn load_comments(path: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let doc = Document::load(&path)?;

        let sidecar = read_sidecar(&doc);
        let mut by_id: HashMap<String, Comment> = sidecar
            .iter()
            .map(|c| (c.id.clone(), c.clone()))
            .collect();

        let mut out: Vec<Comment> = Vec::new();

        // Import every Text annotation, merging sidecar extras by id.
        for (page_num, page_id) in doc.get_pages() {
            let (pw, ph) = get_page_dims(&doc, page_id);
            if pw <= 0.0 || ph <= 0.0 {
                continue;
            }
            for annot_id in annot_refs(&doc, page_id) {
                let Some(dict) = get_dict(&doc, annot_id) else { continue };
                if dict_subtype(dict) != Some(b"Text") {
                    continue;
                }

                let id = annot_comment_id(dict, annot_id);
                let side = by_id.remove(&id);

                // Pin tip = bottom-center of the note icon's /Rect.
                let (x, y) = match dict.get(b"Rect") {
                    Ok(Object::Array(arr)) if arr.len() >= 4 => {
                        let num = |o: &Object| -> f64 {
                            o.as_i64().map(|v| v as f64)
                                .or_else(|_| o.as_f32().map(|v| v as f64))
                                .unwrap_or(0.0)
                        };
                        let (x0, y0, x1, y1) =
                            (num(&arr[0]), num(&arr[1]), num(&arr[2]), num(&arr[3]));
                        let cx = (x0 + x1) / 2.0;
                        let bottom = y0.min(y1);
                        ((cx / pw).clamp(0.0, 1.0), (1.0 - bottom / ph).clamp(0.0, 1.0))
                    }
                    _ => match &side {
                        Some(s) => (s.x, s.y),
                        None => continue,
                    },
                };

                let text = dict_string(dict, b"Contents").unwrap_or_default();
                let color = match dict.get(b"C") {
                    Ok(Object::Array(arr)) => color_array_to_hex(arr),
                    _ => None,
                };
                let created_at = side
                    .as_ref()
                    .map(|s| s.created_at)
                    .or_else(|| {
                        dict_string(dict, b"CreationDate")
                            .or_else(|| dict_string(dict, b"M"))
                            .and_then(|d| millis_from_pdf_date(&d))
                    })
                    .unwrap_or(0.0);

                out.push(Comment {
                    id,
                    page_index: page_num,
                    x,
                    y,
                    text,
                    color: color
                        .or_else(|| side.as_ref().map(|s| s.color.clone()))
                        .unwrap_or_else(|| DEFAULT_COLOR.to_string()),
                    resolved: side.as_ref().map(|s| s.resolved).unwrap_or(false),
                    created_at,
                    quote: side.and_then(|s| s.quote),
                    synced: true,
                });
            }
        }

        // Sidecar leftovers: keep only entries never synced to an annotation
        // (legacy files). Synced-but-missing means deleted in another viewer.
        for c in sidecar {
            if !c.synced && by_id.contains_key(&c.id) {
                out.push(c);
            }
        }

        serde_json::to_string(&out).map_err(|e| AppError::Other(e.to_string()))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn save_comments(path: String, comments_json: String) -> AppResult<()> {
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let mut comments: Vec<Comment> = serde_json::from_str(&comments_json)
            .map_err(|e| AppError::Invalid(format!("comments JSON: {e}")))?;

        let mut doc = Document::load(&path)?;

        sync_text_annots(&mut doc, &mut comments);

        let json_bytes = serde_json::to_vec(&comments)
            .map_err(|e| AppError::Other(e.to_string()))?;
        write_sidecar(&mut doc, json_bytes)?;

        doc.save(&path)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
