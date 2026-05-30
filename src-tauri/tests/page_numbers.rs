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
