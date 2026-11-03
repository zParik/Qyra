//! Page numbering via the pure `add_page_numbers_core`. Removal is covered in
//! transforms.rs.

mod common;

use common::{fixture_str, page_count, page_text, temp_output};
use qyra_lib::commands::page_numbers::{add_page_numbers_core, PageNumberOptions};

#[test]
fn stamps_page_numbers_starting_at_offset() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("numbered.pdf");

    let opts = PageNumberOptions {
        start_at: Some(100),
        position: Some("bottom-center".into()),
        font_size: Some(12.0),
        margin: Some(20.0),
    };

    add_page_numbers_core(src, Some(opts), Some(out.clone()), |_| {}).expect("page numbers");

    assert_eq!(page_count(&out), 5);
    // First page is numbered 100 (distinct from the fixture's own "Page 1" text).
    assert!(page_text(&out, 0).contains("100"), "page number should be stamped");
}

/// Contents of page 1 as (stream id, has `tag`) in paint order.
fn contents_tags(path: &str, tag: &[u8]) -> Vec<bool> {
    let doc = common::load_lopdf(path);
    let page = doc.get_pages()[&1];
    let ids: Vec<lopdf::ObjectId> = match doc.get_dictionary(page).unwrap().get(b"Contents").unwrap() {
        lopdf::Object::Array(a) => a.iter().map(|o| o.as_reference().unwrap()).collect(),
        lopdf::Object::Reference(r) => vec![*r],
        _ => vec![],
    };
    ids.iter().map(|id| doc.get_object(*id).unwrap().as_stream().unwrap().dict.get(tag).is_ok()).collect()
}

#[test]
fn page_numbers_paint_over_a_full_page_scan() {
    let (_d, out) = temp_output("numbered-scan.pdf");
    add_page_numbers_core(fixture_str("scanned.pdf"), None, Some(out.clone()), |_| {}).expect("number");
    let tags = contents_tags(&out, b"PageNumOverlay");
    // The scan's own content must come before the stamp, or the image hides it.
    let first_original = tags.iter().position(|t| !t).expect("original content kept");
    let last_stamp = tags.iter().rposition(|t| *t).expect("stamp added");
    assert!(last_stamp > first_original, "stamp painted under the page: {tags:?}");
}

#[test]
fn removing_page_numbers_restores_the_original_contents() {
    let (_d, out) = temp_output("numbered-scan.pdf");
    let (_d2, back) = temp_output("unnumbered-scan.pdf");
    add_page_numbers_core(fixture_str("scanned.pdf"), None, Some(out.clone()), |_| {}).expect("number");
    qyra_lib::commands::page_numbers::remove_page_numbers(out, Some(back.clone())).expect("remove");
    assert_eq!(contents_tags(&back, b"PageNumOverlay"), contents_tags(&fixture_str("scanned.pdf"), b"PageNumOverlay"));
}
