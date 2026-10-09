//! Sticky-note icons, drawn as vector paths in a 20×20 box.

use super::Appearance;
use crate::content::Content;
use crate::dto::AnnotationDto;
use crate::geometry::Point;

/// Width and height of the note icon in points.
pub const NOTE_ICON_SIZE: f64 = 20.0;

/// Outline colour of the icons.
const OUTLINE: [f64; 3] = [0.2, 0.2, 0.2];

pub fn draw(ap: &mut Appearance, dto: &AnnotationDto) {
    let [x, y, ..] = ap.bbox;
    ap.opacity(dto.opacity, None);
    let c = &mut ap.content;
    c.transform([1.0, 0.0, 0.0, 1.0, x, y]);
    c.stroke_rgb(OUTLINE)
        .line_width(0.75)
        .line_join(1)
        .line_cap(1);
    if let Some(color) = dto.color {
        c.fill_rgb(color);
    }
    let fill = dto.color.is_some();
    match dto.icon.as_deref().unwrap_or("Comment") {
        "Note" => note(c, fill),
        "Help" => help(c, fill),
        "Key" => key(c, fill),
        "Insert" => insert(c, fill),
        "Paragraph" => paragraph(c, fill),
        "NewParagraph" => new_paragraph(c, fill),
        "Check" | "Checkmark" => polygon_icon(c, fill, &CHECK),
        "Cross" => polygon_icon(c, fill, &CROSS),
        "Star" => polygon_icon(c, fill, &star()),
        "Circle" => {
            c.ellipse(Point::new(10.0, 10.0), 8.5, 8.5)
                .paint(fill, true);
        }
        _ => comment(c, fill),
    }
}

fn pts(coords: &[(f64, f64)]) -> Vec<Point> {
    coords.iter().map(|&(x, y)| Point::new(x, y)).collect()
}

/// Dark detail lines (text lines inside the bubble / page).
fn detail_lines(c: &mut Content, x1: f64, x2: f64, ys: &[f64]) {
    c.save().stroke_rgb(OUTLINE).line_width(1.0);
    for &y in ys {
        c.move_to(Point::new(x1, y)).line_to(Point::new(x2, y));
    }
    c.stroke().restore();
}

/// Speech bubble with a tail at the bottom left.
fn comment(c: &mut Content, fill: bool) {
    let p = Point::new;
    let k = 2.5 * (1.0 - crate::content::KAPPA);
    c.move_to(p(4.0, 5.5))
        .line_to(p(3.0, 1.5))
        .line_to(p(9.0, 5.5))
        .line_to(p(16.0, 5.5))
        .curve_to(p(18.5 - k, 5.5), p(18.5, 8.0 - k), p(18.5, 8.0))
        .line_to(p(18.5, 16.0))
        .curve_to(p(18.5, 18.5 - k), p(18.5 - k, 18.5), p(16.0, 18.5))
        .line_to(p(4.0, 18.5))
        .curve_to(p(1.5 + k, 18.5), p(1.5, 18.5 - k), p(1.5, 16.0))
        .line_to(p(1.5, 8.0))
        .curve_to(p(1.5, 8.0 - k), p(1.5 + k, 5.5), p(4.0, 5.5))
        .close()
        .paint(fill, true);
    detail_lines(c, 4.5, 15.5, &[15.0, 12.0, 9.0]);
}

/// A page with a folded corner.
fn note(c: &mut Content, fill: bool) {
    c.polygon(&pts(&[
        (3.0, 1.0),
        (17.0, 1.0),
        (17.0, 14.0),
        (12.0, 19.0),
        (3.0, 19.0),
    ]))
    .paint(fill, true);
    c.polygon(&pts(&[(12.0, 19.0), (12.0, 14.0), (17.0, 14.0)]))
        .stroke();
    detail_lines(c, 5.5, 14.5, &[11.0, 8.0, 5.0]);
}

/// A circle with a question mark.
fn help(c: &mut Content, fill: bool) {
    c.ellipse(Point::new(10.0, 10.0), 8.5, 8.5)
        .paint(fill, true);
    let p = Point::new;
    c.save().stroke_rgb(OUTLINE).line_width(2.0).line_cap(1);
    c.move_to(p(7.0, 12.5))
        .curve_to(p(7.0, 16.0), p(13.0, 16.0), p(13.0, 12.5))
        .curve_to(p(13.0, 10.0), p(10.0, 10.5), p(10.0, 8.0))
        .stroke();
    c.restore();
    c.save()
        .fill_rgb(OUTLINE)
        .ellipse(p(10.0, 4.8), 1.2, 1.2)
        .fill()
        .restore();
}

/// A key: round head and a toothed shaft (both counter-clockwise so the non-zero fill
/// rule unites them).
fn key(c: &mut Content, fill: bool) {
    c.ellipse(Point::new(6.0, 13.0), 4.5, 4.5);
    c.polygon(&pts(&[
        (9.5, 11.8),
        (12.5, 11.8),
        (12.5, 9.5),
        (14.5, 9.5),
        (14.5, 11.8),
        (16.5, 11.8),
        (16.5, 9.0),
        (18.5, 9.0),
        (18.5, 14.2),
        (9.5, 14.2),
    ]));
    c.paint(fill, true);
    c.save()
        .fill_rgb(OUTLINE)
        .ellipse(Point::new(5.0, 13.0), 1.3, 1.3)
        .fill()
        .restore();
}

/// A caret.
fn insert(c: &mut Content, fill: bool) {
    polygon_icon(
        c,
        fill,
        &[
            (2.0, 2.0),
            (10.0, 18.0),
            (18.0, 2.0),
            (14.5, 2.0),
            (10.0, 11.0),
            (5.5, 2.0),
        ],
    );
}

/// A pilcrow (¶).
fn paragraph(c: &mut Content, fill: bool) {
    let p = Point::new;
    c.move_to(p(10.0, 19.0))
        .line_to(p(17.5, 19.0))
        .line_to(p(17.5, 17.0))
        .line_to(p(15.5, 17.0))
        .line_to(p(15.5, 1.0))
        .line_to(p(13.5, 1.0))
        .line_to(p(13.5, 17.0))
        .line_to(p(12.0, 17.0))
        .line_to(p(12.0, 1.0))
        .line_to(p(10.0, 1.0))
        .line_to(p(10.0, 10.0))
        .curve_to(p(4.0, 10.0), p(4.0, 19.0), p(10.0, 19.0))
        .close()
        .paint(fill, true);
}

/// An upward triangle above a small block (new paragraph marker).
fn new_paragraph(c: &mut Content, fill: bool) {
    c.polygon(&pts(&[(10.0, 19.0), (2.5, 8.5), (17.5, 8.5)]));
    c.rect(5.0, 1.5, 10.0, 4.5);
    c.paint(fill, true);
}

const CHECK: [(f64, f64); 6] = [
    (1.5, 10.0),
    (4.5, 13.0),
    (8.0, 8.5),
    (16.5, 18.5),
    (19.0, 16.0),
    (8.0, 2.5),
];

const CROSS: [(f64, f64); 12] = [
    (2.5, 5.0),
    (7.5, 10.0),
    (2.5, 15.0),
    (5.0, 17.5),
    (10.0, 12.5),
    (15.0, 17.5),
    (17.5, 15.0),
    (12.5, 10.0),
    (17.5, 5.0),
    (15.0, 2.5),
    (10.0, 7.5),
    (5.0, 2.5),
];

/// Five-pointed star centred in the box.
fn star() -> Vec<(f64, f64)> {
    (0..10)
        .map(|i| {
            let radius = if i % 2 == 0 { 9.0 } else { 3.8 };
            let angle = std::f64::consts::FRAC_PI_2 + f64::from(i) * std::f64::consts::PI / 5.0;
            (10.0 + radius * angle.cos(), 9.5 + radius * angle.sin())
        })
        .collect()
}

fn polygon_icon(c: &mut Content, fill: bool, coords: &[(f64, f64)]) {
    c.polygon(&pts(coords)).paint(fill, true);
}
