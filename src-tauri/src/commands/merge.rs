use std::collections::BTreeMap;
use lopdf::{Document, Object, ObjectId};
use tauri::Emitter;
use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;
use crate::error::{AppError, AppResult};

/// Merge multiple PDFs into one, using the approach from the lopdf merge example.
#[tauri::command]
pub async fn merge_pdfs(
    paths: Vec<String>,
    output: Option<String>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    if paths.len() < 2 {
        return Err(AppError::Invalid("Need at least 2 files to merge".to_string()));
    }

    let total = paths.len();
    let mut documents = Vec::with_capacity(total);
    for (i, p) in paths.iter().enumerate() {
        let doc = Document::load(p).map_err(|e| AppError::Pdf(format!("Failed to load {}: {}", p, e)))?;
        documents.push(doc);
        let _ = app_handle.emit(
            "operation-progress",
            Progress::new(i + 1, total, format!("Loading file {} of {}", i + 1, total)),
        );
    }

    let mut merged = merge_documents(documents)?;

    let out = output.unwrap_or_else(|| temp_output_path(&paths[0], "merged"));
    merged.save(&out)?;
    Ok(out)
}

pub fn merge_documents(mut documents: Vec<Document>) -> AppResult<Document> {
    let mut max_id = 1u32;
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut document = Document::with_version("1.5");

    for doc in documents.iter_mut() {
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        doc.get_pages()
            .into_values()
            .for_each(|object_id| {
                if let Ok(obj) = doc.get_object(object_id) {
                    documents_pages.insert(object_id, obj.to_owned());
                }
            });

        documents_objects.extend(doc.objects.clone());
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.into_iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((
                    if let Some((id, _)) = catalog_object { id } else { object_id },
                    object,
                ));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref existing)) = pages_object {
                        if let Ok(old_dict) = existing.as_dict() {
                            dictionary.extend(old_dict);
                        }
                    }
                    pages_object = Some((
                        if let Some((id, _)) = pages_object { id } else { object_id },
                        Object::Dictionary(dictionary),
                    ));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {} // handled separately
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let pages_object = pages_object.ok_or_else(|| AppError::Pdf("Pages root not found in source PDFs".to_string()))?;
    let catalog_object = catalog_object.ok_or_else(|| AppError::Pdf("Catalog not found in source PDFs".to_string()))?;

    // Insert all pages with updated Parent reference
    for (object_id, object) in documents_pages.iter() {
        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_object.0);
            document.objects.insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    let (page_id, page_object) = pages_object;
    let (catalog_id, catalog_object) = catalog_object;

    // Build combined Pages dict
    if let Ok(dictionary) = page_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .keys()
                .map(|&id| Object::Reference(id))
                .collect::<Vec<_>>(),
        );
        document.objects.insert(page_id, Object::Dictionary(dictionary));
    }

    // Build combined Catalog
    if let Ok(dictionary) = catalog_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", page_id);
        dictionary.remove(b"Outlines");
        document.objects.insert(catalog_id, Object::Dictionary(dictionary));
    }

    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.adjust_zero_pages();

    Ok(document)
}
