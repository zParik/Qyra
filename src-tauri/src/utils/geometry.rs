//! Mapping between the page as the viewer shows it and PDF user space.
//!
//! The viewer (MuPDF) shows the CropBox, turned by /Rotate, with the origin
//! at the top-left. The frontend sends positions normalised to that view
//! (0..1 on each axis). Mapping them with the MediaBox alone put marks in the
//! wrong place on every rotated or cropped page.

use lopdf::{Document, Object, ObjectId};

/// The visible box of a page and its rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageGeom {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// Clockwise display rotation: 0, 90, 180 or 270.
    pub rotate: i32,
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(f) => Some(*f as f64),
        _ => None,
    }
}

fn read_box(doc: &Document, o: &Object) -> Option<[f64; 4]> {
    let arr = match o {
        Object::Array(a) => a,
        Object::Reference(id) => doc.get_object(*id).ok()?.as_array().ok()?,
        _ => return None,
    };
    if arr.len() < 4 {
        return None;
    }
    let v = [num(&arr[0])?, num(&arr[1])?, num(&arr[2])?, num(&arr[3])?];
    let b = [v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])];
    (b[2] - b[0] > 0.0 && b[3] - b[1] > 0.0).then_some(b)
}

/// Look `key` up on the page, then up its /Parent chain (MediaBox, CropBox
/// and Rotate are inheritable).
fn inherited<'a>(doc: &'a Document, page_id: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut cur = page_id;
    for _ in 0..64 {
        let d = doc.get_object(cur).ok()?.as_dict().ok()?;
        if let Ok(v) = d.get(key) {
            return Some(v);
        }
        cur = d.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

impl PageGeom {
    pub fn of(doc: &Document, page_id: ObjectId) -> Self {
        let media = inherited(doc, page_id, b"MediaBox")
            .and_then(|o| read_box(doc, o))
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        // The CropBox is clipped to the MediaBox; one outside it is ignored.
        let b = inherited(doc, page_id, b"CropBox")
            .and_then(|o| read_box(doc, o))
            .map(|c| [c[0].max(media[0]), c[1].max(media[1]), c[2].min(media[2]), c[3].min(media[3])])
            .filter(|c| c[2] > c[0] && c[3] > c[1])
            .unwrap_or(media);
        let rotate = inherited(doc, page_id, b"Rotate")
            .and_then(|o| match o {
                Object::Reference(id) => doc.get_object(*id).ok().and_then(num),
                o => num(o),
            })
            .map(|r| ((r as i64 / 90 * 90).rem_euclid(360)) as i32)
            .unwrap_or(0);
        PageGeom { x0: b[0], y0: b[1], x1: b[2], y1: b[3], rotate }
    }

    pub fn width(&self) -> f64 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f64 {
        self.y1 - self.y0
    }

    /// Size of the page as shown, in points.
    pub fn display_size(&self) -> (f64, f64) {
        if self.rotate % 180 == 0 {
            (self.width(), self.height())
        } else {
            (self.height(), self.width())
        }
    }

    /// A point normalised to the shown page (top-left origin) in user space.
    pub fn to_pdf(&self, nx: f64, ny: f64) -> (f64, f64) {
        let (dw, dh) = self.display_size();
        let (u, v) = (nx * dw, ny * dh);
        match self.rotate {
            90 => (self.x0 + v, self.y0 + u),
            180 => (self.x1 - u, self.y0 + v),
            270 => (self.x1 - v, self.y1 - u),
            _ => (self.x0 + u, self.y1 - v),
        }
    }

    /// A user-space point normalised to the shown page (top-left origin).
    pub fn to_norm(&self, x: f64, y: f64) -> (f64, f64) {
        let (dw, dh) = self.display_size();
        let (u, v) = match self.rotate {
            90 => (y - self.y0, x - self.x0),
            180 => (self.x1 - x, y - self.y0),
            270 => (self.y1 - y, self.x1 - x),
            _ => (x - self.x0, self.y1 - y),
        };
        (u / dw.max(1e-9), v / dh.max(1e-9))
    }

    /// A normalised rectangle (any corner order) as a user-space
    /// `[llx, lly, urx, ury]`.
    pub fn rect_to_pdf(&self, nx0: f64, ny0: f64, nx1: f64, ny1: f64) -> [f64; 4] {
        let (ax, ay) = self.to_pdf(nx0, ny0);
        let (bx, by) = self.to_pdf(nx1, ny1);
        [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
    }

    /// A user-space rectangle as a normalised `[x0, y0, x1, y1]` with
    /// x0 < x1 and y0 < y1 (top-left origin).
    pub fn rect_to_norm(&self, r: [f64; 4]) -> [f64; 4] {
        let (ax, ay) = self.to_norm(r[0], r[1]);
        let (bx, by) = self.to_norm(r[2], r[3]);
        [ax.min(bx), ay.min(by), ax.max(bx), ay.max(by)]
    }

    /// `[a b c d]` of a matrix that turns user space so that its x axis
    /// points right and its y axis up on the shown page. Text and images
    /// drawn through it read upright on a rotated page.
    pub fn upright_basis(&self) -> [f64; 4] {
        match self.rotate {
            90 => [0.0, 1.0, -1.0, 0.0],
            180 => [-1.0, 0.0, 0.0, -1.0],
            270 => [0.0, -1.0, 1.0, 0.0],
            _ => [1.0, 0.0, 0.0, 1.0],
        }
    }

    /// The `cm` matrix `[a b c d e f]` that draws a unit square (an image)
    /// upright on the shown page. `(nx, ny)` is its shown top-left corner and
    /// `nw`×`nh` its shown size, all normalised.
    pub fn upright_unit_matrix(&self, nx: f64, ny: f64, nw: f64, nh: f64) -> [f64; 6] {
        let (dw, dh) = self.display_size();
        let (w, h) = (nw * dw, nh * dh);
        // The shown bottom-left corner of the object is the unit square's origin.
        let (ox, oy) = self.to_pdf(nx, ny + nh);
        let [a, b, c, d] = self.upright_basis();
        [a * w, b * w, c * h, d * h, ox, oy]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(rotate: i32) -> PageGeom {
        PageGeom { x0: 10.0, y0: 20.0, x1: 210.0, y1: 420.0, rotate }
    }

    #[test]
    fn round_trips_every_rotation() {
        for r in [0, 90, 180, 270] {
            let geom = g(r);
            for (nx, ny) in [(0.0, 0.0), (1.0, 0.0), (0.25, 0.75), (1.0, 1.0)] {
                let (x, y) = geom.to_pdf(nx, ny);
                let (bx, by) = geom.to_norm(x, y);
                assert!((bx - nx).abs() < 1e-9 && (by - ny).abs() < 1e-9, "rotate {r}");
            }
        }
    }

    #[test]
    fn unrotated_top_left_is_crop_top_left() {
        assert_eq!(g(0).to_pdf(0.0, 0.0), (10.0, 420.0));
        assert_eq!(g(0).to_pdf(1.0, 1.0), (210.0, 20.0));
    }

    #[test]
    fn rotated_90_shows_bottom_left_at_top_left() {
        // Turning a page clockwise brings its bottom-left corner to the top-left.
        assert_eq!(g(90).to_pdf(0.0, 0.0), (10.0, 20.0));
        assert_eq!(g(90).display_size(), (400.0, 200.0));
        // Its top-left corner ends up at the top-right.
        assert_eq!(g(90).to_pdf(1.0, 0.0), (10.0, 420.0));
    }

    #[test]
    fn upright_matrix_maps_unit_square_corners() {
        for r in [0, 90, 180, 270] {
            let geom = g(r);
            let m = geom.upright_unit_matrix(0.2, 0.3, 0.4, 0.1);
            let apply = |u: f64, v: f64| (m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]);
            // Unit (0,1) is the object's shown top-left; (1,0) its bottom-right.
            let (tx, ty) = apply(0.0, 1.0);
            let (ex, ey) = geom.to_pdf(0.2, 0.3);
            assert!((tx - ex).abs() < 1e-9 && (ty - ey).abs() < 1e-9, "rotate {r} top-left");
            let (bx, by) = apply(1.0, 0.0);
            let (fx, fy) = geom.to_pdf(0.6, 0.4);
            assert!((bx - fx).abs() < 1e-9 && (by - fy).abs() < 1e-9, "rotate {r} bottom-right");
        }
    }

    #[test]
    fn reads_inherited_crop_and_rotate() {
        use lopdf::dictionary;
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "CropBox" => vec![50.into(), 60.into(), 300.into(), 500.into()],
        });
        doc.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Rotate" => -90,
        }));
        let geom = PageGeom::of(&doc, page_id);
        assert_eq!(geom, PageGeom { x0: 50.0, y0: 60.0, x1: 300.0, y1: 500.0, rotate: 270 });
    }
}
