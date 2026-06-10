/// Content-stream placement analysis.
///
/// Ghostscript downsamples an image to a target *resolution* (DPI), which means
/// it must know how large each image is actually drawn on the page. That size
/// comes from the current transformation matrix (CTM) in effect at the image's
/// `Do` operator. This module walks every page's content stream (recursing into
/// Form XObjects), tracks the CTM through `q`/`Q`/`cm`, and records the largest
/// on-page footprint (in points) for each image XObject.
///
/// The result feeds `ImagePlan`: effective DPI = image_pixels / (footprint/72).
use std::collections::HashMap;

use crate::pdf::parser::PdfReader;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject};

/// Max drawn footprint per image XObject, in PDF points (1/72 inch).
pub type PlacementMap = HashMap<ObjectId, (f64, f64)>;

const MAX_DEPTH: u32 = 12;

/// Build the placement map for the whole document.
pub fn analyze_placements(reader: &mut PdfReader) -> PlacementMap {
    let mut map = PlacementMap::new();
    let page_ids = match reader.pages() {
        Ok(p) => p,
        Err(_) => return map,
    };

    for page_id in page_ids {
        let resources = match effective_resources(reader, page_id) {
            Some(r) => r,
            None => continue,
        };
        let content = match page_content_bytes(reader, page_id) {
            Some(c) => c,
            None => continue,
        };
        let mut visited = Vec::new();
        walk(reader, &content, &resources, [1.0, 0.0, 0.0, 1.0], &mut map, 0, &mut visited);
    }
    map
}

/// Record `id` with the larger of its existing and new footprint.
fn record(map: &mut PlacementMap, id: ObjectId, w: f64, h: f64) {
    let e = map.entry(id).or_insert((0.0, 0.0));
    if w > e.0 {
        e.0 = w;
    }
    if h > e.1 {
        e.1 = h;
    }
}

/// Concatenate matrix `m` (applied first) onto CTM `c`. Only the 2x2 scale/skew
/// part matters for footprint, so translation is dropped.
fn concat(m: [f64; 4], c: [f64; 4]) -> [f64; 4] {
    [
        m[0] * c[0] + m[1] * c[2],
        m[0] * c[1] + m[1] * c[3],
        m[2] * c[0] + m[3] * c[2],
        m[2] * c[1] + m[3] * c[3],
    ]
}

fn footprint(ctm: [f64; 4]) -> (f64, f64) {
    let w = (ctm[0] * ctm[0] + ctm[1] * ctm[1]).sqrt();
    let h = (ctm[2] * ctm[2] + ctm[3] * ctm[3]).sqrt();
    (w, h)
}

#[allow(clippy::too_many_arguments)]
fn walk(
    reader: &mut PdfReader,
    content: &[u8],
    resources: &PdfDict,
    base_ctm: [f64; 4],
    map: &mut PlacementMap,
    depth: u32,
    visited: &mut Vec<ObjectId>,
) {
    let xobjects = xobject_map(reader, resources);

    let mut ctm = base_ctm;
    let mut stack: Vec<[f64; 4]> = Vec::new();
    let mut nums: Vec<f64> = Vec::new();
    let mut last_name: Option<Vec<u8>> = None;

    let mut lex = ContentLexer::new(content);
    while let Some(tok) = lex.next() {
        match tok {
            Tok::Num(n) => nums.push(n),
            Tok::Name(n) => last_name = Some(n),
            Tok::Op(op) => {
                match op.as_slice() {
                    b"q" => stack.push(ctm),
                    b"Q" => {
                        if let Some(c) = stack.pop() {
                            ctm = c;
                        }
                    }
                    b"cm" => {
                        let l = nums.len();
                        if l >= 6 {
                            let m = [nums[l - 6], nums[l - 5], nums[l - 4], nums[l - 3]];
                            ctm = concat(m, ctm);
                        }
                    }
                    b"Do" => {
                        if let Some(name) = last_name.take() {
                            if let Some(&id) = xobjects.get(&name) {
                                handle_do(reader, id, ctm, map, depth, visited);
                            }
                        }
                    }
                    b"BI" => lex.skip_inline_image(),
                    _ => {}
                }
                nums.clear();
                last_name = None;
            }
            Tok::Other => {
                // Strings/arrays/dicts are operands we don't model; a following
                // operator will clear the stack anyway.
            }
        }
    }
}

fn handle_do(
    reader: &mut PdfReader,
    id: ObjectId,
    ctm: [f64; 4],
    map: &mut PlacementMap,
    depth: u32,
    visited: &mut Vec<ObjectId>,
) {
    if visited.contains(&id) || depth >= MAX_DEPTH {
        return;
    }
    let obj = match reader.get_object(id) {
        Ok(o) => o.clone(),
        Err(_) => return,
    };
    let dict = match obj.as_dict() {
        Some(d) => d.clone(),
        None => {
            reader.uncache(id);
            return;
        }
    };
    let subtype = dict.get_subtype().map(|s| s.to_vec());
    match subtype.as_deref() {
        Some(b"Image") => {
            let (w, h) = footprint(ctm);
            record(map, id, w, h);
            // Propagate the same footprint to a soft mask so it downsamples too.
            if let Some(sm) = dict.get(b"SMask").and_then(|v| v.as_reference()) {
                record(map, sm, w, h);
            }
            reader.uncache(id);
        }
        Some(b"Form") => {
            let form_matrix = matrix_from(&dict).unwrap_or([1.0, 0.0, 0.0, 1.0]);
            let form_ctm = concat(form_matrix, ctm);
            let form_res = dict
                .get(b"Resources")
                .and_then(|v| resolve_dict(reader, v))
                .unwrap_or_default();
            let content = stream_bytes(reader, id);
            reader.uncache(id);
            if let Some(content) = content {
                visited.push(id);
                walk(reader, &content, &form_res, form_ctm, map, depth + 1, visited);
                visited.pop();
            }
        }
        _ => {
            reader.uncache(id);
        }
    }
}

// ---------------------------------------------------------------------------
// Resource / stream helpers
// ---------------------------------------------------------------------------

fn matrix_from(dict: &PdfDict) -> Option<[f64; 4]> {
    let arr = dict.get(b"Matrix")?.as_array()?;
    if arr.len() < 4 {
        return None;
    }
    let n = |o: &PdfObject| match o {
        PdfObject::Integer(i) => Some(*i as f64),
        PdfObject::Real(r) => Some(*r),
        _ => None,
    };
    Some([n(&arr[0])?, n(&arr[1])?, n(&arr[2])?, n(&arr[3])?])
}

/// Resolve a value that should be a dict (direct or indirect).
fn resolve_dict(reader: &mut PdfReader, v: &PdfObject) -> Option<PdfDict> {
    match v {
        PdfObject::Dictionary(d) => Some(d.clone()),
        PdfObject::Reference(id) => {
            let id = *id;
            let d = reader.get_object(id).ok()?.as_dict().cloned();
            d
        }
        _ => None,
    }
}

/// Page resources, walking up the /Parent chain when a page omits them.
fn effective_resources(reader: &mut PdfReader, page_id: ObjectId) -> Option<PdfDict> {
    let mut node = page_id;
    for _ in 0..32 {
        let obj = reader.get_object(node).ok()?.clone();
        let dict = obj.as_dict()?;
        if let Some(res) = dict.get(b"Resources") {
            let res = res.clone();
            if let Some(d) = resolve_dict(reader, &res) {
                return Some(d);
            }
        }
        match dict.get(b"Parent").and_then(|v| v.as_reference()) {
            Some(parent) => node = parent,
            None => return None,
        }
    }
    None
}

/// Build name → ObjectId for the /XObject sub-dictionary of `resources`.
fn xobject_map(reader: &mut PdfReader, resources: &PdfDict) -> HashMap<Vec<u8>, ObjectId> {
    let mut out = HashMap::new();
    let xobj = match resources.get(b"XObject") {
        Some(v) => v.clone(),
        None => return out,
    };
    let dict = match resolve_dict(reader, &xobj) {
        Some(d) => d,
        None => return out,
    };
    for (name, val) in dict.iter() {
        if let Some(id) = val.as_reference() {
            out.insert(name.clone(), id);
        }
    }
    out
}

/// Concatenated, filter-decoded /Contents bytes for a page.
fn page_content_bytes(reader: &mut PdfReader, page_id: ObjectId) -> Option<Vec<u8>> {
    let page = reader.get_object(page_id).ok()?.clone();
    let contents = page.as_dict()?.get(b"Contents")?.clone();
    let ids: Vec<ObjectId> = match &contents {
        PdfObject::Reference(id) => vec![*id],
        PdfObject::Array(arr) => arr.iter().filter_map(|o| o.as_reference()).collect(),
        _ => return None,
    };
    let mut out = Vec::new();
    for id in ids {
        if let Some(bytes) = stream_bytes(reader, id) {
            out.extend_from_slice(&bytes);
            out.push(b'\n');
        }
        reader.uncache(id);
    }
    Some(out)
}

/// Decode a stream object's bytes (no-op if it isn't a stream).
fn stream_bytes(reader: &mut PdfReader, id: ObjectId) -> Option<Vec<u8>> {
    let obj = reader.get_object(id).ok()?;
    match obj {
        PdfObject::Stream(s) => s.decode().ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Minimal content-stream tokenizer
// ---------------------------------------------------------------------------

enum Tok {
    Num(f64),
    Name(Vec<u8>),
    Op(Vec<u8>),
    Other,
}

struct ContentLexer<'a> {
    data: &'a [u8],
    pos: usize,
}

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b'\0' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}
#[inline]
fn is_delim(b: u8) -> bool {
    matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

impl<'a> ContentLexer<'a> {
    fn new(data: &'a [u8]) -> Self {
        ContentLexer { data, pos: 0 }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if b == b'%' {
                while self.pos < self.data.len() && self.data[self.pos] != b'\n' && self.data[self.pos] != b'\r' {
                    self.pos += 1;
                }
            } else if is_ws(b) {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn next(&mut self) -> Option<Tok> {
        self.skip_ws();
        if self.pos >= self.data.len() {
            return None;
        }
        let b = self.data[self.pos];
        match b {
            b'/' => Some(self.read_name()),
            b'(' => {
                self.skip_literal_string();
                Some(Tok::Other)
            }
            b'<' => {
                if self.data.get(self.pos + 1) == Some(&b'<') {
                    self.skip_dict();
                } else {
                    self.skip_hex_string();
                }
                Some(Tok::Other)
            }
            b'[' | b']' | b'{' | b'}' | b'>' => {
                self.pos += 1;
                Some(Tok::Other)
            }
            b'+' | b'-' | b'.' | b'0'..=b'9' => Some(self.read_number()),
            _ => Some(self.read_keyword()),
        }
    }

    fn read_name(&mut self) -> Tok {
        self.pos += 1; // skip '/'
        let mut out = Vec::new();
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if is_ws(b) || is_delim(b) {
                break;
            }
            if b == b'#' && self.pos + 2 < self.data.len() {
                let hi = hexval(self.data[self.pos + 1]);
                let lo = hexval(self.data[self.pos + 2]);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push(h * 16 + l);
                    self.pos += 3;
                    continue;
                }
            }
            out.push(b);
            self.pos += 1;
        }
        Tok::Name(out)
    }

    fn read_number(&mut self) -> Tok {
        let start = self.pos;
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E') {
                self.pos += 1;
            } else {
                break;
            }
        }
        let s = std::str::from_utf8(&self.data[start..self.pos]).unwrap_or("0");
        match s.parse::<f64>() {
            Ok(n) => Tok::Num(n),
            Err(_) => Tok::Other,
        }
    }

    fn read_keyword(&mut self) -> Tok {
        let start = self.pos;
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if is_ws(b) || is_delim(b) {
                break;
            }
            self.pos += 1;
        }
        if self.pos == start {
            self.pos += 1; // never stall on a stray delimiter
            return Tok::Other;
        }
        Tok::Op(self.data[start..self.pos].to_vec())
    }

    fn skip_literal_string(&mut self) {
        self.pos += 1; // (
        let mut depth = 1;
        while self.pos < self.data.len() && depth > 0 {
            match self.data[self.pos] {
                b'\\' => self.pos += 2,
                b'(' => {
                    depth += 1;
                    self.pos += 1;
                }
                b')' => {
                    depth -= 1;
                    self.pos += 1;
                }
                _ => self.pos += 1,
            }
        }
    }

    fn skip_hex_string(&mut self) {
        self.pos += 1; // <
        while self.pos < self.data.len() && self.data[self.pos] != b'>' {
            self.pos += 1;
        }
        if self.pos < self.data.len() {
            self.pos += 1;
        }
    }

    fn skip_dict(&mut self) {
        self.pos += 2; // <<
        let mut depth = 1;
        while self.pos < self.data.len() && depth > 0 {
            if self.data[self.pos] == b'<' && self.data.get(self.pos + 1) == Some(&b'<') {
                depth += 1;
                self.pos += 2;
            } else if self.data[self.pos] == b'>' && self.data.get(self.pos + 1) == Some(&b'>') {
                depth -= 1;
                self.pos += 2;
            } else {
                self.pos += 1;
            }
        }
    }

    /// Skip an inline image (`BI` already consumed): scan past `ID`, then to the
    /// `EI` delimiter surrounded by whitespace.
    fn skip_inline_image(&mut self) {
        // Find `ID`.
        while self.pos + 1 < self.data.len() {
            if self.data[self.pos] == b'I' && self.data[self.pos + 1] == b'D' {
                self.pos += 2;
                break;
            }
            self.pos += 1;
        }
        // One whitespace byte after ID is part of the syntax, then binary data.
        if self.pos < self.data.len() && is_ws(self.data[self.pos]) {
            self.pos += 1;
        }
        while self.pos + 1 < self.data.len() {
            let prev_ws = self.pos == 0 || is_ws(self.data[self.pos - 1]);
            if prev_ws
                && self.data[self.pos] == b'E'
                && self.data[self.pos + 1] == b'I'
                && (self.pos + 2 >= self.data.len() || is_ws(self.data[self.pos + 2]))
            {
                self.pos += 2;
                return;
            }
            self.pos += 1;
        }
        self.pos = self.data.len();
    }
}

#[inline]
fn hexval(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctm_footprint_from_cm() {
        // 200 wide, 100 tall placement.
        let content = b"q 200 0 0 100 50 50 cm /Im0 Do Q";
        let mut lex = ContentLexer::new(content);
        let mut nums = Vec::new();
        let mut ctm = [1.0, 0.0, 0.0, 1.0];
        while let Some(t) = lex.next() {
            match t {
                Tok::Num(n) => nums.push(n),
                Tok::Op(op) => {
                    if op.as_slice() == b"cm" {
                        let l = nums.len();
                        ctm = concat([nums[l - 6], nums[l - 5], nums[l - 4], nums[l - 3]], ctm);
                    }
                    nums.clear();
                }
                _ => {}
            }
        }
        let (w, h) = footprint(ctm);
        assert!((w - 200.0).abs() < 0.01);
        assert!((h - 100.0).abs() < 0.01);
    }
}
