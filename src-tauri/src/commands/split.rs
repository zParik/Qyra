use lopdf::{Document, Object};
use std::path::Path;
use crate::utils::paths::temp_dir_str;
use crate::error::{AppError, AppResult};

/// Split a PDF at bookmark boundaries. Each top-level outline entry becomes one output file.
/// Returns the list of output paths.
#[tauri::command]
pub fn split_pdf_by_bookmarks(path: String, output_dir: Option<String>) -> AppResult<Vec<String>> {
    let doc = Document::load(&path)?;
    let total = doc.get_pages().len() as u32;
    if total == 0 {
        return Err(AppError::Invalid("PDF has no pages".to_string()));
    }

    let stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("split");
    let dir = output_dir.unwrap_or_else(temp_dir_str);

    // Build reverse map: ObjectId -> 1-based page number
    let pages_map = doc.get_pages();
    let rev: std::collections::HashMap<lopdf::ObjectId, u32> =
        pages_map.iter().map(|(&n, &id)| (id, n)).collect();

    // Collect top-level outline page boundaries via /First → /Next traversal
    let mut page_starts: Vec<(u32, String)> = Vec::new();

    let outline_start: Option<lopdf::ObjectId> = (|| -> Option<lopdf::ObjectId> {
        let cat_id = doc.trailer.get(b"Root").ok()?.as_reference().ok()?;
        let catalog = doc.get_object(cat_id).ok()?.as_dict().ok()?;
        let outlines_ref = catalog.get(b"Outlines").ok()?.as_reference().ok()?;
        let outlines = doc.get_object(outlines_ref).ok()?.as_dict().ok()?;
        outlines.get(b"First").ok()?.as_reference().ok()
    })();

    if let Some(mut node_id) = outline_start {
        loop {
            let node_page: Option<u32> = (|| -> Option<u32> {
                let node = doc.get_object(node_id).ok()?.as_dict().ok()?;

                // Try /Dest array directly
                if let Ok(dest) = node.get(b"Dest") {
                    let dest = match dest {
                        Object::Array(a) => Some(a.clone()),
                        Object::Reference(r) => doc.get_object(*r).ok()?.as_array().ok().cloned(),
                        _ => None,
                    }?;
                    let page_ref = dest.first()?.as_reference().ok()?;
                    return rev.get(&page_ref).copied();
                }

                // Try /A /GoTo action
                if let Ok(action) = node.get(b"A") {
                    let action_dict = match action {
                        Object::Dictionary(d) => Some(d.clone()),
                        Object::Reference(r) => doc.get_object(*r).ok()?.as_dict().ok().cloned(),
                        _ => None,
                    }?;
                    if let Ok(Object::Array(dest)) = action_dict.get(b"D") {
                        let page_ref = dest.first()?.as_reference().ok()?;
                        return rev.get(&page_ref).copied();
                    }
                }
                None
            })();

            let title: String = (|| -> Option<String> {
                let node = doc.get_object(node_id).ok()?.as_dict().ok()?;
                match node.get(b"Title").ok()? {
                    Object::String(bytes, _) => {
                        // Detect UTF-16 BE BOM
                        if bytes.starts_with(&[0xFE, 0xFF]) {
                            let words: Vec<u16> = bytes[2..]
                                .chunks_exact(2)
                                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                                .collect();
                            String::from_utf16(&words).ok()
                        } else {
                            String::from_utf8(bytes.clone()).ok()
                        }
                    }
                    _ => None,
                }
            })()
            .unwrap_or_else(|| format!("Section {}", page_starts.len() + 1));

            if let Some(p) = node_page {
                page_starts.push((p, title));
            }

            // Advance to next sibling
            match (|| -> Option<lopdf::ObjectId> {
                let node = doc.get_object(node_id).ok()?.as_dict().ok()?;
                node.get(b"Next").ok()?.as_reference().ok()
            })() {
                Some(next_id) => node_id = next_id,
                None => break,
            }
        }
    }

    if page_starts.is_empty() {
        return Err(AppError::NotFound("No bookmarks found in this PDF".to_string()));
    }

    // Build page ranges from the start pages
    page_starts.sort_by_key(|(p, _)| *p);
    // Deduplicate same-page entries
    page_starts.dedup_by_key(|(p, _)| *p);

    let mut output_paths = Vec::new();
    for (i, (start, title)) in page_starts.iter().enumerate() {
        let end = if i + 1 < page_starts.len() {
            page_starts[i + 1].0 - 1
        } else {
            total
        };
        if *start > end { continue; }

        let pages_to_delete: Vec<u32> = (1..=total)
            .filter(|&p| p < *start || p > end)
            .collect();

        let mut part = doc.clone();
        part.delete_pages(&pages_to_delete);

        // Sanitize title for use as filename
        let safe_title: String = title.chars()
            .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
            .collect::<String>()
            .trim()
            .to_string();
        let safe_title = if safe_title.is_empty() { format!("part{}", i + 1) } else { safe_title };

        let out = format!("{}/{}_{}.pdf", dir, stem, safe_title);
        part.save(&out)?;
        output_paths.push(out);
    }

    Ok(output_paths)
}

#[derive(serde::Deserialize)]
pub struct PageRange {
    pub start: u32,
    pub end: u32,
}

/// Split a PDF by explicit page ranges. Each range produces one output file.
/// Pages are 1-indexed.
#[tauri::command]
pub fn split_pdf(
    path: String,
    ranges: Vec<PageRange>,
    output_dir: Option<String>,
) -> AppResult<Vec<String>> {
    let doc = Document::load(&path)?;
    let total = doc.get_pages().len() as u32;

    let stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("split");
    let dir = output_dir.unwrap_or_else(temp_dir_str);

    let mut output_paths = Vec::new();

    for (i, range) in ranges.iter().enumerate() {
        let start = range.start.max(1);
        let end = range.end.min(total);
        if start > end {
            return Err(AppError::Invalid(format!("Invalid range {}-{}", start, end)));
        }

        let pages_to_delete: Vec<u32> = (1..=total)
            .filter(|&p| p < start || p > end)
            .collect();

        let mut part = doc.clone();
        part.delete_pages(&pages_to_delete);

        let out = format!("{}/{}_part{}.pdf", dir, stem, i + 1);
        part.save(&out)?;
        output_paths.push(out);
    }

    Ok(output_paths)
}

/// Split into individual pages.
/// Uses direct page-tree manipulation instead of clone+delete_pages for each page,
/// avoiding O(N²) deletions. Each output file contains only the target page in its
/// page tree (other page objects are technically unreferenced but PDF viewers ignore them).
#[tauri::command]
pub fn split_pdf_per_page(path: String, output_dir: Option<String>) -> AppResult<Vec<String>> {
    let mut doc = Document::load(&path)?;
    let total = doc.get_pages().len() as u32;

    let stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("page");
    let dir = output_dir.unwrap_or_else(temp_dir_str);

    // Collect page ObjectIds once.
    let pages_map = doc.get_pages();

    // Locate the Pages root from the catalog.
    let pages_root_id = {
        let catalog = doc.catalog()?;
        catalog
            .get(b"Pages")
            .and_then(|obj| obj.as_reference())?
    };

    // Ensure every page's Parent already points to the root (flatten any nested tree).
    for (_, &page_obj_id) in &pages_map {
        if let Some(Object::Dictionary(page_dict)) = doc.objects.get_mut(&page_obj_id) {
            page_dict.set("Parent", Object::Reference(pages_root_id));
        }
    }

    let mut output_paths = Vec::new();
    for page_num in 1..=total {
        let page_obj_id = pages_map[&page_num];

        // Swap the Kids array to contain only this page, then save, then restore.
        // This avoids N full document clones while producing correct output.
        let single_kids = Object::Array(vec![Object::Reference(page_obj_id)]);

        let old_kids = if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&pages_root_id) {
            let old = dict.get(b"Kids").ok().cloned();
            dict.set("Kids", single_kids);
            dict.set("Count", Object::Integer(1));
            old
        } else {
            return Err(AppError::Pdf("Could not find Pages root dictionary".to_string()));
        };

        let out = format!("{}/{}_page{:04}.pdf", dir, stem, page_num);
        doc.save(&out)?;
        output_paths.push(out);

        // Restore the original Kids and Count for the next iteration.
        if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&pages_root_id) {
            if let Some(kids) = old_kids {
                dict.set("Kids", kids);
            }
            dict.set("Count", Object::Integer(total as i64));
        }
    }

    Ok(output_paths)
}
