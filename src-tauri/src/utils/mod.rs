pub mod annots;
pub mod geometry;
pub mod paths;
pub mod progress;
pub mod thread_priority;
pub mod timing;

/// Return the effective (width, height) of a PDF page in user-space units.
///
/// Walks up the page tree to resolve an inherited MediaBox, and uses
/// `x1 - x0` / `y1 - y0` so non-zero-origin boxes (e.g. `[50 50 662 842]`)
/// are handled correctly. Falls back to A4 (595 × 842) when no MediaBox is found.
pub fn get_page_dims(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> (f64, f64) {
    let num = |o: &lopdf::Object| -> f64 {
        match o {
            lopdf::Object::Integer(i) => *i as f64,
            lopdf::Object::Real(f) => *f as f64,
            _ => 0.0,
        }
    };

    let mut cur = page_id;
    loop {
        match doc.get_object(cur) {
            Ok(lopdf::Object::Dictionary(d)) => {
                if let Ok(lopdf::Object::Array(arr)) = d.get(b"MediaBox") {
                    if arr.len() >= 4 {
                        let w = (num(&arr[2]) - num(&arr[0])).abs();
                        let h = (num(&arr[3]) - num(&arr[1])).abs();
                        if w > 0.0 && h > 0.0 {
                            return (w, h);
                        }
                    }
                }
                match d.get(b"Parent").and_then(|o| o.as_reference()) {
                    Ok(parent) => cur = parent,
                    Err(_) => break,
                }
            }
            _ => break,
        }
    }
    (595.0, 842.0)
}

/// FNV-1a 64-bit hash — fast, non-cryptographic, collision-resistant enough
/// for cache keys and filename generation within a single session.
pub fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Returns fnv1a(s) formatted as a zero-padded 16-character hex string.
pub fn fnv1a_hex(s: &str) -> String {
    format!("{:016x}", fnv1a(s))
}

/// Paint the stream `stamp_id` over the page's existing content.
///
/// The original streams are wrapped in `q` … `Q`, so whatever graphics state
/// they leave behind (a flipped CTM, a clip) is undone before the stamp, which
/// therefore draws in the page's initial coordinate system. Prepending the
/// stamp instead put it under the content, invisible on a scanned page. The two
/// wrapper streams carry `tag` like the stamp, so removing every stream tagged
/// `tag` restores the page's original Contents.
pub fn put_overlay_on_top(
    doc: &mut lopdf::Document,
    page_id: lopdf::ObjectId,
    stamp_id: lopdf::ObjectId,
    tag: &str,
) -> Result<(), lopdf::Error> {
    use lopdf::{Dictionary, Object, Stream};
    let existing: Vec<Object> = match doc.get_dictionary(page_id)?.get(b"Contents") {
        Ok(Object::Array(arr)) => arr.clone(),
        Ok(r @ Object::Reference(_)) => vec![r.clone()],
        _ => vec![],
    };
    let mut contents = Vec::with_capacity(existing.len() + 3);
    if !existing.is_empty() {
        let mut wrap = |body: &[u8]| {
            let mut d = Dictionary::new();
            d.set(tag, Object::Boolean(true));
            Object::Reference(doc.add_object(Stream::new(d, body.to_vec())))
        };
        let (open, close) = (wrap(b"q\n"), wrap(b"\nQ\n"));
        contents.push(open);
        contents.extend(existing);
        contents.push(close);
    }
    contents.push(Object::Reference(stamp_id));
    if let Object::Dictionary(dict) = doc.get_object_mut(page_id)? {
        dict.set("Contents", Object::Array(contents));
    }
    Ok(())
}

/// Give every page that inherits its /Resources from the page tree a copy of
/// its own.
///
/// Commands that add a font or image to a page's resources otherwise found
/// none on the page and created an empty /Resources there, which hides the
/// inherited fonts and images (a scan's page image disappeared). A copy rather
/// than a shared reference, so adding to one page leaves the others alone.
pub fn own_inherited_resources(doc: &mut lopdf::Document) {
    use lopdf::Object;
    for page_id in doc.get_pages().into_values() {
        let Ok(page) = doc.get_dictionary(page_id) else { continue };
        if page.has(b"Resources") {
            continue;
        }
        // Walk up /Parent (bounded: the tree may be cyclic in broken files).
        let mut node = page.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
        let mut inherited = None;
        for _ in 0..64 {
            let Some(id) = node else { break };
            let Ok(dict) = doc.get_dictionary(id) else { break };
            if let Ok(res) = dict.get(b"Resources") {
                inherited = match res {
                    Object::Reference(r) => doc.get_dictionary(*r).ok().cloned(),
                    Object::Dictionary(d) => Some(d.clone()),
                    _ => None,
                };
                break;
            }
            node = dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok());
        }
        if let (Some(res), Ok(page)) = (inherited, doc.get_dictionary_mut(page_id)) {
            page.set("Resources", Object::Dictionary(res));
        }
    }
}
