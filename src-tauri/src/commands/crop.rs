use lopdf::{Document, Object, ObjectId};
use crate::utils::paths::temp_output_path;
use crate::utils::geometry::PageGeom;
use crate::error::{AppError, AppResult};

#[tauri::command]
pub async fn crop_pages(
    path: String,
    pages: Vec<u32>,
    crop_rect: [f64; 4],
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let _t = crate::utils::timing::Timer::start("crop_pages", String::new());
        let mut doc = Document::load(&path)?;
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

            // crop_rect = [x0, y0, x1, y1] normalised to the page as shown
            // (its current crop, turned by /Rotate; top-left origin).
            let [x0_pdf, y0_pdf, x1_pdf, y1_pdf] = PageGeom::of(&doc, page_id)
                .rect_to_pdf(crop_rect[0], crop_rect[1], crop_rect[2], crop_rect[3]);

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
            let page_obj = doc.get_object_mut(page_id)?;
            if let Object::Dictionary(d) = page_obj {
                d.set("CropBox", Object::Array(box_array.clone()));
                d.set("TrimBox", Object::Array(box_array.clone()));
                d.set("BleedBox", Object::Array(box_array));
            }
        }

        crate::utils::save_pdf(&mut doc, &out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
