//! Reading existing annotations back into DTOs.

use lopdf::{Dictionary, Object, ObjectId};

use super::build::{FLAG_HIDDEN, FLAG_LOCKED, FLAG_PRINT, STAMP_LABEL_KEY, STAMP_SUBLABEL_KEY};
use crate::dto::{
    AnnotKind, AnnotationDto, BorderStyle, ExistingAnnotation, LineEnding, Rect, Rgb, TextAlign,
};
use crate::error::Result;
use crate::objects::{as_f64, parse_color, ObjectSource};
use crate::pages::{annot_entries, document_pages};
use crate::refs::format_ref;
use crate::text::pdf_date_to_rfc3339;

/// Every annotation of every page, in page order then `/Annots` order. Inline annotation
/// dictionaries (no object number) cannot be addressed and are skipped.
pub fn read_all(src: &impl ObjectSource, trailer: &Dictionary) -> Result<Vec<ExistingAnnotation>> {
    let pages = document_pages(src, trailer)?;
    let mut out = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let Some(page_dict) = src.dict(page.id) else {
            continue;
        };
        let page_index = u32::try_from(index).unwrap_or(u32::MAX);
        for entry in annot_entries(src, page_dict) {
            let Object::Reference(id) = entry else {
                continue;
            };
            if let Some(dict) = src.dict(*id) {
                out.push(existing(src, *id, page_index, dict));
            }
        }
    }
    Ok(out)
}

/// Map a `/Subtype` to the kind the application can edit.
pub fn kind_for_subtype(subtype: &str) -> Option<AnnotKind> {
    let kind = match subtype.to_ascii_lowercase().as_str() {
        "highlight" => AnnotKind::Highlight,
        "underline" => AnnotKind::Underline,
        "strikeout" => AnnotKind::Strikeout,
        "squiggly" => AnnotKind::Squiggly,
        "text" => AnnotKind::Note,
        "freetext" => AnnotKind::Freetext,
        "ink" => AnnotKind::Ink,
        "square" => AnnotKind::Square,
        "circle" => AnnotKind::Circle,
        "line" => AnnotKind::Line,
        "polygon" => AnnotKind::Polygon,
        "polyline" => AnnotKind::Polyline,
        "stamp" => AnnotKind::Stamp,
        _ => return None,
    };
    Some(kind)
}

fn reference(dict: &Dictionary, key: &[u8]) -> Option<ObjectId> {
    dict.get(key).ok()?.as_reference().ok()
}

fn flags(src: &impl ObjectSource, dict: &Dictionary) -> u32 {
    src.get_f64(dict, b"F")
        .map_or(0, |f| f.clamp(0.0, f64::from(u32::MAX)) as u32)
}

fn date(src: &impl ObjectSource, dict: &Dictionary, key: &[u8]) -> Option<String> {
    pdf_date_to_rfc3339(&src.get_text(dict, key)?)
}

fn existing(
    src: &impl ObjectSource,
    id: ObjectId,
    page_index: u32,
    dict: &Dictionary,
) -> ExistingAnnotation {
    let subtype = src
        .get_name(dict, b"Subtype")
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .unwrap_or_default();
    let rect = src.get_rect(dict, b"Rect").unwrap_or_default();
    let flags = flags(src, dict);
    let irt = reference(dict, b"IRT");
    ExistingAnnotation {
        reference: format_ref(id),
        page_index,
        annotation: kind_for_subtype(&subtype)
            .map(|kind| to_dto(src, dict, kind, page_index, rect)),
        subtype,
        rect,
        has_appearance: src.get_dict(dict, b"AP").is_some_and(|ap| ap.has(b"N")),
        popup_ref: reference(dict, b"Popup").map(format_ref),
        in_reply_to_ref: irt.map(format_ref),
        reply_type: irt.map(|_| {
            src.get_name(dict, b"RT").map_or_else(
                || "R".to_string(),
                |n| String::from_utf8_lossy(n).into_owned(),
            )
        }),
        flags,
        contents: src.get_text(dict, b"Contents").unwrap_or_default(),
        author: src.get_text(dict, b"T").unwrap_or_default(),
        modified: date(src, dict, b"M"),
    }
}

fn color(src: &impl ObjectSource, dict: &Dictionary, key: &[u8]) -> Option<Rgb> {
    parse_color(&src.get_numbers(dict, key)?)
}

/// Border width, style and dash pattern from `/BS`, `/Border` and `/BE`.
fn border(src: &impl ObjectSource, dict: &Dictionary) -> (f64, BorderStyle, Vec<f64>) {
    let (mut width, mut style, mut dash) = (1.0, BorderStyle::Solid, Vec::new());
    if let Some(bs) = src.get_dict(dict, b"BS") {
        width = src.get_f64(bs, b"W").unwrap_or(1.0);
        if src.get_name(bs, b"S") == Some(b"D".as_slice()) {
            style = BorderStyle::Dashed;
            dash = src.get_numbers(bs, b"D").unwrap_or_default();
        }
    } else if let Some(values) = dict
        .get(b"Border")
        .ok()
        .map(|b| src.resolve(b))
        .and_then(|b| b.as_array().ok())
    {
        width = values
            .get(2)
            .and_then(|w| as_f64(src.resolve(w)))
            .unwrap_or(1.0);
        if let Some(pattern) = values
            .get(3)
            .and_then(|d| src.numbers(d))
            .filter(|d| !d.is_empty())
        {
            style = BorderStyle::Dashed;
            dash = pattern;
        }
    }
    if src
        .get_dict(dict, b"BE")
        .and_then(|be| src.get_name(be, b"S"))
        == Some(b"C".as_slice())
    {
        style = BorderStyle::Cloudy;
    }
    (width.max(0.0), style, dash)
}

fn line_ending(object: &Object) -> LineEnding {
    match object.as_name().unwrap_or_default() {
        b"Square" => LineEnding::Square,
        b"Circle" => LineEnding::Circle,
        b"Diamond" => LineEnding::Diamond,
        b"OpenArrow" => LineEnding::OpenArrow,
        b"ClosedArrow" => LineEnding::ClosedArrow,
        b"Butt" => LineEnding::Butt,
        b"ROpenArrow" => LineEnding::ROpenArrow,
        b"RClosedArrow" => LineEnding::RClosedArrow,
        b"Slash" => LineEnding::Slash,
        _ => LineEnding::None,
    }
}

fn line_endings(src: &impl ObjectSource, dict: &Dictionary) -> [LineEnding; 2] {
    let items = src.get_array(dict, b"LE").unwrap_or_default();
    let get = |i: usize| {
        items
            .get(i)
            .map_or(LineEnding::None, |o| line_ending(src.resolve(o)))
    };
    [get(0), get(1)]
}

/// Font size and colour from a default-appearance string such as `/Helv 12 Tf 1 0 0 rg`.
pub fn parse_default_appearance(da: &str) -> (Option<f64>, Option<Rgb>) {
    let (mut size, mut color) = (None, None);
    let mut operands: Vec<f64> = Vec::new();
    for token in da.split_whitespace() {
        if let Ok(value) = token.parse::<f64>() {
            operands.push(value);
            continue;
        }
        if token.starts_with('/') {
            continue;
        }
        let tail = |n: usize| {
            operands
                .len()
                .checked_sub(n)
                .map(|start| &operands[start..])
        };
        match token {
            "Tf" => size = tail(1).map(|v| v[0]).filter(|s| *s > 0.0).or(size),
            "g" | "rg" | "k" => {
                let n = match token {
                    "g" => 1,
                    "rg" => 3,
                    _ => 4,
                };
                color = tail(n).and_then(parse_color).or(color);
            }
            _ => {}
        }
        operands.clear();
    }
    (size, color)
}

fn ink_list(src: &impl ObjectSource, dict: &Dictionary) -> Vec<Vec<f64>> {
    src.get_array(dict, b"InkList")
        .unwrap_or_default()
        .iter()
        .filter_map(|stroke| src.numbers(stroke))
        .collect()
}

/// A full DTO for an annotation whose subtype maps to `kind`.
fn to_dto(
    src: &impl ObjectSource,
    dict: &Dictionary,
    kind: AnnotKind,
    page_index: u32,
    rect: Rect,
) -> AnnotationDto {
    let flags = i64::from(flags(src, dict));
    let (border_width, border_style, dash) = border(src, dict);
    let da = src
        .get_text(dict, b"DA")
        .map(|da| parse_default_appearance(&da))
        .unwrap_or_default();
    let text = |key: &[u8]| src.get_text(dict, key).filter(|t| !t.is_empty());
    let line = src
        .get_numbers(dict, b"L")
        .and_then(|l| <[f64; 4]>::try_from(l.get(..4)?).ok());
    let name = src
        .get_name(dict, b"Name")
        .map(|n| String::from_utf8_lossy(n).into_owned());
    let is_stamp = kind == AnnotKind::Stamp;
    AnnotationDto {
        kind,
        page_index,
        rect,
        color: color(src, dict, b"C"),
        interior_color: color(src, dict, b"IC"),
        opacity: src.get_f64(dict, b"CA").map_or(1.0, |v| v.clamp(0.0, 1.0)),
        border_width,
        border_style,
        dash,
        contents: src.get_text(dict, b"Contents").unwrap_or_default(),
        author: src.get_text(dict, b"T").unwrap_or_default(),
        subject: text(b"Subj"),
        nm: src.get_text(dict, b"NM").unwrap_or_default(),
        created: date(src, dict, b"CreationDate"),
        modified: date(src, dict, b"M"),
        hidden: flags & FLAG_HIDDEN != 0,
        print: flags & FLAG_PRINT != 0,
        locked: flags & FLAG_LOCKED != 0,
        quad_points: src.get_numbers(dict, b"QuadPoints").unwrap_or_default(),
        ink_list: ink_list(src, dict),
        vertices: src.get_numbers(dict, b"Vertices").unwrap_or_default(),
        line,
        line_endings: line_endings(src, dict),
        icon: if kind == AnnotKind::Note {
            name.clone()
        } else {
            None
        },
        font_size: da.0.unwrap_or(12.0),
        font_color: da.1,
        text_align: match src.get_f64(dict, b"Q").map(|q| q.round() as i64) {
            Some(1) => TextAlign::Center,
            Some(2) => TextAlign::Right,
            _ => TextAlign::Left,
        },
        stamp_label: if is_stamp {
            text(STAMP_LABEL_KEY).or(name)
        } else {
            None
        },
        stamp_sublabel: if is_stamp {
            text(STAMP_SUBLABEL_KEY)
        } else {
            None
        },
        stamp_image: None,
        in_reply_to_ref: reference(dict, b"IRT").map(format_ref),
        in_reply_to_nm: None,
        state: text(b"State"),
        state_model: text(b"StateModel"),
        open: matches!(src.get(dict, b"Open"), Some(Object::Boolean(true))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_appearance() {
        assert_eq!(
            parse_default_appearance("/Helv 12 Tf 1 0 0 rg"),
            (Some(12.0), Some([1.0, 0.0, 0.0]))
        );
        assert_eq!(
            parse_default_appearance("0.5 g /F1 9.5 Tf"),
            (Some(9.5), Some([0.5; 3]))
        );
        assert_eq!(
            parse_default_appearance("/Cour 0 Tf 0 0 0 1 k"),
            (None, Some([0.0; 3]))
        );
        assert_eq!(parse_default_appearance("rg Tf garbage"), (None, None));
    }

    #[test]
    fn maps_subtypes() {
        assert_eq!(kind_for_subtype("StrikeOut"), Some(AnnotKind::Strikeout));
        assert_eq!(kind_for_subtype("PolyLine"), Some(AnnotKind::Polyline));
        assert_eq!(kind_for_subtype("Text"), Some(AnnotKind::Note));
        assert_eq!(kind_for_subtype("Link"), None);
    }
}
