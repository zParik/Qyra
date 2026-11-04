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
            b"FlateDecode" | b"Fl" => decode_flate(&self.raw_bytes, self.decode_parms(0)?),
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
        for (i, filter) in filters.iter().enumerate() {
            let name = filter
                .as_name()
                .ok_or_else(|| PdfError::ParseError("Filter chain element is not a Name".into()))?;
            data = match name {
                b"FlateDecode" | b"Fl" => decode_flate(&data, self.decode_parms(i)?)?,
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

    /// The `/DecodeParms` dict for the filter at `index`. A single dict applies
    /// to every filter; an array holds one entry (dict or null) per filter.
    /// Anything else (an indirect reference, which cannot be resolved here) is
    /// an error: decoding without its predictor would leave predictor bytes in
    /// the data, and the stream must then be left untouched.
    fn decode_parms(&self, index: usize) -> Result<Option<&PdfDict>, PdfError> {
        let unsupported = || PdfError::UnsupportedFilter("indirect or malformed /DecodeParms".into());
        match self.dict.get(b"DecodeParms") {
            None | Some(PdfObject::Null) => Ok(None),
            Some(PdfObject::Dictionary(d)) => Ok(Some(d)),
            Some(PdfObject::Array(arr)) => match arr.get(index) {
                None | Some(PdfObject::Null) => Ok(None),
                Some(PdfObject::Dictionary(d)) => Ok(Some(d)),
                Some(_) => Err(unsupported()),
            },
            Some(_) => Err(unsupported()),
        }
    }
}

/// Largest inflated size of one stream that is decoded (512 MiB).
const MAX_INFLATED_BYTES: u64 = 512 * 1024 * 1024;

fn decode_flate(raw: &[u8], parms: Option<&PdfDict>) -> Result<Vec<u8>, PdfError> {
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    // A few hundred KB can inflate to gigabytes (a Flate bomb); past the cap
    // the stream is treated as undecodable and left untouched.
    let mut decoder = ZlibDecoder::new(raw).take(MAX_INFLATED_BYTES + 1);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).map_err(|e| {
        PdfError::ParseError(format!("FlateDecode decompression failed: {}", e))
    })?;
    if out.len() as u64 > MAX_INFLATED_BYTES {
        return Err(PdfError::ParseError("FlateDecode output exceeds the size limit".into()));
    }

    let Some(parms) = parms else { return Ok(out) };
    // A parameter that is present but not an integer (or a whole real) is
    // malformed: falling back to the default would mis-decode silently.
    let int = |key: &[u8], default: i64| -> Result<i64, PdfError> {
        match parms.get(key) {
            None => Ok(default),
            Some(PdfObject::Integer(n)) => Ok(*n),
            Some(PdfObject::Real(r)) if r.fract() == 0.0 => Ok(*r as i64),
            Some(_) => Err(PdfError::UnsupportedFilter(format!(
                "non-integer /{} in /DecodeParms",
                String::from_utf8_lossy(key)
            ))),
        }
    };
    match int(b"Predictor", 1)? {
        p if p <= 1 => Ok(out),
        // TIFF predictor 2 is not implemented. Passing the still-predicted
        // bytes on as "decoded" would corrupt the stream when rewritten.
        2 => Err(PdfError::UnsupportedFilter("TIFF predictor 2".into())),
        p if p >= 10 => {
            let colors = int(b"Colors", 1)?.max(1) as usize;
            let bpc = int(b"BitsPerComponent", 8)?.max(1) as usize;
            let columns = int(b"Columns", 1)?.max(1) as usize;
            // Sizes come from the file: overflow or a row wider than the data
            // is malformed, and must not size an allocation.
            let bits = colors
                .checked_mul(bpc)
                .and_then(|b| b.checked_mul(columns))
                .ok_or_else(|| PdfError::ParseError("PNG predictor row size overflows".into()))?;
            let row_width = bits.div_ceil(8);
            if !out.is_empty() && row_width >= out.len() {
                return Err(PdfError::ParseError("PNG predictor row wider than its data".into()));
            }
            // PNG filters reference the byte one whole PIXEL back (min 1 byte).
            let bpp = ((colors * bpc).div_ceil(8)).max(1);
            apply_png_predictor(&out, row_width, bpp)
        }
        p => Err(PdfError::UnsupportedFilter(format!("predictor {p}"))),
    }
}

/// Apply PNG unfilter (predictors 10-15) to raw decompressed data.
///
/// Each row starts with a 1-byte filter type:
///   0 = None, 1 = Sub, 2 = Up, 3 = Average, 4 = Paeth
///
/// `bpp` is the byte distance to the corresponding byte of the pixel to the
/// left (`ceil(Colors * BitsPerComponent / 8)`, at least 1).
pub fn apply_png_predictor(data: &[u8], row_width: usize, bpp: usize) -> Result<Vec<u8>, PdfError> {
    if row_width == 0 || data.is_empty() {
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
                    let left = if i >= bpp { cur[i - bpp] } else { 0 };
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
                    let left = if i >= bpp { cur[i - bpp] as u16 } else { 0 };
                    let up = prev_row[i] as u16;
                    cur[i] = raw[i].wrapping_add(((left + up) / 2) as u8);
                }
            }
            4 => {
                // Paeth
                for i in 0..row_width {
                    let a = if i >= bpp { cur[i - bpp] } else { 0 };
                    let b = prev_row[i];
                    let c = if i >= bpp { prev_row[i - bpp] } else { 0 };
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

    /// Merge another table into this one; objects already present are NOT overwritten.
    /// (Used when following /Prev chains — later updates have already been loaded first.)
    ///
    /// Matched by object number alone: an update that frees or reuses an
    /// object bumps its generation, and keying by (number, generation) kept
    /// the old generation alive beside the new one.
    pub fn merge_older(&mut self, older: XrefTable) {
        let newer: std::collections::HashSet<u32> = self.entries.keys().map(|(num, _)| *num).collect();
        for (id, entry) in older.entries {
            if !newer.contains(&id.0) {
                self.entries.insert(id, entry);
            }
        }
        // Merge trailer keys that we don't already have
        for (k, v) in older.trailer.0 {
            if !self.trailer.contains_key(&k) {
                self.trailer.0.push((k, v));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::writer::object_stream::flate_compress;

    #[test]
    fn newer_xref_generation_hides_the_older_one() {
        let mut newer = XrefTable::new();
        newer.entries.insert((5, 1), XrefEntry::Free);
        let mut older = XrefTable::new();
        older.entries.insert((5, 0), XrefEntry::InUse { offset: 10 });
        older.entries.insert((6, 0), XrefEntry::InUse { offset: 20 });
        newer.merge_older(older);
        assert!(!newer.entries.contains_key(&(5, 0)), "freed object came back");
        assert!(newer.entries.contains_key(&(6, 0)));
    }

    fn parms(colors: i64, bpc: i64, columns: i64, predictor: i64) -> PdfDict {
        let mut d = PdfDict::new();
        d.set(b"Predictor", PdfObject::Integer(predictor));
        d.set(b"Colors", PdfObject::Integer(colors));
        d.set(b"BitsPerComponent", PdfObject::Integer(bpc));
        d.set(b"Columns", PdfObject::Integer(columns));
        d
    }

    fn flate_stream(filtered: &[u8], decode_parms: PdfObject, filter: PdfObject) -> PdfStream {
        let mut dict = PdfDict::new();
        dict.set(b"Filter", filter);
        dict.set(b"DecodeParms", decode_parms);
        PdfStream { dict, raw_bytes: flate_compress(filtered) }
    }

    #[test]
    fn a_huge_predictor_row_on_empty_data_does_not_allocate_it() {
        let s = flate_stream(b"", PdfObject::Dictionary(parms(1, 8, 4_000_000_000_000, 12)), PdfObject::Name(b"FlateDecode".to_vec()));
        let _ = s.decode();
    }

    #[test]
    fn indirect_decode_parms_refuse_to_decode_instead_of_dropping_the_predictor() {
        // /DecodeParms 12 0 R cannot be resolved here; "decoding" without it
        // would leave predictor bytes in the data.
        let filtered = [1u8, 10, 20, 30, 1, 2, 3];
        let s = flate_stream(&filtered, PdfObject::Reference((12, 0)), PdfObject::Name(b"FlateDecode".to_vec()));
        assert!(s.decode().is_err());
        let s = flate_stream(
            &filtered,
            PdfObject::Array(vec![PdfObject::Reference((12, 0))]),
            PdfObject::Array(vec![PdfObject::Name(b"FlateDecode".to_vec())]),
        );
        assert!(s.decode().is_err());
    }

    #[test]
    fn a_whole_real_predictor_parameter_counts_and_a_fraction_is_an_error() {
        let filtered = [1u8, 10, 20, 30, 1, 2, 3];
        let mut d = parms(3, 8, 2, 15);
        d.set(b"Columns", PdfObject::Real(2.0));
        let s = flate_stream(&filtered, PdfObject::Dictionary(d.clone()), PdfObject::Name(b"FlateDecode".to_vec()));
        assert_eq!(s.decode().unwrap(), vec![10, 20, 30, 11, 22, 33]);
        d.set(b"Columns", PdfObject::Real(2.5));
        let s = flate_stream(&filtered, PdfObject::Dictionary(d), PdfObject::Name(b"FlateDecode".to_vec()));
        assert!(s.decode().is_err());
    }

    #[test]
    fn png_sub_predictor_steps_back_one_pixel_for_rgb() {
        // One RGB row of two pixels, Sub filter: each byte adds the byte one
        // PIXEL (3 bytes) to its left, not the previous byte.
        let filtered = [1u8, 10, 20, 30, 1, 2, 3];
        let s = flate_stream(
            &filtered,
            PdfObject::Dictionary(parms(3, 8, 2, 15)),
            PdfObject::Name(b"FlateDecode".to_vec()),
        );
        assert_eq!(s.decode().unwrap(), vec![10, 20, 30, 11, 22, 33]);
    }

    #[test]
    fn png_paeth_predictor_uses_left_pixel_for_rgb() {
        // Row 0 (None): two flat RGB pixels. Row 1 (Paeth): a jump of 100 in the
        // first byte only. With a flat row above, Paeth predicts from the left
        // NEIGHBOUR PIXEL, so byte 3 repeats byte 0 (110) while bytes 1-2 and
        // 4-5 stay 10. A one-byte step would smear 110 into byte 1 instead.
        let filtered = [0u8, 10, 10, 10, 10, 10, 10, 4, 100, 0, 0, 0, 0, 0];
        let s = flate_stream(
            &filtered,
            PdfObject::Dictionary(parms(3, 8, 2, 15)),
            PdfObject::Name(b"FlateDecode".to_vec()),
        );
        assert_eq!(
            s.decode().unwrap(),
            vec![10, 10, 10, 10, 10, 10, 110, 10, 10, 110, 10, 10]
        );
    }

    #[test]
    fn decode_parms_array_form_applies_predictor() {
        // `/Filter [/FlateDecode] /DecodeParms [<<...>>]` is the array spelling
        // of the same thing; the predictor must still be undone.
        let filtered = [2u8, 10, 20, 2, 1, 2];
        let s = flate_stream(
            &filtered,
            PdfObject::Array(vec![PdfObject::Dictionary(parms(1, 8, 2, 12))]),
            PdfObject::Array(vec![PdfObject::Name(b"FlateDecode".to_vec())]),
        );
        assert_eq!(s.decode().unwrap(), vec![10, 20, 11, 22]);
    }

    #[test]
    fn tiff_predictor_is_rejected_not_passed_through() {
        // Predictor 2 (TIFF) is not implemented. Returning the still-predicted
        // bytes as if decoded would corrupt the stream once rewritten.
        let s = flate_stream(
            &[1u8, 2, 3],
            PdfObject::Dictionary(parms(1, 8, 3, 2)),
            PdfObject::Name(b"FlateDecode".to_vec()),
        );
        assert!(s.decode().is_err());
    }
}
