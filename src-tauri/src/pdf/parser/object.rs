/// Recursive-descent PDF object parser built on top of the `Lexer`.
use crate::pdf::error::PdfError;
use crate::pdf::parser::lexer::{Lexer, Token};
use crate::pdf::types::{ObjectId, PdfDict, PdfObject, PdfStream};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a single PDF object from `data` starting at `offset`.
///
/// Returns `(object, bytes_consumed)`.
#[allow(dead_code)]
pub fn parse_object_at(data: &[u8], offset: usize) -> Result<(PdfObject, usize), PdfError> {
    let mut lex = Lexer::new(data);
    lex.seek(offset);
    let obj = parse_object(&mut lex)?;
    Ok((obj, lex.pos()))
}

/// Parse a single PDF object using an existing lexer (cursor advanced in-place).
pub fn parse_object(lex: &mut Lexer<'_>) -> Result<PdfObject, PdfError> {
    let tok = lex
        .next_token()?
        .ok_or(PdfError::UnexpectedEof)?;

    match tok {
        Token::Integer(n) => {
            // Could be:
            //   - a plain integer
            //   - the start of an indirect reference  "N G R"
            // Peek ahead to see if we have "INTEGER R" pattern.
            let saved = lex.pos();
            if let Ok(Some(Token::Integer(gen))) = lex.next_token() {
                if let Ok(Some(Token::Keyword(kw))) = lex.next_token() {
                    if kw == b"R" {
                        return Ok(PdfObject::Reference((n as u32, gen as u16)));
                    }
                }
            }
            // Not a reference — restore position and return plain integer.
            lex.seek(saved);
            Ok(PdfObject::Integer(n))
        }
        Token::Real(v) => Ok(PdfObject::Real(v)),
        Token::Name(n) => Ok(PdfObject::Name(n)),
        Token::LiteralString(s) => Ok(PdfObject::StringLiteral(s)),
        Token::HexString(s) => Ok(PdfObject::HexString(s)),
        Token::DictStart => {
            let dict = parse_dict_body(lex)?;
            Ok(PdfObject::Dictionary(dict))
        }
        Token::ArrayStart => {
            let arr = parse_array_body(lex)?;
            Ok(PdfObject::Array(arr))
        }
        Token::Keyword(kw) => match kw.as_slice() {
            b"null" => Ok(PdfObject::Null),
            b"true" => Ok(PdfObject::Boolean(true)),
            b"false" => Ok(PdfObject::Boolean(false)),
            other => Err(PdfError::ParseError(format!(
                "Unexpected keyword while parsing object: {:?}",
                String::from_utf8_lossy(other)
            ))),
        },
        other => Err(PdfError::ParseError(format!(
            "Unexpected token while parsing object: {:?}",
            other
        ))),
    }
}

/// Parse a dictionary body (after `<<` has been consumed, up to and including `>>`).
pub fn parse_dict_body(lex: &mut Lexer<'_>) -> Result<PdfDict, PdfError> {
    let mut dict = PdfDict::new();
    loop {
        lex.skip_whitespace_and_comments();
        match lex.peek_token()? {
            Some(Token::DictEnd) => {
                lex.next_token()?; // consume '>>'
                break;
            }
            Some(Token::Name(_)) => {
                let key = match lex.next_token()? {
                    Some(Token::Name(n)) => n,
                    _ => unreachable!(),
                };
                let val = parse_object(lex)?;
                dict.set(key, val);
            }
            None => return Err(PdfError::UnexpectedEof),
            other => {
                return Err(PdfError::ParseError(format!(
                    "Expected name key in dictionary, got {:?}",
                    other
                )))
            }
        }
    }
    Ok(dict)
}

/// Parse an array body (after `[` has been consumed, up to and including `]`).
fn parse_array_body(lex: &mut Lexer<'_>) -> Result<Vec<PdfObject>, PdfError> {
    let mut arr = Vec::new();
    loop {
        lex.skip_whitespace_and_comments();
        match lex.peek_token()? {
            Some(Token::ArrayEnd) => {
                lex.next_token()?; // consume ']'
                break;
            }
            None => return Err(PdfError::UnexpectedEof),
            _ => {
                arr.push(parse_object(lex)?);
            }
        }
    }
    Ok(arr)
}

// ---------------------------------------------------------------------------
// Indirect object parser
// ---------------------------------------------------------------------------

/// Parse an indirect object of the form `N G obj ... endobj` from `data`
/// starting at `offset`.
///
/// Returns `(id, object)`.  For stream objects the `PdfObject::Stream`
/// variant is returned with `raw_bytes` containing the undecoded stream data.
pub fn parse_indirect_object(
    data: &[u8],
    offset: usize,
) -> Result<(ObjectId, PdfObject), PdfError> {
    let mut lex = Lexer::new(data);
    lex.seek(offset);
    parse_indirect_object_lex(data, &mut lex)
}

pub fn parse_indirect_object_lex(
    data: &[u8],
    lex: &mut Lexer<'_>,
) -> Result<(ObjectId, PdfObject), PdfError> {
    lex.skip_whitespace_and_comments();

    // Object number
    let obj_num = match lex.next_token()? {
        Some(Token::Integer(n)) if n >= 0 => n as u32,
        other => {
            return Err(PdfError::ParseError(format!(
                "Expected object number at offset {}, got {:?}",
                lex.pos(),
                other
            )))
        }
    };

    // Generation number
    let gen = match lex.next_token()? {
        Some(Token::Integer(g)) if g >= 0 => g as u16,
        other => {
            return Err(PdfError::ParseError(format!(
                "Expected generation number, got {:?}",
                other
            )))
        }
    };

    // `obj` keyword
    match lex.next_token()? {
        Some(Token::Keyword(kw)) if kw == b"obj" => {}
        other => {
            return Err(PdfError::ParseError(format!(
                "Expected 'obj' keyword, got {:?}",
                other
            )))
        }
    }

    let id: ObjectId = (obj_num, gen);

    // Parse the object value
    let obj = parse_object(lex)?;

    // Check for `stream` keyword after a dictionary
    lex.skip_whitespace_and_comments();
    if let PdfObject::Dictionary(ref dict) = obj {
        if matches!(lex.peek_token()?, Some(Token::Keyword(ref kw)) if kw == b"stream") {
            lex.next_token()?; // consume 'stream'

            // The spec says: exactly one EOL after 'stream': CR, LF, or CRLF.
            // Consume it.
            consume_stream_eol(lex);

            let stream_start = lex.pos();
            let stream = consume_stream_body(data, lex, dict, stream_start)?;
            return Ok((id, PdfObject::Stream(stream)));
        }
    }

    // `endobj` keyword (optional — some malformed PDFs omit it)
    if let Ok(Some(Token::Keyword(ref kw))) = lex.peek_token() {
        if kw == b"endobj" {
            lex.next_token()?;
        }
    }

    Ok((id, obj))
}

/// Consume the single line-ending that must follow the `stream` keyword.
fn consume_stream_eol(lex: &mut Lexer<'_>) {
    if lex.pos() < lex.data.len() && lex.data[lex.pos()] == b'\r' {
        lex.seek(lex.pos() + 1);
    }
    if lex.pos() < lex.data.len() && lex.data[lex.pos()] == b'\n' {
        lex.seek(lex.pos() + 1);
    }
}

/// Slice raw stream bytes using `/Length` from the dict.
///
/// Falls back to scanning for `\nendstream` or `\rendstream` if the
/// declared length is incorrect or absent (common in malformed PDFs).
fn consume_stream_body(
    data: &[u8],
    lex: &mut Lexer<'_>,
    dict: &PdfDict,
    stream_start: usize,
) -> Result<PdfStream, PdfError> {
    // Try to use the declared /Length first.
    let declared_length = dict
        .get(b"Length")
        .and_then(|v| v.as_integer())
        .map(|n| n as usize);

    let raw_bytes = if let Some(len) = declared_length {
        let end = stream_start + len;
        if end <= data.len() {
            // Verify the next bytes after length are endstream.
            // Skip CR/LF in-place — no allocation needed.
            let after = &data[end..];
            let mut skip = 0;
            while skip < after.len() && (after[skip] == b'\r' || after[skip] == b'\n') {
                skip += 1;
            }
            if after[skip..].starts_with(b"endstream") {
                lex.seek(end);
                // Skip optional EOL before endstream
                if lex.pos() < data.len() && data[lex.pos()] == b'\r' {
                    lex.seek(lex.pos() + 1);
                }
                if lex.pos() < data.len() && data[lex.pos()] == b'\n' {
                    lex.seek(lex.pos() + 1);
                }
                data[stream_start..stream_start + len].to_vec()
            } else {
                // Length is wrong — fall back to scanning
                scan_for_endstream(data, stream_start)?
            }
        } else {
            scan_for_endstream(data, stream_start)?
        }
    } else {
        scan_for_endstream(data, stream_start)?
    };

    // Advance lexer past 'endstream'
    lex.skip_whitespace_and_comments();
    if let Ok(Some(Token::Keyword(kw))) = lex.peek_token() {
        if kw == b"endstream" {
            lex.next_token()?;
        }
    }
    // Consume 'endobj' if present
    lex.skip_whitespace_and_comments();
    if let Ok(Some(Token::Keyword(kw))) = lex.peek_token() {
        if kw == b"endobj" {
            lex.next_token()?;
        }
    }

    Ok(PdfStream {
        dict: dict.clone(),
        raw_bytes,
    })
}

/// Scan forward from `start` looking for `\nendstream` or `\rendstream`.
fn scan_for_endstream(data: &[u8], start: usize) -> Result<Vec<u8>, PdfError> {
    let needle = b"endstream";
    let mut pos = start;
    while pos + needle.len() < data.len() {
        // Look for 'endstream' preceded by CR or LF
        if (pos == 0 || data[pos - 1] == b'\n' || data[pos - 1] == b'\r')
            && data[pos..].starts_with(needle)
        {
            // Back up past any trailing EOL before endstream marker
            let end = if pos > 0 && data[pos - 1] == b'\n' {
                if pos > 1 && data[pos - 2] == b'\r' {
                    pos - 2
                } else {
                    pos - 1
                }
            } else if pos > 0 && data[pos - 1] == b'\r' {
                pos - 1
            } else {
                pos
            };
            return Ok(data[start..end].to_vec());
        }
        pos += 1;
    }
    Err(PdfError::ParseError(
        "Could not find 'endstream' marker".into(),
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(s: &[u8]) -> PdfObject {
        let mut lex = Lexer::new(s);
        parse_object(&mut lex).unwrap()
    }

    #[test]
    fn parse_integer() {
        assert!(matches!(obj(b"42"), PdfObject::Integer(42)));
    }

    #[test]
    fn parse_real() {
        match obj(b"1.5") {
            PdfObject::Real(v) => assert!((v - 1.5).abs() < 1e-10),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_boolean_true() {
        assert!(matches!(obj(b"true"), PdfObject::Boolean(true)));
    }

    #[test]
    fn parse_null() {
        assert!(matches!(obj(b"null"), PdfObject::Null));
    }

    #[test]
    fn parse_name() {
        match obj(b"/Type") {
            PdfObject::Name(n) => assert_eq!(n, b"Type"),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_literal_string() {
        match obj(b"(hello)") {
            PdfObject::StringLiteral(s) => assert_eq!(s, b"hello"),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_hex_string() {
        match obj(b"<48656C6C6F>") {
            PdfObject::HexString(s) => assert_eq!(s, b"Hello"),
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_reference() {
        match obj(b"5 0 R") {
            PdfObject::Reference((5, 0)) => {}
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_array() {
        match obj(b"[1 2 3]") {
            PdfObject::Array(arr) => {
                assert_eq!(arr.len(), 3);
                assert!(matches!(arr[0], PdfObject::Integer(1)));
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_nested_dict() {
        let src = b"<< /Type /Catalog /Pages 2 0 R >>";
        match obj(src) {
            PdfObject::Dictionary(d) => {
                assert!(d.get(b"Type").is_some());
                assert!(d.get(b"Pages").is_some());
            }
            other => panic!("{:?}", other),
        }
    }

    #[test]
    fn parse_indirect_object_integer() {
        let src = b"1 0 obj\n42\nendobj\n";
        let ((num, gen), val) = parse_indirect_object(src, 0).unwrap();
        assert_eq!(num, 1);
        assert_eq!(gen, 0);
        assert!(matches!(val, PdfObject::Integer(42)));
    }

    #[test]
    fn parse_indirect_object_dict() {
        let src = b"3 0 obj\n<< /Type /Page >>\nendobj\n";
        let ((num, _), val) = parse_indirect_object(src, 0).unwrap();
        assert_eq!(num, 3);
        assert!(val.as_dict().is_some());
    }

    #[test]
    fn parse_stream_object() {
        let src = b"4 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n";
        let (_, val) = parse_indirect_object(src, 0).unwrap();
        match val {
            PdfObject::Stream(s) => assert_eq!(s.raw_bytes, b"hello"),
            other => panic!("{:?}", other),
        }
    }
}
