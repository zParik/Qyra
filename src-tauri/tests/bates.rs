//! Bates numbering via the pure `bates_core` (add). Removal is covered in misc.rs.

mod common;

use common::{fixture_str, page_count, page_text, temp_output};
use qyra_lib::commands::bates::{bates_core, BatesOptions};

#[test]
fn stamps_sequential_bates_labels() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("bates.pdf");

    let opts = BatesOptions { prefix: "DOC".into(), digits: 4, ..Default::default() };
    let report = bates_core(src, Some(opts), Some(out.clone()), |_| {}).expect("bates");

    assert_eq!(report.page_count, 5);
    assert_eq!(report.first_label, "DOC0001");
    assert_eq!(report.last_label, "DOC0005");
    assert!(page_text(&out, 0).contains("DOC0001"), "first label should be stamped");
}
