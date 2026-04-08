use crate::pdf::types::ObjectId;

#[derive(Debug)]
pub enum PdfError {
    Io(std::io::Error),
    InvalidHeader,
    XrefNotFound,
    MalformedXref(String),
    MalformedObject { id: ObjectId, reason: String },
    EncryptedDocument,
    UnsupportedFilter(String),
    ImageDecodeError(String),
    WriteError(String),
    UnexpectedEof,
    ParseError(String),
}

impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PdfError::Io(e) => write!(f, "I/O error: {}", e),
            PdfError::InvalidHeader => write!(f, "Invalid PDF header"),
            PdfError::XrefNotFound => write!(f, "Cross-reference table not found"),
            PdfError::MalformedXref(msg) => write!(f, "Malformed xref: {}", msg),
            PdfError::MalformedObject { id, reason } => {
                write!(f, "Malformed object ({}, {}): {}", id.0, id.1, reason)
            }
            PdfError::EncryptedDocument => {
                write!(f, "Cannot process encrypted PDF. Unlock it first.")
            }
            PdfError::UnsupportedFilter(name) => {
                write!(f, "Unsupported stream filter: {}", name)
            }
            PdfError::ImageDecodeError(msg) => write!(f, "Image decode error: {}", msg),
            PdfError::WriteError(msg) => write!(f, "Write error: {}", msg),
            PdfError::UnexpectedEof => write!(f, "Unexpected end of file"),
            PdfError::ParseError(msg) => write!(f, "Parse error: {}", msg),
        }
    }
}

impl std::error::Error for PdfError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PdfError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for PdfError {
    fn from(e: std::io::Error) -> Self {
        PdfError::Io(e)
    }
}
