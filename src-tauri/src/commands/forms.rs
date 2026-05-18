use lopdf::{Document, Object, ObjectId};
use crate::utils::paths::temp_output_path;

#[derive(serde::Serialize)]
pub struct FormField {
    pub name: String,
    pub field_type: String,
    pub value: String,
    pub page: u32,
    pub rect: [f64; 4],
    pub options: Vec<String>,
    pub flags: u32,
}

#[derive(serde::Deserialize)]
pub struct FieldValue {
    pub name: String,
    pub value: String,
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&words).to_string();
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&words).to_string();
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn object_to_string(obj: &Object) -> String {
    match obj {
        Object::String(bytes, _) => decode_pdf_string(bytes),
        Object::Name(bytes) => String::from_utf8_lossy(bytes).to_string(),
        Object::Integer(i) => i.to_string(),
        Object::Real(f) => f.to_string(),
        Object::Boolean(b) => b.to_string(),
        _ => String::new(),
    }
}

fn obj_to_f64(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(f) => *f as f64,
        _ => 0.0,
    }
}

fn page_media_box(doc: &Document, page_id: ObjectId) -> (f64, f64, f64, f64) {
    let try_get = || -> Option<(f64, f64, f64, f64)> {
        let obj = doc.get_object(page_id).ok()?;
        let d = obj.as_dict().ok()?;
        let mb = d.get(b"MediaBox").ok()?.as_array().ok()?;
        if mb.len() < 4 {
            return None;
        }
        Some((obj_to_f64(&mb[0]), obj_to_f64(&mb[1]), obj_to_f64(&mb[2]), obj_to_f64(&mb[3])))
    };
    try_get().unwrap_or((0.0, 0.0, 612.0, 792.0))
}

/// Resolve inherited field attribute: walk up the /Parent chain until found.
fn inherit_attr(doc: &Document, dict: &lopdf::Dictionary, key: &[u8]) -> Option<Object> {
    if let Ok(v) = dict.get(key) {
        return Some(v.clone());
    }
    // Walk up Parent chain iteratively to avoid borrow/lifetime issues
    let mut parent_id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    for _ in 0..32 {
        let parent_dict = doc.get_object(parent_id).ok()?.as_dict().ok()?.clone();
        if let Ok(v) = parent_dict.get(key) {
            return Some(v.clone());
        }
        match parent_dict.get(b"Parent").ok().and_then(|o| o.as_reference().ok()) {
            Some(id) => parent_id = id,
            None => break,
        }
    }
    None
}

/// Collect all terminal widget/field nodes recursively through /Kids.
/// A node is terminal if it has no /Kids or its /Kids are widget annotations
/// (i.e., children have /Subtype /Widget rather than a /FT field type).
fn collect_fields(
    doc: &Document,
    obj_id: ObjectId,
    page_map: &std::collections::HashMap<ObjectId, u32>,
    out: &mut Vec<FormField>,
    depth: usize,
) {
    if depth > 32 {
        return;
    }

    let obj = match doc.get_object(obj_id) {
        Ok(o) => o,
        Err(_) => return,
    };
    let dict = match obj.as_dict() {
        Ok(d) => d.clone(),
        Err(_) => return,
    };

    // If this node has /Kids, recurse — unless kids look like widget annotations
    // (have /Subtype /Widget but no /FT, meaning they're just annotation copies of a field).
    if let Ok(kids_obj) = dict.get(b"Kids") {
        if let Ok(kids) = kids_obj.as_array() {
            let kids_ids: Vec<ObjectId> = kids
                .iter()
                .filter_map(|o| o.as_reference().ok())
                .collect();

            // Determine if this node itself is a field (has /T)
            let has_t = dict.get(b"T").is_ok();
            let has_ft = inherit_attr(doc, &dict, b"FT").is_some();

            if !has_t || !has_ft {
                // Intermediate node — descend into kids
                for kid_id in kids_ids {
                    collect_fields(doc, kid_id, page_map, out, depth + 1);
                }
                return;
            }

            // This node has /T (field name) AND has kids.
            // Kids may be widget annotations for this field (multi-page or radio buttons).
            // Process each kid as a separate visual instance but share field metadata.
            let name = dict
                .get(b"T")
                .ok()
                .and_then(|o| if let Object::String(b, _) = o { Some(decode_pdf_string(b)) } else { None })
                .unwrap_or_default();

            let ft = inherit_attr(doc, &dict, b"FT")
                .map(|o| object_to_string(&o))
                .unwrap_or_else(|| "Tx".to_string());

            let value = inherit_attr(doc, &dict, b"V")
                .map(|o| object_to_string(&o))
                .unwrap_or_default();

            let flags = inherit_attr(doc, &dict, b"Ff")
                .and_then(|o| if let Object::Integer(i) = o { Some(i as u32) } else { None })
                .unwrap_or(0);

            let options: Vec<String> = dict
                .get(b"Opt")
                .ok()
                .and_then(|o| o.as_array().ok())
                .map(|arr| {
                    arr.iter()
                        .map(|item| match item {
                            Object::String(b, _) => decode_pdf_string(b),
                            Object::Array(a) => a
                                .get(1)
                                .or_else(|| a.first())
                                .map(|o| object_to_string(o))
                                .unwrap_or_default(),
                            _ => object_to_string(item),
                        })
                        .collect()
                })
                .unwrap_or_default();

            for kid_id in kids_ids {
                let kid_obj = match doc.get_object(kid_id) {
                    Ok(o) => o,
                    Err(_) => continue,
                };
                let kid_dict = match kid_obj.as_dict() {
                    Ok(d) => d.clone(),
                    Err(_) => continue,
                };

                let page_ref = kid_dict
                    .get(b"P")
                    .ok()
                    .and_then(|o| o.as_reference().ok());
                let page_num = page_ref
                    .and_then(|id| page_map.get(&id).copied())
                    .unwrap_or(1);

                let (bx0, by0, bx1, by1) = if let Some(pid) = page_ref {
                    page_media_box(doc, pid)
                } else {
                    (0.0, 0.0, 612.0, 792.0)
                };
                let pw = (bx1 - bx0).abs().max(1.0);
                let ph = (by1 - by0).abs().max(1.0);

                let rect = kid_dict
                    .get(b"Rect")
                    .ok()
                    .and_then(|o| o.as_array().ok())
                    .filter(|a| a.len() >= 4)
                    .map(|a| {
                        let x0 = (obj_to_f64(&a[0]) - bx0) / pw;
                        let y0 = (obj_to_f64(&a[1]) - by0) / ph;
                        let x1 = (obj_to_f64(&a[2]) - bx0) / pw;
                        let y1 = (obj_to_f64(&a[3]) - by0) / ph;
                        [x0, y0, x1, y1]
                    })
                    .unwrap_or([0.0, 0.0, 0.0, 0.0]);

                out.push(FormField {
                    name: name.clone(),
                    field_type: ft.clone(),
                    value: value.clone(),
                    page: page_num,
                    rect,
                    options: options.clone(),
                    flags,
                });
            }
            return;
        }
    }

    // Leaf node (no /Kids): this is a single widget+field combo
    let name = match inherit_attr(doc, &dict, b"T") {
        Some(Object::String(b, _)) => decode_pdf_string(&b),
        _ => return, // not a field node
    };

    let ft = inherit_attr(doc, &dict, b"FT")
        .map(|o| object_to_string(&o))
        .unwrap_or_else(|| "Tx".to_string());

    let value = inherit_attr(doc, &dict, b"V")
        .map(|o| object_to_string(&o))
        .unwrap_or_default();

    let flags = inherit_attr(doc, &dict, b"Ff")
        .and_then(|o| if let Object::Integer(i) = o { Some(i as u32) } else { None })
        .unwrap_or(0);

    let options = dict
        .get(b"Opt")
        .ok()
        .and_then(|o| o.as_array().ok())
        .map(|arr| {
            arr.iter()
                .map(|item| match item {
                    Object::String(b, _) => decode_pdf_string(b),
                    Object::Array(a) => a
                        .get(1)
                        .or_else(|| a.first())
                        .map(|o| object_to_string(o))
                        .unwrap_or_default(),
                    _ => object_to_string(item),
                })
                .collect()
        })
        .unwrap_or_default();

    let page_ref = dict.get(b"P").ok().and_then(|o| o.as_reference().ok());
    let page_num = page_ref
        .and_then(|id| page_map.get(&id).copied())
        .unwrap_or(1);

    let (bx0, by0, bx1, by1) = {
        if let Some(pid) = page_ref {
            page_media_box(doc, pid)
        } else {
            (0.0, 0.0, 612.0, 792.0)
        }
    };
    let pw = (bx1 - bx0).abs().max(1.0);
    let ph = (by1 - by0).abs().max(1.0);

    let rect = dict
        .get(b"Rect")
        .ok()
        .and_then(|o| o.as_array().ok())
        .filter(|a| a.len() >= 4)
        .map(|a| {
            let x0 = (obj_to_f64(&a[0]) - bx0) / pw;
            let y0 = (obj_to_f64(&a[1]) - by0) / ph;
            let x1 = (obj_to_f64(&a[2]) - bx0) / pw;
            let y1 = (obj_to_f64(&a[3]) - by0) / ph;
            [x0, y0, x1, y1]
        })
        .unwrap_or([0.0, 0.0, 0.0, 0.0]);

    out.push(FormField { name, field_type: ft, value, page: page_num, rect, options, flags });
}

fn get_form_fields_sync(path: &str) -> Result<Vec<FormField>, String> {
    let doc = Document::load(path).map_err(|e| e.to_string())?;

    let catalog_id = doc
        .trailer
        .get(b"Root")
        .and_then(|o| o.as_reference())
        .map_err(|e| e.to_string())?;
    let catalog = doc
        .get_object(catalog_id)
        .and_then(|o| o.as_dict())
        .map_err(|e| e.to_string())?
        .clone();

    let acroform_obj = match catalog.get(b"AcroForm") {
        Ok(o) => o.clone(),
        Err(_) => return Ok(vec![]),
    };

    let acroform = match &acroform_obj {
        Object::Dictionary(d) => d.clone(),
        Object::Reference(id) => doc
            .get_object(*id)
            .and_then(|o| o.as_dict())
            .map_err(|e| e.to_string())?
            .clone(),
        _ => return Ok(vec![]),
    };

    let fields_arr = match acroform.get(b"Fields") {
        Ok(o) => match o {
            Object::Array(a) => a.clone(),
            Object::Reference(id) => doc
                .get_object(*id)
                .and_then(|o| o.as_array())
                .map_err(|e| e.to_string())?
                .clone(),
            _ => return Ok(vec![]),
        },
        Err(_) => return Ok(vec![]),
    };

    let page_map: std::collections::HashMap<ObjectId, u32> = doc
        .get_pages()
        .into_iter()
        .map(|(num, id)| (id, num))
        .collect();

    let field_ids: Vec<ObjectId> = fields_arr
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .collect();

    let mut fields = Vec::new();
    for fid in field_ids {
        collect_fields(&doc, fid, &page_map, &mut fields, 0);
    }

    Ok(fields)
}

#[tauri::command]
pub async fn get_form_fields(path: String) -> Result<Vec<FormField>, String> {
    tokio::task::spawn_blocking(move || get_form_fields_sync(&path))
        .await
        .map_err(|e| e.to_string())?
}

// ── fill_form ─────────────────────────────────────────────────────────────────

/// Collect all (ObjectId, field_name) pairs by traversing the AcroForm tree.
fn collect_field_object_ids(
    doc: &Document,
    obj_id: ObjectId,
    out: &mut Vec<(ObjectId, String)>,
    depth: usize,
) {
    if depth > 32 {
        return;
    }
    let obj = match doc.get_object(obj_id) {
        Ok(o) => o,
        Err(_) => return,
    };
    let dict = match obj.as_dict() {
        Ok(d) => d.clone(),
        Err(_) => return,
    };

    // If this node has a /T name, record it
    if let Ok(Object::String(b, _)) = dict.get(b"T") {
        let name = decode_pdf_string(b);
        out.push((obj_id, name));
    }

    // Recurse into /Kids
    if let Ok(kids_obj) = dict.get(b"Kids") {
        if let Ok(kids) = kids_obj.as_array() {
            let kid_ids: Vec<ObjectId> = kids.iter().filter_map(|o| o.as_reference().ok()).collect();
            for kid_id in kid_ids {
                collect_field_object_ids(doc, kid_id, out, depth + 1);
            }
        }
    }
}

/// Returns field object IDs from the AcroForm tree, or None if no form exists.
fn acroform_field_ids(doc: &Document) -> Result<Vec<ObjectId>, String> {
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .and_then(|o| o.as_reference())
        .map_err(|e| e.to_string())?;
    let catalog = doc
        .get_object(catalog_id)
        .and_then(|o| o.as_dict())
        .map_err(|e| e.to_string())?
        .clone();

    let acroform_obj = match catalog.get(b"AcroForm") {
        Ok(o) => o.clone(),
        Err(_) => return Ok(vec![]),
    };

    let acroform = match acroform_obj {
        Object::Dictionary(d) => d,
        Object::Reference(id) => doc
            .get_object(id)
            .and_then(|o| o.as_dict())
            .map_err(|e| e.to_string())?
            .clone(),
        _ => return Ok(vec![]),
    };

    let fields_arr = match acroform.get(b"Fields") {
        Ok(Object::Array(a)) => a.clone(),
        Ok(Object::Reference(id)) => doc
            .get_object(*id)
            .and_then(|o| o.as_array())
            .map_err(|e| e.to_string())?
            .clone(),
        _ => return Ok(vec![]),
    };

    let top_ids: Vec<ObjectId> = fields_arr.iter().filter_map(|o| o.as_reference().ok()).collect();
    let mut id_name_pairs: Vec<(ObjectId, String)> = Vec::new();
    for top_id in top_ids {
        collect_field_object_ids(doc, top_id, &mut id_name_pairs, 0);
    }
    Ok(id_name_pairs.into_iter().map(|(id, _)| id).collect())
}

fn fill_form_sync(
    path: &str,
    fields: Vec<FieldValue>,
    flatten: bool,
    output: Option<String>,
) -> Result<String, String> {
    let out = output.unwrap_or_else(|| temp_output_path(path, "filled"));
    let mut doc = Document::load(path).map_err(|e| e.to_string())?;

    let field_obj_ids = acroform_field_ids(&doc)?;

    // For each field object, read /T, find matching value, mutate
    for obj_id in field_obj_ids {
        let name = {
            let obj = match doc.get_object(obj_id) {
                Ok(o) => o,
                Err(_) => continue,
            };
            let dict = match obj.as_dict() {
                Ok(d) => d,
                Err(_) => continue,
            };
            match dict.get(b"T") {
                Ok(Object::String(b, _)) => decode_pdf_string(b),
                _ => continue,
            }
        };

        let new_value = match fields.iter().find(|fv| fv.name == name) {
            Some(fv) => fv.value.clone(),
            None => continue,
        };

        let obj_mut = doc.get_object_mut(obj_id).map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = obj_mut {
            d.set("V", Object::string_literal(new_value));
            d.set("AP", Object::Null);

            if flatten {
                let current_ff = d
                    .get(b"Ff")
                    .ok()
                    .and_then(|o| if let Object::Integer(i) = o { Some(*i) } else { None })
                    .unwrap_or(0);
                d.set("Ff", Object::Integer(current_ff | 1));
            }
        }
    }

    if flatten {
        let catalog_id = doc
            .trailer
            .get(b"Root")
            .and_then(|o| o.as_reference())
            .map_err(|e| e.to_string())?;
        let catalog_obj = doc.get_object_mut(catalog_id).map_err(|e| e.to_string())?;
        if let Object::Dictionary(d) = catalog_obj {
            d.set("AcroForm", Object::Null);
        }
    }

    doc.save(&out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub async fn fill_form(
    path: String,
    fields: Vec<FieldValue>,
    flatten: bool,
    output: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || fill_form_sync(&path, fields, flatten, output))
        .await
        .map_err(|e| e.to_string())?
}
