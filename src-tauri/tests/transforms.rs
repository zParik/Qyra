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

/// A one-page form: `buyer.name` and `seller.name` text fields, an `agree`
/// checkbox whose on state is `On`, and a `size` radio group (`S`, `L`).
fn build_form(path: &str) {
    use lopdf::{dictionary, Document, Object, Stream};
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let page_id = doc.new_object_id();
    let mut annots = Vec::new();
    let mut fields = Vec::new();
    let empty_ap = |doc: &mut Document| {
        doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 10.into(), 10.into()] },
            b"0 0 10 10 re f".to_vec(),
        ))
    };

    for (i, parent) in ["buyer", "seller"].iter().enumerate() {
        let parent_id = doc.new_object_id();
        let kid = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx",
            "T" => Object::string_literal("name"), "Parent" => parent_id,
            "Rect" => vec![50.into(), (700 - 40 * i as i64).into(), 250.into(), (720 - 40 * i as i64).into()],
        });
        doc.objects.insert(parent_id, Object::Dictionary(dictionary! {
            "T" => Object::string_literal(*parent), "Kids" => vec![kid.into()],
        }));
        annots.push(kid);
        fields.push(parent_id);
    }

    let on = empty_ap(&mut doc);
    let off = empty_ap(&mut doc);
    let agree = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Btn", "T" => Object::string_literal("agree"),
        "Rect" => vec![50.into(), 600.into(), 62.into(), 612.into()], "AS" => "Off",
        "AP" => dictionary! { "N" => dictionary! { "On" => on, "Off" => off } },
    });
    annots.push(agree);
    fields.push(agree);

    let size_id = doc.new_object_id();
    let mut kids = Vec::new();
    for (i, state) in ["S", "L"].iter().enumerate() {
        let (a, b) = (empty_ap(&mut doc), empty_ap(&mut doc));
        let mut n = lopdf::Dictionary::new();
        n.set(*state, a);
        n.set("Off", b);
        let w = doc.add_object(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "Parent" => size_id, "AS" => "Off",
            "Rect" => vec![(50 + 30 * i as i64).into(), 550.into(), (62 + 30 * i as i64).into(), 562.into()],
            "AP" => dictionary! { "N" => n },
        });
        kids.push(Object::Reference(w));
        annots.push(w);
    }
    doc.objects.insert(size_id, Object::Dictionary(dictionary! {
        "FT" => "Btn", "Ff" => 1 << 15, "T" => Object::string_literal("size"), "Kids" => kids,
    }));
    fields.push(size_id);

    let content = doc.add_object(Stream::new(dictionary! {}, b"".to_vec()));
    doc.objects.insert(page_id, Object::Dictionary(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "Contents" => content,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Annots" => annots.into_iter().map(Object::Reference).collect::<Vec<_>>(),
    }));
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
        "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
    }));
    let catalog = doc.add_object(dictionary! {
        "Type" => "Catalog", "Pages" => pages_id,
        "AcroForm" => dictionary! {
            "Fields" => fields.into_iter().map(Object::Reference).collect::<Vec<_>>(),
            "DA" => Object::string_literal("/Helv 0 Tf 0 g"),
        },
    });
    doc.trailer.set("Root", catalog);
    doc.save(path).expect("save form");
}

fn field_dict<'a>(doc: &'a lopdf::Document, name: &[u8]) -> &'a lopdf::Dictionary {
    doc.objects
        .values()
        .filter_map(|o| o.as_dict().ok())
        .find(|d| d.get(b"T").ok().and_then(|t| t.as_str().ok()) == Some(name))
        .expect("field")
}

#[tokio::test]
async fn form_fields_have_full_names_states_and_top_left_rects() {
    let (_d, src) = temp_output("form.pdf");
    build_form(&src);
    let fields = get_form_fields(src).await.expect("fields");
    let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["buyer.name", "seller.name", "agree", "size", "size"]);
    let buyer = &fields[0];
    // Rect y 700..720 on a 792 pt page: near the top.
    assert!((buyer.rect[1] - 72.0 / 792.0).abs() < 1e-6, "{:?}", buyer.rect);
    assert_eq!(fields[2].on_state.as_deref(), Some("On"));
    assert_eq!(fields[3].on_state.as_deref(), Some("S"));
    assert_eq!(fields[4].on_state.as_deref(), Some("L"));
}

#[tokio::test]
async fn fill_form_sets_nested_text_checkbox_and_radio() {
    let (_d, src) = temp_output("form.pdf");
    build_form(&src);
    let (_d2, out) = temp_output("filled.pdf");
    fill_form(
        src,
        vec![
            FieldValue { name: "seller.name".into(), value: "Zoë".into() },
            FieldValue { name: "agree".into(), value: "Yes".into() },
            FieldValue { name: "size".into(), value: "L".into() },
        ],
        false,
        Some(out.clone()),
    )
    .await
    .expect("fill");

    let fields = get_form_fields(out.clone()).await.expect("fields");
    let value = |n: &str| fields.iter().find(|f| f.name == n).map(|f| f.value.clone()).unwrap();
    assert_eq!(value("buyer.name"), "", "only seller.name was filled");
    assert_eq!(value("seller.name"), "Zoë");
    assert_eq!(value("agree"), "On", "a generic Yes maps to the widget's on state");
    assert_eq!(value("size"), "L");

    let doc = load_lopdf(&out);
    let agree = field_dict(&doc, b"agree");
    assert_eq!(agree.get(b"AS").unwrap().as_name().unwrap(), b"On");
    assert!(agree.get(b"AP").unwrap().as_dict().is_ok(), "checkbox keeps its appearances");
    let seller_kid = doc.objects.values().filter_map(|o| o.as_dict().ok())
        .filter(|d| d.get(b"T").ok().and_then(|t| t.as_str().ok()) == Some(b"name".as_slice()))
        .nth(1).expect("seller widget");
    assert!(seller_kid.get(b"AP").is_ok(), "filled text field gets an appearance");
}

#[tokio::test]
async fn flatten_draws_widgets_into_the_page() {
    let (_d, src) = temp_output("form.pdf");
    build_form(&src);
    let (_d2, out) = temp_output("flat.pdf");
    fill_form(
        src,
        vec![FieldValue { name: "buyer.name".into(), value: "Jane".into() }],
        true,
        Some(out.clone()),
    )
    .await
    .expect("fill and flatten");

    let doc = load_lopdf(&out);
    assert!(doc.catalog().unwrap().get(b"AcroForm").is_err());
    let page_id = doc.get_pages()[&1];
    assert!(qyra_lib::utils::annots::annot_refs(&doc, page_id).is_empty(), "widgets removed");
    let content = doc.get_page_content(page_id).expect("content");
    let content = String::from_utf8_lossy(&content);
    assert!(content.matches(" Do Q").count() >= 1, "appearances drawn: {content}");
}
