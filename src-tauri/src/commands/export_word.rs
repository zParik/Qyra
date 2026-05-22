use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crate::error::{AppError, AppResult};
use docx_rs::{AlignmentType, Docx, Paragraph, Pic, Run, Table, TableCell, TableRow};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Deserialize;

#[derive(Clone, Copy, Default, Debug)]
struct Style {
    bold: bool,
    italic: bool,
    monospace: bool,
    superscript: bool,
}

#[derive(Clone, Copy, Default, Debug)]
struct ParaProps {
    heading_size: Option<usize>, // docx half-points (e.g. 32 = 16pt)
    bold_all: bool,
}

#[derive(Deserialize, Debug, Default, Clone)]
struct JBBox { #[serde(default)] x: i64, #[serde(default)] y: i64, #[serde(default)] w: i64, #[serde(default)] h: i64 }
#[derive(Deserialize, Debug, Default, Clone)]
struct JFont { #[serde(default)] name: String }
#[derive(Deserialize, Debug, Default, Clone)]
struct JLine { #[serde(default)] text: String, #[serde(default)] font: JFont }
#[derive(Deserialize, Debug, Default, Clone)]
struct JBlock { #[serde(default, rename = "type")] btype: String, #[serde(default)] bbox: JBBox, #[serde(default)] lines: Vec<JLine> }
#[derive(Deserialize, Debug, Default)]
struct JPage { #[serde(default)] blocks: Vec<JBlock> }

#[derive(Clone, Debug)]
struct BlockGeom {
    cx: f32,          // bbox center-x in PDF points
    w: f32,           // bbox width
    bbox: (f32, f32, f32, f32), // x0, y0, x1, y1 in PDF points
    is_math: bool,
}

fn is_math_font(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    // Computer Modern math family (CMMI, CMSY, CMEX, CMBSY etc.) — exclude CMR (regular text).
    let math_cm = n.contains("CMMI") || n.contains("CMSY") || n.contains("CMEX")
        || n.contains("CMBSY") || (n.contains("CMBX") && n.contains("MATH"));
    let other = n.contains("MSAM") || n.contains("MSBM") || n.contains("STIX")
        || n.contains("EUSM") || n.contains("EUFM") || n.contains("RSFS")
        || n.contains("MATH") || n.contains("MTMI") || n.contains("MTSY")
        || n.contains("SYMBOL");
    math_cm || other
}

fn block_looks_math(b: &JBlock) -> bool {
    // 1. Any line uses a known math font.
    if b.lines.iter().any(|l| is_math_font(&l.font.name)) {
        return true;
    }
    // 2. High ratio of "broken decode" markers (replacement chars or boxes).
    let mut total = 0usize;
    let mut suspect = 0usize;
    for l in &b.lines {
        for ch in l.text.chars() {
            total += 1;
            if ch == '\u{FFFD}' || ch == '□' || ch == '◇' || ch == '\u{25A1}' {
                suspect += 1;
            }
        }
    }
    if total > 0 && (suspect * 100 / total) >= 20 { return true; }
    false
}

// Accumulating builder for a paragraph: runs are appended as we go.
struct ParaBuf {
    props: ParaProps,
    runs: Vec<Run>,
    pending_text: String,
    pending_style: Style,
}

impl ParaBuf {
    fn new(props: ParaProps) -> Self {
        Self { props, runs: Vec::new(), pending_text: String::new(), pending_style: Style::default() }
    }
    fn flush_text(&mut self) {
        if self.pending_text.is_empty() { return; }
        let mut run = Run::new().add_text(&self.pending_text);
        if self.pending_style.bold || self.props.bold_all { run = run.bold(); }
        if self.pending_style.italic { run = run.italic(); }
        if let Some(sz) = self.props.heading_size { run = run.size(sz); }
        // monospace + superscript: docx-rs has limited support; skip family swap to avoid noise.
        self.runs.push(run);
        self.pending_text.clear();
    }
    fn append_char_data(&mut self, s: &str, style: Style) {
        if style.bold != self.pending_style.bold
            || style.italic != self.pending_style.italic
            || style.monospace != self.pending_style.monospace
            || style.superscript != self.pending_style.superscript
        {
            self.flush_text();
            self.pending_style = style;
        }
        self.pending_text.push_str(s);
    }
    fn into_paragraph(mut self) -> (Paragraph, bool /* has_text */) {
        self.flush_text();
        let has_text = !self.runs.is_empty();
        let mut p = Paragraph::new();
        for r in self.runs { p = p.add_run(r); }
        (p, has_text)
    }
}

// What is the active container that paragraphs/images get appended to?
enum Sink {
    TopLevel,                        // push to outer items vec
    TableCellSink(Vec<Paragraph>),   // currently filling a table cell
}

struct TableBuilder {
    rows: Vec<Vec<TableCell>>,
    current_row: Option<Vec<TableCell>>,
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn export_pdf_to_word(
    path: String,
    output: Option<String>,
) -> AppResult<String> {
    tokio::task::spawn_blocking(move || -> AppResult<String> {
        let doc = mupdf::Document::open(&path)?;
        let page_count = doc.page_count()?;

        let out_path = output.unwrap_or_else(|| {
            std::path::Path::new(&path)
                .with_extension("docx")
                .to_string_lossy()
                .to_string()
        });

        let make_flags = || {
            mupdf::TextPageFlags::PRESERVE_IMAGES
                | mupdf::TextPageFlags::COLLECT_STRUCTURE
                | mupdf::TextPageFlags::TABLE_HUNT
        };

        let mut docx = Docx::new();

        for i in 0..page_count {
            // Page separator paragraph.
            docx = docx.add_paragraph(
                Paragraph::new().add_run(
                    Run::new().add_text(format!("— Page {} —", i + 1)).bold(),
                ),
            );

            let page = doc.load_page(i)?;

            // Geometry pass: PRESERVE_IMAGES only (no STRUCT/TABLE) so JSON sees all text blocks
            // at top level for bbox lookup.
            let page_bounds = page.bounds()?;
            let page_w = (page_bounds.x1 - page_bounds.x0).abs();
            let page_cx = (page_bounds.x0 + page_bounds.x1) * 0.5;
            let geom_stext = page.to_text_page(mupdf::TextPageFlags::PRESERVE_IMAGES)?;
            let geom_json = geom_stext.to_json(1.0)?;
            let geom: JPage = serde_json::from_str(&geom_json).unwrap_or_default();
            let geoms: Vec<BlockGeom> = geom.blocks.iter()
                .filter(|b| b.btype == "text")
                .map(|b| BlockGeom {
                    cx: (b.bbox.x as f32) + (b.bbox.w as f32) * 0.5,
                    w: b.bbox.w as f32,
                    bbox: (
                        b.bbox.x as f32,
                        b.bbox.y as f32,
                        (b.bbox.x + b.bbox.w) as f32,
                        (b.bbox.y + b.bbox.h) as f32,
                    ),
                    is_math: block_looks_math(b),
                })
                .collect();

            // Pre-render full page at 2x for math rasterization (lazy: only if any math).
            let math_images: Vec<Option<(Vec<u8>, u32, u32)>> =
                if geoms.iter().any(|g| g.is_math) {
                    build_math_images(&page, &geoms, page_bounds, 2.0)
                } else {
                    vec![None; geoms.len()]
                };

            // Content pass: structure + table flags for tables/headings/bold-italic.
            let stext = page.to_text_page(make_flags())?;
            let xhtml = stext.to_xhtml(i as i32)?;

            docx = parse_xhtml_into_docx(docx, &xhtml, &geoms, &math_images, page_cx, page_w);
        }

        let file = std::fs::File::create(&out_path)?;
        docx.build().pack(file).map_err(|e| AppError::Other(e.to_string()))?;
        Ok(out_path)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(not(target_os = "android"))]
#[cfg(not(target_os = "android"))]
fn build_math_images(
    page: &mupdf::Page,
    geoms: &[BlockGeom],
    page_bounds: mupdf::Rect,
    scale: f32,
) -> Vec<Option<(Vec<u8>, u32, u32)>> {
    // Render full page once.
    let ctm = mupdf::Matrix::new_scale(scale, scale);
    let cs = mupdf::Colorspace::device_rgb();
    let pixmap = match page.to_pixmap(&ctm, &cs, false, true) {
        Ok(p) => p,
        Err(_) => return vec![None; geoms.len()],
    };
    let mut png_buf: Vec<u8> = Vec::new();
    if pixmap
        .write_to(&mut std::io::Cursor::new(&mut png_buf), mupdf::pixmap::ImageFormat::PNG)
        .is_err()
    {
        return vec![None; geoms.len()];
    }
    let full = match image::load_from_memory(&png_buf) { Ok(i) => i, Err(_) => return vec![None; geoms.len()] };
    let full_w = full.width() as f32;
    let full_h = full.height() as f32;
    let page_w = (page_bounds.x1 - page_bounds.x0).abs();
    let page_h = (page_bounds.y1 - page_bounds.y0).abs();
    if page_w <= 1.0 || page_h <= 1.0 { return vec![None; geoms.len()]; }
    let px_per_pt_x = full_w / page_w;
    let px_per_pt_y = full_h / page_h;

    let mut out: Vec<Option<(Vec<u8>, u32, u32)>> = Vec::with_capacity(geoms.len());
    for g in geoms {
        if !g.is_math { out.push(None); continue; }
        let (x0, y0, x1, y1) = g.bbox;
        // Pad bbox slightly so we don't clip glyph edges.
        let pad_pt = 2.0;
        let cx0 = ((x0 - page_bounds.x0 - pad_pt).max(0.0) * px_per_pt_x) as u32;
        let cy0 = ((y0 - page_bounds.y0 - pad_pt).max(0.0) * px_per_pt_y) as u32;
        let cx1 = (((x1 - page_bounds.x0 + pad_pt) * px_per_pt_x) as u32).min(full.width());
        let cy1 = (((y1 - page_bounds.y0 + pad_pt) * px_per_pt_y) as u32).min(full.height());
        if cx1 <= cx0 || cy1 <= cy0 { out.push(None); continue; }
        let cw = cx1 - cx0;
        let ch = cy1 - cy0;
        let sub = image::imageops::crop_imm(&full, cx0, cy0, cw, ch).to_image();
        let mut buf: Vec<u8> = Vec::new();
        if image::DynamicImage::ImageRgba8(sub)
            .write_to(std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .is_err()
        {
            out.push(None);
            continue;
        }
        out.push(Some((buf, cw, ch)));
    }
    out
}

#[cfg(not(target_os = "android"))]
fn parse_xhtml_into_docx(
    mut docx: Docx,
    xhtml: &str,
    geoms: &[BlockGeom],
    math_images: &[Option<(Vec<u8>, u32, u32)>],
    page_cx: f32,
    page_w: f32,
) -> Docx {
    let mut reader = Reader::from_str(xhtml);
    reader.config_mut().trim_text(false);

    // Style stack: pushed/popped on <b>/<i>/<tt>/<sup>.
    let mut style_stack: Vec<&'static str> = Vec::new();
    let current_style = |stk: &[&str]| -> Style {
        Style {
            bold: stk.iter().any(|s| *s == "b"),
            italic: stk.iter().any(|s| *s == "i"),
            monospace: stk.iter().any(|s| *s == "tt"),
            superscript: stk.iter().any(|s| *s == "sup"),
        }
    };

    let mut para_stack: Vec<ParaBuf> = Vec::new();
    let mut sink_stack: Vec<Sink> = vec![Sink::TopLevel];
    let mut table_stack: Vec<TableBuilder> = Vec::new();

    let mut geom_cursor: usize = 0;
    let is_centered = |idx: usize| -> bool {
        if page_w <= 1.0 { return false; }
        let g = match geoms.get(idx) { Some(v) => v, None => return false };
        let delta = (g.cx - page_cx).abs();
        let tol = page_w * 0.04;
        delta < tol && g.w < page_w * 0.85
    };

    // Helper closures replaced by inline blocks because Docx is moved through; closures
    // can't mutate captured Docx across iterations cleanly. Inline match flow instead.

    loop {
        let ev = reader.read_event();
        match ev {
            Err(_) => break, // tolerate malformed XHTML; emit what we parsed
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let tag = std::str::from_utf8(name.as_ref()).unwrap_or("");
                match tag {
                    "b" | "i" | "tt" | "sup" => {
                        let s: &'static str = match tag {
                            "b" => "b", "i" => "i", "tt" => "tt", "sup" => "sup", _ => "",
                        };
                        style_stack.push(s);
                    }
                    "p" => para_stack.push(ParaBuf::new(ParaProps::default())),
                    "h1" => para_stack.push(ParaBuf::new(ParaProps { heading_size: Some(36), bold_all: true })),
                    "h2" => para_stack.push(ParaBuf::new(ParaProps { heading_size: Some(30), bold_all: true })),
                    "h3" => para_stack.push(ParaBuf::new(ParaProps { heading_size: Some(26), bold_all: true })),
                    "h4" | "h5" | "h6" => para_stack.push(ParaBuf::new(ParaProps { heading_size: Some(22), bold_all: true })),
                    "table" => {
                        table_stack.push(TableBuilder { rows: Vec::new(), current_row: None });
                    }
                    "tr" => {
                        if let Some(t) = table_stack.last_mut() {
                            t.current_row = Some(Vec::new());
                        }
                    }
                    "td" | "th" => {
                        sink_stack.push(Sink::TableCellSink(Vec::new()));
                    }
                    "img" => {
                        // Some emitters use <img> as Start (with whitespace inside); handle data.
                        if let Some(item) = decode_img(&e) {
                            place_image(&mut docx, &mut sink_stack, item);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.local_name();
                let tag = std::str::from_utf8(name.as_ref()).unwrap_or("");
                if tag == "img" {
                    if let Some(item) = decode_img(&e) {
                        place_image(&mut docx, &mut sink_stack, item);
                    }
                } else if tag == "br" {
                    if let Some(p) = para_stack.last_mut() {
                        p.flush_text();
                        p.runs.push(Run::new().add_break(docx_rs::BreakType::TextWrapping));
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let tag = std::str::from_utf8(name.as_ref()).unwrap_or("");
                match tag {
                    "b" | "i" | "tt" | "sup" => {
                        if let Some(pos) = style_stack.iter().rposition(|s| *s == tag) {
                            style_stack.remove(pos);
                        }
                    }
                    "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        if let Some(pb) = para_stack.pop() {
                            let is_heading = pb.props.heading_size.is_some();
                            let (mut para, has_text) = pb.into_paragraph();
                            if has_text {
                                // Math substitution: replace text para with rasterized image.
                                let math_img = math_images.get(geom_cursor).cloned().flatten();
                                let g = geoms.get(geom_cursor).cloned();
                                geom_cursor += 1;
                                if let (Some(bg), Some(img)) = (g.as_ref(), math_img) {
                                    if bg.is_math {
                                        let (bytes, w_px, h_px) = img;
                                        if image::load_from_memory(&bytes).is_ok() {
                                            // Convert px (2x scale) back to EMU: at 2x scale,
                                            // 1 PDF pt = (2 / 72) * 914400 / 2 = 12700 EMU per source pt.
                                            // We have pixel dimensions; assume 144 DPI render: 1 px = 6350 EMU.
                                            const PX_EMU_144: u32 = 914400 / 144;
                                            let w_emu = (w_px * PX_EMU_144).max(1);
                                            let h_emu = (h_px * PX_EMU_144).max(1);
                                            let pic = Pic::new(&bytes).size(w_emu, h_emu);
                                            let img_para = Paragraph::new()
                                                .align(AlignmentType::Center)
                                                .add_run(Run::new().add_image(pic));
                                            place_paragraph(&mut docx, &mut sink_stack, img_para);
                                            continue;
                                        }
                                    }
                                }

                                let in_cell = matches!(sink_stack.last(), Some(Sink::TableCellSink(_)));
                                if is_centered(geom_cursor.saturating_sub(1)) {
                                    para = para.align(AlignmentType::Center);
                                } else if !is_heading && !in_cell {
                                    para = para.align(AlignmentType::Both);
                                }
                            }
                            place_paragraph(&mut docx, &mut sink_stack, para);
                        }
                    }
                    "td" | "th" => {
                        if let Some(Sink::TableCellSink(paras)) = sink_stack.pop() {
                            let mut tc = TableCell::new();
                            if paras.is_empty() {
                                tc = tc.add_paragraph(Paragraph::new());
                            } else {
                                for p in paras { tc = tc.add_paragraph(p); }
                            }
                            if let Some(t) = table_stack.last_mut() {
                                if let Some(row) = t.current_row.as_mut() {
                                    row.push(tc);
                                }
                            }
                        }
                    }
                    "tr" => {
                        if let Some(t) = table_stack.last_mut() {
                            if let Some(row) = t.current_row.take() {
                                if !row.is_empty() { t.rows.push(row); }
                            }
                        }
                    }
                    "table" => {
                        if let Some(t) = table_stack.pop() {
                            if !t.rows.is_empty() {
                                let rows: Vec<TableRow> =
                                    t.rows.into_iter().map(TableRow::new).collect();
                                let table = Table::new(rows);
                                // Tables only go to top-level (nested tables flattened).
                                let owned = std::mem::take(&mut docx);
                                docx = owned.add_table(table);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                let s = match t.unescape() {
                    Ok(v) => v.into_owned(),
                    Err(_) => continue,
                };
                if s.is_empty() { continue; }
                if let Some(p) = para_stack.last_mut() {
                    p.append_char_data(&s, current_style(&style_stack));
                }
                // Text outside any paragraph: ignore (whitespace between tags).
            }
            Ok(_) => {}
        }
    }

    // Flush any unclosed paragraphs (rare; structural error).
    while let Some(pb) = para_stack.pop() {
        let is_heading = pb.props.heading_size.is_some();
        let (mut para, has_text) = pb.into_paragraph();
        if has_text {
            let in_cell = matches!(sink_stack.last(), Some(Sink::TableCellSink(_)));
            if is_centered(geom_cursor) {
                para = para.align(AlignmentType::Center);
            } else if !is_heading && !in_cell {
                para = para.align(AlignmentType::Both);
            }
            geom_cursor += 1;
        }
        place_paragraph(&mut docx, &mut sink_stack, para);
    }

    docx
}

#[cfg(not(target_os = "android"))]
struct ImgData {
    bytes: Vec<u8>,
    w_emu: u32,
    h_emu: u32,
}

#[cfg(not(target_os = "android"))]
fn decode_img(e: &BytesStart<'_>) -> Option<ImgData> {
    let mut src: Option<String> = None;
    let mut width_pt: Option<i64> = None;
    let mut height_pt: Option<i64> = None;
    let decoder = Reader::from_str("").decoder();
    for attr in e.attributes().flatten() {
        let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
        let val = match attr.decode_and_unescape_value(decoder) {
            Ok(v) => v.into_owned(),
            Err(_) => continue,
        };
        match key {
            "src" => src = Some(val),
            "width" => width_pt = val.parse::<i64>().ok(),
            "height" => height_pt = val.parse::<i64>().ok(),
            _ => {}
        }
    }
    let src = src?;
    let comma = src.find(',')?;
    let payload = &src[comma + 1..];
    let bytes = B64.decode(payload.as_bytes()).ok()?;
    if bytes.is_empty() { return None; }
    const EMU_PER_PT: i64 = 12700;
    let (w_emu, h_emu) = match (width_pt, height_pt) {
        (Some(w), Some(h)) if w > 0 && h > 0 => {
            ((w * EMU_PER_PT) as u32, (h * EMU_PER_PT) as u32)
        }
        _ => (914400 / 96 * 200, 914400 / 96 * 150), // fallback ~200x150 px
    };
    Some(ImgData { bytes, w_emu: w_emu.max(1), h_emu: h_emu.max(1) })
}

#[cfg(not(target_os = "android"))]
fn place_paragraph(docx: &mut Docx, sink_stack: &mut Vec<Sink>, para: Paragraph) {
    match sink_stack.last_mut() {
        Some(Sink::TableCellSink(v)) => v.push(para),
        Some(Sink::TopLevel) | None => {
            let owned = std::mem::take(docx);
            *docx = owned.add_paragraph(para);
        }
    }
}

#[cfg(not(target_os = "android"))]
fn place_image(docx: &mut Docx, sink_stack: &mut Vec<Sink>, img: ImgData) {
    // Pic::new panics on undecodable bytes; pre-validate via image crate.
    if image::load_from_memory(&img.bytes).is_err() { return; }
    let pic = Pic::new(&img.bytes).size(img.w_emu, img.h_emu);
    let para = Paragraph::new().add_run(Run::new().add_image(pic));
    place_paragraph(docx, sink_stack, para);
}

#[tauri::command]
#[cfg(target_os = "android")]
pub async fn export_pdf_to_word(
    _path: String,
    _output: Option<String>,
) -> AppResult<String> {
    Err(AppError::Other("Not supported on Android".to_string()))
}
