use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use lopdf::content::{Content, Operation};
use crate::utils::paths::temp_output_path;
use crate::utils::get_page_dims;
use crate::error::{AppError, AppResult};

#[allow(dead_code)]
#[derive(serde::Serialize)]
pub struct PdfAnnotation {
    pub id: String,
    pub subtype: String,
    pub rect: [f64; 4],
    pub color: Option<String>,
    pub contents: Option<String>,
    pub quad_points: Option<Vec<f64>>,
}

fn obj_to_f64(o: &Object) -> f64 {
    o.as_i64().map(|v| v as f64)
        .or_else(|_| o.as_f32().map(|v| v as f64))
        .unwrap_or(0.0)
}

pub(crate) fn color_array_to_hex(arr: &[Object]) -> Option<String> {
    if arr.len() >= 3 {
        let r = (obj_to_f64(&arr[0]) * 255.0).round() as u8;
        let g = (obj_to_f64(&arr[1]) * 255.0).round() as u8;
        let b = (obj_to_f64(&arr[2]) * 255.0).round() as u8;
        Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
    } else {
        None
    }
}

pub(crate) fn hex_to_rgb_f32(hex: &str) -> (f32, f32, f32) {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(hex.get(0..2).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0;
    let g = u8::from_str_radix(hex.get(2..4).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0;
    let b = u8::from_str_radix(hex.get(4..6).unwrap_or("00"), 16).unwrap_or(0) as f32 / 255.0;
    (r, g, b)
}

fn parse_page_annots(doc: &Document, page: u32, page_id: ObjectId) -> Vec<PdfAnnotation> {
    let (pw, ph) = get_page_dims(doc, page_id);

    enum AnnotsKind {
        Inline(Vec<ObjectId>),
        Indirect(ObjectId),
        None,
    }

    let annots_kind: AnnotsKind = {
        let page_obj = match doc.get_object(page_id) {
            Ok(obj) => obj,
            Err(_) => return vec![],
        };
        let page_dict = match page_obj {
            Object::Dictionary(d) => d,
            _ => return vec![],
        };
        match page_dict.get(b"Annots") {
            Ok(Object::Array(arr)) => AnnotsKind::Inline(
                arr.iter().filter_map(|o| o.as_reference().ok()).collect()
            ),
            Ok(Object::Reference(r)) => AnnotsKind::Indirect(*r),
            _ => AnnotsKind::None,
        }
    };

    let annots_array: Vec<ObjectId> = match annots_kind {
        AnnotsKind::Inline(ids) => ids,
        AnnotsKind::Indirect(ref_id) => match doc.get_object(ref_id) {
            Ok(Object::Array(arr)) => arr.iter()
                .filter_map(|o| o.as_reference().ok())
                .collect(),
            _ => vec![],
        },
        AnnotsKind::None => return vec![],
    };

    let mut result = Vec::new();
    for annot_id in annots_array {
        let annot_obj = match doc.get_object(annot_id) {
            Ok(obj) => obj,
            Err(_) => continue,
        };
        let annot_dict = match annot_obj {
            Object::Dictionary(d) => d,
            _ => continue,
        };

        let subtype = match annot_dict.get(b"Subtype") {
            Ok(Object::Name(n)) => String::from_utf8_lossy(n).to_string(),
            _ => continue,
        };

        let known = matches!(subtype.as_str(),
            "Highlight" | "Underline" | "StrikeOut" | "Square" | "Circle"
            | "Line" | "FreeText" | "Note" | "Text" | "Ink" | "Stamp"
        );
        if !known {
            continue;
        }

        let (rx0, ry0, rx1, ry1) = match annot_dict.get(b"Rect") {
            Ok(Object::Array(arr)) if arr.len() >= 4 => (
                obj_to_f64(&arr[0]),
                obj_to_f64(&arr[1]),
                obj_to_f64(&arr[2]),
                obj_to_f64(&arr[3]),
            ),
            _ => continue,
        };

        let norm_x0 = rx0 / pw;
        let norm_y0 = (ph - ry1) / ph;
        let norm_x1 = rx1 / pw;
        let norm_y1 = (ph - ry0) / ph;
        let rect = [
            norm_x0.clamp(0.0, 1.0),
            norm_y0.clamp(0.0, 1.0),
            norm_x1.clamp(0.0, 1.0),
            norm_y1.clamp(0.0, 1.0),
        ];

        let color = match annot_dict.get(b"C") {
            Ok(Object::Array(arr)) => color_array_to_hex(arr),
            _ => None,
        };

        let contents = match annot_dict.get(b"Contents") {
            Ok(Object::String(bytes, _)) => Some(String::from_utf8_lossy(bytes).to_string()),
            _ => None,
        };

        let quad_points = match annot_dict.get(b"QuadPoints") {
            Ok(Object::Array(arr)) => {
                let pts: Vec<f64> = arr.chunks(2)
                    .flat_map(|pair| {
                        if pair.len() == 2 {
                            let qx = obj_to_f64(&pair[0]) / pw;
                            let qy = (ph - obj_to_f64(&pair[1])) / ph;
                            vec![qx.clamp(0.0, 1.0), qy.clamp(0.0, 1.0)]
                        } else {
                            vec![]
                        }
                    })
                    .collect();
                if pts.is_empty() { None } else { Some(pts) }
            }
            _ => None,
        };

        let id = format!("p{}_{}_{}", page, annot_id.0, annot_id.1);
        result.push(PdfAnnotation {
            id,
            subtype,
            rect,
            color,
            contents,
            quad_points,
        });
    }
    result
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        let escaped = s.replace('"', "\"\"");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

#[tauri::command]
pub async fn get_page_annotations(path: String, page: u32) -> AppResult<Vec<PdfAnnotation>> {
    tokio::task::spawn_blocking(move || -> AppResult<Vec<PdfAnnotation>> {
        // Read-only: reuse the shared parse so scrolling an annotated document
        // does not reparse the whole file once per visible page.
        let doc = crate::commands::lopdf_cache::load(&path)?;
        let page_map: std::collections::HashMap<u32, ObjectId> = doc.get_pages().into_iter().collect();
        let page_id = page_map.get(&page).copied()
            .ok_or_else(|| AppError::NotFound(format!("Page {} not found", page)))?;

        Ok(parse_page_annots(doc.as_ref(), page, page_id))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn export_annotations(path: String, output: Option<String>) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let doc = Document::load(&path)?;
        let mut pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect();
        pages.sort_by_key(|(p, _)| *p);

        let mut csv = String::new();
        csv.push_str("page,type,color,contents,x0,y0,x1,y1\n");

        for (page_num, page_id) in pages {
            let annots = parse_page_annots(&doc, page_num, page_id);
            for a in annots {
                let color = a.color.unwrap_or_default();
                let contents = a.contents.unwrap_or_default();
                csv.push_str(&format!(
                    "{},{},{},{},{:.4},{:.4},{:.4},{:.4}\n",
                    page_num,
                    csv_escape(&a.subtype),
                    csv_escape(&color),
                    csv_escape(&contents),
                    a.rect[0], a.rect[1], a.rect[2], a.rect[3],
                ));
            }
        }

        let out_path = output.unwrap_or_else(|| {
            std::path::Path::new(&path)
                .with_extension("annotations.csv")
                .to_string_lossy()
                .to_string()
        });

        std::fs::write(&out_path, csv)?;
        Ok(out_path)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAnnotation {
    pub subtype: String,
    pub page: u32,
    pub rect: [f64; 4],
    pub color: String,
    pub contents: Option<String>,
    pub quad_points: Option<Vec<f64>>,
    pub author: Option<String>,
    pub stamp_name: Option<String>,
}

#[tauri::command]
pub async fn add_pdf_annotation(
    path: String,
    annotation: NewAnnotation,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let mut doc = Document::load(&path)?;
        let out = output.unwrap_or_else(|| temp_output_path(&path, "annotated"));

        let page_map: std::collections::HashMap<u32, ObjectId> = doc.get_pages().into_iter().collect();
        let page_id = page_map.get(&annotation.page).copied()
            .ok_or_else(|| AppError::NotFound(format!("Page {} not found", annotation.page)))?;

        let (pw, ph) = get_page_dims(&doc, page_id);

        // Convert normalized screen coords back to PDF coords (bottom-left origin)
        // annotation.rect = [x0, y0, x1, y1] top-left origin, normalized
        let x0_pdf = annotation.rect[0] * pw;
        let y0_pdf = (1.0 - annotation.rect[3]) * ph;  // bottom of box in PDF
        let x1_pdf = annotation.rect[2] * pw;
        let y1_pdf = (1.0 - annotation.rect[1]) * ph;  // top of box in PDF

        let (r, g, b) = hex_to_rgb_f32(&annotation.color);

        // Build the annotation dictionary
        let mut annot_dict = Dictionary::new();
        annot_dict.set("Type", Object::Name(b"Annot".to_vec()));
        annot_dict.set("Subtype", Object::Name(annotation.subtype.as_bytes().to_vec()));
        annot_dict.set("Rect", Object::Array(vec![
            Object::Real(x0_pdf as f32),
            Object::Real(y0_pdf as f32),
            Object::Real(x1_pdf as f32),
            Object::Real(y1_pdf as f32),
        ]));
        annot_dict.set("C", Object::Array(vec![
            Object::Real(r),
            Object::Real(g),
            Object::Real(b),
        ]));
        annot_dict.set("F", Object::Integer(4)); // Print flag
        annot_dict.set("CA", Object::Real(
            if annotation.subtype == "Highlight" { 0.5_f32 } else { 1.0_f32 }
        ));

        if let Some(contents) = &annotation.contents {
            annot_dict.set("Contents", Object::String(
                contents.as_bytes().to_vec(),
                lopdf::StringFormat::Literal,
            ));
        }

        if let Some(author) = &annotation.author {
            annot_dict.set("T", Object::String(
                author.as_bytes().to_vec(),
                lopdf::StringFormat::Literal,
            ));
        }

        // Stamp /Name field (e.g. /Approved, /Confidential)
        if annotation.subtype == "Stamp" {
            if let Some(ref name) = annotation.stamp_name {
                annot_dict.set("Name", Object::Name(name.as_bytes().to_vec()));
            }
        }

        // QuadPoints for text markup annotations
        if let Some(qp) = &annotation.quad_points {
            let quad_objs: Vec<Object> = qp.chunks(2)
                .flat_map(|pair| {
                    if pair.len() == 2 {
                        let qx = pair[0] * pw;
                        let qy = (1.0 - pair[1]) * ph;
                        vec![Object::Real(qx as f32), Object::Real(qy as f32)]
                    } else {
                        vec![]
                    }
                })
                .collect();
            if !quad_objs.is_empty() {
                annot_dict.set("QuadPoints", Object::Array(quad_objs));
            }
        }

        // Unique annotation name and modification date
        let nm = format!("annot_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0));
        annot_dict.set("NM", Object::String(nm.as_bytes().to_vec(), lopdf::StringFormat::Literal));
        annot_dict.set("M", Object::String(b"D:20240101120000".to_vec(), lopdf::StringFormat::Literal));

        // For Highlight annotations, add a simple appearance stream so viewers render it
        if annotation.subtype == "Highlight" {
            let w = x1_pdf - x0_pdf;
            let h = y1_pdf - y0_pdf;
            let ap_ops = vec![
                Operation::new("q", vec![]),
                Operation::new("rg", vec![
                    Object::Real(r), Object::Real(g), Object::Real(b),
                ]),
                Operation::new("re", vec![
                    Object::Real(0.0_f32), Object::Real(0.0_f32),
                    Object::Real(w as f32), Object::Real(h as f32),
                ]),
                Operation::new("f", vec![]),
                Operation::new("Q", vec![]),
            ];
            let ap_content = Content { operations: ap_ops };
            let ap_bytes = ap_content.encode()?;
            let mut ap_stream_dict = Dictionary::new();
            ap_stream_dict.set("Type", Object::Name(b"XObject".to_vec()));
            ap_stream_dict.set("Subtype", Object::Name(b"Form".to_vec()));
            ap_stream_dict.set("BBox", Object::Array(vec![
                Object::Real(0.0_f32), Object::Real(0.0_f32),
                Object::Real(w as f32), Object::Real(h as f32),
            ]));
            let ap_stream_id = doc.add_object(Stream::new(ap_stream_dict, ap_bytes));
            let mut ap_dict = Dictionary::new();
            ap_dict.set("N", Object::Reference(ap_stream_id));
            annot_dict.set("AP", Object::Dictionary(ap_dict));
        }

        let annot_id = doc.add_object(annot_dict);

        // Add the annotation reference to the page's /Annots array
        let page_obj = doc.get_object_mut(page_id)?;
        if let Object::Dictionary(page_dict) = page_obj {
            match page_dict.get_mut(b"Annots") {
                Ok(Object::Array(arr)) => {
                    arr.push(Object::Reference(annot_id));
                }
                _ => {
                    page_dict.set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
                }
            }
        }

        doc.save(&out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
