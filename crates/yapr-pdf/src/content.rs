//! A tiny content-stream builder emitting compact operators.

use crate::dto::Rgb;
use crate::geometry::Point;

/// Bézier constant for approximating a quarter circle with one cubic curve.
pub const KAPPA: f64 = 0.552_284_749_8;

/// Format a number with at most three decimals and without trailing zeros.
pub fn fmt_num(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded == 0.0 {
        return "0".to_string();
    }
    let text = format!("{rounded:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    text.to_string()
}

/// Builder for PDF content streams.
#[derive(Debug, Default, Clone)]
pub struct Content {
    buf: Vec<u8>,
}

impl Content {
    /// The finished content stream bytes.
    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    fn nums(&mut self, values: &[f64]) {
        for &value in values {
            self.buf.extend_from_slice(fmt_num(value).as_bytes());
            self.buf.push(b' ');
        }
    }

    /// Emit `values` followed by `operator` and a newline.
    fn op(&mut self, values: &[f64], operator: &str) -> &mut Self {
        self.nums(values);
        self.buf.extend_from_slice(operator.as_bytes());
        self.buf.push(b'\n');
        self
    }

    pub fn save(&mut self) -> &mut Self {
        self.op(&[], "q")
    }

    pub fn restore(&mut self) -> &mut Self {
        self.op(&[], "Q")
    }

    pub fn transform(&mut self, m: [f64; 6]) -> &mut Self {
        self.op(&m, "cm")
    }

    pub fn graphics_state(&mut self, name: &str) -> &mut Self {
        self.buf
            .extend_from_slice(format!("/{name} gs\n").as_bytes());
        self
    }

    pub fn xobject(&mut self, name: &str) -> &mut Self {
        self.buf
            .extend_from_slice(format!("/{name} Do\n").as_bytes());
        self
    }

    pub fn fill_rgb(&mut self, c: Rgb) -> &mut Self {
        self.op(&clamp_rgb(c), "rg")
    }

    pub fn stroke_rgb(&mut self, c: Rgb) -> &mut Self {
        self.op(&clamp_rgb(c), "RG")
    }

    pub fn line_width(&mut self, width: f64) -> &mut Self {
        self.op(&[width.max(0.0)], "w")
    }

    /// Line cap: 0 butt, 1 round, 2 square.
    pub fn line_cap(&mut self, cap: u8) -> &mut Self {
        self.op(&[f64::from(cap)], "J")
    }

    /// Line join: 0 miter, 1 round, 2 bevel.
    pub fn line_join(&mut self, join: u8) -> &mut Self {
        self.op(&[f64::from(join)], "j")
    }

    /// Dash pattern; an empty slice restores solid lines.
    pub fn dash(&mut self, pattern: &[f64], phase: f64) -> &mut Self {
        self.buf.push(b'[');
        let items: Vec<String> = pattern.iter().map(|&v| fmt_num(v.max(0.0))).collect();
        self.buf.extend_from_slice(items.join(" ").as_bytes());
        self.buf.extend_from_slice(b"] ");
        self.op(&[phase], "d")
    }

    pub fn move_to(&mut self, p: Point) -> &mut Self {
        self.op(&[p.x, p.y], "m")
    }

    pub fn line_to(&mut self, p: Point) -> &mut Self {
        self.op(&[p.x, p.y], "l")
    }

    pub fn curve_to(&mut self, c1: Point, c2: Point, p: Point) -> &mut Self {
        self.op(&[c1.x, c1.y, c2.x, c2.y, p.x, p.y], "c")
    }

    pub fn close(&mut self) -> &mut Self {
        self.op(&[], "h")
    }

    pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) -> &mut Self {
        self.op(&[x, y, w, h], "re")
    }

    pub fn fill(&mut self) -> &mut Self {
        self.op(&[], "f")
    }

    pub fn stroke(&mut self) -> &mut Self {
        self.op(&[], "S")
    }

    pub fn fill_stroke(&mut self) -> &mut Self {
        self.op(&[], "B")
    }

    pub fn end_path(&mut self) -> &mut Self {
        self.op(&[], "n")
    }

    /// Intersect the clipping path with the current path and end it.
    pub fn clip(&mut self) -> &mut Self {
        self.op(&[], "W n")
    }

    /// Paint the current path according to which colours are present.
    pub fn paint(&mut self, fill: bool, stroke: bool) -> &mut Self {
        match (fill, stroke) {
            (true, true) => self.fill_stroke(),
            (true, false) => self.fill(),
            (false, true) => self.stroke(),
            (false, false) => self.end_path(),
        }
    }

    /// A closed polygon path through `points`.
    pub fn polygon(&mut self, points: &[Point]) -> &mut Self {
        self.polyline(points);
        if points.len() > 1 {
            self.close();
        }
        self
    }

    /// An open path through `points`.
    pub fn polyline(&mut self, points: &[Point]) -> &mut Self {
        if let Some((first, rest)) = points.split_first() {
            self.move_to(*first);
            for p in rest {
                self.line_to(*p);
            }
        }
        self
    }

    /// An ellipse inscribed in the axis-aligned box centred at `c` with radii `rx`, `ry`.
    pub fn ellipse(&mut self, c: Point, rx: f64, ry: f64) -> &mut Self {
        let (kx, ky) = (rx * KAPPA, ry * KAPPA);
        let p = |dx: f64, dy: f64| Point::new(c.x + dx, c.y + dy);
        self.move_to(p(rx, 0.0));
        self.curve_to(p(rx, ky), p(kx, ry), p(0.0, ry));
        self.curve_to(p(-kx, ry), p(-rx, ky), p(-rx, 0.0));
        self.curve_to(p(-rx, -ky), p(-kx, -ry), p(0.0, -ry));
        self.curve_to(p(kx, -ry), p(rx, -ky), p(rx, 0.0));
        self.close()
    }

    /// A rectangle with rounded corners of radius `r`.
    pub fn rounded_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64) -> &mut Self {
        let r = r.clamp(0.0, w.min(h) / 2.0);
        if r <= 0.0 {
            return self.rect(x, y, w, h);
        }
        let k = r * (1.0 - KAPPA);
        let (x2, y2) = (x + w, y + h);
        let p = Point::new;
        self.move_to(p(x + r, y));
        self.line_to(p(x2 - r, y));
        self.curve_to(p(x2 - k, y), p(x2, y + k), p(x2, y + r));
        self.line_to(p(x2, y2 - r));
        self.curve_to(p(x2, y2 - k), p(x2 - k, y2), p(x2 - r, y2));
        self.line_to(p(x + r, y2));
        self.curve_to(p(x + k, y2), p(x, y2 - k), p(x, y2 - r));
        self.line_to(p(x, y + r));
        self.curve_to(p(x, y + k), p(x + k, y), p(x + r, y));
        self.close()
    }

    pub fn begin_text(&mut self) -> &mut Self {
        self.op(&[], "BT")
    }

    pub fn end_text(&mut self) -> &mut Self {
        self.op(&[], "ET")
    }

    pub fn font(&mut self, name: &str, size: f64) -> &mut Self {
        self.buf.extend_from_slice(format!("/{name} ").as_bytes());
        self.op(&[size], "Tf")
    }

    /// Set the text matrix to a pure translation (absolute positioning inside `BT`/`ET`).
    pub fn text_origin(&mut self, x: f64, y: f64) -> &mut Self {
        self.op(&[1.0, 0.0, 0.0, 1.0, x, y], "Tm")
    }

    /// Show a single-byte string (escaped literal).
    pub fn show_literal(&mut self, bytes: &[u8]) -> &mut Self {
        self.buf.push(b'(');
        for &b in bytes {
            match b {
                b'(' | b')' | b'\\' => {
                    self.buf.push(b'\\');
                    self.buf.push(b);
                }
                0x20..=0x7E => self.buf.push(b),
                _ => self.buf.extend_from_slice(format!("\\{b:03o}").as_bytes()),
            }
        }
        self.buf.extend_from_slice(b") Tj\n");
        self
    }

    /// Show a multi-byte string (hex form).
    pub fn show_hex(&mut self, bytes: &[u8]) -> &mut Self {
        self.buf.push(b'<');
        for b in bytes {
            self.buf.extend_from_slice(format!("{b:02X}").as_bytes());
        }
        self.buf.extend_from_slice(b"> Tj\n");
        self
    }
}

fn clamp_rgb(c: Rgb) -> [f64; 3] {
    c.map(|v| {
        if v.is_finite() {
            v.clamp(0.0, 1.0)
        } else {
            0.0
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_compact() {
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(-0.0001), "0");
        assert_eq!(fmt_num(0.5), "0.5");
        assert_eq!(fmt_num(1.23456), "1.235");
        assert_eq!(fmt_num(-12.1), "-12.1");
        assert_eq!(fmt_num(100.0), "100");
        assert_eq!(fmt_num(f64::NAN), "0");
    }

    #[test]
    fn builds_operators() {
        let mut c = Content::default();
        c.save()
            .fill_rgb([1.0, 0.5, 2.0])
            .rect(0.0, 0.0, 10.0, 5.5)
            .fill()
            .restore();
        assert_eq!(
            String::from_utf8(c.into_bytes()).unwrap(),
            "q\n1 0.5 1 rg\n0 0 10 5.5 re\nf\nQ\n"
        );
    }

    #[test]
    fn escapes_literals() {
        let mut c = Content::default();
        c.show_literal(b"a(b)\\\x80");
        assert_eq!(
            String::from_utf8(c.into_bytes()).unwrap(),
            "(a\\(b\\)\\\\\\200) Tj\n"
        );
        let mut c = Content::default();
        c.show_hex(&[0x4F, 0x60]).dash(&[3.0, 1.5], 0.0);
        assert_eq!(
            String::from_utf8(c.into_bytes()).unwrap(),
            "<4F60> Tj\n[3 1.5] 0 d\n"
        );
    }
}
