/// PDF writer — serializes a `PdfObject` graph to bytes and emits a
/// traditional (non-stream) cross-reference table.
use std::collections::BTreeMap;

use crate::pdf::error::PdfError;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject, PdfStream};

pub struct PdfWriter {
    buf: Vec<u8>,
    /// Recorded (object_id → byte_offset) as objects are written.
    offsets: Vec<(ObjectId, u64)>,
}

impl PdfWriter {
    pub fn new() -> Self {
        PdfWriter {
            buf: Vec::new(),
            offsets: Vec::new(),
        }
    }

    // -----------------------------------------------------------------------
    // Header
    // -----------------------------------------------------------------------

    /// Write the PDF header.  The binary comment (4 bytes ≥ 128) signals that
    /// the file contains binary data and should not be mangled by ASCII-only
    /// transport (email, FTP ASCII mode, etc.).
    pub fn write_header(&mut self) {
        self.buf.extend_from_slice(b"%PDF-1.5\n");
        self.buf.extend_from_slice(b"%\xE2\xE3\xCF\xD3\n");
    }

    // -----------------------------------------------------------------------
    // Object writing
    // -----------------------------------------------------------------------

    /// Serialize one indirect object, recording its byte offset.
    pub fn write_object(&mut self, id: ObjectId, obj: &PdfObject) -> Result<(), PdfError> {
        let offset = self.buf.len() as u64;
        self.offsets.push((id, offset));

        // "N G obj\n"
        self.buf
            .extend_from_slice(format!("{} {} obj\n", id.0, id.1).as_bytes());

        self.write_object_body(obj)?;

        self.buf.extend_from_slice(b"\nendobj\n");
        Ok(())
    }

    fn write_object_body(&mut self, obj: &PdfObject) -> Result<(), PdfError> {
        match obj {
            PdfObject::Null => self.buf.extend_from_slice(b"null"),
            PdfObject::Boolean(true) => self.buf.extend_from_slice(b"true"),
            PdfObject::Boolean(false) => self.buf.extend_from_slice(b"false"),
            PdfObject::Integer(n) => {
                self.buf.extend_from_slice(n.to_string().as_bytes());
            }
            PdfObject::Real(v) => {
                // Use enough precision to round-trip PDF real values.
                self.buf
                    .extend_from_slice(format!("{:.6}", v).trim_end_matches('0').trim_end_matches('.').as_bytes());
                // Ensure at least one digit after decimal for 0-valued reals
                if !self.buf.last().map_or(false, |&b| b.is_ascii_digit()) {
                    self.buf.push(b'0');
                }
            }
            PdfObject::Name(n) => self.write_name(n),
            PdfObject::StringLiteral(s) => self.write_string(s),
            PdfObject::HexString(s) => self.write_hex_string(s),
            PdfObject::Array(arr) => {
                self.buf.push(b'[');
                for (i, item) in arr.iter().enumerate() {
                    if i > 0 {
                        self.buf.push(b' ');
                    }
                    self.write_object_body(item)?;
                }
                self.buf.push(b']');
            }
            PdfObject::Dictionary(dict) => self.write_dict(dict)?,
            PdfObject::Stream(stream) => self.write_stream(stream)?,
            PdfObject::Reference(id) => {
                self.buf
                    .extend_from_slice(format!("{} {} R", id.0, id.1).as_bytes());
            }
        }
        Ok(())
    }

    fn write_name(&mut self, name: &[u8]) {
        self.buf.push(b'/');
        for &b in name {
            // Characters that must be escaped in names
            if b <= 0x21
                || b >= 0x7F
                || matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%' | b'#')
            {
                self.buf
                    .extend_from_slice(format!("#{:02X}", b).as_bytes());
            } else {
                self.buf.push(b);
            }
        }
    }

    fn write_string(&mut self, s: &[u8]) {
        // If the string is printable ASCII with no special chars, use literal form.
        // Otherwise use hex form.
        let use_literal = s.iter().all(|&b| {
            b >= 0x20 && b < 0x7F && !matches!(b, b'(' | b')' | b'\\')
        });

        if use_literal {
            self.buf.push(b'(');
            self.buf.extend_from_slice(s);
            self.buf.push(b')');
        } else {
            self.write_hex_string(s);
        }
    }

    fn write_hex_string(&mut self, s: &[u8]) {
        self.buf.push(b'<');
        for &b in s {
            self.buf
                .extend_from_slice(format!("{:02X}", b).as_bytes());
        }
        self.buf.push(b'>');
    }

    fn write_dict(&mut self, dict: &PdfDict) -> Result<(), PdfError> {
        self.buf.extend_from_slice(b"<<");
        for (k, v) in dict.iter() {
            self.buf.push(b'\n');
            self.write_name(k);
            self.buf.push(b' ');
            self.write_object_body(v)?;
        }
        self.buf.extend_from_slice(b"\n>>");
        Ok(())
    }

    fn write_stream(&mut self, stream: &PdfStream) -> Result<(), PdfError> {
        // Update /Length in the dict to match our raw_bytes length.
        let mut dict = stream.dict.clone();
        dict.set(b"Length", PdfObject::Integer(stream.raw_bytes.len() as i64));

        self.write_dict(&dict)?;
        self.buf.extend_from_slice(b"\nstream\n");
        self.buf.extend_from_slice(&stream.raw_bytes);
        self.buf.extend_from_slice(b"\nendstream");
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Xref table + trailer
    // -----------------------------------------------------------------------

    /// Write the traditional cross-reference table and trailer, then finish
    /// the file with `startxref` and `%%EOF`.
    pub fn write_xref_and_trailer(
        &mut self,
        mut trailer_dict: PdfDict,
    ) -> Result<(), PdfError> {
        let xref_offset = self.buf.len() as u64;

        // Build a sorted map: obj_number → (generation, offset)
        // Object 0 is always a free entry with generation 65535.
        let mut by_obj_num: BTreeMap<u32, (u16, Option<u64>)> = BTreeMap::new();
        by_obj_num.insert(0, (65535, None)); // object 0: always free

        for &(id, offset) in &self.offsets {
            by_obj_num.insert(id.0, (id.1, Some(offset)));
        }

        let max_obj_num = *by_obj_num.keys().last().unwrap_or(&0);
        let size = max_obj_num + 1;

        // Update /Size in the trailer
        trailer_dict.set(b"Size", PdfObject::Integer(size as i64));

        // Emit the xref table.  We write one contiguous subsection from 0..=max_obj_num,
        // filling gaps with free entries.
        self.buf.extend_from_slice(b"xref\n");
        self.buf
            .extend_from_slice(format!("0 {}\n", size).as_bytes());

        for obj_num in 0..size {
            let (gen, offset_opt) = by_obj_num
                .get(&obj_num)
                .copied()
                .unwrap_or((0, None));

            let entry = match offset_opt {
                Some(off) => format!("{:010} {:05} n \r\n", off, gen),
                None => format!("{:010} {:05} f \r\n", 0u64, gen),
            };
            self.buf.extend_from_slice(entry.as_bytes());
        }

        // Trailer dictionary
        self.buf.extend_from_slice(b"trailer\n");
        self.write_dict(&trailer_dict)?;
        self.buf.push(b'\n');

        // startxref
        self.buf
            .extend_from_slice(format!("startxref\n{}\n%%EOF\n", xref_offset).as_bytes());

        Ok(())
    }

    /// Consume the writer and return the assembled bytes.
    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}

impl Default for PdfWriter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::{PdfDict, PdfObject};

    #[test]
    fn write_integer_object() {
        let mut w = PdfWriter::new();
        w.write_header();
        w.write_object((1, 0), &PdfObject::Integer(42)).unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("1 0 obj"));
        assert!(s.contains("42"));
        assert!(s.contains("endobj"));
    }

    #[test]
    fn write_dict_object() {
        let mut w = PdfWriter::new();
        w.write_header();
        let mut dict = PdfDict::new();
        dict.set(b"Type".to_vec(), PdfObject::Name(b"Catalog".to_vec()));
        w.write_object((1, 0), &PdfObject::Dictionary(dict))
            .unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("/Type"));
        assert!(s.contains("/Catalog"));
    }

    #[test]
    fn write_reference() {
        let mut w = PdfWriter::new();
        w.write_header();
        w.write_object((1, 0), &PdfObject::Reference((5, 0)))
            .unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("5 0 R"));
    }

    #[test]
    fn xref_entry_offsets() {
        let mut w = PdfWriter::new();
        w.write_header();
        // header is 21 bytes: "%PDF-1.5\n%...\n"
        let obj_offset = w.buf.len() as u64;
        w.write_object((1, 0), &PdfObject::Integer(99)).unwrap();

        let trailer = PdfDict::new();
        w.write_xref_and_trailer(trailer).unwrap();

        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);

        // The xref entry for object 1 should contain the correct offset
        let expected_offset = format!("{:010}", obj_offset);
        assert!(
            s.contains(&expected_offset),
            "Expected offset {} in xref:\n{}",
            expected_offset,
            s
        );
    }

    #[test]
    fn xref_always_has_object_zero_free() {
        let mut w = PdfWriter::new();
        w.write_header();
        w.write_object((1, 0), &PdfObject::Null).unwrap();
        w.write_xref_and_trailer(PdfDict::new()).unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        // Object 0 free entry: "0000000000 65535 f"
        assert!(s.contains("0000000000 65535 f"));
    }

    #[test]
    fn write_stream_object() {
        use crate::pdf::types::PdfStream;
        let mut w = PdfWriter::new();
        w.write_header();
        let mut dict = PdfDict::new();
        dict.set(b"Length".to_vec(), PdfObject::Integer(5));
        let stream = PdfStream {
            dict,
            raw_bytes: b"hello".to_vec(),
        };
        w.write_object((2, 0), &PdfObject::Stream(stream)).unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("stream\nhello\nendstream"));
    }
}
