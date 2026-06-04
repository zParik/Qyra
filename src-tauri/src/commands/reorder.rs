use lopdf::{Document, Object};
use crate::utils::paths::temp_output_path;
use crate::error::{AppError, AppResult};

/// Reorder pages in a PDF. `order` is 1-indexed and maps new position → old page number.
#[tauri::command]
pub fn reorder_pages(
    path: String,
    order: Vec<u32>,
    output: Option<String>,
) -> AppResult<String> {
    let _t = crate::utils::timing::Timer::start("reorder_pages", String::new());
    let mut doc = Document::load(&path)?;
    let total = doc.get_pages().len() as u32;

    if order.len() as u32 != total {
        return Err(AppError::Invalid(format!(
            "Order length {} doesn't match page count {}",
            order.len(),
            total
        )));
    }

    let mut seen = std::collections::HashSet::new();
    for &page in &order {
        if page < 1 || page > total {
            return Err(AppError::Invalid(format!("Page {} out of range (1-{})", page, total)));
        }
        if !seen.insert(page) {
            return Err(AppError::Invalid(format!("Page {} appears more than once in order", page)));
        }
    }

    // Collect the ObjectId for each 1-indexed page number.
    // get_pages() traverses the full page tree and returns BTreeMap<page_num, ObjectId>.
    let pages_map = doc.get_pages();

    // Build the new Kids array in the requested order.
    let new_kids: Vec<Object> = order
        .iter()
        .map(|&old_idx| Object::Reference(pages_map[&old_idx]))
        .collect();

    // Locate the Pages root from the catalog (block scope ends the immutable borrow).
    let pages_root_id = {
        let catalog = doc.catalog().map_err(|e| AppError::Pdf(format!("Catalog error: {}", e)))?;
        catalog
            .get(b"Pages")
            .and_then(|obj| obj.as_reference())
            .map_err(|e| AppError::Pdf(format!("Pages entry error: {}", e)))?
    };

    // Update the Kids array directly — O(N) instead of O(N²) clone+delete+merge.
    match doc.objects.get_mut(&pages_root_id) {
        Some(Object::Dictionary(dict)) => {
            dict.set("Kids", Object::Array(new_kids));
            // Count stays the same; we're reordering, not removing pages.
        }
        _ => return Err(AppError::Pdf("Could not find Pages root dictionary".to_string())),
    }

    // Fix the Parent reference for every page so nested page trees are handled correctly.
    for (_, &page_obj_id) in &pages_map {
        if let Some(Object::Dictionary(page_dict)) = doc.objects.get_mut(&page_obj_id) {
            page_dict.set("Parent", Object::Reference(pages_root_id));
        }
    }

    let out = output.unwrap_or_else(|| temp_output_path(&path, "reordered"));
    doc.save(&out)?;
    Ok(out)
}
