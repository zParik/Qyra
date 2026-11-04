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
async fn images_to_pdf_embeds_jpeg_bytes_unchanged() {
    let (dir, out) = temp_output("fromjpeg.pdf");
    let jpg = dir.path().join("photo.jpg");
    image::RgbImage::from_fn(40, 20, |x, _| image::Rgb([(x * 6) as u8, 80, 160]))
        .save(&jpg)
        .expect("write jpeg");
    let original = std::fs::read(&jpg).unwrap();

    images_to_pdf(
        vec![jpg.to_string_lossy().into_owned(), fixture_str("sample.png")],
        Some(out.clone()),
    )
    .expect("images to pdf");

    assert_eq!(page_count(&out), 2);
    let doc = lopdf::Document::load(&out).unwrap();
    let jpeg_stream = doc
        .objects
        .values()
        .filter_map(|o| o.as_stream().ok())
        .find(|s| matches!(s.dict.get(b"Filter"), Ok(lopdf::Object::Name(n)) if n == b"DCTDecode"))
        .expect("a DCTDecode image");
    assert_eq!(jpeg_stream.content, original, "JPEG must not be re-encoded");
}

#[tokio::test]
async fn remove_bates_is_a_safe_noop_when_absent() {
    let (_d, out) = temp_output("nobates.pdf");
    remove_bates_numbers(fixture_str("multipage.pdf"), Some(out.clone()))
        .expect("remove bates");
    assert_eq!(page_count(&out), 5);
}

#[tokio::test]
async fn anonymize_drops_the_stripped_xmp_stream_from_the_file() {
    let mut doc = common::load_lopdf(&fixture_str("simple.pdf"));
    let xmp = doc.add_object(lopdf::Stream::new(
        lopdf::dictionary! { "Type" => "Metadata", "Subtype" => "XML" },
        b"<x:xmpmeta><dc:creator>Secret Author</dc:creator></x:xmpmeta>".to_vec(),
    ));
    doc.catalog_mut().unwrap().set("Metadata", lopdf::Object::Reference(xmp));
    let (_d, src) = temp_output("with-xmp.pdf");
    doc.save(&src).unwrap();

    let (_d2, out) = temp_output("anon.pdf");
    anonymize_pdf(src, AnonymizeOptions { strip_xmp_metadata: true, ..Default::default() }, Some(out.clone()))
        .expect("anonymize");
    let bytes = std::fs::read(&out).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("Secret Author"), "XMP still in the file");
}
