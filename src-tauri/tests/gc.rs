//! Garbage collection: an unreferenced (orphaned) object is dropped, and the
//! document still re-opens with the same page count.

mod common;

use common::{fixture_str, page_count, temp_output};
use qyra_lib::commands::compress::compress_core;

#[test]
fn orphaned_object_is_dropped() {
    let src = fixture_str("orphaned.pdf");
    let input_size = std::fs::metadata(&src).unwrap().len();

    let (_d, out) = temp_output("out.pdf");
    let report = compress_core(src, Some(out.clone()), Some(0), |_| {}).expect("compress");

    assert_eq!(page_count(&out), 1);
    // The ~3 KB orphan is gone, so the result is clearly smaller.
    assert!(
        report.compressed_bytes < input_size,
        "expected orphan to be dropped: {} >= {}",
        report.compressed_bytes,
        input_size,
    );
}
