use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, content::{Content, Operation}};
use crate::utils::paths::temp_output_path;
use crate::error::AppResult;

#[derive(serde::Deserialize)]
pub struct StrokeData {
    pub tool: String,          // "pen" | "highlighter" | "calligraphy" | "bezier"
    pub color: String,         // hex like "#1d4ed8"
    pub thickness: f64,        // base thickness (UI units)
    pub points: Vec<[f64; 2]>, // normalized 0-1 [x, y]
}

#[derive(serde::Deserialize)]
pub struct PageAnnotationData {
    pub page: u32,  // 1-indexed PDF page number
    pub strokes: Vec<StrokeData>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualPageData {
    pub id: String,
    pub template: String,       // "blank" | "ruled" | "grid" | "dotted"
    pub after_real_page: u32,   // 0 = before all, N = after page N, 9999 = after all
    pub strokes: Vec<StrokeData>,
}

fn hex_to_rgb(hex: &str) -> (f32, f32, f32) {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0) as f32 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0) as f32 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0) as f32 / 255.0;
    (r, g, b)
}

/// Catmull-Rom to cubic bezier conversion.
/// Returns a Vec of [cp1x, cp1y, cp2x, cp2y, px, py] segments.
/// Same algorithm as frontend catmullRomPath:
/// duplicate first and last points for tension, then compute control points.
fn catmull_to_cubic(pts: &[[f64; 2]]) -> Vec<[f64; 6]> {
    if pts.len() < 2 {
        return vec![];
    }

    // Build extended points array with duplicated first and last
    let mut p: Vec<[f64; 2]> = Vec::with_capacity(pts.len() + 2);
    p.push(pts[0]);
    p.extend_from_slice(pts);
    p.push(*pts.last().unwrap());

    let mut segments = Vec::new();
    for i in 1..p.len() - 2 {
        let cp1x = p[i][0] + (p[i + 1][0] - p[i - 1][0]) / 6.0;
        let cp1y = p[i][1] + (p[i + 1][1] - p[i - 1][1]) / 6.0;
        let cp2x = p[i + 1][0] - (p[i + 2][0] - p[i][0]) / 6.0;
        let cp2y = p[i + 1][1] - (p[i + 2][1] - p[i][1]) / 6.0;
        segments.push([cp1x, cp1y, cp2x, cp2y, p[i + 1][0], p[i + 1][1]]);
    }
    segments
}

fn build_stroke_ops(s: &StrokeData, pw: f64, ph: f64, hl_gs_name: Option<&[u8]>) -> Vec<Operation> {
    if s.points.is_empty() {
        return vec![];
    }

    let (r, g, b) = hex_to_rgb(&s.color);
    let line_width = (s.thickness * (pw / 768.0)) as f32;

    // Y-flip helper: PDF origin is bottom-left
    let flip_y = |y_norm: f64| -> f32 { ((1.0 - y_norm) * ph) as f32 };
    let to_x = |x_norm: f64| -> f32 { (x_norm * pw) as f32 };

    let mut ops: Vec<Operation> = Vec::new();

    // Save graphics state
    ops.push(Operation::new("q", vec![]));

    // Apply ExtGState for highlighter transparency
    if let Some(gs_name) = hl_gs_name {
        ops.push(Operation::new("gs", vec![Object::Name(gs_name.to_vec())]));
    }

    // Set stroke color (RG = stroking color in DeviceRGB)
    ops.push(Operation::new("RG", vec![
        Object::Real(r),
        Object::Real(g),
        Object::Real(b),
    ]));

    // Set fill color too (for non-stroke fills if needed)
    ops.push(Operation::new("rg", vec![
        Object::Real(r),
        Object::Real(g),
        Object::Real(b),
    ]));

    // Set line width
    ops.push(Operation::new("w", vec![Object::Real(line_width)]));

    // Round cap (2), round join (1)
    ops.push(Operation::new("J", vec![Object::Integer(1)]));
    ops.push(Operation::new("j", vec![Object::Integer(1)]));

    if s.tool == "bezier" && s.points.len() >= 2 {
        // Catmull-Rom to cubic bezier conversion
        let segments = catmull_to_cubic(&s.points);

        // Move to first point
        let x0 = to_x(s.points[0][0]);
        let y0 = flip_y(s.points[0][1]);
        ops.push(Operation::new("m", vec![Object::Real(x0), Object::Real(y0)]));

        for seg in &segments {
            let cp1x = to_x(seg[0]);
            let cp1y = flip_y(seg[1]);
            let cp2x = to_x(seg[2]);
            let cp2y = flip_y(seg[3]);
            let ex = to_x(seg[4]);
            let ey = flip_y(seg[5]);
            ops.push(Operation::new("c", vec![
                Object::Real(cp1x), Object::Real(cp1y),
                Object::Real(cp2x), Object::Real(cp2y),
                Object::Real(ex), Object::Real(ey),
            ]));
        }

        ops.push(Operation::new("S", vec![]));
    } else {
        // Polyline: m + l... + S
        let x0 = to_x(s.points[0][0]);
        let y0 = flip_y(s.points[0][1]);
        ops.push(Operation::new("m", vec![Object::Real(x0), Object::Real(y0)]));

        for pt in s.points.iter().skip(1) {
            let x = to_x(pt[0]);
            let y = flip_y(pt[1]);
            ops.push(Operation::new("l", vec![Object::Real(x), Object::Real(y)]));
        }

        ops.push(Operation::new("S", vec![]));
    }

    // Restore graphics state
    ops.push(Operation::new("Q", vec![]));

    ops
}

fn build_template_ops(template: &str, pw: f64, ph: f64) -> Vec<Operation> {
    let mut ops: Vec<Operation> = Vec::new();

    // White background
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new("g", vec![Object::Real(1.0_f32)]));
    ops.push(Operation::new("re", vec![
        Object::Real(0.0_f32), Object::Real(0.0_f32),
        Object::Real(pw as f32), Object::Real(ph as f32),
    ]));
    ops.push(Operation::new("f", vec![]));
    ops.push(Operation::new("Q", vec![]));

    match template {
        "ruled" => {
            ops.push(Operation::new("q", vec![]));
            ops.push(Operation::new("G", vec![Object::Real(0.78_f32)]));
            ops.push(Operation::new("w", vec![Object::Real(0.5_f32)]));
            let spacing = 20.0_f64;
            let margin_top = 30.0_f64;
            let margin_bottom = 20.0_f64;
            let margin_left = 25.0_f64;
            let margin_right = 25.0_f64;
            let mut y = ph - margin_top;
            while y > margin_bottom {
                ops.push(Operation::new("m", vec![Object::Real(margin_left as f32), Object::Real(y as f32)]));
                ops.push(Operation::new("l", vec![Object::Real((pw - margin_right) as f32), Object::Real(y as f32)]));
                y -= spacing;
            }
            ops.push(Operation::new("S", vec![]));
            ops.push(Operation::new("Q", vec![]));
        }
        "grid" => {
            ops.push(Operation::new("q", vec![]));
            ops.push(Operation::new("G", vec![Object::Real(0.78_f32)]));
            ops.push(Operation::new("w", vec![Object::Real(0.5_f32)]));
            let spacing = 20.0_f64;
            let mut y = ph - spacing;
            while y > 0.0 {
                ops.push(Operation::new("m", vec![Object::Real(0.0_f32), Object::Real(y as f32)]));
                ops.push(Operation::new("l", vec![Object::Real(pw as f32), Object::Real(y as f32)]));
                y -= spacing;
            }
            let mut x = spacing;
            while x < pw {
                ops.push(Operation::new("m", vec![Object::Real(x as f32), Object::Real(0.0_f32)]));
                ops.push(Operation::new("l", vec![Object::Real(x as f32), Object::Real(ph as f32)]));
                x += spacing;
            }
            ops.push(Operation::new("S", vec![]));
            ops.push(Operation::new("Q", vec![]));
        }
        "dotted" => {
            ops.push(Operation::new("q", vec![]));
            ops.push(Operation::new("g", vec![Object::Real(0.7_f32)]));
            let spacing = 20.0_f64;
            let dot_r = 0.8_f64;
            let mut y = ph - spacing;
            while y > spacing / 2.0 {
                let mut x = spacing;
                while x < pw - spacing / 2.0 {
                    ops.push(Operation::new("re", vec![
                        Object::Real((x - dot_r) as f32),
                        Object::Real((y - dot_r) as f32),
                        Object::Real((2.0 * dot_r) as f32),
                        Object::Real((2.0 * dot_r) as f32),
                    ]));
                    ops.push(Operation::new("f", vec![]));
                    x += spacing;
                }
                y -= spacing;
            }
            ops.push(Operation::new("Q", vec![]));
        }
        _ => {} // blank — white background only
    }

    ops
}

/// Insert virtual (note) pages into the document at the positions specified.
/// Assumes a flat page tree (single-level Kids array), which covers 99%+ of PDFs.
fn insert_virtual_pages(doc: &mut Document, virtual_pages: &[VirtualPageData]) -> AppResult<()> {
    // Resolve pages root ref
    let pages_ref: ObjectId = {
        let catalog_ref = doc.trailer.get(b"Root")
            .and_then(|r| r.as_reference())
            ?;
        let catalog = doc.get_object(catalog_ref)
            .and_then(|o| o.as_dict())
            ?;
        catalog.get(b"Pages")
            .and_then(|o| o.as_reference())
            ?
    };

    // Snapshot current Kids list
    let kids: Vec<ObjectId> = {
        let pages = doc.get_object(pages_ref)
            .and_then(|o| o.as_dict())
            ?;
        pages.get(b"Kids")
            .and_then(|o| o.as_array())
            ?
            .iter()
            .filter_map(|o| o.as_reference().ok())
            .collect()
    };

    let total_real = kids.len() as u32;
    let pw = 595.0_f64;
    let ph = 842.0_f64;

    // Create each virtual page object
    let mut new_pages: Vec<(u32, ObjectId)> = Vec::new();

    for vp in virtual_pages {
        let mut all_ops = build_template_ops(&vp.template, pw, ph);

        let has_hl = vp.strokes.iter().any(|s| s.tool == "highlighter");
        let hl_gs_id: Option<ObjectId> = if has_hl {
            let gs = dictionary! {
                "Type" => "ExtGState",
                "ca" => Object::Real(0.35_f32),
                "CA" => Object::Real(0.35_f32),
                "BM" => Object::Name(b"Multiply".to_vec()),
            };
            Some(doc.add_object(gs))
        } else {
            None
        };

        for s in &vp.strokes {
            if s.tool == "eraser" { continue; }
            let gs_name = if s.tool == "highlighter" { Some(b"HLAlpha".as_slice()) } else { None };
            all_ops.extend(build_stroke_ops(s, pw, ph, gs_name));
        }

        let content = Content { operations: all_ops };
        let content_bytes = content.encode()?;
        let stream_id = doc.add_object(Stream::new(Dictionary::new(), content_bytes));

        let mut resources = Dictionary::new();
        if let Some(gs_id) = hl_gs_id {
            let mut ext_gs = Dictionary::new();
            ext_gs.set("HLAlpha", Object::Reference(gs_id));
            resources.set("ExtGState", Object::Dictionary(ext_gs));
        }

        let mut page_dict = Dictionary::new();
        page_dict.set("Type", Object::Name(b"Page".to_vec()));
        page_dict.set("Parent", Object::Reference(pages_ref));
        page_dict.set("MediaBox", Object::Array(vec![
            Object::Integer(0), Object::Integer(0),
            Object::Integer(pw as i64), Object::Integer(ph as i64),
        ]));
        page_dict.set("Resources", Object::Dictionary(resources));
        page_dict.set("Contents", Object::Reference(stream_id));
        let page_id = doc.add_object(page_dict);

        // Clamp: 9999 → after all real pages
        let after = vp.after_real_page.min(total_real);
        new_pages.push((after, page_id));
    }

    // Group insertions by their insertion point
    let mut insertions: std::collections::HashMap<u32, Vec<ObjectId>> = std::collections::HashMap::new();
    for (after, id) in new_pages {
        insertions.entry(after).or_default().push(id);
    }

    // Build the new Kids list, interleaving virtual pages at their positions
    let mut new_kids: Vec<Object> = Vec::new();

    if let Some(before_all) = insertions.get(&0) {
        for id in before_all {
            new_kids.push(Object::Reference(*id));
        }
    }
    for (i, &real_kid) in kids.iter().enumerate() {
        new_kids.push(Object::Reference(real_kid));
        let page_num = (i + 1) as u32;
        if let Some(after_this) = insertions.get(&page_num) {
            for id in after_this {
                new_kids.push(Object::Reference(*id));
            }
        }
    }

    let new_count = new_kids.len() as i64;

    let pages_obj = doc.get_object_mut(pages_ref)?;
    if let Object::Dictionary(dict) = pages_obj {
        dict.set("Kids", Object::Array(new_kids));
        dict.set("Count", Object::Integer(new_count));
    }

    Ok(())
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

/// Resolve a Reference object to its ObjectId, if it is one.
fn resolve_ref(obj: &Object) -> Option<ObjectId> {
    if let Object::Reference(id) = obj {
        Some(*id)
    } else {
        None
    }
}

fn add_ext_gstate_to_page(doc: &mut Document, page_id: ObjectId, name: &[u8], gs_ref: ObjectId) -> AppResult<()> {
    // Determine indirection for Resources and ExtGState
    let (resources_id, ext_gs_id): (Option<ObjectId>, Option<ObjectId>) = {
        let page = doc.get_object(page_id)?;
        if let Object::Dictionary(page_dict) = page {
            let res_ref = page_dict.get(b"Resources").ok().and_then(|o| resolve_ref(o));

            let ext_gs_ref = if let Some(rid) = res_ref {
                doc.get_object(rid).ok()
                    .and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None })
                    .and_then(|d| d.get(b"ExtGState").ok().and_then(|o| resolve_ref(o)))
            } else {
                page_dict.get(b"Resources").ok()
                    .and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None })
                    .and_then(|d| d.get(b"ExtGState").ok().and_then(|o| resolve_ref(o)))
            };

            (res_ref, ext_gs_ref)
        } else {
            (None, None)
        }
    };

    if let Some(eid) = ext_gs_id {
        // ExtGState is indirect — update it directly
        let obj = doc.get_object_mut(eid)?;
        if let Object::Dictionary(d) = obj {
            d.set(name, Object::Reference(gs_ref));
        }
    } else if let Some(rid) = resources_id {
        // Resources is indirect, ExtGState is inline or absent
        let obj = doc.get_object_mut(rid)?;
        if let Object::Dictionary(res_dict) = obj {
            match res_dict.get_mut(b"ExtGState") {
                Ok(Object::Dictionary(d)) => {
                    d.set(name, Object::Reference(gs_ref));
                }
                _ => {
                    let mut d = Dictionary::new();
                    d.set(name, Object::Reference(gs_ref));
                    res_dict.set("ExtGState", Object::Dictionary(d));
                }
            }
        }
    } else {
        // Resources is inline on the page
        let page = doc.get_object_mut(page_id)?;
        if let Object::Dictionary(dict) = page {
            match dict.get_mut(b"Resources") {
                Ok(Object::Dictionary(res_dict)) => {
                    match res_dict.get_mut(b"ExtGState") {
                        Ok(Object::Dictionary(d)) => {
                            d.set(name, Object::Reference(gs_ref));
                        }
                        _ => {
                            let mut d = Dictionary::new();
                            d.set(name, Object::Reference(gs_ref));
                            res_dict.set("ExtGState", Object::Dictionary(d));
                        }
                    }
                }
                _ => {
                    let mut d = Dictionary::new();
                    d.set(name, Object::Reference(gs_ref));
                    let mut res_dict = Dictionary::new();
                    res_dict.set("ExtGState", Object::Dictionary(d));
                    dict.set("Resources", Object::Dictionary(res_dict));
                }
            }
        }
    }

    Ok(())
}

fn append_stream_to_page(doc: &mut Document, page_id: ObjectId, stream_id: ObjectId) -> AppResult<()> {
    let page = doc.get_object_mut(page_id)?;
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
pub fn bake_annotations(
    path: String,
    annotations: Vec<PageAnnotationData>,
    virtual_pages: Vec<VirtualPageData>,
    output: Option<String>,
) -> AppResult<String> {
    let out = output.unwrap_or_else(|| temp_output_path(&path, "annotated"));

    if annotations.is_empty() && virtual_pages.is_empty() {
        std::fs::copy(&path, &out)?;
        return Ok(out);
    }

    let mut doc = Document::load(&path)?;

    // Build page_map: page number (1-indexed) -> ObjectId
    let page_map: std::collections::HashMap<u32, ObjectId> =
        doc.get_pages().into_iter().collect();

    for annotation in &annotations {
        let page_id = match page_map.get(&annotation.page) {
            Some(id) => *id,
            None => continue,
        };

        if annotation.strokes.is_empty() {
            continue;
        }

        let (pw, ph) = get_page_dims(&doc, page_id);

        // Check if any highlighter strokes exist
        let has_highlighter = annotation.strokes.iter().any(|s| s.tool == "highlighter");

        // Phase 1: Add all new objects (immutable borrows only during reads, then add_object)
        let hl_gs_id: Option<ObjectId> = if has_highlighter {
            let gs_dict = dictionary! {
                "Type" => "ExtGState",
                "ca" => Object::Real(0.35_f32),
                "CA" => Object::Real(0.35_f32),
                "BM" => Object::Name(b"Multiply".to_vec()),
            };
            Some(doc.add_object(gs_dict))
        } else {
            None
        };

        // Phase 2: Build all ops for all strokes
        let hl_gs_name: &[u8] = b"HLAlpha";
        let mut all_ops: Vec<Operation> = Vec::new();
        for stroke in &annotation.strokes {
            if stroke.tool == "eraser" {
                continue; // eraser strokes are not baked
            }
            let gs_name_opt = if stroke.tool == "highlighter" {
                Some(hl_gs_name)
            } else {
                None
            };
            let ops = build_stroke_ops(stroke, pw, ph, gs_name_opt);
            all_ops.extend(ops);
        }

        if all_ops.is_empty() {
            continue;
        }

        // Phase 3: Encode content stream and add to doc
        let content = Content { operations: all_ops };
        let content_bytes = content.encode()?;
        let stream_id = doc.add_object(Stream::new(Dictionary::new(), content_bytes));

        // Phase 4: Mutate — add ExtGState to page Resources if needed
        if let Some(gs_id) = hl_gs_id {
            add_ext_gstate_to_page(&mut doc, page_id, hl_gs_name, gs_id)?;
        }

        // Phase 5: Append content stream to page Contents
        append_stream_to_page(&mut doc, page_id, stream_id)?;
    }

    // Insert virtual (note) pages at their specified positions
    if !virtual_pages.is_empty() {
        insert_virtual_pages(&mut doc, &virtual_pages)?;
    }

    doc.save(&out)?;
    Ok(out)
}
