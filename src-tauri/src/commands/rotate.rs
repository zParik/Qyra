use lopdf::{Document, Object};
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Rotate pages in a PDF.
/// pages: 1-indexed list of page numbers to rotate (empty = all pages).
/// degrees: 90, 180, or 270.
#[tauri::command]
pub fn rotate_pages(
    path: String,
    pages: Vec<u32>,
    degrees: i64,
    output: Option<String>,
) -> AppResult<String> {
    if degrees != 90 && degrees != 180 && degrees != 270 {
        return Err(AppError::Invalid("Degrees must be 90, 180, or 270".to_string()));
    }

    let mut doc = Document::load(&path)?;
    let page_map = doc.get_pages();
    let total = page_map.len() as u32;

    let targets: Vec<u32> = if pages.is_empty() {
        (1..=total).collect()
    } else {
        pages
    };

    for page_num in targets {
        let page_id = page_map
            .get(&page_num)
            .copied()
            .ok_or_else(|| AppError::NotFound(format!("Page {} not found", page_num)))?;

        // Walk parent chain to read inherited Rotate before mutating.
        let current: i64 = {
            let mut inherited = 0i64;
            let mut cur = page_id;
            'walk: loop {
                match doc.get_object(cur) {
                    Ok(Object::Dictionary(d)) => {
                        if let Ok(r) = d.get(b"Rotate").and_then(|o| o.as_i64()) {
                            inherited = r;
                            break 'walk;
                        }
                        match d.get(b"Parent").and_then(|o| o.as_reference()) {
                            Ok(parent) => cur = parent,
                            Err(_) => break 'walk,
                        }
                    }
                    _ => break 'walk,
                }
            }
            inherited
        };
        let page = doc.get_object_mut(page_id)?;
        if let Object::Dictionary(dict) = page {
            let new_rotation = (current + degrees) % 360;
            dict.set("Rotate", Object::Integer(new_rotation));
        }
    }

    let out = output.unwrap_or_else(|| temp_output_path(&path, "rotated"));
    doc.save(&out)?;
    Ok(out)
}
