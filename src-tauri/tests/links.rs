//! Link annotations: add a URI link, then remove it.

mod common;

use common::{fixture_str, load_lopdf, temp_output};
use lopdf::Object;
use qyra_lib::commands::links::{add_link, remove_link, LinkInput};

/// Count /Link annotations on a 1-indexed page.
fn link_count(path: &str, page: u32) -> usize {
    let doc = load_lopdf(path);
    let Some(&pid) = doc.get_pages().get(&page) else { return 0 };
    let Ok(pdict) = doc.get_object(pid).and_then(|o| o.as_dict()) else { return 0 };
    let refs: Vec<lopdf::ObjectId> = match pdict.get(b"Annots") {
        Ok(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
        Ok(Object::Reference(r)) => vec![*r],
        _ => vec![],
    };
    refs.iter()
        .filter(|id| {
            matches!(
                doc.get_object(**id),
                Ok(Object::Dictionary(d)) if matches!(
                    d.get(b"Subtype"), Ok(Object::Name(n)) if n.as_slice() == b"Link"
                )
            )
        })
        .count()
}

#[tokio::test]
async fn add_then_remove_uri_link() {
    let src = fixture_str("simple.pdf");
    let (_d1, with_link) = temp_output("linked.pdf");
    let (_d2, without) = temp_output("unlinked.pdf");

    add_link(
        src,
        LinkInput {
            page: 1,
            x0: 0.1,
            y0: 0.1,
            x1: 0.5,
            y1: 0.2,
            uri: Some("https://example.com/".into()),
            dest_page: None,
        },
        Some(with_link.clone()),
    )
    .await
    .expect("add_link");
    assert_eq!(link_count(&with_link, 1), 1, "one link should be present");

    remove_link(with_link, 1, 0, Some(without.clone())).await.expect("remove_link");
    assert_eq!(link_count(&without, 1), 0, "link should be gone");
}

#[tokio::test]
async fn add_link_requires_a_target() {
    let src = fixture_str("simple.pdf");
    let (_d, out) = temp_output("linked.pdf");
    let result = add_link(
        src,
        LinkInput { page: 1, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2, uri: None, dest_page: None },
        Some(out),
    )
    .await;
    assert!(result.is_err());
}

/// annotated.pdf with page 1's /Annots moved into its own object (as Acrobat
/// and incremental saves write it): `/Annots 12 0 R`.
fn with_indirect_annots() -> (tempfile::TempDir, String) {
    let mut doc = load_lopdf(&fixture_str("annotated.pdf"));
    let pid = doc.get_pages()[&1];
    let arr = doc.get_dictionary(pid).unwrap().get(b"Annots").unwrap().clone();
    let arr_id = doc.add_object(arr);
    doc.get_dictionary_mut(pid).unwrap().set("Annots", Object::Reference(arr_id));
    let (d, p) = temp_output("indirect-annots.pdf");
    doc.save(&p).unwrap();
    (d, p)
}

/// All annotation refs on page 1, following an indirect /Annots.
fn annot_count(path: &str) -> usize {
    let doc = load_lopdf(path);
    let pid = doc.get_pages()[&1];
    match doc.get_dictionary(pid).unwrap().get(b"Annots") {
        Ok(Object::Array(a)) => a.len(),
        Ok(Object::Reference(r)) => doc.get_object(*r).unwrap().as_array().unwrap().len(),
        _ => 0,
    }
}

#[tokio::test]
async fn adding_and_removing_a_link_keeps_annotations_behind_an_indirect_annots() {
    let (_d, src) = with_indirect_annots();
    let before = annot_count(&src);
    let (_d2, out) = temp_output("linked.pdf");
    add_link(
        src,
        LinkInput { page: 1, x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.2, uri: Some("https://example.com/".into()), dest_page: None },
        Some(out.clone()),
    )
    .await
    .expect("add link");
    assert_eq!(annot_count(&out), before + 1, "existing annotations were dropped");

    let (_d3, back) = temp_output("unlinked.pdf");
    remove_link(out, 1, 0, Some(back.clone())).await.expect("remove link");
    assert_eq!(annot_count(&back), before);
}
