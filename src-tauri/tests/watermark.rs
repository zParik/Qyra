//! Watermarking via the pure `watermark_core` (the command wrapper only adds
//! progress events). See P1c: AppHandle commands expose a runtime-free core.

mod common;

use common::{fixture_str, page_count, temp_output};
use qyra_lib::commands::watermark::{watermark_core, WatermarkOptions};

fn opts(text: &str, pages: Option<Vec<u32>>) -> WatermarkOptions {
    WatermarkOptions {
        text: text.into(),
        font_size: None,
        opacity: None,
        angle: None,
        color: None,
        mode: None,
        pages,
    }
}

#[test]
fn watermarks_all_pages_and_preserves_count() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("wm.pdf");

    watermark_core(src, opts("DRAFT", None), Some(out.clone()), |_| {}).expect("watermark");

    assert_eq!(page_count(&out), 5);
}

#[test]
fn watermarks_only_selected_pages() {
    let src = fixture_str("multipage.pdf");
    let (_d, out) = temp_output("wm.pdf");

    watermark_core(src, opts("CONFIDENTIAL", Some(vec![1, 3])), Some(out.clone()), |_| {})
        .expect("watermark");

    assert_eq!(page_count(&out), 5);
}
