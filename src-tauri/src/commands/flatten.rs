use lopdf::{Document, Object, ObjectId};
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

#[tauri::command]
pub async fn flatten_pdf(
    path: String,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let mut doc = Document::load(&path)?;
        let out = output.unwrap_or_else(|| temp_output_path(&path, "flattened"));

        // Step 1: Collect all widget annotation object IDs from all pages
        let page_map: std::collections::HashMap<u32, ObjectId> =
            doc.get_pages().into_iter().collect();

        let mut widget_ids: Vec<ObjectId> = Vec::new();

        for (_page_num, page_id) in &page_map {
            // Resolve /Annots — may be inline Array or a Reference to an Array.
            // Extract any indirect ref first to avoid double-borrow of doc.
            enum AnnotsKind { Inline(Vec<ObjectId>), Indirect(ObjectId), Empty }
            let kind: AnnotsKind = {
                let page_obj = match doc.get_object(*page_id) {
                    Ok(obj) => obj,
                    Err(_) => continue,
                };
                let page_dict = match page_obj {
                    Object::Dictionary(d) => d,
                    _ => continue,
                };
                match page_dict.get(b"Annots") {
                    Ok(Object::Array(arr)) => AnnotsKind::Inline(
                        arr.iter().filter_map(|o| o.as_reference().ok()).collect()
                    ),
                    Ok(Object::Reference(r)) => AnnotsKind::Indirect(*r),
                    _ => AnnotsKind::Empty,
                }
            };
            let annots_refs: Vec<ObjectId> = match kind {
                AnnotsKind::Inline(ids) => ids,
                AnnotsKind::Indirect(ref_id) => match doc.get_object(ref_id) {
                    Ok(Object::Array(arr)) => arr.iter()
                        .filter_map(|o| o.as_reference().ok())
                        .collect(),
                    _ => vec![],
                },
                AnnotsKind::Empty => vec![],
            };

            // Collect widget annotations
            for annot_id in &annots_refs {
                let subtype = match doc.get_object(*annot_id) {
                    Ok(Object::Dictionary(d)) => match d.get(b"Subtype") {
                        Ok(Object::Name(n)) => String::from_utf8_lossy(n).to_string(),
                        _ => String::new(),
                    },
                    _ => String::new(),
                };
                if subtype == "Widget" {
                    widget_ids.push(*annot_id);
                }
            }
        }

        // Step 2: Set ReadOnly flag (bit 1 = value 1) on all widget annotations
        // /Ff field flags: bit 1 = ReadOnly
        for widget_id in &widget_ids {
            if let Ok(Object::Dictionary(d)) = doc.get_object_mut(*widget_id) {
                let existing_ff = match d.get(b"Ff") {
                    Ok(Object::Integer(n)) => *n,
                    _ => 0_i64,
                };
                d.set("Ff", Object::Integer(existing_ff | 1));
            }
        }

        // Step 3: Remove /AcroForm from catalog, making all form fields non-interactive.
        // Read the catalog to determine the AcroForm ref first, then mutate separately.
        let catalog_id: Option<ObjectId> = doc.trailer.get(b"Root")
            .ok()
            .and_then(|o| o.as_reference().ok());

        if let Some(cat_id) = catalog_id {
            // Read-only pass: find the AcroForm indirect ref (if any)
            let acroform_ref: Option<ObjectId> = match doc.get_object(cat_id) {
                Ok(Object::Dictionary(d)) => match d.get(b"AcroForm") {
                    Ok(Object::Reference(r)) => Some(*r),
                    _ => None,
                },
                _ => None,
            };

            // Mutable pass 1: set NeedAppearances=false on AcroForm dict
            if let Some(af_id) = acroform_ref {
                if let Ok(Object::Dictionary(af_dict)) = doc.get_object_mut(af_id) {
                    af_dict.set("NeedAppearances", Object::Boolean(false));
                }
            }

            // Mutable pass 2: remove AcroForm key from catalog
            if let Ok(Object::Dictionary(cat_dict)) = doc.get_object_mut(cat_id) {
                cat_dict.remove(b"AcroForm");
            }
        }

        doc.save(&out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
