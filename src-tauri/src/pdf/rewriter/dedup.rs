//! Object deduplication: collapse byte-identical objects into one and remap
//! every reference to the survivor. Byte-identical `PdfObject`s are fully
//! interchangeable (same type, content, and outgoing references), so merging
//! is always safe — repeated images, fonts, and resources are the big win.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::pdf::types::{ObjectId, PdfObject};
use crate::pdf::writer::serialize::write_object_body;

fn serialize(obj: &PdfObject) -> Vec<u8> {
    let mut b = Vec::new();
    // Serialization is infallible for in-memory objects.
    let _ = write_object_body(&mut b, obj);
    b
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Rewrite every reference inside `obj` according to `remap` (in place).
pub fn remap_refs(obj: &mut PdfObject, remap: &HashMap<ObjectId, ObjectId>) {
    match obj {
        PdfObject::Reference(id) => {
            if let Some(&canonical) = remap.get(id) {
                *id = canonical;
            }
        }
        PdfObject::Array(arr) => {
            for o in arr.iter_mut() {
                remap_refs(o, remap);
            }
        }
        PdfObject::Dictionary(d) => {
            for (_, v) in d.0.iter_mut() {
                remap_refs(v, remap);
            }
        }
        PdfObject::Stream(s) => {
            for (_, v) in s.dict.0.iter_mut() {
                remap_refs(v, remap);
            }
        }
        _ => {}
    }
}

/// Collapse byte-identical objects. Returns the surviving objects (references
/// already remapped) and the `dup -> canonical` map. The caller must also apply
/// `remap_refs` to the trailer.
pub fn dedup(
    mut objects: Vec<(ObjectId, PdfObject)>,
) -> (Vec<(ObjectId, PdfObject)>, HashMap<ObjectId, ObjectId>) {
    // Deterministic canonical = lowest object number.
    objects.sort_by_key(|(id, _)| *id);

    // hash -> canonical (index, serialized bytes). We retain bytes only for the
    // *canonical* of each group and drop duplicate bytes immediately, so peak
    // memory stays near the deduped size rather than ~2x the whole document.
    // Full-bytes comparison within a bucket makes hash collisions harmless.
    let mut buckets: HashMap<u64, Vec<(usize, Vec<u8>)>> = HashMap::new();
    let mut remap: HashMap<ObjectId, ObjectId> = HashMap::new();
    let mut keep = vec![true; objects.len()];

    for i in 0..objects.len() {
        // Skip serialization for large stream objects — they are almost never
        // duplicates and serializing them is very expensive on object-heavy PDFs.
        if let PdfObject::Stream(ref s) = objects[i].1 {
            if s.raw_bytes.len() > 65_536 {
                continue;
            }
        }
        let bytes = serialize(&objects[i].1);
        let key = hash_bytes(&bytes);
        let bucket = buckets.entry(key).or_default();
        let mut matched = None;
        for (c, cbytes) in bucket.iter() {
            if *cbytes == bytes {
                matched = Some(*c);
                break;
            }
        }
        match matched {
            Some(c) => {
                remap.insert(objects[i].0, objects[c].0);
                keep[i] = false;
            }
            None => bucket.push((i, bytes)),
        }
    }

    if remap.is_empty() {
        return (objects, remap);
    }

    let mut out = Vec::with_capacity(objects.len() - remap.len());
    for (i, (id, mut obj)) in objects.into_iter().enumerate() {
        if !keep[i] {
            continue;
        }
        remap_refs(&mut obj, &remap);
        out.push((id, obj));
    }
    (out, remap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::types::PdfDict;

    fn dict_with(parent: u32) -> PdfObject {
        let mut d = PdfDict::new();
        d.set(b"Type", PdfObject::Name(b"Annot".to_vec()));
        d.set(b"Parent", PdfObject::Reference((parent, 0)));
        PdfObject::Dictionary(d)
    }

    #[test]
    fn merges_identical_objects_and_remaps() {
        // Objects 2 and 3 are byte-identical; references to 3 must become 2.
        let mut container = PdfDict::new();
        container.set(
            b"Kids",
            PdfObject::Array(vec![PdfObject::Reference((2, 0)), PdfObject::Reference((3, 0))]),
        );
        let objects = vec![
            ((1u32, 0u16), PdfObject::Dictionary(container)),
            ((2u32, 0u16), dict_with(1)),
            ((3u32, 0u16), dict_with(1)), // identical to 2
        ];

        let (out, remap) = dedup(objects);

        assert_eq!(out.len(), 2, "object 3 merged into object 2");
        assert_eq!(remap.get(&(3, 0)), Some(&(2, 0)));

        // The container's Kids array now references 2 twice.
        let kids = out[0].1.as_dict().unwrap().get(b"Kids").unwrap().as_array().unwrap();
        assert_eq!(kids[0].as_reference(), Some((2, 0)));
        assert_eq!(kids[1].as_reference(), Some((2, 0)));
    }

    #[test]
    fn keeps_distinct_objects() {
        let objects = vec![
            ((1u32, 0u16), PdfObject::Integer(1)),
            ((2u32, 0u16), PdfObject::Integer(2)),
        ];
        let (out, remap) = dedup(objects);
        assert_eq!(out.len(), 2);
        assert!(remap.is_empty());
    }
}
