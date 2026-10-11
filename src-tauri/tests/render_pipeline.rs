//! Render pipeline: page sizes, display lists, tiles, thumbnails, export.
mod common;

use common::fixture;
use qyra_lib::render::geometry::PageSizePt;
use qyra_lib::render::raster::{build_display_list, page_sizes};

fn open(name: &str) -> mupdf::Document {
    mupdf::Document::open(fixture(name).to_str().unwrap()).unwrap()
}

#[test]
fn page_sizes_are_per_page_and_rotation_aware() {
    let sizes = page_sizes(&open("mixed-sizes.pdf")).unwrap();
    assert_eq!(
        sizes,
        vec![
            PageSizePt { w: 612.0, h: 792.0 },
            PageSizePt { w: 792.0, h: 612.0 },
            PageSizePt { w: 300.0, h: 200.0 },
        ]
    );
}

#[test]
fn display_list_bounds_match_page_size() {
    let doc = open("mixed-sizes.pdf");
    for (i, size) in page_sizes(&doc).unwrap().into_iter().enumerate() {
        let list = build_display_list(&doc, i as i32).unwrap();
        let b = list.bounds();
        assert!(((b.x1 - b.x0) as f64 - size.w).abs() < 0.01, "page {i} width");
        assert!(((b.y1 - b.y0) as f64 - size.h).abs() < 0.01, "page {i} height");
    }
}
