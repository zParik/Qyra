//! Garbage collection: keep only objects reachable from the trailer roots
//! (`/Root`, and any other trailer references). Unreachable objects — orphaned
//! fonts, dead images, superseded revision/form data — are dropped. Reachable
//! means used, so this is always safe.

use std::collections::{HashMap, HashSet};

use crate::pdf::types::{ObjectId, PdfDict, PdfObject};

/// Push every direct reference inside `obj` onto `out`.
fn push_refs(obj: &PdfObject, out: &mut Vec<ObjectId>) {
    match obj {
        PdfObject::Reference(id) => out.push(*id),
        PdfObject::Array(a) => {
            for o in a {
                push_refs(o, out);
            }
        }
        PdfObject::Dictionary(d) => {
            for (_, v) in d.iter() {
                push_refs(v, out);
            }
        }
        PdfObject::Stream(s) => {
            for (_, v) in s.dict.iter() {
                push_refs(v, out);
            }
        }
        _ => {}
    }
}

/// Compute the set of object ids reachable from the trailer.
pub fn collect_reachable(
    objects: &[(ObjectId, PdfObject)],
    trailer: &PdfDict,
) -> HashSet<ObjectId> {
    let map: HashMap<ObjectId, &PdfObject> = objects.iter().map(|(id, o)| (*id, o)).collect();
    let mut reachable: HashSet<ObjectId> = HashSet::new();
    let mut stack: Vec<ObjectId> = Vec::new();

    for (_, v) in trailer.iter() {
        push_refs(v, &mut stack);
    }
    while let Some(id) = stack.pop() {
        if !reachable.insert(id) {
            continue;
        }
        if let Some(o) = map.get(&id) {
            push_refs(o, &mut stack);
        }
    }
    reachable
}

/// Drop objects not reachable from the trailer. If nothing is reachable (e.g. a
/// trailer with no `/Root`), returns the input unchanged as a safety guard.
pub fn gc(
    objects: Vec<(ObjectId, PdfObject)>,
    trailer: &PdfDict,
) -> Vec<(ObjectId, PdfObject)> {
    let reachable = collect_reachable(&objects, trailer);
    if reachable.is_empty() {
        return objects;
    }
    objects
        .into_iter()
        .filter(|(id, _)| reachable.contains(id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict(pairs: &[(&[u8], PdfObject)]) -> PdfObject {
        let mut d = PdfDict::new();
        for (k, v) in pairs {
            d.set(*k, v.clone());
        }
        PdfObject::Dictionary(d)
    }

    #[test]
    fn drops_unreachable_objects() {
        // 1 Catalog -> 2 Pages -> 3 Page; object 4 is orphaned.
        let objects = vec![
            ((1u32, 0u16), dict(&[(b"Pages", PdfObject::Reference((2, 0)))])),
            (
                (2u32, 0u16),
                dict(&[(b"Kids", PdfObject::Array(vec![PdfObject::Reference((3, 0))]))]),
            ),
            ((3u32, 0u16), dict(&[(b"Type", PdfObject::Name(b"Page".to_vec()))])),
            ((4u32, 0u16), dict(&[(b"Junk", PdfObject::Integer(1))])),
        ];
        let mut trailer = PdfDict::new();
        trailer.set(b"Root", PdfObject::Reference((1, 0)));

        let kept = gc(objects, &trailer);
        let ids: Vec<u32> = kept.iter().map(|(id, _)| id.0).collect();
        assert_eq!(ids, vec![1, 2, 3], "object 4 (orphan) dropped");
    }

    #[test]
    fn keeps_all_when_no_root() {
        let objects = vec![((1u32, 0u16), PdfObject::Integer(1))];
        let trailer = PdfDict::new();
        assert_eq!(gc(objects, &trailer).len(), 1);
    }
}
