//! PDF text strings (document info, outline titles, annotation text, form
//! values): PDFDocEncoding, or UTF-16BE with a byte-order mark.
//!
//! Writing a non-ASCII value as a literal of UTF-8 bytes made other viewers
//! show mojibake, and reading every string as UTF-8 garbled PDFDocEncoding
//! characters such as "é" or "–".

use lopdf::{Object, StringFormat};

/// PDFDocEncoding bytes 0x18..=0x1F and 0x80..=0xA0 that differ from Latin-1.
fn pdfdoc_char(b: u8) -> Option<char> {
    let c = match b {
        0x18 => '\u{02D8}', 0x19 => '\u{02C7}', 0x1A => '\u{02C6}', 0x1B => '\u{02D9}',
        0x1C => '\u{02DD}', 0x1D => '\u{02DB}', 0x1E => '\u{02DA}', 0x1F => '\u{02DC}',
        0x80 => '\u{2022}', 0x81 => '\u{2020}', 0x82 => '\u{2021}', 0x83 => '\u{2026}',
        0x84 => '\u{2014}', 0x85 => '\u{2013}', 0x86 => '\u{0192}', 0x87 => '\u{2044}',
        0x88 => '\u{2039}', 0x89 => '\u{203A}', 0x8A => '\u{2212}', 0x8B => '\u{2030}',
        0x8C => '\u{201E}', 0x8D => '\u{201C}', 0x8E => '\u{201D}', 0x8F => '\u{2018}',
        0x90 => '\u{2019}', 0x91 => '\u{201A}', 0x92 => '\u{2122}', 0x93 => '\u{FB01}',
        0x94 => '\u{FB02}', 0x95 => '\u{0141}', 0x96 => '\u{0152}', 0x97 => '\u{0160}',
        0x98 => '\u{0178}', 0x99 => '\u{017D}', 0x9A => '\u{0131}', 0x9B => '\u{0142}',
        0x9C => '\u{0153}', 0x9D => '\u{0161}', 0x9E => '\u{017E}', 0xA0 => '\u{20AC}',
        _ => return None,
    };
    Some(c)
}

/// Decode a text string's bytes.
pub fn decode(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned(); // PDF 2.0
    }
    // Many producers (and older Qyra builds) wrote raw UTF-8. Non-ASCII
    // PDFDocEncoding text is almost never valid UTF-8, so try that first.
    if !bytes.is_ascii() {
        if let Ok(s) = std::str::from_utf8(bytes) {
            return s.to_string();
        }
    }
    bytes.iter().map(|&b| pdfdoc_char(b).unwrap_or(b as char)).collect()
}

/// Encode as a text string: a literal when ASCII, UTF-16BE otherwise.
pub fn encode(s: &str) -> Object {
    if s.is_ascii() {
        Object::string_literal(s)
    } else {
        let mut out = vec![0xFE, 0xFF];
        for unit in s.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        Object::String(out, StringFormat::Hexadecimal)
    }
}

/// The text of a string object (or a name), if it is one.
pub fn object_text(o: &Object) -> Option<String> {
    match o {
        Object::String(b, _) => Some(decode(b)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_unicode() {
        for s in ["plain", "Zoë – café", "漢字"] {
            match encode(s) {
                Object::String(b, _) => assert_eq!(decode(&b), s),
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn reads_pdfdoc_and_utf8() {
        assert_eq!(decode(b"caf\xE9 \x85 \x80"), "café – •");
        assert_eq!(decode("café".as_bytes()), "café");
    }
}
