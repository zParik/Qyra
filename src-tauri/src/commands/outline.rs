#[derive(serde::Serialize, Clone)]
pub struct OutlineNode {
    pub title: String,
    pub page: Option<u32>,
    pub items: Vec<OutlineNode>,
}

// ── Desktop: use MuPDF (handles all dest formats, encodings, named dests) ─────

#[cfg(not(target_os = "android"))]
fn convert_outlines(outlines: Vec<mupdf::Outline>) -> Vec<OutlineNode> {
    outlines
        .into_iter()
        .map(|o| {
            // MuPDF page_number is 0-indexed; frontend expects 1-indexed
            let page = o.dest.map(|d| d.loc.page_number + 1);
            OutlineNode {
                title: o.title,
                page,
                items: convert_outlines(o.down),
            }
        })
        .collect()
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_outline(path: String) -> Result<Vec<OutlineNode>, String> {
    tokio::task::spawn_blocking(move || {
        let doc = mupdf::Document::open(&path).map_err(|e| e.to_string())?;
        let outlines = doc.outlines().map_err(|e| e.to_string())?;
        Ok(convert_outlines(outlines))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Android stub ───────────────────────────────────────────────────────────────

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_outline(_path: String) -> Result<Vec<OutlineNode>, String> {
    Ok(vec![])
}
