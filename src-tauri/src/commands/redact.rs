use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use lopdf::content::{Content, Operation};
use crate::utils::paths::temp_output_path;

#[allow(dead_code)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactRegion {
    pub page: u32,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

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

fn append_stream_to_page(doc: &mut Document, page_id: ObjectId, stream_id: ObjectId) -> Result<(), String> {
    let page = doc.get_object_mut(page_id).map_err(|e| e.to_string())?;
    if let Object::Dictionary(dict) = page {
        match dict.get_mut(b"Contents") {
            Ok(Object::Array(arr)) => {
                arr.push(Object::Reference(stream_id));
            }
            Ok(Object::Reference(r)) => {
                let existing = *r;
                dict.set("Contents", Object::Array(vec![
                    Object::Reference(existing),
                    Object::Reference(stream_id),
                ]));
            }
            _ => {
                dict.set("Contents", Object::Reference(stream_id));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn redact_pdf(
    path: String,
    regions: Vec<RedactRegion>,
    output: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if regions.is_empty() {
            let out = output.unwrap_or_else(|| temp_output_path(&path, "redacted"));
            std::fs::copy(&path, &out).map_err(|e| e.to_string())?;
            return Ok(out);
        }

        let mut doc = Document::load(&path).map_err(|e| e.to_string())?;
        let out = output.unwrap_or_else(|| temp_output_path(&path, "redacted"));

        let page_map: std::collections::HashMap<u32, ObjectId> =
            doc.get_pages().into_iter().collect();

        // Group regions by page
        let mut by_page: std::collections::HashMap<u32, Vec<&RedactRegion>> =
            std::collections::HashMap::new();
        for region in &regions {
            by_page.entry(region.page).or_default().push(region);
        }

        // Collect: (page_id, stream_id) pairs to append after building all streams
        let mut streams_to_append: Vec<(ObjectId, ObjectId)> = Vec::new();

        for (page_num, page_regions) in &by_page {
            let page_id = match page_map.get(page_num).copied() {
                Some(id) => id,
                None => continue,
            };

            let (pw, ph) = get_page_dims(&doc, page_id);

            let mut ops: Vec<Operation> = Vec::new();
            ops.push(Operation::new("q", vec![]));
            // Set fill color to black
            ops.push(Operation::new("rg", vec![
                Object::Real(0.0_f32),
                Object::Real(0.0_f32),
                Object::Real(0.0_f32),
            ]));

            for region in page_regions {
                // Convert normalized top-left screen coords to PDF coords (bottom-left origin)
                // x0_pdf = x0 * pw
                // y0_pdf (PDF bottom) = (1 - y1) * ph
                // x1_pdf = x1 * pw
                // y1_pdf (PDF top) = (1 - y0) * ph
                let x_pdf = region.x0 * pw;
                let y_pdf = (1.0 - region.y1) * ph;
                let w_pdf = (region.x1 - region.x0) * pw;
                let h_pdf = (region.y1 - region.y0) * ph;

                ops.push(Operation::new("re", vec![
                    Object::Real(x_pdf as f32),
                    Object::Real(y_pdf as f32),
                    Object::Real(w_pdf as f32),
                    Object::Real(h_pdf as f32),
                ]));
                ops.push(Operation::new("f", vec![]));
            }

            ops.push(Operation::new("Q", vec![]));

            let content = Content { operations: ops };
            let content_bytes = content.encode().map_err(|e| e.to_string())?;
            let stream_id = doc.add_object(Stream::new(Dictionary::new(), content_bytes));

            streams_to_append.push((page_id, stream_id));
        }

        // Append the black-rectangle streams to each page
        for (page_id, stream_id) in streams_to_append {
            append_stream_to_page(&mut doc, page_id, stream_id)?;
        }

        // TODO: Full content-stream text removal within redacted bboxes.
        // This would require parsing PDF content stream operators (BT/ET blocks,
        // Tj/TJ/'/\" operators) and filtering out text whose position matrix (Tm/Td/TD)
        // places it within the redaction box. The visual overlay above covers the
        // rendered output, but the underlying text bytes remain in the PDF stream.

        doc.save(&out).map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
