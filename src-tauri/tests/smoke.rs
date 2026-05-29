//! P0 harness smoke: prove the integration test crate can drive the real
//! commands against the generated fixtures and assert on PDF structure.

mod common;

use common::{fixture_str, page_count, page_text};
use qyra_lib::commands::page_count::{get_file_size, get_page_count};

#[tokio::test]
async fn multipage_reports_five_pages() {
    let path = fixture_str("multipage.pdf");

    // Through the command (as the IPC layer calls it)…
    let via_command = get_page_count(path.clone()).await.expect("page count");
    // …and through the mupdf assertion helper.
    let via_helper = page_count(&path);

    assert_eq!(via_command, 5, "multipage.pdf should have 5 pages");
    assert_eq!(via_command, via_helper);
}

#[tokio::test]
async fn simple_has_nonzero_size() {
    let path = fixture_str("simple.pdf");
    let size = get_file_size(path).await.expect("file size");
    assert!(size > 0, "simple.pdf should be non-empty");
}

#[tokio::test]
async fn text_fixture_contains_known_string() {
    let path = fixture_str("text.pdf");
    let text = page_text(&path, 0);
    assert!(
        text.contains("Hello World"),
        "expected extractable text, got: {text:?}",
    );
}
