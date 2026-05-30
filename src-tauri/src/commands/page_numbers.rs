use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream, content::{Content, Operation}};
use tauri::Emitter;
use crate::utils::paths::temp_output_path;
use crate::utils::progress::Progress;
use crate::utils::get_page_dims;
use crate::error::AppResult;

#[derive(serde::Deserialize)]
pub struct PageNumberOptions {
    pub start_at: Option<u32>,
    pub position: Option<String>,
    pub font_size: Option<f32>,
    pub margin: Option<f32>,
}

/// Return a font name (as bytes) that is not already in `font_dict`.
fn pick_font_name(font_dict: &Dictionary) -> Vec<u8> {
    let candidates = [b"PN" as &[u8], b"PNF", b"PNFONT"];
    for name in candidates {
        if font_dict.get(name).is_err() {
            return name.to_vec();
        }
    }
    let mut i = 0u32;
    loop {
        let name = format!("PN{}", i).into_bytes();
        if font_dict.get(&name).is_err() {
            return name;
        }
        i += 1;
    }
}

/// Resolve a chain of indirect references to get the final ObjectId.
fn resolve_ref(_doc: &Document, obj: &Object) -> Option<ObjectId> {
    if let Object::Reference(id) = obj {
        Some(*id)
    } else {
        None
    }
}

/// Add page numbers to a PDF as content stream overlays.
#[tauri::command]
pub async fn add_page_numbers(
    path: String,
    options: Option<PageNumberOptions>,
    output: Option<String>,
    app_handle: tauri::AppHandle,
) -> AppResult<String> {
    add_page_numbers_core(path, options, output, |p| {
        let _ = app_handle.emit("operation-progress", p);
    })
}

/// Pure page-numbering core (no Tauri runtime). `progress` receives each step
/// so the command wrapper can forward it; tests pass a no-op.
pub fn add_page_numbers_core(
    path: String,
    options: Option<PageNumberOptions>,
    output: Option<String>,
    progress: impl Fn(Progress),
) -> AppResult<String> {
    let opts = options.unwrap_or(PageNumberOptions {
        start_at: Some(1),
        position: Some("bottom-center".into()),
        font_size: Some(10.0),
        margin: Some(20.0),
    });

    let start_at = opts.start_at.unwrap_or(1);
    let font_size = opts.font_size.unwrap_or(10.0);
    let margin = opts.margin.unwrap_or(20.0);
    let position = opts.position.unwrap_or_else(|| "bottom-center".into());

    let mut doc = Document::load(&path)?;

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });

    let page_ids: Vec<(u32, (u32, u16))> = doc.get_pages().into_iter().collect();
    let total_pages = page_ids.len();

    for (i, (_page_num, page_id)) in page_ids.iter().enumerate() {
        progress(Progress::new(i + 1, total_pages, format!("Page {} of {}", i + 1, total_pages)));
        let display_num = start_at as usize + i;
        let label = format!("{}", display_num);

        // --- Read page geometry ---
        let (page_width, page_height) = {
            let (w, h) = get_page_dims(&doc, *page_id);
            (w as f32, h as f32)
        };

        // --- Resolve resource reference chain ---
        // We need to figure out where Resources and Font live (direct or indirect)
        // so we can mutate the correct object without clobbering anything.
        //
        // resources_id: Some(id) means Resources is stored as an indirect object
        // font_dict_id: Some(id) means the Font dict inside Resources is indirect
        let (resources_id, font_dict_id): (Option<ObjectId>, Option<ObjectId>) = {
            let page = doc.get_object(*page_id)?;
            if let Object::Dictionary(page_dict) = page {
                let res_ref = page_dict.get(b"Resources").ok().and_then(|o| resolve_ref(&doc, o));

                let font_ref = if let Some(rid) = res_ref {
                    // Resources is indirect — look inside that object
                    doc.get_object(rid).ok()
                        .and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None })
                        .and_then(|d| d.get(b"Font").ok().and_then(|o| resolve_ref(&doc, o)))
                } else {
                    // Resources is inline — look inside the page dict directly
                    page_dict.get(b"Resources").ok()
                        .and_then(|o| if let Object::Dictionary(d) = o { Some(d) } else { None })
                        .and_then(|d| d.get(b"Font").ok().and_then(|o| resolve_ref(&doc, o)))
                };

                (res_ref, font_ref)
            } else {
                (None, None)
            }
        };

        // --- Pick a non-conflicting font name ---
        let font_name: Vec<u8> = {
            // Read the actual Font dictionary (follow refs as needed)
            let maybe_font_dict: Option<Dictionary> = if let Some(fid) = font_dict_id {
                doc.get_object(fid).ok()
                    .and_then(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
            } else if let Some(rid) = resources_id {
                doc.get_object(rid).ok()
                    .and_then(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
                    .and_then(|d| d.get(b"Font").ok()
                        .and_then(|o| if let Object::Dictionary(fd) = o { Some(fd.clone()) } else { None }))
            } else {
                // Resources is inline on the page
                doc.get_object(*page_id).ok()
                    .and_then(|o| if let Object::Dictionary(d) = o { Some(d.clone()) } else { None })
                    .and_then(|d| d.get(b"Resources").ok()
                        .and_then(|o| if let Object::Dictionary(r) = o { Some(r.clone()) } else { None }))
                    .and_then(|r| r.get(b"Font").ok()
                        .and_then(|o| if let Object::Dictionary(fd) = o { Some(fd.clone()) } else { None }))
            };

            maybe_font_dict
                .as_ref()
                .map(pick_font_name)
                .unwrap_or_else(|| b"PN".to_vec())
        };

        // --- Compute position ---
        // x0/y0 are the MediaBox origin (usually 0); positions are absolute coords.
        let text_w = label.len() as f32 * font_size * 0.6; // approx Helvetica glyph width
        let x0 = 0.0_f32; // MediaBox lower-left x (standard PDFs use 0)
        let y0 = 0.0_f32; // MediaBox lower-left y (standard PDFs use 0)
        let (x, y) = match position.as_str() {
            "bottom-left"   => (x0 + margin,                                y0 + margin),
            "bottom-center" => (x0 + (page_width - x0) / 2.0 - text_w / 2.0, y0 + margin),
            "bottom-right"  => (x0 + page_width - margin - text_w,          y0 + margin),
            "top-left"      => (x0 + margin,                                y0 + page_height - margin),
            "top-center"    => (x0 + (page_width - x0) / 2.0 - text_w / 2.0, y0 + page_height - margin),
            "top-right"     => (x0 + page_width - margin - text_w,          y0 + page_height - margin),
            _               => (x0 + (page_width - x0) / 2.0 - text_w / 2.0, y0 + margin),
        };

        // --- Build content stream ---
        // Wrap in q/Q so our graphics state changes don't bleed into the existing
        // content streams. We also prepend (rather than append) to the Contents
        // array so our stream runs in the clean initial CTM — many word-processor
        // PDFs apply a Y-flip transform inside their streams without restoring it,
        // which would invert our Y coordinates if we ran after them.
        let ops = vec![
            Operation::new("q", vec![]),
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec![Object::Name(font_name.clone()), Object::Real(font_size)]),
            Operation::new("Td", vec![Object::Real(x), Object::Real(y)]),
            Operation::new("Tj", vec![Object::string_literal(label.clone())]),
            Operation::new("ET", vec![]),
            Operation::new("Q", vec![]),
        ];
        let content = Content { operations: ops };
        let content_bytes = content.encode()?;
        let mut stream_dict = Dictionary::new();
        // Tag so remove_page_numbers can identify streams we added.
        stream_dict.set("PageNumOverlay", Object::Boolean(true));
        let stream_id = doc.add_object(Stream::new(stream_dict, content_bytes));

        // --- Add font to resources (follow indirect refs so we never clobber existing data) ---
        if let Some(fid) = font_dict_id {
            // Font dict is an indirect object — update it directly
            let obj = doc.get_object_mut(fid)?;
            if let Object::Dictionary(fd) = obj {
                fd.set(font_name.clone(), Object::Reference(font_id));
            }
        } else if let Some(rid) = resources_id {
            // Resources is indirect, Font is inline or absent inside it
            let obj = doc.get_object_mut(rid)?;
            if let Object::Dictionary(res_dict) = obj {
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
        } else {
            // Resources is inline (or absent) on the page — update the page dict directly
            let page = doc.get_object_mut(*page_id)?;
            if let Object::Dictionary(dict) = page {
                match dict.get_mut(b"Resources") {
                    Ok(Object::Dictionary(res_dict)) => {
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
                    _ => {
                        let mut fd = Dictionary::new();
                        fd.set(font_name.clone(), Object::Reference(font_id));
                        let mut res_dict = Dictionary::new();
                        res_dict.set("Font", Object::Dictionary(fd));
                        dict.set("Resources", Object::Dictionary(res_dict));
                    }
                }
            }
        }

        // --- Prepend content stream to page ---
        // Prepending ensures our stream runs in the clean initial graphics state
        // (origin at bottom-left, Y increasing upward). Appending would inherit
        // any CTM mutations left by the existing streams (e.g. Y-flip transforms
        // common in word-processor-generated PDFs), inverting our coordinates.
        let page = doc.get_object_mut(*page_id)?;
        if let Object::Dictionary(dict) = page {
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

    let out = output.unwrap_or_else(|| temp_output_path(&path, "numbered"));
    doc.save(&out)?;
    Ok(out)
}

/// Remove page-number overlay streams previously added by `add_page_numbers`.
/// Streams are identified by the `PageNumOverlay` tag written into their dict.
#[tauri::command]
pub fn remove_page_numbers(
    path: String,
    output: Option<String>,
) -> AppResult<String> {
    let mut doc = Document::load(&path)?;

    let page_ids: Vec<(u32, (u32, u16))> = doc.get_pages().into_iter().collect();

    // First pass: collect which stream IDs to drop per page (immutable borrows only).
    let mut removals: Vec<((u32, u16), Vec<(u32, u16)>)> = Vec::new();

    for (_page_num, page_id) in &page_ids {
        let page = doc.get_object(*page_id)?;
        let stream_refs: Vec<(u32, u16)> = if let Object::Dictionary(dict) = page {
            match dict.get(b"Contents") {
                Ok(Object::Array(arr)) => arr.iter()
                    .filter_map(|o| if let Object::Reference(id) = o { Some(*id) } else { None })
                    .collect(),
                Ok(Object::Reference(id)) => vec![*id],
                _ => vec![],
            }
        } else {
            vec![]
        };

        let mut to_remove = Vec::new();
        for sid in stream_refs {
            if let Ok(Object::Stream(s)) = doc.get_object(sid) {
                if s.dict.get(b"PageNumOverlay").is_ok() {
                    to_remove.push(sid);
                }
            }
        }
        if !to_remove.is_empty() {
            removals.push((*page_id, to_remove));
        }
    }

    // Second pass: mutate Contents arrays to drop the tagged streams.
    for (page_id, remove_ids) in removals {
        let page = doc.get_object_mut(page_id)?;
        if let Object::Dictionary(dict) = page {
            match dict.get_mut(b"Contents") {
                Ok(Object::Array(arr)) => {
                    arr.retain(|o| {
                        if let Object::Reference(id) = o {
                            !remove_ids.contains(id)
                        } else {
                            true
                        }
                    });
                }
                Ok(Object::Reference(r)) if remove_ids.contains(r) => {
                    dict.remove(b"Contents");
                }
                _ => {}
            }
        }
    }

    let out = output.unwrap_or_else(|| temp_output_path(&path, "unnumbered"));
    doc.save(&out)?;
    Ok(out)
}
