use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

#[derive(Serialize, Deserialize, Default)]
pub struct PdfMetadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub mod_date: Option<String>,
}

#[derive(Serialize)]
pub struct PdfInfo {
    pub page_count: usize,
    pub file_size: u64,
    pub metadata: PdfMetadata,
}

fn get_info_string(doc: &Document, key: &[u8]) -> Option<String> {
    // Get Info dict reference from trailer
    let info_id = doc.trailer.get(b"Info").ok()?.as_reference().ok()?;
    // Dereference it
    let info_obj = doc.get_object(info_id).ok()?;
    if let Object::Dictionary(dict) = info_obj {
        let val = dict.get(key).ok()?;
        // May be a string literal or a string reference
        val.as_str().ok().map(|s| String::from_utf8_lossy(s).to_string())
    } else {
        None
    }
}

#[tauri::command]
pub async fn get_pdf_info(path: String) -> AppResult<PdfInfo> {
    tokio::task::spawn_blocking(move || -> AppResult<PdfInfo> {
        let doc = crate::commands::lopdf_cache::load(&path)?;
        let d = doc.as_ref();
        let page_count = d.get_pages().len();
        let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

        let metadata = PdfMetadata {
            title: get_info_string(d, b"Title"),
            author: get_info_string(d, b"Author"),
            subject: get_info_string(d, b"Subject"),
            keywords: get_info_string(d, b"Keywords"),
            creator: get_info_string(d, b"Creator"),
            producer: get_info_string(d, b"Producer"),
            creation_date: get_info_string(d, b"CreationDate"),
            mod_date: get_info_string(d, b"ModDate"),
        };

        Ok(PdfInfo { page_count, file_size, metadata })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn get_metadata(path: String) -> AppResult<PdfMetadata> {
    let doc = crate::commands::lopdf_cache::load(&path)?;
    let d = doc.as_ref();
    Ok(PdfMetadata {
        title: get_info_string(d, b"Title"),
        author: get_info_string(d, b"Author"),
        subject: get_info_string(d, b"Subject"),
        keywords: get_info_string(d, b"Keywords"),
        creator: get_info_string(d, b"Creator"),
        producer: get_info_string(d, b"Producer"),
        creation_date: get_info_string(d, b"CreationDate"),
        mod_date: get_info_string(d, b"ModDate"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPermissions {
    pub encrypted: bool,
    pub print: bool,
    pub modify_contents: bool,
    pub copy_extract: bool,
    pub annotate: bool,
    pub fill_forms: bool,
    pub accessibility_extract: bool,
    pub assemble: bool,
    pub print_high_quality: bool,
    pub p_value: Option<i64>,
    pub revision: Option<i64>,
    pub algorithm: Option<String>,
}

impl Default for PdfPermissions {
    fn default() -> Self {
        // No /Encrypt dict → all permissions implicit.
        Self {
            encrypted: false,
            print: true,
            modify_contents: true,
            copy_extract: true,
            annotate: true,
            fill_forms: true,
            accessibility_extract: true,
            assemble: true,
            print_high_quality: true,
            p_value: None,
            revision: None,
            algorithm: None,
        }
    }
}

fn algorithm_name(v: i64) -> &'static str {
    // PDF spec §7.6.3.1 — /V values.
    match v {
        1 => "RC4 40-bit (V1)",
        2 => "RC4 128-bit (V2)",
        4 => "AES-128 (V4)",
        5 => "AES-256 (V5)",
        _ => "Unknown",
    }
}

/// Read the permission flags from /Encrypt /P. Returns defaults (everything
/// allowed) when the document is not encrypted.
#[tauri::command]
pub fn get_pdf_permissions(path: String) -> AppResult<PdfPermissions> {
    let doc = crate::commands::lopdf_cache::load(&path)?;
    let Ok(encrypt_ref) = doc.trailer.get(b"Encrypt") else {
        return Ok(PdfPermissions::default());
    };
    let encrypt_id = match encrypt_ref.as_reference() {
        Ok(id) => id,
        Err(_) => return Ok(PdfPermissions::default()),
    };
    let Ok(encrypt_obj) = doc.get_object(encrypt_id) else {
        return Ok(PdfPermissions::default());
    };
    let Object::Dictionary(dict) = encrypt_obj else {
        return Ok(PdfPermissions::default());
    };

    let p = dict.get(b"P").ok().and_then(|o| o.as_i64().ok()).unwrap_or(-1);
    let revision = dict.get(b"R").ok().and_then(|o| o.as_i64().ok());
    let algorithm = dict
        .get(b"V")
        .ok()
        .and_then(|o| o.as_i64().ok())
        .map(|v| algorithm_name(v).to_string());

    // Spec §7.6.3.2: bits are 1-based. Bit N corresponds to (1 << (N-1)).
    // P is a signed 32-bit integer; treat unset bits in higher positions as the
    // "1" defaults (all permissions granted) when revision < 3.
    let bit = |n: u32| -> bool { (p & (1i64 << (n - 1))) != 0 };

    let rev = revision.unwrap_or(2);
    let rev3plus = rev >= 3;

    Ok(PdfPermissions {
        encrypted: true,
        print: bit(3),
        modify_contents: bit(4),
        copy_extract: bit(5),
        annotate: bit(6),
        fill_forms: if rev3plus { bit(9) } else { bit(6) },
        accessibility_extract: if rev3plus { bit(10) } else { bit(5) },
        assemble: if rev3plus { bit(11) } else { bit(4) },
        print_high_quality: if rev3plus { bit(12) } else { bit(3) },
        p_value: Some(p),
        revision,
        algorithm,
    })
}

#[tauri::command]
pub fn set_metadata(
    path: String,
    metadata: PdfMetadata,
    output: Option<String>,
) -> AppResult<String> {
    let mut doc = Document::load(&path)?;

    // Get or create Info dictionary
    let info_id = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .unwrap_or_else(|| {
            let id = doc.add_object(Object::Dictionary(lopdf::Dictionary::new()));
            doc.trailer.set("Info", Object::Reference(id));
            id
        });

    let info = doc.get_object_mut(info_id)?;
    if let Object::Dictionary(dict) = info {
        let set_str = |dict: &mut lopdf::Dictionary, key: &[u8], val: Option<&String>| {
            if let Some(v) = val {
                dict.set(key, Object::string_literal(v.clone()));
            }
        };
        set_str(dict, b"Title", metadata.title.as_ref());
        set_str(dict, b"Author", metadata.author.as_ref());
        set_str(dict, b"Subject", metadata.subject.as_ref());
        set_str(dict, b"Keywords", metadata.keywords.as_ref());
        set_str(dict, b"Creator", metadata.creator.as_ref());
    }

    let out = output.unwrap_or_else(|| temp_output_path(&path, "meta"));
    doc.save(&out)?;
    Ok(out)
}
