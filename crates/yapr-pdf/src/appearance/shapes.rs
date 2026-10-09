//! Geometric appearances: ink, square, circle, line, polygon and polyline.

use super::{border_width, ending_size, stroke_style, Appearance};
use crate::content::Content;
use crate::dto::{AnnotKind, AnnotationDto, BorderStyle, LineEnding, Rgb};
use crate::geometry::Point;

/// Freehand strokes, smoothed with quadratic midpoint curves (as cubic Béziers).
pub fn ink(ap: &mut Appearance, dto: &AnnotationDto, strokes: &[Vec<Point>]) {
    let Some(color) = dto.color else { return };
    let width = border_width(dto).max(0.1);
    ap.opacity(dto.opacity, None);
    ap.content
        .stroke_rgb(color)
        .fill_rgb(color)
        .line_width(width)
        .line_cap(1)
        .line_join(1);
    for stroke in strokes {
        match stroke.as_slice() {
            [] => {}
            [dot] => {
                ap.content.ellipse(*dot, width / 2.0, width / 2.0).fill();
            }
            [a, b] => {
                ap.content.move_to(*a).line_to(*b).stroke();
            }
            points => {
                smooth_path(&mut ap.content, points);
                ap.content.stroke();
            }
        }
    }
}

/// A smooth open path through `points` (at least three).
fn smooth_path(c: &mut Content, points: &[Point]) {
    let (first, last) = (points[0], points[points.len() - 1]);
    c.move_to(first);
    let mut current = first.lerp(points[1], 0.5);
    c.line_to(current);
    for window in points[1..].windows(2) {
        let (control, next) = (window[0], window[1]);
        let end = control.lerp(next, 0.5);
        // Quadratic (current, control, end) expressed as a cubic.
        let c1 = current + (control - current) * (2.0 / 3.0);
        let c2 = end + (control - end) * (2.0 / 3.0);
        c.curve_to(c1, c2, end);
        current = end;
    }
    c.line_to(last);
}

/// Rectangle or ellipse inset by half the border width (plus the scallops of a cloudy
/// border), optionally filled.
pub fn square_circle(ap: &mut Appearance, dto: &AnnotationDto) {
    let [x1, y1, x2, y2] = ap.bbox;
    ap.opacity(dto.opacity, None);
    if let Some(fill) = dto.interior_color {
        ap.content.fill_rgb(fill);
    }
    let stroked = stroke_style(ap, dto);
    let width = if stroked { border_width(dto) } else { 0.0 };
    let center = Point::new((x1 + x2) / 2.0, (y1 + y2) / 2.0);
    let circle = dto.kind == AnnotKind::Circle;
    if stroked && dto.border_style == BorderStyle::Cloudy {
        let radius = cloud_radius(width).min((x2 - x1).min(y2 - y1) / 4.0);
        let inset = radius + width / 2.0;
        let (rx, ry) = (
            ((x2 - x1) / 2.0 - inset).max(0.0),
            ((y2 - y1) / 2.0 - inset).max(0.0),
        );
        let outline = if circle {
            ellipse_outline(center, rx, ry, radius)
        } else {
            let p = |dx: f64, dy: f64| Point::new(center.x + dx, center.y + dy);
            vec![p(-rx, -ry), p(rx, -ry), p(rx, ry), p(-rx, ry)]
        };
        cloud_path(&mut ap.content, &outline, radius);
    } else {
        let (rx, ry) = (
            ((x2 - x1 - width) / 2.0).max(0.0),
            ((y2 - y1 - width) / 2.0).max(0.0),
        );
        if circle {
            ap.content.ellipse(center, rx, ry);
        } else {
            ap.content
                .rect(center.x - rx, center.y - ry, 2.0 * rx, 2.0 * ry);
        }
    }
    ap.content.paint(dto.interior_color.is_some(), stroked);
}

/// Radius of the scallops of a cloudy border drawn with stroke `width`.
pub fn cloud_radius(width: f64) -> f64 {
    4.0 + width
}

/// Points on an ellipse spaced roughly `2 * radius` apart (counter-clockwise).
fn ellipse_outline(center: Point, rx: f64, ry: f64, radius: f64) -> Vec<Point> {
    // Ramanujan's approximation of the circumference.
    let h = ((rx - ry) / (rx + ry).max(1e-9)).powi(2);
    let circumference =
        std::f64::consts::PI * (rx + ry) * (1.0 + 3.0 * h / (10.0 + (4.0 - 3.0 * h).sqrt()));
    let count = (circumference / (2.0 * radius)).round().clamp(6.0, 2000.0) as usize;
    (0..count)
        .map(|i| {
            let angle = std::f64::consts::TAU * i as f64 / count as f64;
            Point::new(center.x + rx * angle.cos(), center.y + ry * angle.sin())
        })
        .collect()
}

/// Twice the signed area of a closed outline (positive when counter-clockwise).
fn signed_area2(outline: &[Point]) -> f64 {
    let n = outline.len();
    (0..n)
        .map(|i| {
            let (a, b) = (outline[i], outline[(i + 1) % n]);
            a.x * b.y - b.x * a.y
        })
        .sum()
}

/// A cloudy outline: the closed polygon `outline` is resampled into chords of about
/// `2 * radius`, and each chord is replaced by a semicircular bump bulging outwards.
fn cloud_path(c: &mut Content, outline: &[Point], radius: f64) {
    let mut points = Vec::new();
    for (i, &a) in outline.iter().enumerate() {
        let b = outline[(i + 1) % outline.len()];
        let pieces = ((b - a).length() / (2.0 * radius))
            .round()
            .clamp(1.0, 2000.0) as usize;
        points.extend((0..pieces).map(|k| a.lerp(b, k as f64 / pieces as f64)));
    }
    if points.len() < 3 {
        c.polygon(outline);
        return;
    }
    // The right-hand normal points outwards for a counter-clockwise outline.
    let side = if signed_area2(outline) >= 0.0 {
        1.0
    } else {
        -1.0
    };
    c.move_to(points[0]);
    for (i, &a) in points.iter().enumerate() {
        let b = points[(i + 1) % points.len()];
        let chord = b - a;
        let normal = Point::new(chord.y, -chord.x).unit_or(Point::new(0.0, 0.0)) * side;
        // One cubic approximates a semicircle when its handles rise 4/3 of the radius.
        let rise = normal * (chord.length() / 2.0 * 4.0 / 3.0);
        c.curve_to(a + rise, b + rise, b);
    }
    c.close();
}

/// A straight line with optional endings.
pub fn line(ap: &mut Appearance, dto: &AnnotationDto, start: Point, end: Point) {
    ap.opacity(dto.opacity, None);
    if !stroke_style(ap, dto) {
        return;
    }
    ap.content.line_cap(0).move_to(start).line_to(end).stroke();
    let dir = (end - start).unit_or(Point::new(1.0, 0.0));
    draw_endings(ap, dto, (start, dir * -1.0), (end, dir));
}

/// Closed polygon (filled with the interior colour) or open polyline (with endings).
pub fn poly(ap: &mut Appearance, dto: &AnnotationDto, vertices: &[Point]) {
    ap.opacity(dto.opacity, None);
    let closed = dto.kind == AnnotKind::Polygon;
    let fill = closed && dto.interior_color.is_some();
    if let (true, Some(color)) = (fill, dto.interior_color) {
        ap.content.fill_rgb(color);
    }
    let stroked = stroke_style(ap, dto);
    ap.content.line_join(1);
    if closed && stroked && dto.border_style == BorderStyle::Cloudy {
        cloud_path(&mut ap.content, vertices, cloud_radius(border_width(dto)));
    } else if closed {
        ap.content.polygon(vertices);
    } else {
        ap.content.polyline(vertices);
    }
    ap.content.paint(fill, stroked);
    if closed || !stroked || vertices.len() < 2 {
        return;
    }
    let n = vertices.len();
    let start_dir = (vertices[0] - vertices[1]).unit_or(Point::new(-1.0, 0.0));
    let end_dir = (vertices[n - 1] - vertices[n - 2]).unit_or(Point::new(1.0, 0.0));
    draw_endings(
        ap,
        dto,
        (vertices[0], start_dir),
        (vertices[n - 1], end_dir),
    );
}

/// Draw both line endings; each is given as (tip point, outward unit direction).
fn draw_endings(
    ap: &mut Appearance,
    dto: &AnnotationDto,
    start: (Point, Point),
    end: (Point, Point),
) {
    let Some(stroke) = dto.color else { return };
    let size = ending_size(border_width(dto));
    ap.content.dash(&[], 0.0).line_join(0);
    for (ending, (tip, dir)) in [(dto.line_endings[0], start), (dto.line_endings[1], end)] {
        draw_ending(
            &mut ap.content,
            ending,
            tip,
            dir,
            size,
            (stroke, dto.interior_color),
        );
    }
}

/// Draw one line ending at `tip`, pointing along the outward direction `dir`.
fn draw_ending(
    c: &mut Content,
    ending: LineEnding,
    tip: Point,
    dir: Point,
    size: f64,
    colors: (Rgb, Option<Rgb>),
) {
    let (stroke, interior) = colors;
    let normal = dir.perp();
    let half = size / 2.0;
    let fill_with = |c: &mut Content, color: Option<Rgb>| {
        if let Some(color) = color {
            c.fill_rgb(color);
        }
        color.is_some()
    };
    match ending {
        LineEnding::None => {}
        LineEnding::OpenArrow
        | LineEnding::ROpenArrow
        | LineEnding::ClosedArrow
        | LineEnding::RClosedArrow => {
            let reversed = matches!(ending, LineEnding::ROpenArrow | LineEnding::RClosedArrow);
            let back = if reversed {
                tip + dir * size
            } else {
                tip - dir * size
            };
            let wings = [back + normal * half, tip, back - normal * half];
            if matches!(ending, LineEnding::ClosedArrow | LineEnding::RClosedArrow) {
                let fill = fill_with(c, Some(interior.unwrap_or(stroke)));
                c.polygon(&wings).paint(fill, true);
            } else {
                c.polyline(&wings).stroke();
            }
        }
        LineEnding::Circle => {
            let fill = fill_with(c, interior);
            c.ellipse(tip, half, half).paint(fill, true);
        }
        LineEnding::Square | LineEnding::Diamond => {
            let (a, b) = if ending == LineEnding::Square {
                ((dir + normal) * half, (dir - normal) * half)
            } else {
                (dir * half, normal * half)
            };
            let fill = fill_with(c, interior);
            c.polygon(&[tip + a, tip + b, tip - a, tip - b])
                .paint(fill, true);
        }
        LineEnding::Butt => {
            c.move_to(tip + normal * half)
                .line_to(tip - normal * half)
                .stroke();
        }
        LineEnding::Slash => {
            let slant = dir.rotate(std::f64::consts::PI / 3.0) * half;
            c.move_to(tip + slant).line_to(tip - slant).stroke();
        }
    }
}
