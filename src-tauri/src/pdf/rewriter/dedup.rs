//! Stream deduplication: collapse byte-identical stream objects into one and
//! remap every reference to the survivor. Identical streams are interchangeable
//! (same data and outgoing references) — repeated images and fonts are the big
//! win. Non-stream objects are never merged; see `dedup`.

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
        // Only streams (images, fonts, content) are merged. Non-stream objects
        // can carry identity even when byte-identical — two blank pages, two
        // identical link annotations, two OCG layers — and merging them breaks
        // /Kids, /Annots and optional content. Large streams are skipped too:
        // they are almost never duplicates and serializing them is expensive.
        match &objects[i].1 {
            PdfObject::Stream(s) if s.raw_bytes.len() <= 65_536 => {}
            _ => continue,
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
    use crate::pdf::types::{PdfDict, PdfStream};

    fn dict_with(parent: u32) -> PdfObject {
        let mut d = PdfDict::new();
        d.set(b"Type", PdfObject::Name(b"Annot".to_vec()));
        d.set(b"Parent", PdfObject::Reference((parent, 0)));
        PdfObject::Dictionary(d)
    }

    fn image_stream() -> PdfObject {
        let mut d = PdfDict::new();
        d.set(b"Subtype", PdfObject::Name(b"Image".to_vec()));
        PdfObject::Stream(PdfStream { dict: d, raw_bytes: vec![1, 2, 3, 4] })
    }

    #[test]
    fn merges_identical_streams_and_remaps() {
        // Objects 2 and 3 are byte-identical streams; references to 3 must become 2.
        let mut container = PdfDict::new();
        container.set(
            b"XObjects",
            PdfObject::Array(vec![PdfObject::Reference((2, 0)), PdfObject::Reference((3, 0))]),
        );
        let objects = vec![
            ((1u32, 0u16), PdfObject::Dictionary(container)),
            ((2u32, 0u16), image_stream()),
            ((3u32, 0u16), image_stream()), // identical to 2
        ];

        let (out, remap) = dedup(objects);

        assert_eq!(out.len(), 2, "object 3 merged into object 2");
        assert_eq!(remap.get(&(3, 0)), Some(&(2, 0)));

        let refs = out[0].1.as_dict().unwrap().get(b"XObjects").unwrap().as_array().unwrap();
        assert_eq!(refs[0].as_reference(), Some((2, 0)));
        assert_eq!(refs[1].as_reference(), Some((2, 0)));
    }

    #[test]
    fn keeps_identical_dicts_separate() {
        // Two identical annotation (or page, or OCG) dicts are still two
        // distinct things; merging them breaks /Annots, /Kids and layers.
        let objects = vec![
            ((2u32, 0u16), dict_with(1)),
            ((3u32, 0u16), dict_with(1)),
        ];
        let (out, remap) = dedup(objects);
        assert_eq!(out.len(), 2);
        assert!(remap.is_empty());
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
