//! Invisible text layer (OCR): recognised lines are written with text rendering mode 3
//! ("neither fill nor stroke") exactly over the picture of the text, so scanned pages become
//! searchable, selectable and copyable while looking unchanged.

use std::collections::{HashMap, HashSet};

use lopdf::{Object, ObjectId};

use crate::content::fmt_num;
use crate::dto::{TextLayerLine, TextLayerPage};
use crate::error::{PdfError, Result};
use crate::fonts::{font_objects, split_runs, CjkCollection, FontKey, Measure};
use crate::load::Revision;
use crate::page_edit::{add_resource, wrap_contents};
use crate::pages::PageRef;

/// Upper bound of lines per page (protects against runaway input).
const MAX_LINES: usize = 20_000;

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn literal(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 2);
    out.push('(');
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(b as char);
            }
            0x20..=0x7E => out.push(b as char),
            _ => out.push_str(&format!("\\{b:03o}")),
        }
    }
    out.push(')');
    out
}

/// Operators drawing one line; `fonts` maps font keys to resource names of the page.
fn draw_line(line: &TextLayerLine, cjk: CjkCollection, fonts: &HashMap<FontKey, String>, out: &mut String) {
    let q = line.quad;
    if q.iter().any(|v| !v.is_finite()) {
        return;
    }
    let (tl, tr, bl) = ((q[0], q[1]), (q[2], q[3]), (q[6], q[7]));
    let br = (q[4], q[5]);
    // Direction of the text (average of the top and bottom edges) and its "up" vector.
    let dx = ((tr.0 - tl.0) + (br.0 - bl.0)) / 2.0;
    let dy = ((tr.1 - tl.1) + (br.1 - bl.1)) / 2.0;
    let width = dx.hypot(dy);
    let (ux, uy) = if width > 0.0 { (dx / width, dy / width) } else { return };
    // Height measured perpendicular to the baseline.
    let height = ((tl.0 - bl.0) * -uy + (tl.1 - bl.1) * ux).abs();
    if width < 0.5 || height < 0.5 {
        return;
    }
    // "Up" is perpendicular to the text direction, towards the top edge.
    let side = if (tl.0 - bl.0) * -uy + (tl.1 - bl.1) * ux >= 0.0 { 1.0 } else { -1.0 };
    let (vx, vy) = (-uy * side, ux * side);
    let runs = split_runs(&line.text, FontKey::Helvetica, cjk);
    let measure = Measure { latin: FontKey::Helvetica, cjk, size: 1.0 };
    let natural: f64 = runs.iter().map(|r| measure.text(&r.text)).sum();
    if natural <= 0.0 {
        return;
    }
    let size = height * 0.9;
    // Horizontal scaling makes the text span exactly the recognised box.
    let stretch = width / (natural * size);
    let baseline = (bl.0 + vx * height * 0.18, bl.1 + vy * height * 0.18);
    let mut advance = 0.0;
    for run in runs {
        let Some(name) = fonts.get(&run.font) else { continue };
        let origin = (baseline.0 + ux * advance * size * stretch, baseline.1 + uy * advance * size * stretch);
        let m = [ux * stretch, uy * stretch, vx, vy, origin.0, origin.1];
        let nums: Vec<String> = m.iter().map(|v| fmt_num(*v)).collect();
        let shown = match run.font {
            FontKey::Cjk(_) => format!("<{}>", hex(&run.encode())),
            _ => literal(&run.encode()),
        };
        out.push_str(&format!("/{name} {} Tf {} Tm {shown} Tj\n", fmt_num(size), nums.join(" ")));
        advance += measure.text(&run.text);
    }
}

/// Write the invisible text of `layers` into the pages.
pub fn apply_text_layer(rev: &mut Revision, pages: &[PageRef], layers: &[TextLayerPage], cjk_hint: Option<&str>) -> Result<()> {
    let hint = CjkCollection::from_hint(cjk_hint);
    let mut font_ids: HashMap<FontKey, ObjectId> = HashMap::new();
    let mut done = HashSet::new();
    for layer in layers {
        let page = pages.get(layer.page as usize).ok_or_else(|| {
            invalid(format!("page index {} is out of range (document has {} pages)", layer.page, pages.len()))
        })?;
        if !done.insert(layer.page) {
            return Err(invalid(format!("page {} appears twice", layer.page)));
        }
        if layer.lines.len() > MAX_LINES {
            return Err(invalid(format!("too many text lines on page {}", layer.page)));
        }
        let lines: Vec<&TextLayerLine> = layer.lines.iter().filter(|l| !l.text.trim().is_empty()).collect();
        if lines.is_empty() {
            continue;
        }
        let all_text: String = lines.iter().map(|l| l.text.as_str()).collect();
        let cjk = CjkCollection::for_text(&all_text, hint);
        // Fonts used on this page, added to its resources.
        let mut needed: Vec<FontKey> = Vec::new();
        for line in &lines {
            for run in split_runs(&line.text, FontKey::Helvetica, cjk) {
                if !needed.contains(&run.font) {
                    needed.push(run.font);
                }
            }
        }
        let mut names = HashMap::new();
        for key in needed {
            let id = match font_ids.get(&key) {
                Some(id) => *id,
                None => {
                    let id = add_font(rev, key);
                    font_ids.insert(key, id);
                    id
                }
            };
            let name = add_resource(rev, page, "Font", "YaprOcr", Object::Reference(id))?;
            names.insert(key, name);
        }
        let mut content = String::from("q\nBT\n3 Tr\n");
        for line in lines {
            draw_line(line, cjk, &names, &mut content);
        }
        content.push_str("ET\nQ\n");
        wrap_contents(rev, page.id, b"", None, content.as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_matrix_spans_the_box() {
        let mut fonts = HashMap::new();
        fonts.insert(FontKey::Helvetica, "F0".to_string());
        let line = TextLayerLine { text: "Hello".into(), quad: [100.0, 220.0, 300.0, 220.0, 300.0, 200.0, 100.0, 200.0] };
        let mut out = String::new();
        draw_line(&line, CjkCollection::Gb1, &fonts, &mut out);
        // Font size 18 (0.9 × height 20); the baseline sits 3.6 above the bottom edge.
        assert!(out.starts_with("/F0 18 Tf "), "{out}");
        assert!(out.contains(" 0 0 1 100 203.6 Tm (Hello) Tj"), "{out}");
        // Upside-down quads (page rotated by 180°) keep "up" pointing to the top edge.
        let flipped = TextLayerLine { text: "Hi".into(), quad: [300.0, 200.0, 100.0, 200.0, 100.0, 220.0, 300.0, 220.0] };
        let mut out = String::new();
        draw_line(&flipped, CjkCollection::Gb1, &fonts, &mut out);
        assert!(out.contains(" -0 -1 300 216.4 Tm") || out.contains(" 0 -1 300 216.4 Tm"), "{out}");
    }

    #[test]
    fn skips_degenerate_lines() {
        let fonts = HashMap::from([(FontKey::Helvetica, "F0".to_string())]);
        let mut out = String::new();
        let line = TextLayerLine { text: "x".into(), quad: [0.0; 8] };
        draw_line(&line, CjkCollection::Gb1, &fonts, &mut out);
        assert!(out.is_empty());
    }
}
