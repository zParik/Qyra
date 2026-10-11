//! Render pipeline: page sizes, display lists, tiles, thumbnails, export.
mod common;

use common::fixture;
use qyra_lib::render::geometry::{grid, page_px, tile_rect, PageSizePt, TileRect};
use qyra_lib::render::raster::{build_display_list, encode_png, page_sizes, render_region, to_wire};

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

fn whole(px: (u32, u32)) -> TileRect {
    TileRect { x0: 0, y0: 0, x1: px.0, y1: px.1 }
}

/// Render every tile and copy it into one buffer the size of the page.
fn stitched(list: &mupdf::DisplayList, scale: f64, px: (u32, u32)) -> Vec<u8> {
    let mut out = vec![0u8; (px.0 * px.1 * 4) as usize];
    let (cols, rows) = grid(px);
    for ty in 0..rows {
        for tx in 0..cols {
            let r = tile_rect(px, tx, ty).unwrap();
            let t = render_region(list, scale, r).unwrap();
            assert_eq!((t.width, t.height), (r.width(), r.height()));
            for row in 0..t.height {
                let src = (row * t.width * 4) as usize;
                let dst = (((r.y0 + row) * px.0 + r.x0) * 4) as usize;
                out[dst..dst + (t.width * 4) as usize]
                    .copy_from_slice(&t.data[src..src + (t.width * 4) as usize]);
            }
        }
    }
    out
}

#[test]
fn stitched_tiles_equal_whole_page_render() {
    let doc = open("mixed-sizes.pdf");
    for (i, size) in page_sizes(&doc).unwrap().into_iter().enumerate() {
        let list = build_display_list(&doc, i as i32).unwrap();
        let scale = 2.0;
        let px = page_px(size, scale);
        let full = render_region(&list, scale, whole(px)).unwrap();
        assert_eq!(full.data, stitched(&list, scale, px), "page {i}: tiles must match exactly");
    }
}

#[test]
fn render_region_is_opaque_rgba_on_white() {
    let doc = open("text.pdf");
    let list = build_display_list(&doc, 0).unwrap();
    let img = render_region(&list, 1.0, TileRect { x0: 0, y0: 0, x1: 4, y1: 4 }).unwrap();
    assert_eq!(img.data.len(), 4 * 4 * 4);
    assert!(img.data.chunks(4).all(|p| p == [255, 255, 255, 255]), "top-left corner is blank white");
}

#[test]
fn page_with_text_has_dark_pixels() {
    let doc = open("text.pdf");
    let list = build_display_list(&doc, 0).unwrap();
    let px = page_px(page_sizes(&doc).unwrap()[0], 1.0);
    let img = render_region(&list, 1.0, whole(px)).unwrap();
    assert!(img.data.chunks(4).any(|p| p[0] < 128), "text must render");
}

#[test]
fn wire_format_has_le_header_then_pixels() {
    let doc = open("text.pdf");
    let list = build_display_list(&doc, 0).unwrap();
    let img = render_region(&list, 1.0, TileRect { x0: 0, y0: 0, x1: 3, y1: 2 }).unwrap();
    let wire = to_wire(Some(&img));
    assert_eq!(&wire[0..4], &3u32.to_le_bytes());
    assert_eq!(&wire[4..8], &2u32.to_le_bytes());
    assert_eq!(wire.len(), 8 + 3 * 2 * 4);
    assert_eq!(to_wire(None), vec![0u8; 8]);
}

#[test]
fn encode_png_produces_a_png() {
    let doc = open("text.pdf");
    let list = build_display_list(&doc, 0).unwrap();
    let img = render_region(&list, 0.5, TileRect { x0: 0, y0: 0, x1: 50, y1: 50 }).unwrap();
    let png = encode_png(&img).unwrap();
    assert_eq!(&png[0..8], b"\x89PNG\r\n\x1a\n");
}

use qyra_lib::commands::render::ActiveDocument;
use qyra_lib::commands::render_worker::RenderWorker;
use qyra_lib::render::scheduler::Priority;
use qyra_lib::render::service::{RenderService, TileReq};

fn service() -> RenderService {
    RenderService::new(RenderWorker::new(ActiveDocument::new()), 2)
}

fn req(id: u64, path: &str, tx: u32, ty: u32) -> TileReq {
    TileReq { id, path: path.to_string(), page: 1, scale: 2.0, tx, ty, priority: Priority::Visible }
}

#[test]
fn service_renders_a_tile_matching_geometry() {
    let path = fixture("text.pdf").to_string_lossy().into_owned();
    let img = service().tile(req(1, &path, 1, 0)).unwrap().expect("tile in range");
    // text.pdf is Letter: 1224 x 1584 at scale 2 → tile (1,0) is 512 wide.
    assert_eq!((img.width, img.height), (512, 512));
}

#[test]
fn service_returns_none_for_tile_outside_page() {
    let path = fixture("text.pdf").to_string_lossy().into_owned();
    assert!(service().tile(req(1, &path, 99, 0)).unwrap().is_none());
}

#[test]
fn service_renders_whole_page() {
    let path = fixture("text.pdf").to_string_lossy().into_owned();
    let img = service().page(1, path, 1, 1.0, Priority::Visible).unwrap().unwrap();
    assert_eq!((img.width, img.height), (612, 792));
}

use qyra_lib::render::thumbs::{thumb_png, ThumbCache};

#[test]
fn thumbnail_is_png_of_requested_width_and_cached() {
    let dir = tempfile::tempdir().unwrap();
    let cache = ThumbCache::new(dir.path().to_path_buf(), 1 << 24);
    let path = fixture("text.pdf").to_string_lossy().into_owned();
    let svc = service();
    let png = thumb_png(&svc, &cache, &path, 1, 256).unwrap();
    let img = image::load_from_memory(&png).unwrap();
    assert_eq!(img.width(), 256);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "written to disk cache");
    assert_eq!(thumb_png(&svc, &cache, &path, 1, 256).unwrap(), png, "cache hit is identical");
}

use qyra_lib::render::export::export_page_image;

#[test]
fn png_export_is_real_png_at_full_300_dpi() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("p1.png");
    export_page_image(&open("text.pdf"), 1, 300, "png", &out).unwrap();
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(&bytes[0..8], b"\x89PNG\r\n\x1a\n", "PNG means PNG, not JPEG");
    let img = image::load_from_memory(&bytes).unwrap();
    assert_eq!((img.width(), img.height()), (2550, 3300), "no 2600 px cap");
}

#[test]
fn jpg_export_is_jpeg() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("p1.jpg");
    export_page_image(&open("text.pdf"), 1, 72, "jpg", &out).unwrap();
    assert_eq!(&std::fs::read(&out).unwrap()[0..2], &[0xFF, 0xD8]);
}
