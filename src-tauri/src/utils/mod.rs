pub mod paths;
pub mod progress;
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
