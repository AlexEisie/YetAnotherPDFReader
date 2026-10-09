//! Small 2D geometry helpers (points, rectangles, quads).

use std::ops::{Add, Mul, Sub};

use crate::dto::Rect;

/// A point or vector in page user space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }

    /// Unit vector in the same direction (or `fallback` for a zero vector).
    pub fn unit_or(self, fallback: Point) -> Point {
        let len = self.length();
        if len > 1e-9 {
            self * (1.0 / len)
        } else {
            fallback
        }
    }

    /// The vector rotated by +90° (counter-clockwise).
    pub fn perp(self) -> Point {
        Point::new(-self.y, self.x)
    }

    pub fn lerp(self, other: Point, t: f64) -> Point {
        self + (other - self) * t
    }

    /// Rotate the vector by `angle` radians.
    pub fn rotate(self, angle: f64) -> Point {
        let (sin, cos) = angle.sin_cos();
        Point::new(self.x * cos - self.y * sin, self.x * sin + self.y * cos)
    }
}

impl Add for Point {
    type Output = Point;
    fn add(self, rhs: Point) -> Point {
        Point::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl Sub for Point {
    type Output = Point;
    fn sub(self, rhs: Point) -> Point {
        Point::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl Mul<f64> for Point {
    type Output = Point;
    fn mul(self, rhs: f64) -> Point {
        Point::new(self.x * rhs, self.y * rhs)
    }
}

/// Order rectangle corners as `[x_min, y_min, x_max, y_max]`.
pub fn normalize_rect(r: Rect) -> Rect {
    [
        r[0].min(r[2]),
        r[1].min(r[3]),
        r[0].max(r[2]),
        r[1].max(r[3]),
    ]
}

/// Grow a normalised rectangle by `d` on every side.
pub fn pad_rect(r: Rect, d: f64) -> Rect {
    [r[0] - d, r[1] - d, r[2] + d, r[3] + d]
}

/// Bounding box of `points`, `None` when empty.
pub fn bounding_box(points: impl IntoIterator<Item = Point>) -> Option<Rect> {
    points.into_iter().fold(None, |acc, p| {
        Some(match acc {
            None => [p.x, p.y, p.x, p.y],
            Some([x1, y1, x2, y2]) => [x1.min(p.x), y1.min(p.y), x2.max(p.x), y2.max(p.y)],
        })
    })
}

/// Pair a flat coordinate list into points (a trailing odd value is ignored).
pub fn points(flat: &[f64]) -> Vec<Point> {
    flat.chunks_exact(2)
        .map(|c| Point::new(c[0], c[1]))
        .collect()
}

/// A text-markup quadrilateral. Acrobat orders the corners upper-left, upper-right,
/// lower-left, lower-right, relative to the text direction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quad {
    pub ul: Point,
    pub ur: Point,
    pub ll: Point,
    pub lr: Point,
}

impl Quad {
    /// Split a flat `/QuadPoints` array into quads.
    pub fn parse_all(flat: &[f64]) -> Vec<Quad> {
        flat.chunks_exact(8)
            .map(|c| Quad {
                ul: Point::new(c[0], c[1]),
                ur: Point::new(c[2], c[3]),
                ll: Point::new(c[4], c[5]),
                lr: Point::new(c[6], c[7]),
            })
            .collect()
    }

    /// Corners in drawing order (a closed outline).
    pub fn outline(&self) -> [Point; 4] {
        [self.ll, self.lr, self.ur, self.ul]
    }

    /// Unit vector along the baseline (text direction).
    pub fn direction(&self) -> Point {
        let along = (self.lr - self.ll) + (self.ur - self.ul);
        along.unit_or(Point::new(1.0, 0.0))
    }

    /// Unit vector from the baseline towards the top of the text.
    pub fn up(&self) -> Point {
        let dir = self.direction();
        let normal = dir.perp();
        let rise = (self.ul - self.ll) + (self.ur - self.lr);
        if rise.x * normal.x + rise.y * normal.y < 0.0 {
            normal * -1.0
        } else {
            normal
        }
    }

    /// Height of the quad measured perpendicular to the baseline.
    pub fn height(&self) -> f64 {
        let up = self.up();
        let rise = ((self.ul - self.ll) + (self.ur - self.lr)) * 0.5;
        (rise.x * up.x + rise.y * up.y).abs()
    }

    /// Start and end of the baseline, offset by `fraction` of the height towards the top.
    pub fn line_at(&self, fraction: f64) -> (Point, Point) {
        (
            self.ll.lerp(self.ul, fraction),
            self.lr.lerp(self.ur, fraction),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_rects() {
        assert_eq!(
            normalize_rect([10.0, 20.0, 0.0, 5.0]),
            [0.0, 5.0, 10.0, 20.0]
        );
        assert_eq!(pad_rect([0.0, 0.0, 1.0, 1.0], 1.0), [-1.0, -1.0, 2.0, 2.0]);
    }

    #[test]
    fn bbox_of_points() {
        let pts = points(&[1.0, 5.0, -2.0, 3.0, 4.0, 0.0, 9.0]);
        assert_eq!(pts.len(), 3);
        assert_eq!(bounding_box(pts).unwrap(), [-2.0, 0.0, 4.0, 5.0]);
        assert!(bounding_box(Vec::new()).is_none());
    }

    #[test]
    fn quad_vectors_follow_rotation() {
        // Upright quad.
        let q = Quad::parse_all(&[0.0, 10.0, 50.0, 10.0, 0.0, 0.0, 50.0, 0.0])[0];
        assert_eq!(q.direction(), Point::new(1.0, 0.0));
        assert_eq!(q.up(), Point::new(0.0, 1.0));
        assert!((q.height() - 10.0).abs() < 1e-9);
        // Text running bottom-to-top (page rotated by 90°).
        let q = Quad::parse_all(&[0.0, 0.0, 0.0, 50.0, 10.0, 0.0, 10.0, 50.0])[0];
        assert!((q.direction().y - 1.0).abs() < 1e-9);
        assert!((q.up().x + 1.0).abs() < 1e-9);
        assert!((q.height() - 10.0).abs() < 1e-9);
    }
}
