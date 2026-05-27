use crate::error::{AppError, AppResult};
use crate::utils::get_page_dims;
use crate::utils::paths::temp_output_path;
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    /// 1-indexed page to attach the link to.
    pub page: u32,
    /// Normalized [0, 1] coords with y=0 at the top of the page (matches
    /// `get_page_links` output and the viewer overlay's convention).
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// External URL target. Mutually exclusive with `dest_page`.
    pub uri: Option<String>,
    /// Internal link target (1-indexed). Mutually exclusive with `uri`.
    pub dest_page: Option<u32>,
}

fn norm_rect_to_pdf(
    x0: f64, y0: f64, x1: f64, y1: f64,
    page_w: f64, page_h: f64,
) -> [f64; 4] {
    // y=0 at top in normalized → flip to PDF user space (origin bottom-left).
    let llx = x0 * page_w;
    let urx = x1 * page_w;
    let ury = (1.0 - y0) * page_h;
    let lly = (1.0 - y1) * page_h;
    let (llx, urx) = if llx <= urx { (llx, urx) } else { (urx, llx) };
    let (lly, ury) = if lly <= ury { (lly, ury) } else { (ury, lly) };
    [llx, lly, urx, ury]
}

fn page_id_for(doc: &Document, page: u32) -> AppResult<ObjectId> {
    doc.get_pages()
        .get(&page)
        .copied()
        .ok_or_else(|| AppError::Other(format!("page {} not found", page)))
}

fn build_link_annot(
    doc: &mut Document,
    rect: [f64; 4],
    uri: Option<&str>,
    dest_page_id: Option<ObjectId>,
) -> ObjectId {
    let mut annot = Dictionary::new();
    annot.set("Type", Object::Name(b"Annot".to_vec()));
    annot.set("Subtype", Object::Name(b"Link".to_vec()));
    annot.set("Rect", Object::Array(rect.iter()
        .map(|v| Object::Real(*v as f32))
        .collect()));
    annot.set("Border", Object::Array(vec![
        Object::Integer(0), Object::Integer(0), Object::Integer(0),
    ]));
    annot.set("F", Object::Integer(4)); // Print flag

    if let Some(uri) = uri {
        let mut action = Dictionary::new();
        action.set("Type", Object::Name(b"Action".to_vec()));
        action.set("S", Object::Name(b"URI".to_vec()));
        action.set("URI", Object::string_literal(uri.to_string()));
        annot.set("A", Object::Dictionary(action));
    } else if let Some(page_id) = dest_page_id {
        let dest = vec![
            Object::Reference(page_id),
            Object::Name(b"XYZ".to_vec()),
            Object::Null, Object::Null, Object::Null,
        ];
        annot.set("Dest", Object::Array(dest));
    }

    doc.add_object(Object::Dictionary(annot))
}

#[tauri::command]
pub async fn add_link(
    path: String,
    link: LinkInput,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let mut doc = Document::load(&path)?;
        let page_id = page_id_for(&doc, link.page)?;

        let (pw, ph) = get_page_dims(&doc, page_id);
        let rect = norm_rect_to_pdf(link.x0, link.y0, link.x1, link.y1, pw, ph);

        let dest_page_id = match link.dest_page {
            Some(p) => Some(page_id_for(&doc, p)?),
            None => None,
        };

        if link.uri.is_none() && dest_page_id.is_none() {
            return Err(AppError::Other("link requires uri or destPage".into()));
        }

        let annot_id = build_link_annot(&mut doc, rect, link.uri.as_deref(), dest_page_id);

        // Attach to the page's /Annots array, creating one if missing.
        if let Ok(Object::Dictionary(page)) = doc.get_object_mut(page_id) {
            match page.get_mut(b"Annots") {
                Ok(Object::Array(arr)) => arr.push(Object::Reference(annot_id)),
                Ok(Object::Reference(r)) => {
                    let existing = *r;
                    // Replace direct reference with array containing both.
                    page.set("Annots", Object::Array(vec![
                        Object::Reference(existing),
                        Object::Reference(annot_id),
                    ]));
                }
                _ => {
                    page.set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
                }
            }
        }

        let out = output.unwrap_or_else(|| temp_output_path(&path, "links"));
        doc.save(&out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn remove_link(
    path: String,
    page: u32,
    index: u32,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let mut doc = Document::load(&path)?;
        let page_id = page_id_for(&doc, page)?;

        // Collect all annotation refs on the page that are Link subtype.
        let link_refs: Vec<ObjectId> = {
            let Ok(Object::Dictionary(page)) = doc.get_object(page_id) else {
                return Err(AppError::Other("page missing".into()));
            };
            let annot_refs: Vec<ObjectId> = match page.get(b"Annots") {
                Ok(Object::Array(arr)) => arr.iter()
                    .filter_map(|o| o.as_reference().ok())
                    .collect(),
                Ok(Object::Reference(r)) => vec![*r],
                _ => vec![],
            };
            annot_refs.into_iter().filter(|id| {
                matches!(
                    doc.get_object(*id),
                    Ok(Object::Dictionary(d)) if matches!(
                        d.get(b"Subtype"),
                        Ok(Object::Name(n)) if n.as_slice() == b"Link"
                    )
                )
            }).collect()
        };

        let target = link_refs.get(index as usize).copied()
            .ok_or_else(|| AppError::Other(format!("link index {} out of range", index)))?;

        if let Ok(Object::Dictionary(page)) = doc.get_object_mut(page_id) {
            match page.get_mut(b"Annots") {
                Ok(Object::Array(arr)) => {
                    arr.retain(|o| match o.as_reference() {
                        Ok(id) => id != target,
                        Err(_) => true,
                    });
                }
                Ok(Object::Reference(r)) if *r == target => {
                    page.remove(b"Annots");
                }
                _ => {}
            }
        }

        let out = output.unwrap_or_else(|| temp_output_path(&path, "links"));
        doc.save(&out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_flip_y_axis() {
        let r = norm_rect_to_pdf(0.0, 0.0, 1.0, 1.0, 100.0, 200.0);
        assert_eq!(r, [0.0, 0.0, 100.0, 200.0]);
    }

    #[test]
    fn rect_top_half() {
        // Normalized top half (y0=0, y1=0.5) → PDF upper half.
        let r = norm_rect_to_pdf(0.0, 0.0, 1.0, 0.5, 100.0, 200.0);
        assert_eq!(r, [0.0, 100.0, 100.0, 200.0]);
    }
}
