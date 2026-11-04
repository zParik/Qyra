//! Build a PDF 1.5 cross-reference stream (/Type /XRef).
use crate::pdf::error::PdfError;
use crate::pdf::types::{PdfDict, PdfObject, PdfStream};
use crate::pdf::writer::object_stream::flate_compress;

/// One row of the xref stream, pre-typed (indexed by object number).
pub enum XrefRow {
    Free,                                   // type 0
    InUse { offset: u64, gen: u16 },        // type 1
    Compressed { objstm: u32, index: u32 }, // type 2
}

/// Build the `/XRef` stream. `rows` is indexed `0..size` by object number.
/// Field widths `/W [1 4 2]`: type (1B), field2 (4B BE), field3 (2B BE).
pub fn build_xref_stream(rows: &[XrefRow], trailer: &PdfDict) -> Result<PdfStream, PdfError> {
    const W0: usize = 1;
    const W1: usize = 4;
    const W2: usize = 2;

    let mut data = Vec::with_capacity(rows.len() * (W0 + W1 + W2));
    for row in rows {
        let (t, f2, f3): (u8, u32, u16) = match *row {
            XrefRow::Free => (0, 0, 0),
            XrefRow::InUse { offset, gen } => {
                let offset = u32::try_from(offset).map_err(|_| {
                    PdfError::WriteError(format!("offset {offset} exceeds the 4 GiB xref stream limit"))
                })?;
                (1, offset, gen)
            }
            XrefRow::Compressed { objstm, index } => (2, objstm, index as u16),
        };
        data.push(t);
        data.extend_from_slice(&f2.to_be_bytes()); // W1 = 4
        data.extend_from_slice(&f3.to_be_bytes()); // W2 = 2
    }
    let compressed = flate_compress(&data);

    let size = rows.len() as i64;
    let mut dict = PdfDict::new();
    dict.set(b"Type", PdfObject::Name(b"XRef".to_vec()));
    dict.set(b"Size", PdfObject::Integer(size));
    dict.set(
        b"W",
        PdfObject::Array(vec![
            PdfObject::Integer(W0 as i64),
            PdfObject::Integer(W1 as i64),
            PdfObject::Integer(W2 as i64),
        ]),
    );
    if let Some(root) = trailer.get(b"Root") {
        dict.set(b"Root", root.clone());
    }
    if let Some(info) = trailer.get(b"Info") {
        dict.set(b"Info", info.clone());
    }
    dict.set(b"Filter", PdfObject::Name(b"FlateDecode".to_vec()));
    dict.set(b"Length", PdfObject::Integer(compressed.len() as i64));
    Ok(PdfStream {
        dict,
        raw_bytes: compressed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xref_stream_dict_and_size() {
        let mut trailer = PdfDict::new();
        trailer.set(b"Root", PdfObject::Reference((1, 0)));
        let rows = vec![
            XrefRow::Free,
            XrefRow::InUse { offset: 17, gen: 0 },
            XrefRow::Compressed { objstm: 5, index: 2 },
        ];
        let s = build_xref_stream(&rows, &trailer).unwrap();
        assert_eq!(s.dict.get(b"Type").unwrap().as_name(), Some(&b"XRef"[..]));
        assert_eq!(s.dict.get(b"Size").unwrap().as_integer(), Some(3));
        let decoded = s.decode().unwrap();
        assert_eq!(decoded.len(), 3 * 7);
        // Row 1 (InUse): type byte 1, offset 17 in next 4 BE bytes.
        assert_eq!(decoded[7], 1);
        assert_eq!(
            u32::from_be_bytes([decoded[8], decoded[9], decoded[10], decoded[11]]),
            17
        );
    }

    #[test]
    fn xref_stream_rejects_offsets_beyond_4gib() {
        // /W [1 4 2] has 4 bytes for the offset. Silently truncating a larger
        // offset would point the reader at the wrong bytes.
        let rows = vec![XrefRow::Free, XrefRow::InUse { offset: 5_000_000_000, gen: 0 }];
        assert!(build_xref_stream(&rows, &PdfDict::new()).is_err());
    }

    #[test]
    fn xref_stream_row_carries_generation() {
        let rows = vec![XrefRow::Free, XrefRow::InUse { offset: 17, gen: 3 }];
        let decoded = build_xref_stream(&rows, &PdfDict::new()).unwrap().decode().unwrap();
        assert_eq!(u16::from_be_bytes([decoded[12], decoded[13]]), 3);
    }
}
