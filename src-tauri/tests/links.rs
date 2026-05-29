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
