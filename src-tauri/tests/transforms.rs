//! Content-mutating commands: flatten, fill form, remove page numbers, redact,
//! export form data.

mod common;

use common::{fixture_str, load_lopdf, page_count, temp_output};
use qyra_lib::commands::flatten::flatten_pdf;
use qyra_lib::commands::form_data::export_form_xfdf;
use qyra_lib::commands::forms::{fill_form, get_form_fields, FieldValue};
use qyra_lib::commands::page_numbers::remove_page_numbers;
use qyra_lib::commands::redact::{redact_pdf, RedactRegion};

#[tokio::test]
async fn flatten_strips_acroform() {
    let src = fixture_str("acroform.pdf");
    let (_d, out) = temp_output("flat.pdf");

    flatten_pdf(src, Some(out.clone())).await.expect("flatten");

    assert_eq!(page_count(&out), 1);
    let doc = load_lopdf(&out);
    let cat = doc.catalog().expect("catalog");
    assert!(cat.get(b"AcroForm").is_err(), "AcroForm should be removed");
}

#[tokio::test]
async fn fill_form_writes_field_value() {
    let src = fixture_str("acroform.pdf");
    let (_d, out) = temp_output("filled.pdf");

    fill_form(
        src,
        vec![FieldValue { name: "full_name".into(), value: "Jane Doe".into() }],
        false,
        Some(out.clone()),
    )
    .await
    .expect("fill");

    let fields = get_form_fields(out).await.expect("fields");
    let field = fields.iter().find(|f| f.name == "full_name").expect("full_name field");
    assert_eq!(field.value, "Jane Doe");
}

#[tokio::test]
async fn remove_page_numbers_is_a_safe_noop_when_absent() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("nonum.pdf");

    remove_page_numbers(src, Some(out.clone())).expect("remove page numbers");
    assert_eq!(page_count(&out), 5);
}

#[tokio::test]
async fn redact_full_page_produces_valid_pdf() {
    let src = fixture_str("text.pdf");
    let (_d, out) = temp_output("redacted.pdf");

    redact_pdf(
        src,
        vec![RedactRegion { page: 1, x0: 0.0, y0: 0.0, x1: 612.0, y1: 792.0 }],
        Some(out.clone()),
    )
    .await
    .expect("redact");

    assert_eq!(page_count(&out), 1);
}

#[tokio::test]
async fn export_form_xfdf_contains_field_name() {
    let src = fixture_str("acroform.pdf");
    let (_d, out) = temp_output("form.xfdf");

    export_form_xfdf(src, Some(out.clone())).await.expect("export xfdf");

    let xml = std::fs::read_to_string(&out).expect("read xfdf");
    assert!(xml.contains("full_name"), "xfdf should reference the field, got: {xml}");
}

#[tokio::test]
async fn redact_on_a_page_with_annotations_does_not_crash() {
    // mupdf-rs 0.6 hands out annotations without taking a reference; dropping
    // them double-frees. Run a few times: a use-after-free does not always
    // fault on the first pass.
    for _ in 0..5 {
        let (_d, out) = temp_output("redacted-annots.pdf");
        redact_pdf(
            fixture_str("annotated.pdf"),
            vec![RedactRegion { page: 1, x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0 }],
            Some(out.clone()),
        )
        .await
        .expect("redact");
        assert_eq!(page_count(&out), 1);
    }
}
