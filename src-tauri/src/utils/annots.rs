//! A page's /Annots array, which may be inline (`/Annots [..]`) or its own
//! object (`/Annots 12 0 R`, as Acrobat and incremental saves write it).
//! Treating the indirect form as missing replaced it and dropped every
//! existing annotation on the page.

use lopdf::{Document, Object, ObjectId};

/// Where the page's annotation array lives, if it has one.
enum Annots {
    Inline,
    Indirect(ObjectId),
    Missing,
}

fn locate(doc: &Document, page_id: ObjectId) -> Annots {
    match doc.get_dictionary(page_id).ok().and_then(|d| d.get(b"Annots").ok()) {
        Some(Object::Array(_)) => Annots::Inline,
        Some(Object::Reference(r)) if matches!(doc.get_object(*r), Ok(Object::Array(_))) => Annots::Indirect(*r),
        _ => Annots::Missing,
    }
}

/// The page's annotation references, in order.
pub fn annot_refs(doc: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    let arr = match locate(doc, page_id) {
        Annots::Inline => doc.get_dictionary(page_id).ok().and_then(|d| d.get(b"Annots").ok()),
        Annots::Indirect(id) => doc.get_object(id).ok(),
        Annots::Missing => None,
    };
    match arr {
        Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
        _ => vec![],
    }
}

/// Mutable access to the page's annotation array, creating an inline one if
/// it has none.
fn annots_mut(doc: &mut Document, page_id: ObjectId) -> lopdf::Result<&mut Vec<Object>> {
    match locate(doc, page_id) {
        Annots::Indirect(id) => doc.get_object_mut(id)?.as_array_mut(),
        Annots::Inline => doc.get_dictionary_mut(page_id)?.get_mut(b"Annots")?.as_array_mut(),
        Annots::Missing => {
            let page = doc.get_dictionary_mut(page_id)?;
            page.set("Annots", Object::Array(vec![]));
            page.get_mut(b"Annots")?.as_array_mut()
        }
    }
}

/// Append an annotation reference to the page.
pub fn push_annot_ref(doc: &mut Document, page_id: ObjectId, annot_id: ObjectId) -> lopdf::Result<()> {
    annots_mut(doc, page_id)?.push(Object::Reference(annot_id));
    Ok(())
}

/// Remove an annotation reference from the page.
pub fn remove_annot_ref(doc: &mut Document, page_id: ObjectId, annot_id: ObjectId) -> lopdf::Result<()> {
    if matches!(locate(doc, page_id), Annots::Missing) {
        return Ok(());
    }
    annots_mut(doc, page_id)?.retain(|o| o.as_reference().ok() != Some(annot_id));
    Ok(())
}
