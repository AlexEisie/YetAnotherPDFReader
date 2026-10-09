//! Text-markup appearances: highlight, underline, strike-out and squiggly.

use super::Appearance;
use crate::dto::{AnnotKind, AnnotationDto, Rect};
use crate::error::Result;
use crate::geometry::{bounding_box, pad_rect, Point, Quad};

/// Union of all quads, padded so strokes drawn near the edges are not clipped.
pub fn rect(quads: &[Quad]) -> Result<Rect> {
    let corners = quads.iter().flat_map(Quad::outline);
    let max_height = quads.iter().map(Quad::height).fold(0.0, f64::max);
    let bbox = bounding_box(corners).ok_or_else(|| super::invalid("quadPoints are empty"))?;
    Ok(pad_rect(bbox, 1.0 + max_height * 0.1))
}

/// Stroke thickness for a quad of the given height.
fn thickness(height: f64) -> f64 {
    (height / 14.0).max(0.5)
}

pub fn draw(ap: &mut Appearance, dto: &AnnotationDto, quads: &[Quad]) {
    let Some(color) = dto.color else { return };
    if dto.kind == AnnotKind::Highlight {
        ap.opacity(dto.opacity, Some("Multiply"));
        ap.content.fill_rgb(color);
        for quad in quads {
            ap.content.polygon(&quad.outline());
        }
        ap.content.fill();
        return;
    }
    ap.opacity(dto.opacity, None);
    ap.content.stroke_rgb(color);
    for quad in quads {
        let t = thickness(quad.height());
        ap.content.line_width(t);
        match dto.kind {
            AnnotKind::Strikeout => {
                let (a, b) = quad.line_at(0.5);
                ap.content.move_to(a).line_to(b);
            }
            AnnotKind::Squiggly => {
                let pts = squiggle(quad, t);
                ap.content.polyline(&pts);
            }
            _ => {
                let up = quad.up() * (t / 2.0 + quad.height() * 0.04);
                ap.content.move_to(quad.ll + up).line_to(quad.lr + up);
            }
        }
        ap.content.stroke();
    }
}

/// Zig-zag points along the bottom of `quad`, following the quad's own baseline.
fn squiggle(quad: &Quad, thickness: f64) -> Vec<Point> {
    let height = quad.height();
    let period = (height / 4.0).max(1.0);
    let amplitude = period / 2.0;
    let dir = quad.direction();
    let up = quad.up();
    let length = (quad.lr - quad.ll).length();
    let base = quad.ll + up * (thickness / 2.0 + height * 0.02);
    let half = period / 2.0;
    let steps = (length / half).ceil().max(1.0) as usize;
    (0..=steps)
        .map(|i| {
            let along = (i as f64 * half).min(length);
            let rise = if i % 2 == 1 { amplitude } else { 0.0 };
            base + dir * along + up * rise
        })
        .collect()
}
