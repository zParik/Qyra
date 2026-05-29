//! Page-structure commands: rotate, remove, reorder, crop.

mod common;

use common::{fixture_str, load_lopdf, page_count, page_text, temp_output};
use qyra_lib::commands::crop::crop_pages;
use qyra_lib::commands::remove::remove_pages;
use qyra_lib::commands::reorder::reorder_pages;
use qyra_lib::commands::rotate::rotate_pages;

#[tokio::test]
async fn rotate_sets_rotate_entry_and_keeps_pages() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("rotated.pdf");

    rotate_pages(src, vec![1], 90, Some(out.clone())).expect("rotate");

    assert_eq!(page_count(&out), 5, "rotate must preserve page count");

    // Page 1 should now carry /Rotate 90.
    let doc = load_lopdf(&out);
    let page1 = *doc.get_pages().get(&1).expect("page 1 exists");
    let dict = doc.get_object(page1).unwrap().as_dict().unwrap();
    let rotate = dict.get(b"Rotate").and_then(|o| o.as_i64()).unwrap_or(0);
    assert_eq!(rotate, 90);
}

#[tokio::test]
async fn rotate_rejects_invalid_degrees() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("rotated.pdf");
    assert!(rotate_pages(src, vec![1], 45, Some(out)).is_err());
}

#[tokio::test]
async fn remove_drops_requested_pages() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("removed.pdf");

    remove_pages(src, vec![2, 4], Some(out.clone())).expect("remove");

    assert_eq!(page_count(&out), 3, "removing 2 of 5 pages leaves 3");
    // Remaining pages were 1,3,5 → text order preserved.
    assert!(page_text(&out, 0).contains("Page 1"));
    assert!(page_text(&out, 1).contains("Page 3"));
    assert!(page_text(&out, 2).contains("Page 5"));
}

#[tokio::test]
async fn reorder_reverses_pages() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("reordered.pdf");

    reorder_pages(src, vec![5, 4, 3, 2, 1], Some(out.clone())).expect("reorder");

    assert_eq!(page_count(&out), 5);
    assert!(page_text(&out, 0).contains("Page 5"), "first page should be old page 5");
    assert!(page_text(&out, 4).contains("Page 1"), "last page should be old page 1");
}

#[tokio::test]
async fn reorder_rejects_wrong_length() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("reordered.pdf");
    assert!(reorder_pages(src, vec![1, 2, 3], Some(out)).is_err());
}

#[tokio::test]
async fn crop_succeeds_and_preserves_page_count() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("cropped.pdf");

    crop_pages(src, vec![1], [0.0, 0.0, 300.0, 300.0], Some(out.clone()))
        .await
        .expect("crop");

    assert_eq!(page_count(&out), 5);
}
