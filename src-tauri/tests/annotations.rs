//! Standard PDF annotations: add, read back, export to CSV.

mod common;

use common::{fixture_str, temp_output};
use qyra_lib::commands::pdf_annotations::{
    add_pdf_annotation, export_annotations, get_page_annotations, NewAnnotation,
};

#[tokio::test]
async fn add_annotation_then_read_it_back() {
    let src = fixture_str("simple.pdf");
    let (_d, out) = temp_output("annotated.pdf");

    add_pdf_annotation(
        src,
        NewAnnotation {
            subtype: "Square".into(),
            page: 1,
            rect: [100.0, 100.0, 200.0, 200.0],
            color: "#ff0000".into(),
            contents: Some("box".into()),
            quad_points: None,
            author: None,
            stamp_name: None,
        },
        Some(out.clone()),
    )
    .await
    .expect("add annotation");

    let annots = get_page_annotations(out, 1).await.expect("read annotations");
    assert!(
        annots.iter().any(|a| a.subtype == "Square"),
        "expected a Square annotation, got {:?}",
        annots.iter().map(|a| &a.subtype).collect::<Vec<_>>(),
    );
}

#[tokio::test]
async fn read_existing_fixture_annotations() {
    let annots = get_page_annotations(fixture_str("annotated.pdf"), 1)
        .await
        .expect("read annotations");
    assert!(!annots.is_empty(), "annotated.pdf carries annotations");
}

#[tokio::test]
async fn export_annotations_writes_csv_rows() {
    let (_d, out) = temp_output("annots.csv");
    export_annotations(fixture_str("annotated.pdf"), Some(out.clone()))
        .await
        .expect("export annotations");

    let csv = std::fs::read_to_string(&out).expect("read csv");
    assert!(csv.contains("page,type,color,contents"), "has CSV header");
    assert!(csv.contains("Square") || csv.contains("Text"), "lists an annotation row");
}
