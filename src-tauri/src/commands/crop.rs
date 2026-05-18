use lopdf::{Document, Object, ObjectId};
use crate::utils::paths::temp_output_path;

fn get_page_dims(doc: &Document, page_id: ObjectId) -> (f64, f64) {
    let page = match doc.get_object(page_id) {
        Ok(obj) => obj,
        Err(_) => return (595.0, 842.0),
    };
    if let Object::Dictionary(dict) = page {
        if let Ok(Object::Array(arr)) = dict.get(b"MediaBox") {
            let w = arr.get(2)
                .and_then(|o| o.as_i64().ok().map(|v| v as f64)
                    .or_else(|| o.as_f32().ok().map(|v| v as f64)))
                .unwrap_or(595.0);
            let h = arr.get(3)
                .and_then(|o| o.as_i64().ok().map(|v| v as f64)
                    .or_else(|| o.as_f32().ok().map(|v| v as f64)))
                .unwrap_or(842.0);
            return (w, h);
        }
    }
    (595.0, 842.0)
}

#[tauri::command]
pub async fn crop_pages(
    path: String,
    pages: Vec<u32>,
    crop_rect: [f64; 4],
    output: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut doc = Document::load(&path).map_err(|e| e.to_string())?;
        let out = output.unwrap_or_else(|| temp_output_path(&path, "cropped"));

        let page_map: std::collections::HashMap<u32, ObjectId> =
            doc.get_pages().into_iter().collect();

        let target_pages: Vec<u32> = if pages.is_empty() {
            let mut all: Vec<u32> = page_map.keys().copied().collect();
            all.sort_unstable();
            all
        } else {
            pages
        };

        // First pass: collect (page_id, crop_box_array) for each page
        let mut crops: Vec<(ObjectId, Vec<Object>)> = Vec::new();

        for page_num in &target_pages {
            let page_id = match page_map.get(page_num).copied() {
                Some(id) => id,
                None => continue,
            };

            let (pw, ph) = get_page_dims(&doc, page_id);

            // crop_rect = [x0, y0, x1, y1] normalized, top-left origin
            // Convert to PDF coords (bottom-left origin):
            //   x0_pdf = x0 * pw
            //   y0_pdf = (1 - y1) * ph   ← bottom of crop box in PDF coords
            //   x1_pdf = x1 * pw
            //   y1_pdf = (1 - y0) * ph   ← top of crop box in PDF coords
            let x0_pdf = crop_rect[0] * pw;
            let y0_pdf = (1.0 - crop_rect[3]) * ph;
            let x1_pdf = crop_rect[2] * pw;
            let y1_pdf = (1.0 - crop_rect[1]) * ph;

            let box_array = vec![
                Object::Real(x0_pdf as f32),
                Object::Real(y0_pdf as f32),
                Object::Real(x1_pdf as f32),
                Object::Real(y1_pdf as f32),
            ];

            crops.push((page_id, box_array));
        }

        // Second pass: mutate page dicts
        for (page_id, box_array) in crops {
            let page_obj = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
            if let Object::Dictionary(d) = page_obj {
                d.set("CropBox", Object::Array(box_array.clone()));
                d.set("TrimBox", Object::Array(box_array.clone()));
                d.set("BleedBox", Object::Array(box_array));
            }
        }

        doc.save(&out).map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
