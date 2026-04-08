/// PDF byte-level tokenizer.
///
/// Operates on a `&[u8]` slice with a mutable cursor — no intermediate string
/// allocations on the hot path.  The only allocations are for token variants
/// that require decoding (names with `#XX` escapes, strings with escape
/// sequences).
use crate::pdf::error::PdfError;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    Integer(i64),
    Real(f64),
    /// Name bytes without the leading `/`.  `#XX` escapes are already decoded.
    Name(Vec<u8>),
    /// Literal string bytes — escape sequences and balanced parens resolved.
    LiteralString(Vec<u8>),
    /// Hex string bytes — already decoded from `<hexhex>`.
    HexString(Vec<u8>),
    /// A keyword token: `obj`, `endobj`, `stream`, `endstream`, `xref`,
    /// `trailer`, `startxref`, `R`, `null`, `true`, `false`.
    Keyword(Vec<u8>),
    ArrayStart,  // [
    ArrayEnd,    // ]
    DictStart,   // <<
    DictEnd,     // >>
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

pub struct Lexer<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Lexer { data, pos: 0 }
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn seek(&mut self, pos: usize) {
        self.pos = pos;
    }

    pub fn remaining(&self) -> &[u8] {
        &self.data[self.pos..]
    }

    pub fn peek_bytes(&self, n: usize) -> &[u8] {
        let end = (self.pos + n).min(self.data.len());
        &self.data[self.pos..end]
    }

    pub fn is_eof(&self) -> bool {
        self.pos >= self.data.len()
    }

    // -----------------------------------------------------------------------
    // Public token API
    // -----------------------------------------------------------------------

    /// Advance past whitespace/comments and return the next token, or `None`
    /// at EOF.
    pub fn next_token(&mut self) -> Result<Option<Token>, PdfError> {
        self.skip_whitespace_and_comments();
        if self.is_eof() {
            return Ok(None);
        }

        let b = self.data[self.pos];

        match b {
            b'/' => {
                self.pos += 1; // consume '/'
                Ok(Some(Token::Name(self.read_name()?)))
            }
            b'(' => {
                self.pos += 1; // consume '('
                Ok(Some(Token::LiteralString(self.read_literal_string()?)))
            }
            b'<' => {
                if self.pos + 1 < self.data.len() && self.data[self.pos + 1] == b'<' {
                    self.pos += 2;
                    Ok(Some(Token::DictStart))
                } else {
                    self.pos += 1; // consume '<'
                    Ok(Some(Token::HexString(self.read_hex_string()?)))
                }
            }
            b'>' => {
                if self.pos + 1 < self.data.len() && self.data[self.pos + 1] == b'>' {
                    self.pos += 2;
                    Ok(Some(Token::DictEnd))
                } else {
                    Err(PdfError::ParseError(
                        "Unexpected '>' not part of '>>'".into(),
                    ))
                }
            }
            b'[' => {
                self.pos += 1;
                Ok(Some(Token::ArrayStart))
            }
            b']' => {
                self.pos += 1;
                Ok(Some(Token::ArrayEnd))
            }
            b'0'..=b'9' | b'+' | b'-' | b'.' => self.read_number(),
            _ => {
                // Keyword or unknown
                let kw = self.read_keyword();
                Ok(Some(Token::Keyword(kw)))
            }
        }
    }

    /// Peek at the next token without consuming it.
    pub fn peek_token(&mut self) -> Result<Option<Token>, PdfError> {
        let saved = self.pos;
        let tok = self.next_token()?;
        self.pos = saved;
        Ok(tok)
    }

    // -----------------------------------------------------------------------
    // Whitespace / comments
    // -----------------------------------------------------------------------

    pub fn skip_whitespace_and_comments(&mut self) {
        loop {
            // Skip whitespace: NUL, TAB, LF, FF, CR, SPACE
            while self.pos < self.data.len()
                && matches!(
                    self.data[self.pos],
                    0x00 | 0x09 | 0x0A | 0x0C | 0x0D | 0x20
                )
            {
                self.pos += 1;
            }

            // Skip comment lines (% to end of line)
            if self.pos < self.data.len() && self.data[self.pos] == b'%' {
                while self.pos < self.data.len()
                    && self.data[self.pos] != 0x0A
                    && self.data[self.pos] != 0x0D
                {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Name
    // -----------------------------------------------------------------------

    fn read_name(&mut self) -> Result<Vec<u8>, PdfError> {
        let mut name = Vec::new();
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if is_delimiter(b) || is_whitespace(b) {
                break;
            }
            if b == b'#' {
                // #XX escape
                if self.pos + 2 >= self.data.len() {
                    return Err(PdfError::ParseError(
                        "Truncated #XX escape in name".into(),
                    ));
                }
                let hi = hex_digit(self.data[self.pos + 1])?;
                let lo = hex_digit(self.data[self.pos + 2])?;
                name.push((hi << 4) | lo);
                self.pos += 3;
            } else {
                name.push(b);
                self.pos += 1;
            }
        }
        Ok(name)
    }

    // -----------------------------------------------------------------------
    // Literal string
    // -----------------------------------------------------------------------

    fn read_literal_string(&mut self) -> Result<Vec<u8>, PdfError> {
        let mut out = Vec::new();
        let mut depth = 1usize; // we've already consumed the opening '('

        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            self.pos += 1;

            match b {
                b'(' => {
                    depth += 1;
                    out.push(b'(');
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(b')');
                }
                b'\\' => {
                    if self.pos >= self.data.len() {
                        return Err(PdfError::UnexpectedEof);
                    }
                    let esc = self.data[self.pos];
                    self.pos += 1;
                    match esc {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0C),
                        b'(' => out.push(b'('),
                        b')' => out.push(b')'),
                        b'\\' => out.push(b'\\'),
                        b'\r' => {
                            // backslash + CR or CRLF — line continuation
                            if self.pos < self.data.len() && self.data[self.pos] == b'\n' {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {} // line continuation
                        b'0'..=b'7' => {
                            // Octal escape (up to 3 digits)
                            let mut val = (esc - b'0') as u32;
                            for _ in 0..2 {
                                if self.pos < self.data.len()
                                    && self.data[self.pos] >= b'0'
                                    && self.data[self.pos] <= b'7'
                                {
                                    val = val * 8 + (self.data[self.pos] - b'0') as u32;
                                    self.pos += 1;
                                } else {
                                    break;
                                }
                            }
                            out.push((val & 0xFF) as u8);
                        }
                        other => {
                            // Unknown escape — treat as literal
                            out.push(other);
                        }
                    }
                }
                b'\r' => {
                    // CR or CRLF → LF
                    out.push(b'\n');
                    if self.pos < self.data.len() && self.data[self.pos] == b'\n' {
                        self.pos += 1;
                    }
                }
                other => out.push(other),
            }
        }

        Ok(out)
    }

    // -----------------------------------------------------------------------
    // Hex string
    // -----------------------------------------------------------------------

    fn read_hex_string(&mut self) -> Result<Vec<u8>, PdfError> {
        let mut out = Vec::new();
        let mut high: Option<u8> = None;

        loop {
            if self.pos >= self.data.len() {
                return Err(PdfError::UnexpectedEof);
            }
            let b = self.data[self.pos];
            self.pos += 1;

            if b == b'>' {
                // Flush any trailing nibble (spec: trailing nibble treated as 0)
                if let Some(h) = high {
                    out.push(h << 4);
                }
                break;
            }

            // Skip whitespace inside hex strings
            if is_whitespace(b) {
                continue;
            }

            let nibble = hex_digit(b)?;
            match high {
                None => high = Some(nibble),
                Some(h) => {
                    out.push((h << 4) | nibble);
                    high = None;
                }
            }
        }
        Ok(out)
    }

    // -----------------------------------------------------------------------
    // Numbers
    // -----------------------------------------------------------------------

    fn read_number(&mut self) -> Result<Option<Token>, PdfError> {
        let start = self.pos;
        let mut is_real = false;

        // Optional sign
        if self.pos < self.data.len() && matches!(self.data[self.pos], b'+' | b'-') {
            self.pos += 1;
        }

        while self.pos < self.data.len() {
            match self.data[self.pos] {
                b'0'..=b'9' => self.pos += 1,
                b'.' if !is_real => {
                    is_real = true;
                    self.pos += 1;
                }
                _ => break,
            }
        }

        let s = std::str::from_utf8(&self.data[start..self.pos])
            .map_err(|_| PdfError::ParseError("Non-UTF8 in number".into()))?;

        if is_real {
            let v: f64 = s
                .parse()
                .map_err(|_| PdfError::ParseError(format!("Invalid real: {}", s)))?;
            Ok(Some(Token::Real(v)))
        } else {
            let v: i64 = s
                .parse()
                .map_err(|_| PdfError::ParseError(format!("Invalid integer: {}", s)))?;
            Ok(Some(Token::Integer(v)))
        }
    }

    // -----------------------------------------------------------------------
    // Keywords
    // -----------------------------------------------------------------------

    fn read_keyword(&mut self) -> Vec<u8> {
        let start = self.pos;
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if is_whitespace(b) || is_delimiter(b) {
                break;
            }
            self.pos += 1;
        }
        self.data[start..self.pos].to_vec()
    }

    // -----------------------------------------------------------------------
    // Helpers for the object parser
    // -----------------------------------------------------------------------

    /// Skip an exact byte sequence, returning an error if it doesn't match.
    pub fn expect_bytes(&mut self, expected: &[u8]) -> Result<(), PdfError> {
        if self.data.get(self.pos..self.pos + expected.len()) == Some(expected) {
            self.pos += expected.len();
            Ok(())
        } else {
            Err(PdfError::ParseError(format!(
                "Expected {:?} at offset {}",
                expected, self.pos
            )))
        }
    }

    /// Read a single line (up to and including CR/LF/CRLF), returning the line
    /// without the line ending.
    pub fn read_line(&mut self) -> Vec<u8> {
        let start = self.pos;
        while self.pos < self.data.len()
            && self.data[self.pos] != b'\n'
            && self.data[self.pos] != b'\r'
        {
            self.pos += 1;
        }
        let line = self.data[start..self.pos].to_vec();
        // consume line ending(s)
        if self.pos < self.data.len() && self.data[self.pos] == b'\r' {
            self.pos += 1;
        }
        if self.pos < self.data.len() && self.data[self.pos] == b'\n' {
            self.pos += 1;
        }
        line
    }
}

// ---------------------------------------------------------------------------
// Character classification helpers
// ---------------------------------------------------------------------------

pub fn is_whitespace(b: u8) -> bool {
    matches!(b, 0x00 | 0x09 | 0x0A | 0x0C | 0x0D | 0x20)
}

pub fn is_delimiter(b: u8) -> bool {
    matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

fn hex_digit(b: u8) -> Result<u8, PdfError> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(PdfError::ParseError(format!(
            "Invalid hex digit: {:02X}",
            b
        ))),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(s: &[u8]) -> Token {
        Lexer::new(s).next_token().unwrap().unwrap()
    }

    #[test]
    fn integer_positive() {
        assert_eq!(tok(b"42"), Token::Integer(42));
    }

    #[test]
    fn integer_negative() {
        assert_eq!(tok(b"-7"), Token::Integer(-7));
    }

    #[test]
    fn real_number() {
        match tok(b"3.14") {
            Token::Real(v) => assert!((v - 3.14).abs() < 1e-10),
            other => panic!("Expected Real, got {:?}", other),
        }
    }

    #[test]
    fn name_simple() {
        assert_eq!(tok(b"/Type"), Token::Name(b"Type".to_vec()));
    }

    #[test]
    fn name_with_hash_escape() {
        assert_eq!(tok(b"/J#6Fs"), Token::Name(b"Jos".to_vec()));
    }

    #[test]
    fn literal_string_simple() {
        assert_eq!(
            tok(b"(hello)"),
            Token::LiteralString(b"hello".to_vec())
        );
    }

    #[test]
    fn literal_string_nested_parens() {
        assert_eq!(
            tok(b"(a(b)c)"),
            Token::LiteralString(b"a(b)c".to_vec())
        );
    }

    #[test]
    fn literal_string_escape_n() {
        assert_eq!(
            tok(b"(a\\nb)"),
            Token::LiteralString(b"a\nb".to_vec())
        );
    }

    #[test]
    fn literal_string_octal() {
        // \101 = 'A'
        assert_eq!(
            tok(b"(\\101)"),
            Token::LiteralString(b"A".to_vec())
        );
    }

    #[test]
    fn hex_string() {
        assert_eq!(
            tok(b"<48656C6C6F>"),
            Token::HexString(b"Hello".to_vec())
        );
    }

    #[test]
    fn hex_string_odd_digits() {
        // trailing nibble treated as 0 → 0x40
        assert_eq!(tok(b"<4>"), Token::HexString(vec![0x40]));
    }

    #[test]
    fn dict_delimiters() {
        let mut lex = Lexer::new(b"<< >>");
        assert_eq!(lex.next_token().unwrap(), Some(Token::DictStart));
        assert_eq!(lex.next_token().unwrap(), Some(Token::DictEnd));
    }

    #[test]
    fn array_delimiters() {
        let mut lex = Lexer::new(b"[]");
        assert_eq!(lex.next_token().unwrap(), Some(Token::ArrayStart));
        assert_eq!(lex.next_token().unwrap(), Some(Token::ArrayEnd));
    }

    #[test]
    fn keyword_r() {
        assert_eq!(tok(b"R"), Token::Keyword(b"R".to_vec()));
    }

    #[test]
    fn keyword_null() {
        assert_eq!(tok(b"null"), Token::Keyword(b"null".to_vec()));
    }

    #[test]
    fn comment_skipped() {
        // Comment before the integer
        assert_eq!(tok(b"% comment\n99"), Token::Integer(99));
    }

    #[test]
    fn eof_returns_none() {
        assert_eq!(Lexer::new(b"  ").next_token().unwrap(), None);
    }
}
