use crate::error::{AppError, AppResult};
use crate::utils::geometry::PageGeom;
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

        let rect = PageGeom::of(&doc, page_id).rect_to_pdf(link.x0, link.y0, link.x1, link.y1);

        let dest_page_id = match link.dest_page {
            Some(p) => Some(page_id_for(&doc, p)?),
            None => None,
        };

        if link.uri.is_none() && dest_page_id.is_none() {
            return Err(AppError::Other("link requires uri or destPage".into()));
        }

        let annot_id = build_link_annot(&mut doc, rect, link.uri.as_deref(), dest_page_id);

        // Attach to the page's /Annots array, creating one if missing.
        crate::utils::annots::push_annot_ref(&mut doc, page_id, annot_id)?;

        let out = output.unwrap_or_else(|| temp_output_path(&path, "links"));
        crate::utils::save_pdf(&mut doc, &out)?;
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
            if doc.get_dictionary(page_id).is_err() {
                return Err(AppError::Other("page missing".into()));
            }
            crate::utils::annots::annot_refs(&doc, page_id).into_iter().filter(|id| {
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

        crate::utils::annots::remove_annot_ref(&mut doc, page_id, target)?;

        let out = output.unwrap_or_else(|| temp_output_path(&path, "links"));
        crate::utils::save_pdf(&mut doc, &out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geom(w: f64, h: f64) -> PageGeom {
        PageGeom { x0: 0.0, y0: 0.0, x1: w, y1: h, rotate: 0 }
    }

    #[test]
    fn rect_flip_y_axis() {
        let r = geom(100.0, 200.0).rect_to_pdf(0.0, 0.0, 1.0, 1.0);
        assert_eq!(r, [0.0, 0.0, 100.0, 200.0]);
    }

    #[test]
    fn rect_top_half() {
        // Normalized top half (y0=0, y1=0.5) → PDF upper half.
        let r = geom(100.0, 200.0).rect_to_pdf(0.0, 0.0, 1.0, 0.5);
        assert_eq!(r, [0.0, 100.0, 100.0, 200.0]);
    }
}
