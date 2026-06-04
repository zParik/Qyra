use crate::error::AppResult;
use crate::utils::paths::temp_output_path;
use lopdf::{Document, Object};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AnonymizeOptions {
    pub strip_info: bool,
    pub strip_xmp_metadata: bool,
    pub strip_javascript: bool,
    pub strip_embedded_files: bool,
    pub strip_open_actions: bool,
    pub strip_annot_authors: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnonymizeReport {
    pub output: String,
    pub info_fields_removed: usize,
    pub xmp_removed: bool,
    pub names_removed: bool,
    pub open_action_removed: bool,
    pub additional_actions_removed: bool,
    pub annot_authors_removed: usize,
}

fn strip_dict_keys(dict: &mut lopdf::Dictionary, keys: &[&[u8]]) -> usize {
    let mut removed = 0;
    for key in keys {
        if dict.remove(key).is_some() {
            removed += 1;
        }
    }
    removed
}

#[tauri::command]
pub fn anonymize_pdf(
    path: String,
    options: AnonymizeOptions,
    output: Option<String>,
) -> AppResult<AnonymizeReport> {
    let _t = crate::utils::timing::Timer::start("anonymize_pdf", String::new());
    let mut doc = Document::load(&path)?;

    let mut report = AnonymizeReport {
        output: String::new(),
        info_fields_removed: 0,
        xmp_removed: false,
        names_removed: false,
        open_action_removed: false,
        additional_actions_removed: false,
        annot_authors_removed: 0,
    };

    // /Info — Title/Author/Subject/Keywords/Creator/Producer/CreationDate/ModDate.
    if options.strip_info {
        if let Ok(info_id) = doc.trailer.get(b"Info").and_then(|o| o.as_reference()) {
            if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(info_id) {
                report.info_fields_removed = strip_dict_keys(
                    dict,
                    &[
                        b"Title", b"Author", b"Subject", b"Keywords",
                        b"Creator", b"Producer", b"CreationDate", b"ModDate",
                    ],
                );
            }
        }
    }

    // Catalog-level strips: /Metadata (XMP), /Names (tree includes EmbeddedFiles + JavaScript),
    // /OpenAction, /AA (additional actions).
    let catalog_id = doc.catalog().ok().and_then(|c| {
        doc.trailer
            .get(b"Root")
            .ok()
            .and_then(|o| o.as_reference().ok())
            .map(|id| (id, c))
    });

    if let Some((root_id, _)) = catalog_id {
        if let Ok(Object::Dictionary(catalog)) = doc.get_object_mut(root_id) {
            if options.strip_xmp_metadata && catalog.remove(b"Metadata").is_some() {
                report.xmp_removed = true;
            }
            if (options.strip_javascript || options.strip_embedded_files)
                && catalog.remove(b"Names").is_some()
            {
                report.names_removed = true;
            }
            if options.strip_open_actions {
                if catalog.remove(b"OpenAction").is_some() {
                    report.open_action_removed = true;
                }
                if catalog.remove(b"AA").is_some() {
                    report.additional_actions_removed = true;
                }
            }
            if options.strip_javascript {
                // /AcroForm may host XFA + form-level JS.
                if let Ok(Object::Reference(form_id)) = catalog.get(b"AcroForm") {
                    let form_id = *form_id;
                    if let Ok(Object::Dictionary(form)) = doc.get_object_mut(form_id) {
                        form.remove(b"XFA");
                        form.remove(b"JS");
                    }
                }
            }
        }
    }

    // Per-annotation /T (author) field.
    if options.strip_annot_authors {
        let page_ids: Vec<lopdf::ObjectId> = doc.page_iter().collect();
        for page_id in page_ids {
            let annot_refs: Vec<lopdf::ObjectId> = {
                let Ok(Object::Dictionary(page)) = doc.get_object(page_id) else { continue };
                let Ok(annots) = page.get(b"Annots") else { continue };
                match annots {
                    Object::Array(arr) => arr
                        .iter()
                        .filter_map(|o| o.as_reference().ok())
                        .collect(),
                    Object::Reference(id) => match doc.get_object(*id) {
                        Ok(Object::Array(arr)) => arr
                            .iter()
                            .filter_map(|o| o.as_reference().ok())
                            .collect(),
                        _ => continue,
                    },
                    _ => continue,
                }
            };
            for annot_id in annot_refs {
                if let Ok(Object::Dictionary(annot)) = doc.get_object_mut(annot_id) {
                    if annot.remove(b"T").is_some() { report.annot_authors_removed += 1; }
                    annot.remove(b"NM"); // unique annotation name (often UUID)
                    annot.remove(b"M");  // modification date
                }
            }
        }
    }

    let out = output.unwrap_or_else(|| temp_output_path(&path, "anon"));
    doc.save(&out)?;
    report.output = out;
    Ok(report)
}
