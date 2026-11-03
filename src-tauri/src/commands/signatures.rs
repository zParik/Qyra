//! Draw placed signature images into their pages.

use std::collections::BTreeMap;

use base64::Engine;
use lopdf::{Dictionary, Document, Stream};

use crate::error::{AppError, AppResult};
use crate::utils::geometry::PageGeom;
use crate::utils::paths::temp_output_path;

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageStamp {
    /// 1-based page number.
    pub page: u32,
    /// Centre of the image, normalised to the page as shown.
    pub x: f64,
    pub y: f64,
    /// Size, normalised to the page as shown.
    pub width: f64,
    pub height: f64,
    /// `data:image/png;base64,...` (PNG or JPEG).
    pub data_url: String,
}

fn decode_data_url(url: &str) -> AppResult<Vec<u8>> {
    let b64 = url.split_once(";base64,").map(|(_, b)| b).unwrap_or(url);
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| AppError::Other(format!("bad signature image: {e}")))
}

pub fn stamp_images_doc(doc: &mut Document, stamps: &[ImageStamp]) -> AppResult<()> {
    crate::utils::own_inherited_resources(doc);
    let pages = doc.get_pages();
    let mut by_page: BTreeMap<u32, Vec<&ImageStamp>> = BTreeMap::new();
    for s in stamps {
        by_page.entry(s.page).or_default().push(s);
    }
    for (page, group) in by_page {
        let Some(&page_id) = pages.get(&page) else { continue };
        let geom = PageGeom::of(doc, page_id);
        let mut ops = String::new();
        for s in group {
            let bytes = decode_data_url(&s.data_url)?;
            let (image, _, _) = crate::commands::create::image_xobject(doc, &bytes).map_err(AppError::Other)?;
            let image_id = doc.add_object(image);
            let name = crate::utils::add_page_xobject(doc, page_id, "QySig", image_id)?;
            let [a, b, c, d, e, f] =
                geom.upright_unit_matrix(s.x - s.width / 2.0, s.y - s.height / 2.0, s.width, s.height);
            ops.push_str(&format!("q {a:.4} {b:.4} {c:.4} {d:.4} {e:.3} {f:.3} cm /{name} Do Q\n"));
        }
        let stamp = doc.add_object(Stream::new(Dictionary::new(), ops.into_bytes()));
        crate::utils::put_overlay_on_top(doc, page_id, stamp, "QyraSignature")?;
    }
    Ok(())
}

/// Draw the signatures into a copy of `path` and return the copy's path.
#[tauri::command(async)]
pub fn stamp_images(path: String, stamps: Vec<ImageStamp>, output: Option<String>) -> AppResult<String> {
    let mut doc = Document::load(&path)?;
    stamp_images_doc(&mut doc, &stamps)?;
    let out = output.unwrap_or_else(|| temp_output_path(&path, "signed"));
    doc.save(&out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_data_url() {
        assert_eq!(decode_data_url("data:image/png;base64,aGk=").unwrap(), b"hi");
    }
}
