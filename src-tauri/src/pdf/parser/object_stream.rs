/// ObjStm (object stream) unpacker — PDF 1.5+.
///
/// Multiple indirect objects are packed into one compressed stream.
/// After decompression the format is:
///   `N obj_num1 offset1 obj_num2 offset2 ... <objects>`
/// where N comes from /N in the stream dict, and /First is the byte offset
/// of the first object from the start of the decoded stream.
use crate::pdf::error::PdfError;
use crate::pdf::parser::lexer::Lexer;
use crate::pdf::parser::object::parse_object;
use crate::pdf::types::{ObjectId, PdfObject, PdfStream};

/// Unpack all objects from an ObjStm stream.
///
/// Returns a list of `(ObjectId, PdfObject)` pairs.  Generation is always 0
/// for objects stored in an ObjStm.
pub fn parse_object_stream(stream: &PdfStream) -> Result<Vec<(ObjectId, PdfObject)>, PdfError> {
    let n = stream
        .dict
        .get(b"N")
        .and_then(|v| v.as_integer())
        .ok_or_else(|| PdfError::ParseError("/N missing from ObjStm dict".into()))? as usize;

    let first = stream
        .dict
        .get(b"First")
        .and_then(|v| v.as_integer())
        .ok_or_else(|| PdfError::ParseError("/First missing from ObjStm dict".into()))? as usize;

    let decoded = stream.decode()?;

    if first > decoded.len() {
        return Err(PdfError::ParseError(format!(
            "/First ({}) exceeds decoded ObjStm length ({})",
            first,
            decoded.len()
        )));
    }

    // Parse the header: N pairs of (obj_num, relative_offset)
    let header_pairs = parse_objstm_header(&decoded, n, first)?;

    // Parse each object at its absolute offset (relative_offset + first)
    let mut results = Vec::with_capacity(n);
    for (obj_num, rel_offset) in header_pairs {
        let abs_offset = first + rel_offset;
        if abs_offset > decoded.len() {
            return Err(PdfError::ParseError(format!(
                "ObjStm entry offset {} is out of bounds (decoded len {})",
                abs_offset,
                decoded.len()
            )));
        }
        let mut lex = Lexer::new(&decoded);
        lex.seek(abs_offset);
        let obj = parse_object(&mut lex).map_err(|e| {
            PdfError::MalformedObject {
                id: (obj_num, 0),
                reason: format!("ObjStm parse error: {}", e),
            }
        })?;
        results.push(((obj_num, 0u16), obj));
    }

    Ok(results)
}

/// Parse the header of a decoded ObjStm: returns `Vec<(obj_num, relative_offset)>`.
fn parse_objstm_header(
    decoded: &[u8],
    n: usize,
    first: usize,
) -> Result<Vec<(u32, usize)>, PdfError> {
    let header_data = &decoded[..first];
    let mut lex = Lexer::new(header_data);
    let mut pairs = Vec::with_capacity(n);

    for _ in 0..n {
        let obj_num = match lex.next_token()? {
            Some(crate::pdf::parser::lexer::Token::Integer(n)) if n >= 0 => n as u32,
            other => {
                return Err(PdfError::ParseError(format!(
                    "Expected object number in ObjStm header, got {:?}",
                    other
                )))
            }
        };
        let offset = match lex.next_token()? {
            Some(crate::pdf::parser::lexer::Token::Integer(o)) if o >= 0 => o as usize,
            other => {
                return Err(PdfError::ParseError(format!(
                    "Expected offset in ObjStm header, got {:?}",
                    other
                )))
            }
        };
        pairs.push((obj_num, offset));
    }

    Ok(pairs)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::{PdfDict, PdfObject};

    fn make_objstm(n: usize, first: usize, content: &[u8]) -> PdfStream {
        let mut dict = PdfDict::new();
        dict.set(b"Type".to_vec(), PdfObject::Name(b"ObjStm".to_vec()));
        dict.set(b"N".to_vec(), PdfObject::Integer(n as i64));
        dict.set(b"First".to_vec(), PdfObject::Integer(first as i64));
        PdfStream {
            dict,
            raw_bytes: content.to_vec(), // uncompressed for test simplicity — no /Filter
        }
    }

    #[test]
    fn parse_simple_objstm() {
        // Header: "10 0 11 5" (obj 10 at rel 0, obj 11 at rel 5)
        // Objects: "42    true"
        //                ^0   ^5
        let header = b"10 0 11 5 ";
        let objects = b"42   true";
        let first = header.len();
        let mut content = header.to_vec();
        content.extend_from_slice(objects);

        let stream = make_objstm(2, first, &content);
        let objs = parse_object_stream(&stream).unwrap();

        assert_eq!(objs.len(), 2);
        let ((n0, g0), ref v0) = objs[0];
        assert_eq!(n0, 10);
        assert_eq!(g0, 0);
        assert!(matches!(v0, PdfObject::Integer(42)));

        let ((n1, g1), ref v1) = objs[1];
        assert_eq!(n1, 11);
        assert_eq!(g1, 0);
        assert!(matches!(v1, PdfObject::Boolean(true)));
    }

    #[test]
    fn parse_objstm_dict_object() {
        let header = b"5 0 ";
        let objects = b"<< /Type /Page >>";
        let first = header.len();
        let mut content = header.to_vec();
        content.extend_from_slice(objects);

        let stream = make_objstm(1, first, &content);
        let objs = parse_object_stream(&stream).unwrap();
        assert_eq!(objs.len(), 1);
        assert!(objs[0].1.as_dict().is_some());
    }
}
