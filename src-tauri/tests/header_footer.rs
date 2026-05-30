//! Header/footer stamping via the pure `header_footer_core`.

mod common;

use common::{fixture_str, page_count, page_text, temp_output};
use qyra_lib::commands::header_footer::{header_footer_core, HeaderFooterOptions, HeaderFooterZones};

#[test]
fn stamps_a_footer_on_every_page() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("hf.pdf");

    let opts = HeaderFooterOptions {
        zones: HeaderFooterZones { footer_center: "CONFIDENTIAL".into(), ..Default::default() },
        ..Default::default()
    };

    let report = header_footer_core(src, opts, Some(out.clone()), |_| {}).expect("header/footer");

    assert_eq!(report.pages_stamped, 5);
    assert_eq!(page_count(&out), 5);
    assert!(page_text(&out, 0).contains("CONFIDENTIAL"), "footer text should be stamped");
}
