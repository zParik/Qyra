use std::collections::HashMap;

use crate::pdf::error::PdfError;

/// (object_number, generation_number)
pub type ObjectId = (u32, u16);

// ---------------------------------------------------------------------------
// PdfObject
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum PdfObject {
    Null,
    Boolean(bool),
    Integer(i64),
    Real(f64),
    /// Decoded literal string — escape sequences already applied.
    StringLiteral(Vec<u8>),
    /// Decoded hex string — hex pairs already converted to bytes.
    HexString(Vec<u8>),
    /// Name without the leading `/`.
    Name(Vec<u8>),
    Array(Vec<PdfObject>),
    Dictionary(PdfDict),
    Stream(PdfStream),
    Reference(ObjectId),
}

impl PdfObject {
    /// Return the integer value if this is an Integer.
    pub fn as_integer(&self) -> Option<i64> {
        match self {
            PdfObject::Integer(n) => Some(*n),
            _ => None,
        }
    }

    /// Return the name bytes (without `/`) if this is a Name.
    pub fn as_name(&self) -> Option<&[u8]> {
        match self {
            PdfObject::Name(n) => Some(n),
            _ => None,
        }
    }

    /// Return the reference if this is a Reference.
    pub fn as_reference(&self) -> Option<ObjectId> {
        match self {
            PdfObject::Reference(id) => Some(*id),
            _ => None,
        }
    }

    /// Return the dictionary if this is a Dictionary or a Stream.
    pub fn as_dict(&self) -> Option<&PdfDict> {
        match self {
            PdfObject::Dictionary(d) => Some(d),
            PdfObject::Stream(s) => Some(&s.dict),
            _ => None,
        }
    }

    /// Return a mutable reference to the dictionary.
    #[allow(dead_code)]
    pub fn as_dict_mut(&mut self) -> Option<&mut PdfDict> {
        match self {
            PdfObject::Dictionary(d) => Some(d),
            PdfObject::Stream(s) => Some(&mut s.dict),
            _ => None,
        }
    }

    /// Return the array slice if this is an Array.
    pub fn as_array(&self) -> Option<&[PdfObject]> {
        match self {
            PdfObject::Array(a) => Some(a),
            _ => None,
        }
    }

    /// Return the string bytes regardless of literal vs hex variant.
    #[allow(dead_code)]
    pub fn as_string_bytes(&self) -> Option<&[u8]> {
        match self {
            PdfObject::StringLiteral(b) | PdfObject::HexString(b) => Some(b),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// PdfDict
// ---------------------------------------------------------------------------

/// An ordered dictionary of PDF key-value pairs.
///
/// Using `Vec` instead of `HashMap` because:
/// - Preserves insertion order (important for deterministic output)
/// - No `Hash` impl needed for `Vec<u8>` keys
/// - Linear scan is fast enough for typical PDF dictionaries (< 30 entries)
#[derive(Debug, Clone, Default)]
pub struct PdfDict(pub Vec<(Vec<u8>, PdfObject)>);

impl PdfDict {
    pub fn new() -> Self {
        PdfDict(Vec::new())
    }

    pub fn get(&self, key: &[u8]) -> Option<&PdfObject> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    #[allow(dead_code)]
    pub fn get_mut(&mut self, key: &[u8]) -> Option<&mut PdfObject> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn set(&mut self, key: impl Into<Vec<u8>>, val: PdfObject) {
        let key = key.into();
        if let Some((_, v)) = self.0.iter_mut().find(|(k, _)| k == &key) {
            *v = val;
        } else {
            self.0.push((key, val));
        }
    }

    pub fn remove(&mut self, key: &[u8]) {
        self.0.retain(|(k, _)| k != key);
    }

    pub fn contains_key(&self, key: &[u8]) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&Vec<u8>, &PdfObject)> {
        self.0.iter().map(|(k, v)| (k, v))
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Convenience: get the /Type name value if present.
    pub fn get_type(&self) -> Option<&[u8]> {
        self.get(b"Type")?.as_name()
    }

    /// Convenience: get the /Subtype name value if present.
    pub fn get_subtype(&self) -> Option<&[u8]> {
        self.get(b"Subtype")?.as_name()
    }
}

// ---------------------------------------------------------------------------
// PdfStream
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PdfStream {
    pub dict: PdfDict,
    /// Raw (encoded) bytes as stored on disk — between `stream\n` and `endstream`.
    pub raw_bytes: Vec<u8>,
}

impl PdfStream {
    /// Return the first filter name, if any.
    pub fn filter_name(&self) -> Option<&[u8]> {
        match self.dict.get(b"Filter")? {
            PdfObject::Name(n) => Some(n),
            PdfObject::Array(arr) => arr.first()?.as_name(),
            _ => None,
        }
    }

    /// Decode the stream data by applying the Filter chain.
    ///
    /// Currently supports: FlateDecode (with optional PNG predictor), DCTDecode (pass-through),
    /// and no filter (raw).
    pub fn decode(&self) -> Result<Vec<u8>, PdfError> {
        let filter = match self.dict.get(b"Filter") {
            None => return Ok(self.raw_bytes.clone()),
            Some(f) => f,
        };

        // Normalise to a single filter name (we don't support filter chains beyond one step)
        let filter_name: &[u8] = match filter {
            PdfObject::Name(n) => n,
            PdfObject::Array(arr) => {
                if arr.len() == 1 {
                    arr[0].as_name().ok_or_else(|| {
                        PdfError::ParseError("Filter array contains non-name".into())
                    })?
                } else if arr.is_empty() {
                    return Ok(self.raw_bytes.clone());
                } else {
                    // Multi-filter chain: apply each in order (limited support)
                    return self.decode_chain(arr);
                }
            }
            _ => {
                return Err(PdfError::ParseError(
                    "Filter is neither Name nor Array".into(),
                ))
            }
        };

        match filter_name {
            b"FlateDecode" | b"Fl" => self.decode_flate(),
            b"DCTDecode" | b"DCT" => {
                // JPEG — raw bytes are already the JPEG payload
                Ok(self.raw_bytes.clone())
            }
            b"Identity" => Ok(self.raw_bytes.clone()),
            other => Err(PdfError::UnsupportedFilter(
                String::from_utf8_lossy(other).into_owned(),
            )),
        }
    }

    fn decode_chain(&self, filters: &[PdfObject]) -> Result<Vec<u8>, PdfError> {
        let mut data = self.raw_bytes.clone();
        for filter in filters {
            let name = filter
                .as_name()
                .ok_or_else(|| PdfError::ParseError("Filter chain element is not a Name".into()))?;
            data = match name {
                b"FlateDecode" | b"Fl" => {
                    let tmp = PdfStream {
                        dict: self.dict.clone(),
                        raw_bytes: data,
                    };
                    tmp.decode_flate()?
                }
                b"DCTDecode" | b"DCT" => data,
                b"Identity" => data,
                other => {
                    return Err(PdfError::UnsupportedFilter(
                        String::from_utf8_lossy(other).into_owned(),
                    ))
                }
            };
        }
        Ok(data)
    }

    fn decode_flate(&self) -> Result<Vec<u8>, PdfError> {
        use flate2::read::ZlibDecoder;
        use std::io::Read;

        let mut decoder = ZlibDecoder::new(self.raw_bytes.as_slice());
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).map_err(|e| {
            PdfError::ParseError(format!("FlateDecode decompression failed: {}", e))
        })?;

        // Apply PNG predictor if present
        if let Some(parms) = self.dict.get(b"DecodeParms") {
            if let Some(dict) = parms.as_dict() {
                if let Some(pred) = dict.get(b"Predictor").and_then(|p| p.as_integer()) {
                    if pred >= 10 {
                        let colors = dict
                            .get(b"Colors")
                            .and_then(|v| v.as_integer())
                            .unwrap_or(1) as usize;
                        let bpc = dict
                            .get(b"BitsPerComponent")
                            .and_then(|v| v.as_integer())
                            .unwrap_or(8) as usize;
                        let columns = dict
                            .get(b"Columns")
                            .and_then(|v| v.as_integer())
                            .unwrap_or(1) as usize;
                        let row_width = (colors * bpc * columns + 7) / 8;
                        out = apply_png_predictor(&out, row_width)?;
                    }
                }
            }
        }

        Ok(out)
    }
}

/// Apply PNG unfilter (predictors 10-15) to raw decompressed data.
///
/// Each row starts with a 1-byte filter type:
///   0 = None, 1 = Sub, 2 = Up, 3 = Average, 4 = Paeth
pub fn apply_png_predictor(data: &[u8], row_width: usize) -> Result<Vec<u8>, PdfError> {
    if row_width == 0 {
        return Ok(data.to_vec());
    }
    let stride = row_width + 1; // +1 for the predictor byte
    if data.len() % stride != 0 {
        return Err(PdfError::ParseError(format!(
            "PNG predictor data length {} is not a multiple of stride {}",
            data.len(),
            stride
        )));
    }
    let num_rows = data.len() / stride;
    let mut out = vec![0u8; num_rows * row_width];
    let mut prev_row = vec![0u8; row_width];

    for row in 0..num_rows {
        let filter_byte = data[row * stride];
        let raw = &data[row * stride + 1..row * stride + 1 + row_width];
        let cur = &mut out[row * row_width..(row + 1) * row_width];

        match filter_byte {
            0 => cur.copy_from_slice(raw),
            1 => {
                // Sub
                for i in 0..row_width {
                    let left = if i >= 1 { cur[i - 1] } else { 0 };
                    cur[i] = raw[i].wrapping_add(left);
                }
            }
            2 => {
                // Up
                for i in 0..row_width {
                    cur[i] = raw[i].wrapping_add(prev_row[i]);
                }
            }
            3 => {
                // Average
                for i in 0..row_width {
                    let left = if i >= 1 { cur[i - 1] as u16 } else { 0 };
                    let up = prev_row[i] as u16;
                    cur[i] = raw[i].wrapping_add(((left + up) / 2) as u8);
                }
            }
            4 => {
                // Paeth
                for i in 0..row_width {
                    let a = if i >= 1 { cur[i - 1] } else { 0 };
                    let b = prev_row[i];
                    let c = if i >= 1 { prev_row[i - 1] } else { 0 };
                    cur[i] = raw[i].wrapping_add(paeth(a, b, c));
                }
            }
            f => {
                return Err(PdfError::ParseError(format!(
                    "Unknown PNG filter byte: {}",
                    f
                )))
            }
        }
        prev_row.copy_from_slice(cur);
    }
    Ok(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a, b, c) = (a as i32, b as i32, c as i32);
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

// ---------------------------------------------------------------------------
// XrefTable
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum XrefEntry {
    Free,
    InUse { offset: u64 },
    /// PDF 1.5+ compressed object: lives inside an object stream.
    Compressed { obj_stream_id: u32, index: u32 },
}

#[derive(Debug, Default)]
pub struct XrefTable {
    pub entries: HashMap<ObjectId, XrefEntry>,
    pub trailer: PdfDict,
}

impl XrefTable {
    pub fn new() -> Self {
        XrefTable::default()
    }

    /// Merge another table into this one; entries already present are NOT overwritten.
    /// (Used when following /Prev chains — later updates have already been loaded first.)
    pub fn merge_older(&mut self, older: XrefTable) {
        for (id, entry) in older.entries {
            self.entries.entry(id).or_insert(entry);
        }
        // Merge trailer keys that we don't already have
        for (k, v) in older.trailer.0 {
            if !self.trailer.contains_key(&k) {
                self.trailer.0.push((k, v));
            }
        }
    }
}
