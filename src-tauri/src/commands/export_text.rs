use crate::error::{AppError, AppResult};

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn export_pdf_to_text(
    path: String,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let doc = mupdf::Document::open(&path)?;
        let page_count = doc.page_count()?;
        let mut full_text = String::new();

        for i in 0..page_count {
            let page = doc.load_page(i)?;
            let stext = page.to_text_page(mupdf::TextPageFlags::empty())?;

            full_text.push_str(&format!("--- Page {} ---\n", i + 1));

            for block in stext.blocks() {
                if block.r#type() != mupdf::text_page::TextBlockType::Text {
                    continue;
                }
                for line in block.lines() {
                    for ch in line.chars() {
                        if let Some(c) = ch.char() {
                            full_text.push(c);
                        }
                    }
                    full_text.push('\n');
                }
                full_text.push('\n');
            }
        }

        let out_path = output.unwrap_or_else(|| {
            let p = std::path::Path::new(&path);
            p.with_extension("txt").to_string_lossy().to_string()
        });

        std::fs::write(&out_path, full_text.as_bytes())?;
        Ok(out_path)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn export_pdf_to_text(
    _path: String,
    _output: Option<String>,
) -> AppResult<String> {
    Err(AppError::Other("Not supported on Android".to_string()))
}
