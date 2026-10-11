//! Pure page/tile maths shared (by convention) with `src/render/tiles.ts`.
//! A page at `scale` occupies `ceil(pt * scale - 1e-6)` device pixels per axis;
//! it is cut into a grid of `TILE`-sized tiles, the last row/column clipped.

/// Tile edge in device pixels.
pub const TILE: u32 = 512;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct PageSizePt {
    pub w: f64,
    pub h: f64,
}

/// Half-open device-pixel rectangle `[x0, x1) × [y0, y1)` within a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileRect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl TileRect {
    pub fn width(&self) -> u32 { self.x1 - self.x0 }
    pub fn height(&self) -> u32 { self.y1 - self.y0 }
}

/// Device-pixel size of a page at `scale`. The epsilon keeps exact products
/// (612 * 4/3 = 816.0000000001) from rounding up a whole pixel.
pub fn page_px(size: PageSizePt, scale: f64) -> (u32, u32) {
    let px = |pt: f64| ((pt * scale - 1e-6).ceil().max(1.0)) as u32;
    (px(size.w), px(size.h))
}

/// Number of tile columns and rows covering a page of `page_px` pixels.
pub fn grid(page_px: (u32, u32)) -> (u32, u32) {
    (page_px.0.div_ceil(TILE), page_px.1.div_ceil(TILE))
}

/// Rect of tile `(tx, ty)`, clipped to the page; `None` outside the grid.
pub fn tile_rect(page_px: (u32, u32), tx: u32, ty: u32) -> Option<TileRect> {
    let (cols, rows) = grid(page_px);
    if tx >= cols || ty >= rows {
        return None;
    }
    let x0 = tx * TILE;
    let y0 = ty * TILE;
    Some(TileRect { x0, y0, x1: (x0 + TILE).min(page_px.0), y1: (y0 + TILE).min(page_px.1) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LETTER: PageSizePt = PageSizePt { w: 612.0, h: 792.0 };

    #[test]
    fn page_px_rounds_up_and_ignores_float_noise() {
        // 612 * (96/72) = 816 exactly; float noise must not push it to 817.
        assert_eq!(page_px(LETTER, 96.0 / 72.0), (816, 1056));
        assert_eq!(page_px(LETTER, 0.5), (306, 396));
        assert_eq!(page_px(PageSizePt { w: 10.1, h: 10.0 }, 1.0), (11, 10));
    }

    #[test]
    fn page_px_is_at_least_one_pixel() {
        assert_eq!(page_px(LETTER, 0.0001), (1, 1));
    }

    #[test]
    fn grid_counts_partial_tiles() {
        assert_eq!(grid((816, 1056)), (2, 3));
        assert_eq!(grid((512, 512)), (1, 1));
        assert_eq!(grid((513, 1)), (2, 1));
    }

    #[test]
    fn tile_rect_clips_last_row_and_column() {
        let px = (816, 1056);
        assert_eq!(tile_rect(px, 0, 0), Some(TileRect { x0: 0, y0: 0, x1: 512, y1: 512 }));
        assert_eq!(tile_rect(px, 1, 2), Some(TileRect { x0: 512, y0: 1024, x1: 816, y1: 1056 }));
    }

    #[test]
    fn tile_rect_outside_grid_is_none() {
        assert_eq!(tile_rect((816, 1056), 2, 0), None);
        assert_eq!(tile_rect((816, 1056), 0, 3), None);
    }
}
