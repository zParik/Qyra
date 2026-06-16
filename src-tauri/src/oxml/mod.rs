//! OOXML / OPC package handling — the spine of lossless Word/Excel/PowerPoint
//! interop.
//!
//! A `.docx` / `.xlsx` / `.pptx` is an OPC package: a ZIP whose entries ("parts")
//! are XML and media. The whole interop strategy rests on one invariant — we
//! decompose a package into its parts, edit only the parts we understand, and
//! write *every* part back byte-for-byte, known or not. Parts we don't yet
//! model (macros, SmartArt, custom XML, vendor extensions) ride along untouched,
//! so a save reproduces a file the host app treats as identical.
//!
//! This is deliberately a plain module for now. When the document model + layout
//! engine land it grows into its own crate (`oxml`), extracted from here.
//! ponytail: module-in-crate until it earns a workspace split; no premature crate.

use std::io::{Cursor, Read, Write};

use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// One part of an OPC package: its path within the ZIP plus its raw bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub data: Vec<u8>,
}

/// An OPC package decomposed into its parts, in their original order.
///
/// `load` then `save` is lossless at the part level: every part's name and
/// bytes survive a round trip. ZIP container details (compression method,
/// timestamps, extra fields) are *not* preserved — Office addresses parts by
/// name and ignores those, so re-compressing is safe.
pub struct Package {
    pub parts: Vec<Part>,
}

impl Package {
    /// Decompose package bytes (a `.docx` etc.) into ordered parts.
    pub fn load(bytes: &[u8]) -> Result<Self, PackageError> {
        let mut zip = ZipArchive::new(Cursor::new(bytes))?;
        let mut parts = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            // Directory entries carry no content and are implied by part names.
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let mut data = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut data)?;
            parts.push(Part { name, data });
        }
        Ok(Self { parts })
    }

    /// Recompose the parts into package bytes. Parts are written in their stored
    /// order with deflate; content is reproduced byte-for-byte.
    pub fn save(&self) -> Result<Vec<u8>, PackageError> {
        let mut buf = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for part in &self.parts {
                zip.start_file(part.name.as_str(), opts)?;
                zip.write_all(&part.data)?;
            }
            zip.finish()?;
        }
        Ok(buf)
    }

    /// Find a part by its package path, e.g. `"word/document.xml"`.
    pub fn part(&self, name: &str) -> Option<&Part> {
        self.parts.iter().find(|p| p.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    /// Build a minimal but representative `.docx` using the raw `zip` writer
    /// (an independent code path from `Package::save`) so the round-trip test
    /// exercises `load` against bytes we didn't produce ourselves. Includes a
    /// binary media part and an "unknown" custom-XML part to prove non-text and
    /// unmodelled parts survive untouched.
    fn fixture_docx() -> (Vec<u8>, Vec<Part>) {
        let parts = vec![
            Part {
                name: "[Content_Types].xml".into(),
                data: br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#.to_vec(),
            },
            Part {
                name: "_rels/.rels".into(),
                data: br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#.to_vec(),
            },
            Part {
                name: "word/document.xml".into(),
                data: br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Qyra</w:t></w:r></w:p></w:body></w:document>"#.to_vec(),
            },
            // Binary media: must survive byte-identical, no text mangling.
            Part {
                name: "word/media/image1.png".into(),
                data: vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0x10, 0x42],
            },
            // Unmodelled part: the spine claim — rides along untouched.
            Part {
                name: "customXml/item1.xml".into(),
                data: br#"<root vendor="acme"><secret/></root>"#.to_vec(),
            },
        ];

        let mut buf = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for part in &parts {
                zip.start_file(part.name.as_str(), opts).unwrap();
                zip.write_all(&part.data).unwrap();
            }
            zip.finish().unwrap();
        }
        (buf, parts)
    }

    #[test]
    fn round_trip_preserves_every_part_byte_for_byte() {
        let (bytes, expected) = fixture_docx();

        // load -> save -> load: the lossless gate.
        let pkg = Package::load(&bytes).expect("load fixture");
        let saved = pkg.save().expect("save package");
        let reloaded = Package::load(&saved).expect("reload saved");

        assert_eq!(
            reloaded.parts, expected,
            "parts must survive a round trip byte-for-byte and in order"
        );
    }

    #[test]
    fn unknown_and_binary_parts_survive() {
        let (bytes, _) = fixture_docx();
        let reloaded = Package::load(&Package::load(&bytes).unwrap().save().unwrap()).unwrap();

        let media = reloaded.part("word/media/image1.png").expect("media part");
        assert_eq!(
            media.data,
            vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0x10, 0x42],
            "binary media must not be mangled"
        );

        let custom = reloaded.part("customXml/item1.xml").expect("unknown part");
        assert_eq!(
            custom.data, br#"<root vendor="acme"><secret/></root>"#,
            "unmodelled parts must ride along untouched"
        );
    }
}
