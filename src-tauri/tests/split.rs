//! Splitting: by ranges, per page, and by bookmarks.

mod common;

use common::{fixture_str, page_count, page_text, temp_dir};
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

/// Number of `/Type /Page` objects physically stored in the file, counted from
/// the raw object map rather than by walking the page tree.
///
/// This is the distinction that matters here: a split output can advertise one
/// page in its tree while still storing every other page's dictionary, content
/// stream, fonts and images. Those objects are unreachable, so `page_count`
/// (and any PDF viewer) reports 1 either way — but the bytes are still on disk.
fn stored_page_objects(path: &str) -> usize {
    let doc = lopdf::Document::load(path).expect("load split output");
    doc.objects
        .values()
        .filter(|obj| {
            obj.as_dict()
                .ok()
                .and_then(|d| d.get(b"Type").ok())
                .and_then(|t| t.as_name().ok())
                .is_some_and(|n| n == b"Page")
        })
        .count()
}

/// Number of stream objects physically stored in the file.
///
/// `delete_pages` removes the page dictionaries but not the content streams they
/// referenced, so the excluded pages' bytes ride along invisibly. Counting page
/// dictionaries cannot see that; counting streams can.
fn stored_stream_objects(path: &str) -> usize {
    let doc = lopdf::Document::load(path).expect("load split output");
    doc.objects
        .values()
        .filter(|obj| matches!(obj, lopdf::Object::Stream(_)))
        .count()
}

fn file_len(path: &str) -> u64 {
    std::fs::metadata(path).expect("stat split output").len()
}

#[tokio::test]
async fn split_per_page_does_not_carry_the_other_pages() {
    let src = fixture_str("multipage.pdf");
    let d = temp_dir();
    let dir = d.path().to_string_lossy().into_owned();

    let parts = split_pdf_per_page(src.clone(), Some(dir)).expect("split per page");
    assert_eq!(parts.len(), 5);

    let src_len = file_len(&src);
    let mut total = 0;
    for (i, part) in parts.iter().enumerate() {
        assert_eq!(page_count(part), 1, "part {i} should hold one page");
        assert_eq!(
            stored_page_objects(part),
            1,
            "part {i} still stores the other pages' objects — the whole source was copied",
        );
        assert!(
            file_len(part) < src_len,
            "part {i} is not smaller than the source it came from",
        );
        total += file_len(part);
    }

    // Before pruning, every output was a full copy, so the total was ~5x the
    // source. Allow generous headroom for per-file PDF overhead on a fixture
    // this small while still failing loudly if whole-document copying returns.
    assert!(
        total < src_len * 3,
        "per-page outputs total {total} bytes from a {src_len}-byte source",
    );
}

#[tokio::test]
async fn split_per_page_keeps_each_page_intact() {
    let src = fixture_str("multipage.pdf");
    let d = temp_dir();
    let dir = d.path().to_string_lossy().into_owned();

    let parts = split_pdf_per_page(src, Some(dir)).expect("split per page");

    // Smaller output is only correct if the page's own content survived.
    for (i, part) in parts.iter().enumerate() {
        let text = page_text(part, 0);
        let expected = format!("Page {}", i + 1);
        assert!(
            text.contains(&expected),
            "part {i} lost its content: expected {expected:?}, extracted {text:?}",
        );
    }
}

#[tokio::test]
async fn split_by_ranges_does_not_carry_the_excluded_pages() {
    let src = fixture_str("multipage.pdf");
    let d = temp_dir();
    let dir = d.path().to_string_lossy().into_owned();

    let parts = split_pdf(
        src,
        vec![PageRange { start: 1, end: 2 }, PageRange { start: 3, end: 5 }],
        Some(dir),
    )
    .expect("split");

    // delete_pages() unlinks the excluded pages and drops their page dictionaries,
    // but leaves the content streams they referenced in the object map. Counting
    // pages therefore looks correct even when the whole document rode along, so
    // assert on the streams actually stored.
    assert_eq!(stored_page_objects(&parts[0]), 2);
    assert_eq!(stored_page_objects(&parts[1]), 3);
    assert_eq!(
        stored_stream_objects(&parts[0]),
        2,
        "part 1 still stores the excluded pages' content streams",
    );
    assert_eq!(
        stored_stream_objects(&parts[1]),
        3,
        "part 2 still stores the excluded pages' content streams",
    );
    assert!(page_text(&parts[0], 0).contains("Page 1"));
    assert!(page_text(&parts[1], 0).contains("Page 3"));
}
