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

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BatesOptions {
    pub prefix: String,
    pub suffix: String,
    pub start_at: u64,
    pub increment: u64,
    pub digits: u8,
    pub position: String,
    pub font_size: f32,
    pub margin: f32,
}

impl Default for BatesOptions {
    fn default() -> Self {
        Self {
            prefix: String::new(),
            suffix: String::new(),
            start_at: 1,
            increment: 1,
            digits: 6,
            position: "bottom-right".to_string(),
            font_size: 9.0,
            margin: 18.0,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatesResult {
    pub output: String,
    pub first_label: String,
    pub last_label: String,
    pub page_count: usize,
}

fn pick_font_name(font_dict: &Dictionary) -> Vec<u8> {
    let candidates = [b"BN" as &[u8], b"BNF", b"BNFONT"];
    for name in candidates {
        if font_dict.get(name).is_err() {
            return name.to_vec();
        }
    }
    let mut i = 0u32;
    loop {
        let name = format!("BN{}", i).into_bytes();
        if font_dict.get(&name).is_err() {
            return name;
        }
        i += 1;
    }
}

fn resolve_ref(obj: &Object) -> Option<ObjectId> {
    if let Object::Reference(id) = obj { Some(*id) } else { None }
}

fn build_label(opts: &BatesOptions, seq: u64) -> String {
    let digits = opts.digits.clamp(1, 12) as usize;
    format!("{}{:0>width$}{}", opts.prefix, seq, opts.suffix, width = digits)
}

#[tauri::command]
pub async fn add_bates_numbers(
    path: String,
    options: Option<BatesOptions>,
    output: Option<String>,
    app_handle: tauri::AppHandle,
) -> AppResult<BatesResult> {
    tokio::task::spawn_blocking(move || -> AppResult<BatesResult> {
        bates_core(path, options, output, |p| {
            let _ = app_handle.emit("operation-progress", p);
        })
    })
    .await
    .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

/// Pure Bates-numbering core (no Tauri runtime). `progress` receives each step
/// so the command wrapper can forward it; tests pass a no-op.
pub fn bates_core(
    path: String,
    options: Option<BatesOptions>,
    output: Option<String>,
    progress: impl Fn(Progress),
) -> AppResult<BatesResult> {
        let opts = options.unwrap_or_default();
        let mut doc = Document::load(&path)?;

        let font_id = doc.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        });

        let page_ids: Vec<(u32, (u32, u16))> = doc.get_pages().into_iter().collect();
        let total_pages = page_ids.len();
        let increment = opts.increment.max(1);
        let start_at = opts.start_at;

        let mut first_label = String::new();
        let mut last_label = String::new();

        for (i, (_page_num, page_id)) in page_ids.iter().enumerate() {
            progress(Progress::new(i + 1, total_pages, format!("Page {} of {}", i + 1, total_pages)));

            let seq = start_at + (i as u64) * increment;
            let label = build_label(&opts, seq);
            if i == 0 { first_label = label.clone(); }
            if i + 1 == total_pages { last_label = label.clone(); }

            let (page_width, page_height) = {
                let (w, h) = get_page_dims(&doc, *page_id);
                (w as f32, h as f32)
            };

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
                    doc.get_object(*page_id).ok()
                        .and_then(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
                        .and_then(|d| d.get(b"Resources").ok()
                            .and_then(|o| if let Object::Dictionary(r) = o { Some(r.clone()) } else { None }))
                        .and_then(|r| r.get(b"Font").ok()
                            .and_then(|o| if let Object::Dictionary(fd) = o { Some(fd.clone()) } else { None }))
                };
                maybe_font_dict.as_ref().map(pick_font_name).unwrap_or_else(|| b"BN".to_vec())
            };

            let text_w = label.len() as f32 * opts.font_size * 0.6;
            let (x, y) = match opts.position.as_str() {
                "bottom-left"   => (opts.margin,                            opts.margin),
                "bottom-center" => (page_width / 2.0 - text_w / 2.0,              opts.margin),
                "bottom-right"  => (page_width - opts.margin - text_w,      opts.margin),
                "top-left"      => (opts.margin,                            page_height - opts.margin),
                "top-center"    => (page_width / 2.0 - text_w / 2.0,              page_height - opts.margin),
                "top-right"     => (page_width - opts.margin - text_w,      page_height - opts.margin),
                _               => (page_width - opts.margin - text_w,      opts.margin),
            };

            let ops = vec![
                Operation::new("q", vec![]),
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(font_name.clone()), Object::Real(opts.font_size)]),
                Operation::new("Td", vec![Object::Real(x), Object::Real(y)]),
                Operation::new("Tj", vec![Object::string_literal(label.clone())]),
                Operation::new("ET", vec![]),
                Operation::new("Q", vec![]),
            ];
            let content = Content { operations: ops };
            let content_bytes = content.encode()?;
            let mut stream_dict = Dictionary::new();
            stream_dict.set("BatesOverlay", Object::Boolean(true));
            let stream_id = doc.add_object(Stream::new(stream_dict, content_bytes));

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
        }

        let out = output.unwrap_or_else(|| temp_output_path(&path, "bates"));
        doc.save(&out)?;

        Ok(BatesResult {
            output: out,
            first_label,
            last_label,
            page_count: total_pages,
        })
}

/// Remove BatesOverlay streams added by `add_bates_numbers`.
#[tauri::command]
pub fn remove_bates_numbers(path: String, output: Option<String>) -> AppResult<String> {
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
                if s.dict.get(b"BatesOverlay").is_ok() {
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

    let out = output.unwrap_or_else(|| temp_output_path(&path, "unbates"));
    doc.save(&out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_format_pads_and_wraps() {
        let mut opts = BatesOptions::default();
        opts.prefix = "CASE-".to_string();
        opts.suffix = "-A".to_string();
        opts.digits = 4;
        assert_eq!(build_label(&opts, 7), "CASE-0007-A");
        assert_eq!(build_label(&opts, 9999), "CASE-9999-A");
        assert_eq!(build_label(&opts, 10000), "CASE-10000-A");
    }
}
