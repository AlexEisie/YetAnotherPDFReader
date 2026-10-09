//! Text and picture watermarks, drawn into the page content (marked as a pagination
//! artifact) above or below the original content.

use std::collections::{HashMap, HashSet};

use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};

use crate::content::{fmt_num, Content};
use crate::dto::{WatermarkLayer, WatermarkPosition, WatermarkSpec};
use crate::error::{PdfError, Result};
use crate::fonts::{font_objects, split_runs, CjkCollection, FontKey, Measure};
use crate::imaging::add_picture;
use crate::load::Revision;
use crate::page_edit::{add_resource, mul, rotate, translate, view, wrap_contents, Matrix};
use crate::pages::PageRef;

const MAX_TEXT_CHARS: usize = 500;
const MAX_LINES: usize = 20;

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
}

/// The watermark drawn once as a form XObject.
struct Block {
    form: ObjectId,
    /// Natural size of the form in its own units.
    width: f64,
    height: f64,
    /// Fraction of the page width the block takes (pictures), or `None` for text (points).
    page_fraction: Option<f64>,
}

fn matrix_string(m: Matrix) -> String {
    let nums: Vec<String> = m.iter().map(|v| fmt_num(*v)).collect();
    format!("{} cm", nums.join(" "))
}

fn text_block(rev: &mut Revision, spec: &WatermarkSpec, text: &str) -> Result<Block> {
    let size = if spec.font_size.is_finite() { spec.font_size.clamp(4.0, 500.0) } else { 48.0 };
    let lines: Vec<&str> = text.lines().map(str::trim_end).take(MAX_LINES).collect();
    if lines.iter().all(|l| l.trim().is_empty()) {
        return Err(invalid("the watermark text is empty"));
    }
    let latin = if spec.bold { FontKey::HelveticaBold } else { FontKey::Helvetica };
    let cjk = CjkCollection::for_text(text, CjkCollection::from_hint(spec.cjk_hint.as_deref()));
    let measure = Measure { latin, cjk, size };
    let line_height = size * 1.25;
    let width = lines.iter().map(|l| measure.text(l)).fold(1.0_f64, f64::max);
    let height = line_height * lines.len() as f64;

    let mut fonts: HashMap<FontKey, ObjectId> = HashMap::new();
    let mut content = Content::default();
    let [r, g, b] = spec.color.map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.5 });
    content.fill_rgb([r, g, b]).stroke_rgb([r, g, b]);
    content.begin_text();
    for (i, line) in lines.iter().enumerate() {
        let mut x = (width - measure.text(line)) / 2.0;
        let y = height - (i as f64 + 1.0) * line_height + (line_height - size) / 2.0 + size * 0.22;
        for run in split_runs(line, latin, cjk) {
            if let std::collections::hash_map::Entry::Vacant(slot) = fonts.entry(run.font) {
                slot.insert(add_font(rev, run.font));
            }
            // Faux bold for CJK fonts, which have no bold face: fill and stroke the glyphs.
            let faux_bold = spec.bold && matches!(run.font, FontKey::Cjk(_));
            content.font(run.font.resource_name(), size);
            if faux_bold {
                content.line_width(size * 0.025);
                content.render_mode(2);
            } else {
                content.render_mode(0);
            }
            content.text_origin(x, y);
            match run.font {
                FontKey::Cjk(_) => content.show_hex(&run.encode()),
                _ => content.show_literal(&run.encode()),
            };
            x += measure.text(&run.text);
        }
    }
    content.end_text();
    let font_dict: Dictionary = fonts
        .iter()
        .map(|(key, id)| (key.resource_name().as_bytes().to_vec(), Object::Reference(*id)))
        .collect();
    let form = rev.add(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), Object::Real(width as f32), Object::Real(height as f32)],
            "Resources" => dictionary! { "Font" => font_dict },
        },
        content.into_bytes(),
    ));
    Ok(Block { form, width, height, page_fraction: None })
}

fn add_font(rev: &mut Revision, key: FontKey) -> ObjectId {
    let objects = font_objects(key);
    let mut font = objects.font;
    if let Some((mut cid_font, descriptor)) = objects.descendant {
        let descriptor_id = rev.add(descriptor);
        cid_font.set("FontDescriptor", descriptor_id);
        let cid_id = rev.add(cid_font);
        font.set("DescendantFonts", vec![Object::Reference(cid_id)]);
    }
    rev.add(font)
}

fn picture_block(rev: &mut Revision, spec: &WatermarkSpec, blobs: &[&[u8]]) -> Result<Block> {
    let image = spec.image.as_ref().ok_or_else(|| invalid("no watermark picture"))?;
    let picture = add_picture(image, blobs, |o| rev.add(o))?;
    let (w, h) = (f64::from(picture.width), f64::from(picture.height));
    let m = picture.placement(0.0, 0.0, w, h);
    let content = format!("q {} /Im0 Do Q\n", matrix_string(m));
    let form = rev.add(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), Object::Real(w as f32), Object::Real(h as f32)],
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => picture.id } },
        },
        content.into_bytes(),
    ));
    let fraction = if spec.image_scale.is_finite() { spec.image_scale.clamp(0.02, 1.0) } else { 0.4 };
    Ok(Block { form, width: w, height: h, page_fraction: Some(fraction) })
}

/// Centres of the watermark copies on a `page_w`×`page_h` displayed page for a `bw`×`bh`
/// block rotated by `degrees`.
fn placements(position: WatermarkPosition, page_w: f64, page_h: f64, bw: f64, bh: f64, degrees: f64) -> Vec<(f64, f64)> {
    let (sin, cos) = degrees.to_radians().sin_cos();
    let hw = (bw * cos.abs() + bh * sin.abs()) / 2.0;
    let hh = (bw * sin.abs() + bh * cos.abs()) / 2.0;
    let margin = (page_w.min(page_h) * 0.06).clamp(12.0, 48.0);
    use WatermarkPosition as P;
    if position == P::Tile {
        // A staggered grid in the block's own (rotated) frame: rows run along the text, so
        // copies never overlap whatever the angle.
        let gap = (bh * 0.8).clamp(16.0, 96.0);
        let (step_x, step_y) = (bw + gap * 1.5, bh + gap * 1.5);
        let reach = (page_w.hypot(page_h) / 2.0) + bw.max(bh);
        let cols = (reach / step_x).ceil() as i64 + 1;
        let rows = (reach / step_y).ceil() as i64 + 1;
        let (cx, cy) = (page_w / 2.0, page_h / 2.0);
        let mut out = Vec::new();
        for row in -rows.min(150)..=rows.min(150) {
            let shift = if row.rem_euclid(2) == 1 { step_x / 2.0 } else { 0.0 };
            for col in -cols.min(150)..=cols.min(150) {
                let (lx, ly) = (col as f64 * step_x + shift, row as f64 * step_y);
                let (x, y) = (cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
                if x > -hw && x < page_w + hw && y > -hh && y < page_h + hh {
                    out.push((x, y));
                }
            }
        }
        return out;
    }
    let x = match position {
        P::Left | P::TopLeft | P::BottomLeft => margin + hw,
        P::Right | P::TopRight | P::BottomRight => page_w - margin - hw,
        _ => page_w / 2.0,
    };
    let y = match position {
        P::Top | P::TopLeft | P::TopRight => page_h - margin - hh,
        P::Bottom | P::BottomLeft | P::BottomRight => margin + hh,
        _ => page_h / 2.0,
    };
    vec![(x, y)]
}

/// Draw the watermark on the selected pages.
pub fn apply_watermark(
    rev: &mut Revision,
    pages: &[PageRef],
    selected: &[u32],
    spec: &WatermarkSpec,
    blobs: &[&[u8]],
) -> Result<()> {
    if selected.is_empty() {
        return Err(invalid("no pages selected for the watermark"));
    }
    let block = match (&spec.image, spec.text.as_deref()) {
        (Some(_), _) => picture_block(rev, spec, blobs)?,
        (None, Some(text)) => {
            let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
            text_block(rev, spec, &text)?
        }
        (None, None) => return Err(invalid("the watermark needs a text or a picture")),
    };
    let opacity = if spec.opacity.is_finite() { spec.opacity.clamp(0.01, 1.0) } else { 0.3 };
    let gs = rev.add(dictionary! {
        "Type" => "ExtGState",
        "CA" => Object::Real(opacity as f32),
        "ca" => Object::Real(opacity as f32),
    });
    let rotation = if spec.rotation.is_finite() { spec.rotation % 360.0 } else { 0.0 };

    let mut done = HashSet::new();
    for &index in selected {
        let page = pages.get(index as usize).ok_or_else(|| {
            invalid(format!("page index {index} is out of range (document has {} pages)", pages.len()))
        })?;
        if !done.insert(page.id) {
            continue;
        }
        let v = view(&*rev, page);
        let scale = match block.page_fraction {
            Some(fraction) => fraction * v.width / block.width,
            None => 1.0,
        };
        let (bw, bh) = (block.width * scale, block.height * scale);
        let gs_name = add_resource(rev, page, "ExtGState", "YaprWmGs", Object::Reference(gs))?;
        let form_name = add_resource(rev, page, "XObject", "YaprWm", Object::Reference(block.form))?;

        let mut draw = String::from("q\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC\n");
        draw.push_str(&matrix_string(v.to_user));
        draw.push('\n');
        draw.push_str(&format!("0 0 {} {} re W n\n", fmt_num(v.width), fmt_num(v.height)));
        draw.push_str(&format!("/{gs_name} gs\n"));
        for (cx, cy) in placements(spec.position, v.width, v.height, bw, bh, rotation) {
            let m = mul(
                mul(
                    mul([scale, 0.0, 0.0, scale, 0.0, 0.0], translate(-bw / 2.0, -bh / 2.0)),
                    rotate(rotation),
                ),
                translate(cx, cy),
            );
            draw.push_str(&format!("q {} /{form_name} Do Q\n", matrix_string(m)));
        }
        draw.push_str("EMC\nQ\n");
        match spec.layer {
            WatermarkLayer::Above => wrap_contents(rev, page.id, b"", None, draw.as_bytes())?,
            WatermarkLayer::Below => wrap_contents(rev, page.id, draw.as_bytes(), None, b"")?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_positions_stay_inside_the_page() {
        for position in [
            WatermarkPosition::Center,
            WatermarkPosition::TopLeft,
            WatermarkPosition::BottomRight,
            WatermarkPosition::Top,
        ] {
            let spots = placements(position, 600.0, 800.0, 200.0, 40.0, 0.0);
            assert_eq!(spots.len(), 1);
            let (x, y) = spots[0];
            assert!(x - 100.0 >= 0.0 && x + 100.0 <= 600.0, "{position:?}");
            assert!(y - 20.0 >= 0.0 && y + 20.0 <= 800.0, "{position:?}");
        }
    }

    #[test]
    fn tiles_cover_the_page() {
        let spots = placements(WatermarkPosition::Tile, 600.0, 800.0, 160.0, 60.0, 45.0);
        assert!(spots.len() > 6);
        // No two copies closer than the block height (they would overlap).
        for (i, a) in spots.iter().enumerate() {
            for b in &spots[i + 1..] {
                assert!((a.0 - b.0).hypot(a.1 - b.1) >= 60.0);
            }
        }
        assert!(spots.iter().any(|&(x, y)| x < 80.0 && y < 80.0));
        assert!(spots.iter().any(|&(x, y)| x > 520.0 && y > 720.0));
    }
}
