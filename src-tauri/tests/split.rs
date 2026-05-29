//! Splitting: by ranges, per page, and by bookmarks.

mod common;

use common::{fixture_str, page_count, temp_dir};
use qyra_lib::commands::split::{split_pdf, split_pdf_by_bookmarks, split_pdf_per_page, PageRange};

#[tokio::test]
async fn split_by_ranges_produces_one_file_per_range() {
    let src = fixture_str("multipage.pdf");
    let d = temp_dir();
    let dir = d.path().to_string_lossy().into_owned();

    let parts = split_pdf(
        src,
        vec![PageRange { start: 1, end: 2 }, PageRange { start: 3, end: 5 }],
        Some(dir),
    )
    .expect("split");

    assert_eq!(parts.len(), 2);
    assert_eq!(page_count(&parts[0]), 2);
    assert_eq!(page_count(&parts[1]), 3);
}

#[tokio::test]
async fn split_per_page_yields_one_file_per_page() {
    let src = fixture_str("multipage.pdf");
    let d = temp_dir();
    let dir = d.path().to_string_lossy().into_owned();

    let parts = split_pdf_per_page(src, Some(dir)).expect("split per page");

    assert_eq!(parts.len(), 5);
    assert_eq!(page_count(&parts[0]), 1);
}

#[tokio::test]
async fn split_by_bookmarks_splits_at_each_top_level_entry() {
    let src = fixture_str("outline.pdf");
    let d = temp_dir();
    let dir = d.path().to_string_lossy().into_owned();

    let parts = split_pdf_by_bookmarks(src, Some(dir)).expect("split by bookmarks");

    // outline.pdf has three top-level bookmarks (Chapter 1/2/3) at pages 1,2,3.
    assert_eq!(parts.len(), 3);
}
