use crate::error::AppResult;
use crate::utils::get_page_dims;
use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;
use lopdf::{
    content::{Content, Operation},
    dictionary, Dictionary, Document, Object, ObjectId, Stream,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct HeaderFooterZones {
    pub header_left: String,
    pub header_center: String,
    pub header_right: String,
    pub footer_left: String,
    pub footer_center: String,
    pub footer_right: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct HeaderFooterOptions {
    pub zones: HeaderFooterZones,
    pub font_size: f32,
    pub margin: f32,
    pub start_page: u32,
    pub end_page: Option<u32>,
}

impl Default for HeaderFooterOptions {
    fn default() -> Self {
        Self {
            zones: HeaderFooterZones::default(),
            font_size: 10.0,
            margin: 24.0,
            start_page: 1,
            end_page: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFooterReport {
    pub output: String,
    pub pages_stamped: usize,
}

fn substitute_variables(template: &str, page: u32, total: u32, filename: &str) -> String {
    template
        .replace("{page}", &page.to_string())
        .replace("{total}", &total.to_string())
        .replace("{filename}", filename)
        .replace("{date}", &current_date_string())
}

fn current_date_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // Roughly correct UTC YYYY-MM-DD without pulling in chrono.
    let days = secs / 86400;
    let (y, m, d) = days_to_date(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Convert days-since-1970-01-01 (UTC) into a (year, month, day) tuple.
/// Algorithm from Howard Hinnant's date library, public-domain.
fn days_to_date(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn pick_font_name(font_dict: &Dictionary) -> Vec<u8> {
    let candidates = [b"HF" as &[u8], b"HFF", b"HFFONT"];
    for name in candidates {
        if font_dict.get(name).is_err() {
            return name.to_vec();
        }
    }
    let mut i = 0u32;
    loop {
        let name = format!("HF{}", i).into_bytes();
        if font_dict.get(&name).is_err() {
            return name;
        }
        i += 1;
    }
}

fn resolve_ref(obj: &Object) -> Option<ObjectId> {
    if let Object::Reference(id) = obj { Some(*id) } else { None }
}

#[tauri::command]
pub async fn add_header_footer(
    path: String,
    options: HeaderFooterOptions,
    output: Option<String>,
    app_handle: tauri::AppHandle,
) -> AppResult<HeaderFooterReport> {
    let opts = options;
    let path_for_blocking = path.clone();
    let output_for_blocking = output.clone();
    let filename = std::path::Path::new(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    tokio::task::spawn_blocking(move || -> AppResult<HeaderFooterReport> {
        let mut doc = Document::load(&path_for_blocking)?;
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });

        let page_ids: Vec<(u32, (u32, u16))> = doc.get_pages().into_iter().collect();
        let total = page_ids.len() as u32;
        let end_page = opts.end_page.unwrap_or(total);
        let start_page = opts.start_page.max(1);

        let mut pages_stamped = 0usize;

        for (page_num, page_id) in &page_ids {
            let _ = app_handle.emit(
                "operation-progress",
                Progress::new(*page_num as usize, total as usize, format!("Page {} of {}", page_num, total)),
            );
            if *page_num < start_page || *page_num > end_page { continue; }

            let (page_width, page_height) = {
                let (w, h) = get_page_dims(&doc, *page_id);
                (w as f32, h as f32)
            };

            // Build the six zone strings with variables substituted.
            let zones = [
                (&opts.zones.header_left, "left", false),
                (&opts.zones.header_center, "center", false),
                (&opts.zones.header_right, "right", false),
                (&opts.zones.footer_left, "left", true),
                (&opts.zones.footer_center, "center", true),
                (&opts.zones.footer_right, "right", true),
            ];

            let resolved: Vec<(String, &'static str, bool)> = zones
                .iter()
                .map(|(template, align, is_footer)| {
                    let text = substitute_variables(template, *page_num, total, &filename);
                    (text, *align, *is_footer)
                })
                .filter(|(text, _, _)| !text.is_empty())
                .collect();

            if resolved.is_empty() { continue; }

            // Resolve resources / font dict like page_numbers does.
            let (resources_id, font_dict_id): (Option<ObjectId>, Option<ObjectId>) = {
                let page = doc.get_object(*page_id)?;
                if let Object::Dictionary(page_dict) = page {
                    let res_ref = page_dict.get(b"Resources").ok().and_then(resolve_ref);
                    let font_ref = if let Some(rid) = res_ref {
                        doc.get_object(rid).ok()
                            .and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None })
                            .and_then(|d| d.get(b"Font").ok().and_then(resolve_ref))
                    } else {
                        page_dict.get(b"Resources").ok()
                            .and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None })
                            .and_then(|d| d.get(b"Font").ok().and_then(resolve_ref))
                    };
                    (res_ref, font_ref)
                } else {
                    (None, None)
                }
            };

            let font_name: Vec<u8> = {
                let maybe_font_dict: Option<Dictionary> = if let Some(fid) = font_dict_id {
                    doc.get_object(fid).ok()
                        .and_then(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
                } else if let Some(rid) = resources_id {
                    doc.get_object(rid).ok()
                        .and_then(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
                        .and_then(|d| d.get(b"Font").ok()
                            .and_then(|o| if let Object::Dictionary(fd) = o { Some(fd.clone()) } else { None }))
                } else {
                    None
                };
                maybe_font_dict.as_ref().map(pick_font_name).unwrap_or_else(|| b"HF".to_vec())
            };

            // Compose all six zones into a single content stream wrapped in q/Q.
            let mut ops: Vec<Operation> = Vec::new();
            ops.push(Operation::new("q", vec![]));
            for (text, align, is_footer) in &resolved {
                let text_w = text.len() as f32 * opts.font_size * 0.6;
                let x = match *align {
                    "left" => opts.margin,
                    "center" => page_width / 2.0 - text_w / 2.0,
                    _ => page_width - opts.margin - text_w,
                };
                let y = if *is_footer {
                    opts.margin
                } else {
                    page_height - opts.margin - opts.font_size
                };
                ops.push(Operation::new("BT", vec![]));
                ops.push(Operation::new(
                    "Tf",
                    vec![Object::Name(font_name.clone()), Object::Real(opts.font_size)],
                ));
                ops.push(Operation::new("Td", vec![Object::Real(x), Object::Real(y)]));
                ops.push(Operation::new("Tj", vec![Object::string_literal(text.clone())]));
                ops.push(Operation::new("ET", vec![]));
            }
            ops.push(Operation::new("Q", vec![]));

            let content = Content { operations: ops };
            let content_bytes = content.encode()?;
            let mut stream_dict = Dictionary::new();
            stream_dict.set("HeaderFooterOverlay", Object::Boolean(true));
            let stream_id = doc.add_object(Stream::new(stream_dict, content_bytes));

            // Attach font + prepend stream — same pattern as page_numbers.
            if let Some(fid) = font_dict_id {
                if let Ok(Object::Dictionary(fd)) = doc.get_object_mut(fid) {
                    fd.set(font_name.clone(), Object::Reference(font_id));
                }
            } else if let Some(rid) = resources_id {
                if let Ok(Object::Dictionary(res_dict)) = doc.get_object_mut(rid) {
                    match res_dict.get_mut(b"Font") {
                        Ok(Object::Dictionary(fd)) => {
                            fd.set(font_name.clone(), Object::Reference(font_id));
                        }
                        _ => {
                            let mut fd = Dictionary::new();
                            fd.set(font_name.clone(), Object::Reference(font_id));
                            res_dict.set("Font", Object::Dictionary(fd));
                        }
                    }
                }
            } else if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(*page_id) {
                match dict.get_mut(b"Resources") {
                    Ok(Object::Dictionary(res_dict)) => match res_dict.get_mut(b"Font") {
                        Ok(Object::Dictionary(fd)) => {
                            fd.set(font_name.clone(), Object::Reference(font_id));
                        }
                        _ => {
                            let mut fd = Dictionary::new();
                            fd.set(font_name.clone(), Object::Reference(font_id));
                            res_dict.set("Font", Object::Dictionary(fd));
                        }
                    },
                    _ => {
                        let mut fd = Dictionary::new();
                        fd.set(font_name.clone(), Object::Reference(font_id));
                        let mut res_dict = Dictionary::new();
                        res_dict.set("Font", Object::Dictionary(fd));
                        dict.set("Resources", Object::Dictionary(res_dict));
                    }
                }
            }

            if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(*page_id) {
                match dict.get_mut(b"Contents") {
                    Ok(Object::Array(arr)) => {
                        arr.insert(0, Object::Reference(stream_id));
                    }
                    Ok(Object::Reference(r)) => {
                        let existing = *r;
                        dict.set("Contents", Object::Array(vec![
                            Object::Reference(stream_id),
                            Object::Reference(existing),
                        ]));
                    }
                    _ => {
                        dict.set("Contents", Object::Reference(stream_id));
                    }
                }
            }

            pages_stamped += 1;
        }

        let out = output_for_blocking
            .unwrap_or_else(|| temp_output_path(&path_for_blocking, "header"));
        doc.save(&out)?;

        Ok(HeaderFooterReport { output: out, pages_stamped })
    })
    .await
    .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

#[tauri::command]
pub fn remove_header_footer(path: String, output: Option<String>) -> AppResult<String> {
    let mut doc = Document::load(&path)?;
    let page_ids: Vec<(u32, (u32, u16))> = doc.get_pages().into_iter().collect();
    let mut removals: Vec<((u32, u16), Vec<(u32, u16)>)> = Vec::new();

    for (_n, page_id) in &page_ids {
        let stream_refs: Vec<(u32, u16)> = match doc.get_object(*page_id) {
            Ok(Object::Dictionary(dict)) => match dict.get(b"Contents") {
                Ok(Object::Array(arr)) => arr
                    .iter()
                    .filter_map(|o| if let Object::Reference(id) = o { Some(*id) } else { None })
                    .collect(),
                Ok(Object::Reference(id)) => vec![*id],
                _ => vec![],
            },
            _ => vec![],
        };
        let mut to_remove = Vec::new();
        for sid in stream_refs {
            if let Ok(Object::Stream(s)) = doc.get_object(sid) {
                if s.dict.get(b"HeaderFooterOverlay").is_ok() {
                    to_remove.push(sid);
                }
            }
        }
        if !to_remove.is_empty() {
            removals.push((*page_id, to_remove));
        }
    }

    for (page_id, remove_ids) in removals {
        if let Ok(Object::Dictionary(dict)) = doc.get_object_mut(page_id) {
            match dict.get_mut(b"Contents") {
                Ok(Object::Array(arr)) => {
                    arr.retain(|o| match o {
                        Object::Reference(id) => !remove_ids.contains(id),
                        _ => true,
                    });
                }
                Ok(Object::Reference(r)) if remove_ids.contains(r) => {
                    dict.remove(b"Contents");
                }
                _ => {}
            }
        }
    }

    let out = output.unwrap_or_else(|| temp_output_path(&path, "unheader"));
    doc.save(&out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variables_substituted() {
        let s = substitute_variables("{filename} — page {page}/{total}", 3, 12, "report.pdf");
        assert_eq!(s, "report.pdf — page 3/12");
    }

    #[test]
    fn date_format_known_epoch() {
        // 2020-01-01 = day 18262 since 1970-01-01
        let (y, m, d) = days_to_date(18262);
        assert_eq!((y, m, d), (2020, 1, 1));
    }
}
