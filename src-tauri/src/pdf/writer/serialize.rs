//! Pure object-body serialization shared by the writer and the ObjStm builder.
//! Each fn appends to a caller-owned buffer; no I/O, no offsets.
use crate::pdf::error::PdfError;
use crate::pdf::types::{PdfDict, PdfObject, PdfStream};

pub fn write_object_body(buf: &mut Vec<u8>, obj: &PdfObject) -> Result<(), PdfError> {
    match obj {
        PdfObject::Null => buf.extend_from_slice(b"null"),
        PdfObject::Boolean(true) => buf.extend_from_slice(b"true"),
        PdfObject::Boolean(false) => buf.extend_from_slice(b"false"),
        PdfObject::Integer(n) => buf.extend_from_slice(n.to_string().as_bytes()),
        PdfObject::Real(v) => {
            let s = format!("{:.6}", v);
            let s = s.trim_end_matches('0').trim_end_matches('.');
            buf.extend_from_slice(s.as_bytes());
            if !buf.last().map_or(false, |&b| b.is_ascii_digit()) {
                buf.push(b'0');
            }
        }
        PdfObject::Name(n) => write_name(buf, n),
        PdfObject::StringLiteral(s) => write_string(buf, s),
        PdfObject::HexString(s) => write_hex_string(buf, s),
        PdfObject::Array(arr) => {
            buf.push(b'[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    buf.push(b' ');
                }
                write_object_body(buf, item)?;
            }
            buf.push(b']');
        }
        PdfObject::Dictionary(dict) => write_dict(buf, dict)?,
        PdfObject::Stream(stream) => write_stream(buf, stream)?,
        PdfObject::Reference(id) => {
            buf.extend_from_slice(format!("{} {} R", id.0, id.1).as_bytes());
        }
    }
    Ok(())
}

pub fn write_name(buf: &mut Vec<u8>, name: &[u8]) {
    buf.push(b'/');
    for &b in name {
        if b <= 0x21
            || b >= 0x7F
            || matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%' | b'#')
        {
            buf.extend_from_slice(format!("#{:02X}", b).as_bytes());
        } else {
            buf.push(b);
        }
    }
}

pub fn write_string(buf: &mut Vec<u8>, s: &[u8]) {
    let use_literal = s
        .iter()
        .all(|&b| b >= 0x20 && b < 0x7F && !matches!(b, b'(' | b')' | b'\\'));
    if use_literal {
        buf.push(b'(');
        buf.extend_from_slice(s);
        buf.push(b')');
    } else {
        write_hex_string(buf, s);
    }
}

pub fn write_hex_string(buf: &mut Vec<u8>, s: &[u8]) {
    buf.push(b'<');
    for &b in s {
        buf.extend_from_slice(format!("{:02X}", b).as_bytes());
    }
    buf.push(b'>');
}

pub fn write_dict(buf: &mut Vec<u8>, dict: &PdfDict) -> Result<(), PdfError> {
    buf.extend_from_slice(b"<<");
    for (k, v) in dict.iter() {
        buf.push(b'\n');
        write_name(buf, k);
        buf.push(b' ');
        write_object_body(buf, v)?;
    }
    buf.extend_from_slice(b"\n>>");
    Ok(())
}

pub fn write_stream(buf: &mut Vec<u8>, stream: &PdfStream) -> Result<(), PdfError> {
    let mut dict = stream.dict.clone();
    dict.set(b"Length", PdfObject::Integer(stream.raw_bytes.len() as i64));
    write_dict(buf, &dict)?;
    buf.extend_from_slice(b"\nstream\n");
    buf.extend_from_slice(&stream.raw_bytes);
    buf.extend_from_slice(b"\nendstream");
    Ok(())
}
