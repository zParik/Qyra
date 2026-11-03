//! Remaining standalone commands: anonymize, repair, images→PDF, remove Bates
//! numbers.

mod common;

use common::{fixture_str, page_count, temp_output};
use qyra_lib::commands::anonymize::{anonymize_pdf, AnonymizeOptions};
use qyra_lib::commands::bates::remove_bates_numbers;
use qyra_lib::commands::create::images_to_pdf;
use qyra_lib::commands::repair::repair_pdf;

#[tokio::test]
async fn anonymize_strips_info_and_keeps_pages() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("anon.pdf");

    let report = anonymize_pdf(
        src,
        AnonymizeOptions { strip_info: true, ..Default::default() },
        Some(out.clone()),
    )
    .expect("anonymize");

    assert_eq!(report.output, out);
    assert_eq!(page_count(&out), 5);
}

#[tokio::test]
async fn repair_reports_page_count() {
    let (_d, out) = temp_output("repaired.pdf");
    let report = repair_pdf(fixture_str("multipage.pdf"), None, Some(out.clone()))
        .await
        .expect("repair");
    assert_eq!(report.page_count, 5);
    assert_eq!(page_count(&out), 5);
}

#[tokio::test]
async fn images_to_pdf_makes_a_one_page_document() {
    let png = fixture_str("sample.png");
    let (_d, out) = temp_output("fromimg.pdf");

    images_to_pdf(vec![png], Some(out.clone())).expect("images to pdf");
    assert_eq!(page_count(&out), 1);
}

#[tokio::test]
async fn remove_bates_is_a_safe_noop_when_absent() {
    let (_d, out) = temp_output("nobates.pdf");
    remove_bates_numbers(fixture_str("multipage.pdf"), Some(out.clone()))
        .expect("remove bates");
    assert_eq!(page_count(&out), 5);
}
