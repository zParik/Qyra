//! Rasterize a laid-out page to an RGBA8 buffer. White background; per-run face
//! (regular/bold/italic), colour, underline, and strikethrough.

use super::engine::{LaidPage, LineRun};
use super::font::FontSet;

/// Render one laid-out page at `scale` device pixels per point.
pub fn render_page(page: &LaidPage, font: &FontSet, scale: f32) -> (u32, u32, Vec<u8>) {
    let w = ((page.width * scale).round() as u32).max(1);
    let h = ((page.height * scale).round() as u32).max(1);
    let mut buf = vec![255u8; (w as usize) * (h as usize) * 4]; // opaque white

    for line in &page.lines {
        let baseline = line.baseline_y * scale;
        for run in &line.runs {
            draw_run(&mut buf, w, h, run, baseline, scale, font);
        }
    }
    (w, h, buf)
}

fn draw_run(buf: &mut [u8], w: u32, h: u32, run: &LineRun, baseline: f32, scale: f32, font: &FontSet) {
    let px = run.size_pt * scale;
    let mut pen_x = run.x * scale;
    for ch in run.text.chars() {
        let (m, cov) = font.rasterize(ch, px, run.bold, run.italic);
        let gx = (pen_x + m.xmin as f32).round() as i32;
        let gy = (baseline - m.ymin as f32 - m.height as f32).round() as i32;
        blit_glyph(buf, w, h, gx, gy, m.width, m.height, &cov, run.color);
        pen_x += m.advance_width;
    }

    let run_w = run.width * scale;
    let x0 = run.x * scale;
    if run.underline {
        let y = baseline + (run.size_pt * 0.08 * scale);
        let t = (run.size_pt * 0.05 * scale).max(1.0);
        fill_rect(buf, w, h, x0, y, run_w, t, run.color);
    }
    if run.strike {
        let y = baseline - (run.size_pt * 0.30 * scale);
        let t = (run.size_pt * 0.05 * scale).max(1.0);
        fill_rect(buf, w, h, x0, y, run_w, t, run.color);
    }
}

/// Composite a glyph coverage map in `color` onto the buffer (over white/bg).
#[allow(clippy::too_many_arguments)]
fn blit_glyph(buf: &mut [u8], w: u32, h: u32, x0: i32, y0: i32, gw: usize, gh: usize, cov: &[u8], color: [u8; 3]) {
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
            let a = cov[row * gw + col] as u32;
            if a == 0 {
                continue;
            }
            let idx = ((py as u32 * w + px as u32) * 4) as usize;
            blend(buf, idx, color, a);
        }
    }
}

fn fill_rect(buf: &mut [u8], w: u32, h: u32, x: f32, y: f32, rw: f32, rh: f32, color: [u8; 3]) {
    let x0 = x.round() as i32;
    let y0 = y.round() as i32;
    let x1 = (x + rw).round() as i32;
    let y1 = (y + rh).round() as i32;
    for py in y0..y1 {
        if py < 0 || py >= h as i32 {
            continue;
        }
        for px in x0..x1 {
            if px < 0 || px >= w as i32 {
                continue;
            }
            let idx = ((py as u32 * w + px as u32) * 4) as usize;
            blend(buf, idx, color, 255);
        }
    }
}

/// Alpha-blend `color` at coverage `a` (0..=255) over the existing pixel.
fn blend(buf: &mut [u8], idx: usize, color: [u8; 3], a: u32) {
    let inv = 255 - a;
    buf[idx] = ((buf[idx] as u32 * inv + color[0] as u32 * a) / 255) as u8;
    buf[idx + 1] = ((buf[idx + 1] as u32 * inv + color[1] as u32 * a) / 255) as u8;
    buf[idx + 2] = ((buf[idx + 2] as u32 * inv + color[2] as u32 * a) / 255) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::engine::{LaidPage, Line, LineRun};

    #[test]
    fn renders_colored_text() {
        let page = LaidPage {
            width: 200.0,
            height: 80.0,
            lines: vec![Line {
                baseline_y: 40.0,
                runs: vec![LineRun {
                    x: 10.0,
                    width: 80.0,
                    text: "Hi".into(),
                    bold: true,
                    italic: false,
                    underline: true,
                    strike: false,
                    size_pt: 24.0,
                    color: [200, 0, 0],
                }],
            }],
        };
        let (w, h, buf) = render_page(&page, &FontSet::default_set(), 1.0);
        assert_eq!((w, h), (200, 80));
        // Some pixel should carry red ink (high R, low G/B).
        let reddish = buf.chunks(4).any(|p| p[0] > 100 && p[1] < 80 && p[2] < 80);
        assert!(reddish, "expected red text/underline pixels");
    }
}
