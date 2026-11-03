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
async fn add_multiline_highlight_with_quads() {
    // Two text lines selected from the popup → one Highlight annot carrying two
    // quad groups (8 numbers each: UL, UR, LL, LR in normalized top-left).
    // Exercises the per-line appearance-stream path.
    let src = fixture_str("simple.pdf");
    let (_d, out) = temp_output("highlighted.pdf");

    add_pdf_annotation(
        src,
        NewAnnotation {
            subtype: "Highlight".into(),
            page: 1,
            rect: [0.1, 0.1, 0.6, 0.18],
            color: "#ffeb3b".into(),
            contents: None,
            quad_points: Some(vec![
                0.1, 0.10, 0.6, 0.10, 0.1, 0.14, 0.6, 0.14, // line 1
                0.1, 0.14, 0.5, 0.14, 0.1, 0.18, 0.5, 0.18, // line 2
            ]),
            author: None,
            stamp_name: None,
        },
        Some(out.clone()),
    )
    .await
    .expect("add highlight");

    let annots = get_page_annotations(out, 1).await.expect("read annotations");
    let hl = annots.iter().find(|a| a.subtype == "Highlight").expect("highlight present");
    assert!(
        hl.quad_points.as_ref().map_or(0, |q| q.len()) >= 16,
        "expected two quad groups (16 numbers), got {:?}",
        hl.quad_points,
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

#[tokio::test]
async fn adding_an_annotation_keeps_annotations_behind_an_indirect_annots() {
    let mut doc = common::load_lopdf(&fixture_str("annotated.pdf"));
    let pid = doc.get_pages()[&1];
    let arr = doc.get_dictionary(pid).unwrap().get(b"Annots").unwrap().clone();
    let before = arr.as_array().unwrap().len();
    let arr_id = doc.add_object(arr);
    doc.get_dictionary_mut(pid).unwrap().set("Annots", lopdf::Object::Reference(arr_id));
    let (_d, src) = temp_output("indirect-annots.pdf");
    doc.save(&src).unwrap();

    let (_d2, out) = temp_output("annotated2.pdf");
    add_pdf_annotation(
        src,
        NewAnnotation {
            subtype: "Square".into(), page: 1, rect: [100.0, 100.0, 200.0, 200.0], color: "#ff0000".into(),
            contents: None, quad_points: None, author: None, stamp_name: None,
        },
        Some(out.clone()),
    )
    .await
    .expect("annotate");
    let doc = common::load_lopdf(&out);
    let pid = doc.get_pages()[&1];
    let n = match doc.get_dictionary(pid).unwrap().get(b"Annots").unwrap() {
        lopdf::Object::Array(a) => a.len(),
        lopdf::Object::Reference(r) => doc.get_object(*r).unwrap().as_array().unwrap().len(),
        _ => 0,
    };
    assert_eq!(n, before + 1, "existing annotations were dropped");
}

#[tokio::test]
async fn highlight_on_rotated_page_reads_back_where_it_was_drawn() {
    // Positions are normalised to the page as shown. On a page turned by
    // /Rotate they used to be mapped as if it were upright.
    let (_d, rotated) = temp_output("rotated.pdf");
    qyra_lib::commands::rotate::rotate_pages(fixture_str("simple.pdf"), vec![1], 90, Some(rotated.clone()))
        .expect("rotate");
    let (_d2, out) = temp_output("rotated-highlight.pdf");
    let rect = [0.1, 0.2, 0.5, 0.25];
    add_pdf_annotation(
        rotated,
        NewAnnotation {
            subtype: "Highlight".into(),
            page: 1,
            rect,
            color: "#ffeb3b".into(),
            contents: None,
            quad_points: Some(vec![0.1, 0.2, 0.5, 0.2, 0.1, 0.25, 0.5, 0.25]),
            author: None,
            stamp_name: None,
        },
        Some(out.clone()),
    )
    .await
    .expect("add highlight");

    let annots = get_page_annotations(out.clone(), 1).await.expect("read annotations");
    let hl = annots.iter().find(|a| a.subtype == "Highlight").expect("highlight");
    for (got, want) in hl.rect.iter().zip(rect) {
        assert!((got - want).abs() < 1e-3, "rect {:?} != {:?}", hl.rect, rect);
    }
    // In user space the box is turned: tall and narrow on a portrait page.
    let doc = common::load_lopdf(&out);
    let page_id = doc.get_pages()[&1];
    let annot_id = qyra_lib::utils::annots::annot_refs(&doc, page_id)[0];
    let r = doc.get_object(annot_id).unwrap().as_dict().unwrap().get(b"Rect").unwrap().as_array().unwrap().clone();
    let n = |o: &lopdf::Object| o.as_float().unwrap() as f64;
    assert!(n(&r[3]) - n(&r[1]) > n(&r[2]) - n(&r[0]), "rect {r:?} should be taller than wide");
}

#[test]
fn signature_is_drawn_over_the_page_upright() {
    use qyra_lib::commands::signatures::{stamp_images, ImageStamp};
    // A 2×1 red PNG.
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(2, 1, image::Rgba([255, 0, 0, 255]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    use base64::Engine;
    let data_url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png));
    let (_d, rotated) = temp_output("rotated.pdf");
    qyra_lib::commands::rotate::rotate_pages(fixture_str("simple.pdf"), vec![1], 90, Some(rotated.clone()))
        .expect("rotate");
    let (_d2, out) = temp_output("signed.pdf");
    stamp_images(
        rotated,
        vec![ImageStamp { page: 1, x: 0.5, y: 0.5, width: 0.2, height: 0.1, data_url }],
        Some(out.clone()),
    )
    .expect("stamp");

    let doc = common::load_lopdf(&out);
    let page_id = doc.get_pages()[&1];
    let content = String::from_utf8_lossy(&doc.get_page_content(page_id).unwrap()).to_string();
    // On a page turned 90° clockwise the image's x axis runs up user space.
    let line = content.lines().find(|l| l.contains("/QySig0 Do")).expect("signature drawn");
    let nums: Vec<f64> = line.split_whitespace().skip(1).take(6).map(|n| n.parse().unwrap()).collect();
    assert!(nums[0].abs() < 1e-6 && nums[1] > 0.0 && nums[2] < 0.0, "{line}");
    assert!(content.trim_end().ends_with("/QySig0 Do Q"), "drawn last, over the page");
}
