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

#[tokio::test]
async fn each_single_page_file_holds_only_its_own_page() {
    let src = fixture_str("multipage.pdf");
    let d = temp_dir();
    let parts = split_pdf_per_page(src, Some(d.path().to_string_lossy().into_owned())).expect("split per page");
    for (i, part) in parts.iter().enumerate() {
        let doc = common::load_lopdf(part);
        // Every page's caption is "Page K"; only this file's own may be in it.
        let all_content: Vec<u8> = doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .flat_map(|s| s.decompressed_content().unwrap_or_else(|_| s.content.clone()))
            .collect();
        let text = String::from_utf8_lossy(&all_content);
        for k in 1..=parts.len() {
            let has = text.contains(&format!("(Page {k})"));
            assert_eq!(has, k == i + 1, "file {} contains page {k}: {has}", i + 1);
        }
    }
}
