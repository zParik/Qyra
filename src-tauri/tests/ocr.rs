//! OCR: recognition with MuPDF's bundled tesseract (`ocr_page_core`) and
//! baking an invisible, searchable text layer from the word boxes
//! (`make_searchable_core`).

mod common;

use common::{fixture_str, page_count, page_text, temp_output};
use qyra_lib::commands::ocr::{make_searchable_core, OcrPage, OcrWord};

#[test]
fn bakes_an_invisible_searchable_text_layer() {
    let src = fixture_str("scanned.pdf"); // image-only page, no text
    let (_d, out) = temp_output("searchable.pdf");

    let pages = vec![OcrPage {
        words: vec![OcrWord { text: "invoice".into(), x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
    }];

    make_searchable_core(src, pages, Some(out.clone()), |_| {}).expect("ocr");

    assert_eq!(page_count(&out), 1);
    assert!(
        page_text(&out, 0).to_lowercase().contains("invoice"),
        "baked OCR word should be extractable",
    );
}

#[test]
fn recognizes_the_words_on_a_page_with_bundled_english_data() {
    let tessdata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/tessdata");
    let page = qyra_lib::commands::ocr::ocr_page_core(&fixture_str("text.pdf"), 1, &tessdata)
        .expect("ocr page");

    let text: Vec<String> = page.words.iter().map(|w| w.text.to_lowercase()).collect();
    for want in ["hello", "world", "qyra"] {
        assert!(text.iter().any(|t| t.contains(want)), "missing {want:?} in {text:?}");
    }
    for w in &page.words {
        assert!((0.0..=1.0).contains(&w.x) && (0.0..=1.0).contains(&w.y), "box outside page: {}", w.text);
        assert!(w.w > 0.0 && w.h > 0.0, "empty box: {}", w.text);
    }
}
