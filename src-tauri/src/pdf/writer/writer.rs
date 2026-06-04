/// PDF writer — serializes a `PdfObject` graph to bytes. Emits either a
/// traditional cross-reference table or (preferred) object streams + an
/// xref stream (PDF 1.5).
use std::collections::BTreeMap;

use crate::pdf::error::PdfError;
use crate::pdf::types::{ObjectId, PdfDict, PdfObject};
use crate::pdf::writer::object_stream::build_objstm;
use crate::pdf::writer::serialize;
use crate::pdf::writer::xref_stream::{build_xref_stream, XrefRow};

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

        self.buf
            .extend_from_slice(format!("{} {} obj\n", id.0, id.1).as_bytes());
        serialize::write_object_body(&mut self.buf, obj)?;
        self.buf.extend_from_slice(b"\nendobj\n");
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Object streams + xref stream (PDF 1.5)
    // -----------------------------------------------------------------------

    /// Write the document using object streams + an xref stream.
    /// `objects` is the full set of live objects (any order). Stream objects
    /// stay as regular indirect objects; other generation-0 objects are packed
    /// into `/ObjStm` batches. Emits the `/XRef` stream + `startxref`/`%%EOF`.
    pub fn write_with_object_streams(
        &mut self,
        objects: &[(ObjectId, PdfObject)],
        trailer: PdfDict,
    ) -> Result<(), PdfError> {
        const BATCH: usize = 100;

        let max_obj = objects.iter().map(|(id, _)| id.0).max().unwrap_or(0);

        // Partition: stream objects (or non-gen-0) → regular; else → packable.
        // Sorting each partition by object number is equivalent to sorting the
        // whole input first (as before) and gives the same deterministic
        // numbering — while letting us borrow `objects` instead of owning a
        // full clone of every object (streams included) from the caller.
        let mut regular: Vec<(ObjectId, &PdfObject)> = Vec::new();
        let mut packable: Vec<(ObjectId, &PdfObject)> = Vec::new();
        for (id, obj) in objects {
            if matches!(obj, PdfObject::Stream(_)) || id.1 != 0 {
                regular.push((*id, obj));
            } else {
                packable.push((*id, obj));
            }
        }
        regular.sort_by_key(|(id, _)| id.0);
        packable.sort_by_key(|(id, _)| id.0);

        // Allocate new object numbers for the ObjStm objects + the xref stream.
        let n_batches = packable.len().div_ceil(BATCH);
        let mut next_id = max_obj + 1;
        let objstm_ids: Vec<u32> = (0..n_batches)
            .map(|_| {
                let i = next_id;
                next_id += 1;
                i
            })
            .collect();
        let xref_id = next_id;
        let total_objs = (xref_id + 1) as usize;

        // rows[obj_num] — all Free until filled.
        let mut rows: Vec<XrefRow> = (0..total_objs).map(|_| XrefRow::Free).collect();

        // 1) Regular objects: write now, record offset (type 1).
        for (id, obj) in &regular {
            let offset = self.buf.len() as u64;
            self.buf
                .extend_from_slice(format!("{} {} obj\n", id.0, id.1).as_bytes());
            serialize::write_object_body(&mut self.buf, obj)?;
            self.buf.extend_from_slice(b"\nendobj\n");
            rows[id.0 as usize] = XrefRow::InUse { offset };
        }

        // 2) Object streams: members → type-2 rows; the ObjStm itself → type 1.
        for (b, chunk) in packable.chunks(BATCH).enumerate() {
            let objstm_num = objstm_ids[b];
            let members: Vec<(ObjectId, PdfObject)> =
                chunk.iter().map(|(id, obj)| (*id, (*obj).clone())).collect();
            for (index, (id, _)) in chunk.iter().enumerate() {
                rows[id.0 as usize] = XrefRow::Compressed {
                    objstm: objstm_num,
                    index: index as u32,
                };
            }
            let stream = build_objstm(&members)?;
            let offset = self.buf.len() as u64;
            self.buf
                .extend_from_slice(format!("{} 0 obj\n", objstm_num).as_bytes());
            serialize::write_object_body(&mut self.buf, &PdfObject::Stream(stream))?;
            self.buf.extend_from_slice(b"\nendobj\n");
            rows[objstm_num as usize] = XrefRow::InUse { offset };
        }

        // 3) XRef stream at the end (references itself by offset, type 1).
        let xref_offset = self.buf.len() as u64;
        rows[xref_id as usize] = XrefRow::InUse { offset: xref_offset };
        let xref_stream = build_xref_stream(&rows, &trailer)?;
        self.buf
            .extend_from_slice(format!("{} 0 obj\n", xref_id).as_bytes());
        serialize::write_object_body(&mut self.buf, &PdfObject::Stream(xref_stream))?;
        self.buf.extend_from_slice(b"\nendobj\n");

        self.buf
            .extend_from_slice(format!("startxref\n{}\n%%EOF\n", xref_offset).as_bytes());
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Classic cross-reference table + trailer (fallback path)
    // -----------------------------------------------------------------------

    /// Write the traditional cross-reference table and trailer, then finish
    /// the file with `startxref` and `%%EOF`.
    pub fn write_xref_and_trailer(&mut self, mut trailer_dict: PdfDict) -> Result<(), PdfError> {
        let xref_offset = self.buf.len() as u64;

        // Build a sorted map: obj_number → (generation, offset).
        let mut by_obj_num: BTreeMap<u32, (u16, Option<u64>)> = BTreeMap::new();
        by_obj_num.insert(0, (65535, None)); // object 0: always free

        for &(id, offset) in &self.offsets {
            by_obj_num.insert(id.0, (id.1, Some(offset)));
        }

        let max_obj_num = *by_obj_num.keys().last().unwrap_or(&0);
        let size = max_obj_num + 1;

        trailer_dict.set(b"Size", PdfObject::Integer(size as i64));

        self.buf.extend_from_slice(b"xref\n");
        self.buf
            .extend_from_slice(format!("0 {}\n", size).as_bytes());

        for obj_num in 0..size {
            let (gen, offset_opt) = by_obj_num.get(&obj_num).copied().unwrap_or((0, None));
            let entry = match offset_opt {
                Some(off) => format!("{:010} {:05} n \r\n", off, gen),
                None => format!("{:010} {:05} f \r\n", 0u64, gen),
            };
            self.buf.extend_from_slice(entry.as_bytes());
        }

        self.buf.extend_from_slice(b"trailer\n");
        serialize::write_dict(&mut self.buf, &trailer_dict)?;
        self.buf.push(b'\n');

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
        w.write_object((1, 0), &PdfObject::Dictionary(dict)).unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("/Type"));
        assert!(s.contains("/Catalog"));
    }

    #[test]
    fn write_reference() {
        let mut w = PdfWriter::new();
        w.write_header();
        w.write_object((1, 0), &PdfObject::Reference((5, 0))).unwrap();
        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("5 0 R"));
    }

    #[test]
    fn xref_entry_offsets() {
        let mut w = PdfWriter::new();
        w.write_header();
        let obj_offset = w.buf.len() as u64;
        w.write_object((1, 0), &PdfObject::Integer(99)).unwrap();

        let trailer = PdfDict::new();
        w.write_xref_and_trailer(trailer).unwrap();

        let bytes = w.finish();
        let s = String::from_utf8_lossy(&bytes);
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

    #[test]
    fn object_streams_round_trip_via_reader() {
        use crate::pdf::parser::PdfReader;

        let mut catalog = PdfDict::new();
        catalog.set(b"Type", PdfObject::Name(b"Catalog".to_vec()));
        catalog.set(b"Pages", PdfObject::Reference((2, 0)));
        let mut pages = PdfDict::new();
        pages.set(b"Type", PdfObject::Name(b"Pages".to_vec()));
        pages.set(b"Kids", PdfObject::Array(vec![PdfObject::Reference((3, 0))]));
        pages.set(b"Count", PdfObject::Integer(1));
        let mut page = PdfDict::new();
        page.set(b"Type", PdfObject::Name(b"Page".to_vec()));
        page.set(b"Parent", PdfObject::Reference((2, 0)));
        page.set(
            b"MediaBox",
            PdfObject::Array(vec![
                PdfObject::Integer(0),
                PdfObject::Integer(0),
                PdfObject::Integer(612),
                PdfObject::Integer(792),
            ]),
        );

        let objects = vec![
            ((1u32, 0u16), PdfObject::Dictionary(catalog)),
            ((2u32, 0u16), PdfObject::Dictionary(pages)),
            ((3u32, 0u16), PdfObject::Dictionary(page)),
        ];
        let mut trailer = PdfDict::new();
        trailer.set(b"Root", PdfObject::Reference((1, 0)));

        let mut w = PdfWriter::new();
        w.write_header();
        w.write_with_object_streams(&objects, trailer).unwrap();
        let bytes = w.finish();

        let mut reader = PdfReader::new(bytes).expect("reader parses object-stream output");
        let page_ids = reader.pages().expect("pages resolve");
        assert_eq!(page_ids.len(), 1);
    }
}
