//! Rasterize a laid-out page to an RGBA8 pixel buffer. White background, black
//! text, anti-aliased via per-glyph coverage maps.
//!
//! ponytail: draws every run with the single regular face (no bold/italic face
//! selection yet) and paints text flat black. Colour, faces, and images widen in
//! later phases.

use super::engine::LaidPage;
use super::font::Font;

/// Render one laid-out page at `scale` device pixels per point. Returns
/// `(width_px, height_px, rgba8)`.
pub fn render_page(page: &LaidPage, font: &Font, scale: f32) -> (u32, u32, Vec<u8>) {
    let w = ((page.width * scale).round() as u32).max(1);
    let h = ((page.height * scale).round() as u32).max(1);
    let mut buf = vec![255u8; (w as usize) * (h as usize) * 4]; // opaque white

    for line in &page.lines {
        let baseline = line.baseline_y * scale;
        for run in &line.runs {
            let mut pen_x = run.x * scale;
            let px = run.size_pt * scale;
            for ch in run.text.chars() {
                let (m, cov) = font.rasterize(ch, px);
                let gx = (pen_x + m.xmin as f32).round() as i32;
                // fontdue's ymin is the baseline-to-bitmap-bottom offset; the
                // bitmap top is baseline - ymin - height.
                let gy = (baseline - m.ymin as f32 - m.height as f32).round() as i32;
                blit_black(&mut buf, w, h, gx, gy, m.width, m.height, &cov);
                pen_x += m.advance_width;
            }
        }
    }
    (w, h, buf)
}

/// Composite a glyph's coverage map as black text onto the RGBA buffer.
#[allow(clippy::too_many_arguments)]
fn blit_black(buf: &mut [u8], w: u32, h: u32, x0: i32, y0: i32, gw: usize, gh: usize, cov: &[u8]) {
    for row in 0..gh {
        let py = y0 + row as i32;
        if py < 0 || py >= h as i32 {
            continue;
        }
        for col in 0..gw {
            let px = x0 + col as i32;
            if px < 0 || px >= w as i32 {
                continue;
            }
            let a = cov[row * gw + col] as u32; // 0..=255 coverage
            if a == 0 {
                continue;
            }
            let idx = ((py as u32 * w + px as u32) * 4) as usize;
            let inv = 255 - a; // black over bg: out = bg * (1 - a)
            buf[idx] = ((buf[idx] as u32 * inv) / 255) as u8;
            buf[idx + 1] = ((buf[idx + 1] as u32 * inv) / 255) as u8;
            buf[idx + 2] = ((buf[idx + 2] as u32 * inv) / 255) as u8;
            // alpha channel stays opaque
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::engine::{LaidPage, Line, LineRun};

    #[test]
    fn renders_dark_pixels_for_text() {
        let page = LaidPage {
            width: 200.0,
            height: 100.0,
            lines: vec![Line {
                baseline_y: 50.0,
                runs: vec![LineRun {
                    x: 10.0,
                    width: 80.0,
                    text: "Hello".into(),
                    bold: false,
                    italic: false,
                    size_pt: 24.0,
                }],
            }],
        };
        let (w, h, buf) = render_page(&page, &Font::default_font(), 1.0);
        assert_eq!(w, 200);
        assert_eq!(h, 100);
        let has_dark = buf.chunks(4).any(|p| p[0] < 128);
        assert!(has_dark, "text should produce dark pixels");
    }
}
