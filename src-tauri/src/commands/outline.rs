use crate::error::{AppError, AppResult};

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

#[cfg(not(target_os = "android"))]
fn outlines_of(doc: &mupdf::Document) -> AppResult<Vec<OutlineNode>> {
    let outlines = doc.outlines().map_err(|e| AppError::Pdf(e.to_string()))?;
    Ok(convert_outlines(outlines))
}

/// Read the outline tree, reusing the render worker's open-document cache when
/// the app is running. Falls back to opening directly (e.g. in tests).
#[cfg(not(target_os = "android"))]
fn read_outline(path: String) -> AppResult<Vec<OutlineNode>> {
    match crate::commands::render_worker::global() {
        Some(worker) => worker.with(path, outlines_of),
        None => {
            let doc = mupdf::Document::open(&path).map_err(|e| AppError::Pdf(e.to_string()))?;
            outlines_of(&doc)
        }
    }
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn get_outline(path: String) -> AppResult<Vec<OutlineNode>> {
    tokio::task::spawn_blocking(move || read_outline(path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ── Android stub ───────────────────────────────────────────────────────────────

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn get_outline(_path: String) -> AppResult<Vec<OutlineNode>> {
    Ok(vec![])
}

// ── Auto-outline detection from font-size jumps ────────────────────────────────

#[cfg(not(target_os = "android"))]
struct HeadingCandidate {
    text: String,
    height: f32,
    page: u32,
}

#[cfg(not(target_os = "android"))]
fn detect_headings(path: &str, max_pages: usize) -> AppResult<Vec<HeadingCandidate>> {
    let doc = mupdf::Document::open(path).map_err(|e| AppError::Pdf(e.to_string()))?;
    let page_count = doc.page_count().map_err(|e| AppError::Pdf(e.to_string()))? as usize;
    let limit = page_count.min(max_pages);

    let mut all_heights: Vec<f32> = Vec::new();
    let mut candidates: Vec<HeadingCandidate> = Vec::new();

    for pi in 0..limit {
        let page = match doc.load_page(pi as i32) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let stext = match page.to_text_page(mupdf::TextPageFlags::empty()) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for block in stext.blocks() {
            if block.r#type() != mupdf::text_page::TextBlockType::Text {
                continue;
            }
            for line in block.lines() {
                let mut text = String::new();
                let mut max_h: f32 = 0.0;
                let mut has_char = false;
                for ch in line.chars() {
                    let c_char = match ch.char() { Some(c) => c, None => continue };
                    let cp = c_char as u32;
                    if cp == 0 || (cp < 32 && cp != 9) { continue; }
                    let q = ch.quad();
                    let h = (q.lr.y - q.ul.y).abs() as f32;
                    if h > max_h { max_h = h; }
                    text.push(c_char);
                    has_char = true;
                }
                if !has_char || max_h <= 0.0 { continue; }
                let trimmed = text.trim();
                if trimmed.is_empty() || trimmed.len() < 2 { continue; }
                all_heights.push(max_h);
                candidates.push(HeadingCandidate {
                    text: trimmed.to_string(),
                    height: max_h,
                    page: (pi + 1) as u32,
                });
            }
        }
    }

    Ok(filter_headings(all_heights, candidates))
}

#[cfg(not(target_os = "android"))]
fn filter_headings(
    mut all_heights: Vec<f32>,
    candidates: Vec<HeadingCandidate>,
) -> Vec<HeadingCandidate> {
    if all_heights.is_empty() { return Vec::new(); }
    all_heights.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = all_heights[all_heights.len() / 2];
    let threshold = median * 1.25;

    candidates
        .into_iter()
        .filter(|c| c.height >= threshold)
        .filter(|c| c.text.len() <= 200) // body paragraphs shouldn't qualify; cap noise
        .collect()
}

#[cfg(not(target_os = "android"))]
fn bucket_into_tiers(candidates: &[HeadingCandidate]) -> Vec<OutlineNode> {
    if candidates.is_empty() { return Vec::new(); }

    // Build up to three font-size tiers (largest = H1, next = H2, smallest = H3).
    let mut sizes: Vec<f32> = candidates.iter().map(|c| c.height).collect();
    sizes.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    sizes.dedup_by(|a, b| (*a - *b).abs() < 0.5);
    let tiers: Vec<f32> = sizes.into_iter().take(3).collect();

    fn tier_for(h: f32, tiers: &[f32]) -> usize {
        for (idx, t) in tiers.iter().enumerate() {
            if (h - t).abs() < 0.6 { return idx; }
        }
        // Fall back to nearest below.
        tiers.len().saturating_sub(1)
    }

    let mut root: Vec<OutlineNode> = Vec::new();
    let mut h2_parent: Option<*mut OutlineNode> = None;
    let mut h1_parent: Option<*mut OutlineNode> = None;

    for c in candidates {
        let depth = tier_for(c.height, &tiers);
        let node = OutlineNode { title: c.text.clone(), page: Some(c.page), items: Vec::new() };
        // SAFETY: raw-pointer hop into the latest H1/H2 nodes is sound because
        // we always push the parent before its children and never reallocate
        // the slot we hand out (we push into a freshly-cleared Vec<items>).
        // Wrapping in unsafe to keep ergonomics linear.
        unsafe {
            match depth {
                0 => {
                    root.push(node);
                    h1_parent = root.last_mut().map(|n| n as *mut OutlineNode);
                    h2_parent = None;
                }
                1 => {
                    if let Some(p) = h1_parent {
                        (*p).items.push(node);
                        h2_parent = (*p).items.last_mut().map(|n| n as *mut OutlineNode);
                    } else {
                        root.push(node);
                        h1_parent = root.last_mut().map(|n| n as *mut OutlineNode);
                    }
                }
                _ => {
                    if let Some(p) = h2_parent {
                        (*p).items.push(node);
                    } else if let Some(p) = h1_parent {
                        (*p).items.push(node);
                    } else {
                        root.push(node);
                    }
                }
            }
        }
    }
    root
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn detect_outline(path: String, max_pages: Option<usize>) -> AppResult<Vec<OutlineNode>> {
    let cap = max_pages.unwrap_or(500).max(1);
    tokio::task::spawn_blocking(move || -> AppResult<Vec<OutlineNode>> {
        let candidates = detect_headings(&path, cap)?;
        Ok(bucket_into_tiers(&candidates))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn detect_outline(_path: String, _max_pages: Option<usize>) -> AppResult<Vec<OutlineNode>> {
    Ok(vec![])
}
