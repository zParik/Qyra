use lopdf::{Dictionary, Document, Object, Stream};
use tauri::Emitter;
use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;
use crate::error::{AppError, AppResult};
use std::f64::consts::PI;

#[derive(serde::Deserialize)]
pub struct WatermarkOptions {
    pub text: String,
    pub font_size: Option<f64>,  // default 48
    pub opacity: Option<f64>,    // default 0.25, range 0–1
    pub angle: Option<f64>,      // degrees CCW, default 45
    pub color: Option<String>,   // hex "#rrggbb", default "#888888"
    pub mode: Option<String>,    // "diagonal" | "center" | "tile", default "diagonal"
    pub pages: Option<Vec<u32>>, // 1-indexed; None = all pages
}

#[tauri::command]
pub async fn add_watermark(
    path: String,
    options: WatermarkOptions,
    output: Option<String>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let out = output.unwrap_or_else(|| temp_output_path(&path, "watermarked"));
        let mut doc = Document::load(&path)?;

        let font_size = options.font_size.unwrap_or(48.0).max(4.0);
        let opacity = options.opacity.unwrap_or(0.25).clamp(0.0, 1.0);
        let angle_deg = options.angle.unwrap_or(45.0);
        let angle_rad = angle_deg * PI / 180.0;
        let cos_a = angle_rad.cos();
        let sin_a = angle_rad.sin();
        let (r, g, b) = hex_to_rgb(options.color.as_deref().unwrap_or("#888888"));
        let mode = options.mode.clone().unwrap_or_else(|| "diagonal".to_string());

        let page_ids: Vec<lopdf::ObjectId> = doc.get_pages().into_values().collect();
        let pages_to_mark: Vec<lopdf::ObjectId> = match &options.pages {
            Some(nums) => nums
                .iter()
                .filter_map(|&n| page_ids.get((n as usize).saturating_sub(1)).copied())
                .collect(),
            None => page_ids.clone(),
        };

        struct Patch {
            page_id: lopdf::ObjectId,
            gs_id: lopdf::ObjectId,
            font_id: lopdf::ObjectId,
            content_id: lopdf::ObjectId,
        }
        let mut patches: Vec<Patch> = Vec::new();
        let total_to_mark = pages_to_mark.len();

        for (idx, &page_id) in pages_to_mark.iter().enumerate() {
            let _ = app_handle.emit(
                "operation-progress",
                Progress::new(idx, total_to_mark + 1, format!("Watermarking page {} / {}", idx + 1, total_to_mark)),
            );
            let (pw, ph) = page_size(&doc, page_id);

            let mut gs = Dictionary::new();
            gs.set("Type", Object::Name(b"ExtGState".to_vec()));
            gs.set("ca", Object::Real(opacity as f32));
            gs.set("CA", Object::Real(opacity as f32));
            let gs_id = doc.add_object(Object::Dictionary(gs));

            let mut font = Dictionary::new();
            font.set("Type", Object::Name(b"Font".to_vec()));
            font.set("Subtype", Object::Name(b"Type1".to_vec()));
            font.set("BaseFont", Object::Name(b"Helvetica-Bold".to_vec()));
            let font_id = doc.add_object(Object::Dictionary(font));

            let content = build_content(
                &options.text, pw, ph, font_size, r, g, b, cos_a, sin_a, &mode,
            );
            if content.is_empty() {
                continue;
            }
            let stream = Stream::new(Dictionary::new(), content);
            let content_id = doc.add_object(Object::Stream(stream));

            patches.push(Patch { page_id, gs_id, font_id, content_id });
        }

        for patch in patches {
            patch_page(&mut doc, patch.page_id, patch.gs_id, patch.font_id, patch.content_id)?;
        }

        let _ = app_handle.emit(
            "operation-progress",
            Progress::new(total_to_mark, total_to_mark + 1, "Saving PDF"),
        );
        doc.save(&out)?;
        Ok(out)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

// ── content stream ────────────────────────────────────────────────────────────

fn build_content(
    text: &str,
    pw: f64,
    ph: f64,
    font_size: f64,
    r: f32,
    g: f32,
    b: f32,
    cos_a: f64,
    sin_a: f64,
    mode: &str,
) -> Vec<u8> {
    let escaped = escape_pdf(text);
    if escaped.is_empty() {
        return Vec::new();
    }

    // Helvetica-Bold average char width ≈ 0.55× font_size
    let text_w = text.chars().count() as f64 * font_size * 0.55;

    let positions: Vec<(f64, f64, f64, f64)> = match mode {
        "tile" => {
            let step_x = (text_w * 1.5 + font_size).max(120.0);
            let step_y = (font_size * 3.5).max(80.0);
            let mut pos = Vec::new();
            let mut row = 0i32;
            let mut y = step_y * 0.5;
            while y < ph + step_y {
                let x_offset = if row % 2 == 0 { 0.0 } else { step_x * 0.5 };
                let mut x = x_offset - step_x * 0.25;
                while x < pw + step_x {
                    pos.push((x, y, cos_a, sin_a));
                    x += step_x;
                }
                y += step_y;
                row += 1;
            }
            pos
        }
        "center" => {
            vec![(pw / 2.0 - text_w / 2.0, ph / 2.0 - font_size / 3.0, 1.0, 0.0)]
        }
        _ => {
            // "diagonal": centered, rotated
            // CW matrix [cos,-sin,sin,cos]: advance=(cos,-sin), perp-up=(sin,cos)
            let cx = pw / 2.0;
            let cy = ph / 2.0;
            let x = cx - (text_w / 2.0) * cos_a - (font_size / 3.0) * sin_a;
            let y = cy + (text_w / 2.0) * sin_a - (font_size / 3.0) * cos_a;
            vec![(x, y, cos_a, sin_a)]
        }
    };

    let mut buf = format!(
        "q\n/WmGS gs\n{:.4} {:.4} {:.4} rg\nBT\n/WmF {:.2} Tf\n",
        r, g, b, font_size
    );

    for (x, y, ca, sa) in &positions {
        buf.push_str(&format!(
            "{:.6} {:.6} {:.6} {:.6} {:.4} {:.4} Tm ({}) Tj\n",
            ca, -sa, sa, ca, x, y, escaped
        ));
    }

    buf.push_str("ET\nQ\n");
    buf.into_bytes()
}

// ── page patching ─────────────────────────────────────────────────────────────

fn patch_page(
    doc: &mut Document,
    page_id: lopdf::ObjectId,
    gs_id: lopdf::ObjectId,
    font_id: lopdf::ObjectId,
    content_id: lopdf::ObjectId,
) -> AppResult<()> {
    let (res_obj, contents_obj) = {
        let obj = doc.get_object(page_id)?;
        let d = obj.as_dict()?;
        (d.get(b"Resources").ok().cloned(), d.get(b"Contents").ok().cloned())
    };

    let (res_ref_id, mut res_dict) = resolve_dict(doc, res_obj)?;

    let font_sub = res_dict.get(b"Font").ok().cloned();
    let (_, mut font_dict) = resolve_dict(doc, font_sub)?;
    font_dict.set("WmF", Object::Reference(font_id));
    res_dict.set("Font", Object::Dictionary(font_dict));

    let gs_sub = res_dict.get(b"ExtGState").ok().cloned();
    let (_, mut gs_dict) = resolve_dict(doc, gs_sub)?;
    gs_dict.set("WmGS", Object::Reference(gs_id));
    res_dict.set("ExtGState", Object::Dictionary(gs_dict));

    let inline_res: Option<Dictionary> = if let Some(ref_id) = res_ref_id {
        let target = doc.get_object_mut(ref_id)?;
        *target = Object::Dictionary(res_dict);
        None
    } else {
        Some(res_dict)
    };

    let new_contents = match contents_obj {
        Some(Object::Reference(id)) => {
            Object::Array(vec![Object::Reference(id), Object::Reference(content_id)])
        }
        Some(Object::Array(mut arr)) => {
            arr.push(Object::Reference(content_id));
            Object::Array(arr)
        }
        _ => Object::Reference(content_id),
    };

    let page_obj = doc.get_object_mut(page_id)?;
    if let Object::Dictionary(d) = page_obj {
        if let Some(res) = inline_res {
            d.set("Resources", Object::Dictionary(res));
        }
        d.set("Contents", new_contents);
    }

    Ok(())
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn page_size(doc: &Document, page_id: lopdf::ObjectId) -> (f64, f64) {
    let try_get = || -> Option<(f64, f64)> {
        let obj = doc.get_object(page_id).ok()?;
        let d = obj.as_dict().ok()?;
        let mb = d.get(b"MediaBox").ok()?.as_array().ok()?;
        if mb.len() < 4 {
            return None;
        }
        let v = |o: &Object| -> f64 {
            match o {
                Object::Integer(i) => *i as f64,
                Object::Real(f) => *f as f64,
                _ => 0.0,
            }
        };
        Some((v(&mb[2]) - v(&mb[0]), v(&mb[3]) - v(&mb[1])))
    };
    try_get().unwrap_or((612.0, 792.0))
}

fn hex_to_rgb(hex: &str) -> (f32, f32, f32) {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(hex.get(0..2).unwrap_or("88"), 16).unwrap_or(136) as f32 / 255.0;
    let g = u8::from_str_radix(hex.get(2..4).unwrap_or("88"), 16).unwrap_or(136) as f32 / 255.0;
    let b = u8::from_str_radix(hex.get(4..6).unwrap_or("88"), 16).unwrap_or(136) as f32 / 255.0;
    (r, g, b)
}

fn escape_pdf(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            c if c.is_ascii() && !c.is_control() => out.push(c),
            _ => {}
        }
    }
    out
}

fn resolve_dict(
    doc: &Document,
    obj: Option<Object>,
) -> AppResult<(Option<lopdf::ObjectId>, Dictionary)> {
    match obj {
        Some(Object::Dictionary(d)) => Ok((None, d)),
        Some(Object::Reference(id)) => {
            let d = doc.get_object(id)?.as_dict()?.clone();
            Ok((Some(id), d))
        }
        _ => Ok((None, Dictionary::new())),
    }
}
