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
        let doc = Document::load(&path)?;
        let page_count = doc.get_pages().len();
        let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

        let metadata = PdfMetadata {
            title: get_info_string(&doc, b"Title"),
            author: get_info_string(&doc, b"Author"),
            subject: get_info_string(&doc, b"Subject"),
            keywords: get_info_string(&doc, b"Keywords"),
            creator: get_info_string(&doc, b"Creator"),
            producer: get_info_string(&doc, b"Producer"),
            creation_date: get_info_string(&doc, b"CreationDate"),
            mod_date: get_info_string(&doc, b"ModDate"),
        };

        Ok(PdfInfo { page_count, file_size, metadata })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn get_metadata(path: String) -> AppResult<PdfMetadata> {
    let doc = Document::load(&path)?;
    Ok(PdfMetadata {
        title: get_info_string(&doc, b"Title"),
        author: get_info_string(&doc, b"Author"),
        subject: get_info_string(&doc, b"Subject"),
        keywords: get_info_string(&doc, b"Keywords"),
        creator: get_info_string(&doc, b"Creator"),
        producer: get_info_string(&doc, b"Producer"),
        creation_date: get_info_string(&doc, b"CreationDate"),
        mod_date: get_info_string(&doc, b"ModDate"),
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
