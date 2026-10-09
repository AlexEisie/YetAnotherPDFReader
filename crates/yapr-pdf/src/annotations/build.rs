//! Annotation dictionaries built from DTOs.

use lopdf::{dictionary, Dictionary, Object, ObjectId};

use crate::appearance::{
    border_width, clamp_opacity, dash_pattern, default_appearance, default_style, rich_text,
    stamp_name, NOTE_ICON_SIZE,
};
use crate::dto::{AnnotKind, AnnotationDto, BorderStyle, Rect, TextAlign};
use crate::objects::{color_array, name, num, num_array};
use crate::text::{rfc3339_to_pdf_date, text_string};

pub const FLAG_HIDDEN: i64 = 2;
pub const FLAG_PRINT: i64 = 4;
pub const FLAG_NO_ZOOM: i64 = 8;
pub const FLAG_NO_ROTATE: i64 = 16;
pub const FLAG_LOCKED: i64 = 128;

/// Private keys preserving the exact text of a text stamp (the `/Name` is sanitised).
pub const STAMP_LABEL_KEY: &[u8] = b"YAPRStampLabel";
pub const STAMP_SUBLABEL_KEY: &[u8] = b"YAPRStampSublabel";

/// Size of popups created for sticky notes.
const POPUP_SIZE: (f64, f64) = (180.0, 120.0);

/// Keys describing geometry and style; they are dropped before an annotation is regenerated
/// so that stale entries of a previous kind (or features the DTO cannot express, such as
/// callouts and leader lines) cannot contradict the new appearance.
pub const MANAGED_KEYS: [&[u8]; 33] = [
    b"Rect",
    b"Rotate",
    b"IT",
    b"CL",
    b"LL",
    b"LLE",
    b"LLO",
    b"Cap",
    b"CP",
    b"CO",
    b"ca",
    b"QuadPoints",
    b"InkList",
    b"Vertices",
    b"L",
    b"LE",
    b"IC",
    b"BS",
    b"Border",
    b"BE",
    b"DA",
    b"DS",
    b"RC",
    b"Q",
    b"Name",
    b"AP",
    b"AS",
    b"RD",
    b"Open",
    b"State",
    b"StateModel",
    STAMP_LABEL_KEY,
    STAMP_SUBLABEL_KEY,
];

/// Whether the DTO describes a reply to another annotation.
pub fn is_reply(dto: &AnnotationDto) -> bool {
    dto.in_reply_to_ref.is_some() || dto.in_reply_to_nm.is_some()
}

/// The `/F` value for `dto`, keeping all bits of `existing` that the DTO does not model.
pub fn merged_flags(existing: i64, dto: &AnnotationDto) -> i64 {
    let mut flags = existing & !(FLAG_HIDDEN | FLAG_PRINT | FLAG_LOCKED);
    for (on, bit) in [
        (dto.hidden, FLAG_HIDDEN),
        (dto.print, FLAG_PRINT),
        (dto.locked, FLAG_LOCKED),
    ] {
        if on {
            flags |= bit;
        }
    }
    flags
}

/// Base flags of a new annotation (icons do not zoom or rotate).
fn initial_flags(dto: &AnnotationDto) -> i64 {
    let icon_like = dto.kind == AnnotKind::Note || is_reply(dto);
    merged_flags(
        if icon_like {
            FLAG_NO_ZOOM | FLAG_NO_ROTATE
        } else {
            0
        },
        dto,
    )
}

/// A PDF date for an optional RFC 3339 value, falling back to `now`.
fn pdf_date(value: Option<&str>, now: &str) -> Object {
    text_string(
        &value
            .and_then(rfc3339_to_pdf_date)
            .unwrap_or_else(|| now.to_string()),
    )
}

/// Update the descriptive entries shared by every markup annotation:
/// `/Contents`, `/T`, `/Subj`, `/M`, `/C`, `/CA` and `/F`.
pub fn apply_common(dict: &mut Dictionary, dto: &AnnotationDto, now: &str) {
    dict.set("Contents", text_string(&dto.contents));
    if dto.author.is_empty() {
        dict.remove(b"T");
    } else {
        dict.set("T", text_string(&dto.author));
    }
    match dto.subject.as_deref().filter(|s| !s.is_empty()) {
        Some(subject) => dict.set("Subj", text_string(subject)),
        None => {
            dict.remove(b"Subj");
        }
    }
    dict.set("M", pdf_date(dto.modified.as_deref(), now));
    dict.set(
        "C",
        dto.color.map_or(Object::Array(Vec::new()), color_array),
    );
    dict.set("CA", num(clamp_opacity(dto.opacity)));
    let existing = dict
        .get(b"F")
        .ok()
        .and_then(|f| f.as_i64().ok())
        .unwrap_or(0);
    dict.set("F", merged_flags(existing, dto));
}

/// The complete dictionary of a new annotation (without `/P`, `/AP`, `/Popup`, `/IRT`).
pub fn annotation_dict(dto: &AnnotationDto, rect: Rect, nm: &str, now: &str) -> Dictionary {
    let mut dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => dto.kind.subtype(),
        "Rect" => num_array(&rect),
        "F" => initial_flags(dto),
        "NM" => text_string(nm),
        "CreationDate" => pdf_date(dto.created.as_deref(), now),
    };
    apply_common(&mut dict, dto, now);
    apply_kind_keys(&mut dict, dto);
    dict
}

/// The dictionary of a reply (`/Subtype /Text` without appearance) placed at the parent's
/// top-left corner.
pub fn reply_dict(
    dto: &AnnotationDto,
    parent: ObjectId,
    parent_rect: Rect,
    nm: &str,
    now: &str,
) -> Dictionary {
    let [x1, _, _, y2] = parent_rect;
    let rect = [x1, y2 - NOTE_ICON_SIZE, x1 + NOTE_ICON_SIZE, y2];
    let mut dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Text",
        "Rect" => num_array(&rect),
        "F" => initial_flags(dto),
        "NM" => text_string(nm),
        "CreationDate" => pdf_date(dto.created.as_deref(), now),
        "IRT" => parent,
        "RT" => "R",
        "Name" => "Comment",
    };
    apply_common(&mut dict, dto, now);
    apply_state(&mut dict, dto);
    dict
}

/// The pop-up of a sticky note: to the right of the icon, or to its left when that would
/// leave the page.
pub fn popup_dict(parent: ObjectId, icon: Rect, page_box: Rect) -> Dictionary {
    let (w, h) = POPUP_SIZE;
    let mut x = icon[2] + 4.0;
    if x + w > page_box[2] && icon[0] - 4.0 - w >= page_box[0] {
        x = icon[0] - 4.0 - w;
    }
    let top = icon[3].min(page_box[3]).max(page_box[1] + h);
    dictionary! {
        "Type" => "Annot",
        "Subtype" => "Popup",
        "Rect" => num_array(&[x, top - h, x + w, top]),
        "Parent" => parent,
        "Open" => false,
        "F" => FLAG_PRINT | FLAG_NO_ZOOM | FLAG_NO_ROTATE,
    }
}

/// `/State` and `/StateModel` (the model defaults from the state).
pub fn apply_state(dict: &mut Dictionary, dto: &AnnotationDto) {
    if let Some(state) = dto.state.as_deref().filter(|s| !s.is_empty()) {
        dict.set("State", text_string(state));
        let model = dto
            .state_model
            .as_deref()
            .filter(|m| !m.is_empty())
            .unwrap_or(match state {
                "Marked" | "Unmarked" => "Marked",
                _ => "Review",
            });
        dict.set("StateModel", text_string(model));
    }
}

/// `/BS` (and `/BE` for cloudy borders).
fn apply_border(dict: &mut Dictionary, dto: &AnnotationDto) {
    let mut bs = dictionary! { "Type" => "Border", "W" => num(border_width(dto)) };
    match dto.border_style {
        BorderStyle::Dashed => {
            bs.set("S", "D");
            bs.set("D", num_array(&dash_pattern(dto)));
        }
        BorderStyle::Solid | BorderStyle::Cloudy => bs.set("S", "S"),
    }
    dict.set("BS", bs);
    if dto.border_style == BorderStyle::Cloudy {
        dict.set("BE", dictionary! { "S" => "C", "I" => 1 });
    }
}

fn set_interior(dict: &mut Dictionary, dto: &AnnotationDto) {
    if let Some(color) = dto.interior_color {
        dict.set("IC", color_array(color));
    }
}

fn line_endings(dto: &AnnotationDto) -> Object {
    Object::Array(
        dto.line_endings
            .iter()
            .map(|e| name(e.pdf_name()))
            .collect(),
    )
}

/// Kind-specific geometry and style entries.
fn apply_kind_keys(dict: &mut Dictionary, dto: &AnnotationDto) {
    match dto.kind {
        AnnotKind::Highlight
        | AnnotKind::Underline
        | AnnotKind::Strikeout
        | AnnotKind::Squiggly => {
            dict.set("QuadPoints", num_array(&dto.quad_points));
        }
        AnnotKind::Note => {
            dict.set(
                "Name",
                name(
                    dto.icon
                        .as_deref()
                        .filter(|i| !i.is_empty())
                        .unwrap_or("Comment"),
                ),
            );
            dict.set("Open", dto.open);
        }
        AnnotKind::Freetext => {
            apply_border(dict, dto);
            set_interior(dict, dto);
            dict.set("DA", text_string(&default_appearance(dto)));
            dict.set("DS", text_string(&default_style(dto)));
            dict.set("RC", text_string(&rich_text(dto)));
            let q = match dto.text_align {
                TextAlign::Left => 0,
                TextAlign::Center => 1,
                TextAlign::Right => 2,
            };
            dict.set("Q", q);
        }
        AnnotKind::Ink => {
            apply_border(dict, dto);
            dict.set(
                "InkList",
                Object::Array(dto.ink_list.iter().map(|s| num_array(s)).collect()),
            );
        }
        AnnotKind::Square | AnnotKind::Circle => {
            apply_border(dict, dto);
            set_interior(dict, dto);
        }
        AnnotKind::Line => {
            apply_border(dict, dto);
            set_interior(dict, dto);
            dict.set("L", num_array(&dto.line.unwrap_or_default()));
            dict.set("LE", line_endings(dto));
        }
        AnnotKind::Polygon | AnnotKind::Polyline => {
            apply_border(dict, dto);
            set_interior(dict, dto);
            dict.set("Vertices", num_array(&dto.vertices));
            if dto.kind == AnnotKind::Polyline {
                dict.set("LE", line_endings(dto));
            }
        }
        AnnotKind::Stamp => apply_stamp_keys(dict, dto),
    }
    apply_state(dict, dto);
}

fn apply_stamp_keys(dict: &mut Dictionary, dto: &AnnotationDto) {
    if dto.stamp_image.is_some() {
        return;
    }
    let label = dto.stamp_label.as_deref().filter(|l| !l.trim().is_empty());
    dict.set("Name", name(&stamp_name(label.unwrap_or("Draft"))));
    if let Some(label) = label {
        dict.set(STAMP_LABEL_KEY, text_string(label));
    }
    if let Some(sub) = dto
        .stamp_sublabel
        .as_deref()
        .filter(|l| !l.trim().is_empty())
    {
        dict.set(STAMP_SUBLABEL_KEY, text_string(sub));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::tests::dto;

    #[test]
    fn flags_merge() {
        let mut d = dto(AnnotKind::Note);
        assert_eq!(
            initial_flags(&d),
            FLAG_PRINT | FLAG_NO_ZOOM | FLAG_NO_ROTATE
        );
        d.print = false;
        d.hidden = true;
        d.locked = true;
        assert_eq!(
            merged_flags(FLAG_PRINT | 256, &d),
            FLAG_HIDDEN | FLAG_LOCKED | 256
        );
    }

    #[test]
    fn dashed_border() {
        let mut d = dto(AnnotKind::Square);
        d.border_style = BorderStyle::Dashed;
        let dict = annotation_dict(&d, d.rect, "nm", "D:20260101000000+00'00'");
        let bs = dict.get(b"BS").unwrap().as_dict().unwrap();
        assert_eq!(bs.get(b"S").unwrap().as_name().unwrap(), b"D");
        assert_eq!(bs.get(b"D").unwrap(), &num_array(&[3.0, 3.0]));
    }

    #[test]
    fn popup_stays_on_page() {
        let popup = popup_dict(
            (1, 0),
            [580.0, 700.0, 600.0, 720.0],
            [0.0, 0.0, 612.0, 792.0],
        );
        let rect = popup.get(b"Rect").unwrap().as_array().unwrap();
        assert_eq!(rect[0], num(396.0));
        let popup = popup_dict((1, 0), [10.0, 10.0, 30.0, 30.0], [0.0, 0.0, 612.0, 792.0]);
        let rect = popup.get(b"Rect").unwrap().as_array().unwrap();
        assert_eq!(rect[1], num(0.0));
    }

    #[test]
    fn state_defaults_model() {
        let mut d = dto(AnnotKind::Note);
        d.state = Some("Accepted".into());
        let dict = reply_dict(&d, (5, 0), [0.0, 0.0, 50.0, 50.0], "r", "now");
        assert_eq!(dict.get(b"StateModel").unwrap(), &text_string("Review"));
        assert_eq!(dict.get(b"IRT").unwrap(), &Object::Reference((5, 0)));
    }
}
