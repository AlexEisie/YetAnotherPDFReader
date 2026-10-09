//! Appearance-stream (`/AP /N`) generation for every [`AnnotKind`].
//!
//! Every appearance is drawn directly in page user space: the form's `/BBox` equals the
//! annotation rectangle and its `/Matrix` is the identity, so viewers map it 1:1.

mod freetext;
mod markup;
mod note;
mod shapes;
mod stamp;

use std::collections::HashMap;

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

use crate::content::Content;
use crate::dto::{AnnotKind, AnnotationDto, BorderStyle, LineEnding, Rect};
use crate::error::{PdfError, Result};
use crate::fonts::{font_objects, CjkCollection, FontKey};
use crate::geometry::{bounding_box, normalize_rect, pad_rect, points, Point, Quad};
use crate::load::Revision;
use crate::objects::{num, num_array};

pub use freetext::{default_appearance, default_style, rich_text};
pub use note::NOTE_ICON_SIZE;
pub use stamp::stamp_name;

/// Something that can store the indirect objects (fonts, images) an appearance refers to.
pub trait ObjectSink {
    fn add_object(&mut self, object: Object) -> ObjectId;
}

impl ObjectSink for Revision {
    fn add_object(&mut self, object: Object) -> ObjectId {
        self.add(object)
    }
}

impl ObjectSink for Document {
    fn add_object(&mut self, object: Object) -> ObjectId {
        Document::add_object(self, object)
    }
}

/// Shared state while generating the appearances of one request.
pub struct ApContext<'a> {
    pub sink: &'a mut dyn ObjectSink,
    /// Font objects already created in this request (shared between annotations).
    pub fonts: &'a mut HashMap<FontKey, ObjectId>,
    /// CJK collection used for text that is not WinAnsi encodable.
    pub cjk: CjkCollection,
    pub blobs: &'a [&'a [u8]],
}

impl ApContext<'_> {
    /// The font object for `key`, created on first use.
    fn font(&mut self, key: FontKey) -> ObjectId {
        if let Some(id) = self.fonts.get(&key) {
            return *id;
        }
        let objects = font_objects(key);
        let mut font = objects.font;
        if let Some((mut cid_font, descriptor)) = objects.descendant {
            let descriptor_id = self.sink.add_object(descriptor.into());
            cid_font.set("FontDescriptor", descriptor_id);
            let cid_id = self.sink.add_object(cid_font.into());
            font.set("DescendantFonts", vec![Object::Reference(cid_id)]);
        }
        let id = self.sink.add_object(font.into());
        self.fonts.insert(key, id);
        id
    }
}

/// A generated appearance: content plus the resources it uses.
#[derive(Debug, Default)]
pub struct Appearance {
    pub bbox: Rect,
    pub content: Content,
    ext_gstates: Dictionary,
    fonts: Dictionary,
    xobjects: Dictionary,
}

impl Appearance {
    fn new(bbox: Rect) -> Self {
        Self {
            bbox,
            ..Self::default()
        }
    }

    /// Install an `/ExtGState` for opacity (and optional blend mode) and select it.
    fn opacity(&mut self, opacity: f64, blend: Option<&str>) {
        let opacity = clamp_opacity(opacity);
        if opacity >= 1.0 && blend.is_none() {
            return;
        }
        let mut gs =
            dictionary! { "Type" => "ExtGState", "CA" => num(opacity), "ca" => num(opacity) };
        if let Some(mode) = blend {
            gs.set("BM", mode);
        }
        self.ext_gstates.set("GS0", gs);
        self.content.graphics_state("GS0");
    }

    /// Register a font resource and return its resource name.
    fn use_font(&mut self, ctx: &mut ApContext, key: FontKey) -> &'static str {
        let name = key.resource_name();
        if !self.fonts.has(name.as_bytes()) {
            let id = ctx.font(key);
            self.fonts.set(name, id);
        }
        name
    }

    fn use_xobject(&mut self, name: &str, id: ObjectId) {
        self.xobjects.set(name, id);
    }

    /// The `/Resources` dictionary.
    fn resources(&self) -> Dictionary {
        let mut resources = Dictionary::new();
        for (key, dict) in [
            ("ExtGState", &self.ext_gstates),
            ("Font", &self.fonts),
            ("XObject", &self.xobjects),
        ] {
            if !dict.is_empty() {
                resources.set(key, dict.clone());
            }
        }
        resources
    }

    /// The Form XObject stream (Flate-compressed when that helps).
    pub fn into_stream(self) -> Stream {
        let dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "FormType" => 1,
            "BBox" => num_array(&self.bbox),
            "Matrix" => num_array(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
            "Resources" => self.resources(),
        };
        let mut stream = Stream::new(dict, self.content.into_bytes());
        // Compression is an optimisation only; the plain stream is valid too.
        let _ = stream.compress();
        stream
    }
}

/// Opacity clamped to `0..=1` (non-finite values mean opaque).
pub fn clamp_opacity(opacity: f64) -> f64 {
    if opacity.is_finite() {
        opacity.clamp(0.0, 1.0)
    } else {
        1.0
    }
}

/// Border width clamped to a sane range.
pub fn border_width(dto: &AnnotationDto) -> f64 {
    if dto.border_width.is_finite() {
        dto.border_width.clamp(0.0, 100.0)
    } else {
        1.0
    }
}

/// Dash pattern for dashed borders (`[3 3]` when the DTO gives none).
pub fn dash_pattern(dto: &AnnotationDto) -> Vec<f64> {
    let dash: Vec<f64> = dto
        .dash
        .iter()
        .copied()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .collect();
    if dash.is_empty() || dash.iter().all(|v| *v == 0.0) {
        vec![3.0, 3.0]
    } else {
        dash
    }
}

/// Size of a line ending for stroke width `width`.
pub fn ending_size(width: f64) -> f64 {
    (3.0 * width).max(6.0)
}

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
}

fn finite(values: &[f64], what: &str) -> Result<()> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(invalid(format!("{what} contains non-finite numbers")))
    }
}

fn require_area(rect: Rect, kind: AnnotKind) -> Result<Rect> {
    finite(&rect, "rect")?;
    let rect = normalize_rect(rect);
    if rect[2] - rect[0] <= 0.0 || rect[3] - rect[1] <= 0.0 {
        return Err(invalid(format!(
            "{} annotation needs a rect with a positive area",
            kind.subtype()
        )));
    }
    Ok(rect)
}

/// Validated geometry of a polyline-like list (`min_points` points at least).
fn point_list(flat: &[f64], min_points: usize, what: &str) -> Result<Vec<Point>> {
    finite(flat, what)?;
    if !flat.len().is_multiple_of(2) || flat.len() / 2 < min_points {
        return Err(invalid(format!(
            "{what} needs at least {min_points} points as x/y pairs"
        )));
    }
    Ok(points(flat))
}

/// Validated quads of a text-markup annotation.
pub fn quads(dto: &AnnotationDto) -> Result<Vec<Quad>> {
    finite(&dto.quad_points, "quadPoints")?;
    if dto.quad_points.is_empty() || !dto.quad_points.len().is_multiple_of(8) {
        return Err(invalid("quadPoints must contain 8 numbers per quad"));
    }
    Ok(Quad::parse_all(&dto.quad_points))
}

/// Validated ink strokes.
pub fn ink_strokes(dto: &AnnotationDto) -> Result<Vec<Vec<Point>>> {
    if dto.ink_list.is_empty() {
        return Err(invalid("ink annotation needs at least one stroke"));
    }
    dto.ink_list
        .iter()
        .map(|stroke| point_list(stroke, 1, "inkList stroke"))
        .collect()
}

/// Validated vertices of a polygon / polyline.
pub fn vertices(dto: &AnnotationDto) -> Result<Vec<Point>> {
    point_list(&dto.vertices, 2, "vertices")
}

/// Validated line coordinates.
pub fn line_points(dto: &AnnotationDto) -> Result<(Point, Point)> {
    let line = dto
        .line
        .ok_or_else(|| invalid("line annotation needs line coordinates"))?;
    finite(&line, "line")?;
    Ok((Point::new(line[0], line[1]), Point::new(line[2], line[3])))
}

fn has_endings(endings: &[LineEnding; 2]) -> bool {
    endings.iter().any(|e| *e != LineEnding::None)
}

/// The `/Rect` an annotation gets: computed from its geometry where it has one, otherwise
/// the (normalised) DTO rectangle.
pub fn annotation_rect(dto: &AnnotationDto) -> Result<Rect> {
    let width = border_width(dto);
    let pad_for = |endings: bool| {
        if endings {
            ending_size(width) + width
        } else {
            width / 2.0 + 1.0
        }
    };
    let bbox = |pts: Vec<Point>, pad: f64| {
        bounding_box(pts)
            .map(|r| pad_rect(r, pad))
            .ok_or_else(|| invalid("empty geometry"))
    };
    match dto.kind {
        kind if kind.is_text_markup() => markup::rect(&quads(dto)?),
        AnnotKind::Note => {
            finite(&dto.rect, "rect")?;
            let r = normalize_rect(dto.rect);
            Ok([r[0], r[3] - NOTE_ICON_SIZE, r[0] + NOTE_ICON_SIZE, r[3]])
        }
        AnnotKind::Ink => bbox(ink_strokes(dto)?.concat(), width / 2.0 + 1.0),
        AnnotKind::Line => {
            let (a, b) = line_points(dto)?;
            bbox(vec![a, b], pad_for(has_endings(&dto.line_endings)))
        }
        AnnotKind::Polygon if dto.border_style == BorderStyle::Cloudy => {
            bbox(vertices(dto)?, shapes::cloud_radius(width) + width)
        }
        AnnotKind::Polygon => bbox(vertices(dto)?, pad_for(false)),
        AnnotKind::Polyline => bbox(vertices(dto)?, pad_for(has_endings(&dto.line_endings))),
        kind => require_area(dto.rect, kind),
    }
}

/// Whether appearances of `kind` hold text or images that are counter-rotated to appear
/// upright on rotated pages (geometry-based kinds simply follow their coordinates).
pub fn is_upright_kind(kind: AnnotKind) -> bool {
    matches!(kind, AnnotKind::Freetext | AnnotKind::Stamp)
}

/// Drawing frame for content that must appear upright on a page displayed with `/Rotate`
/// `rotation`: the `cm` matrix mapping a local box `[0 0 w h]` onto `rect`, plus `w` and `h`
/// (the box size as seen in the viewer).
fn upright_frame(rect: Rect, rotation: i64) -> ([f64; 6], f64, f64) {
    let [x1, y1, x2, y2] = rect;
    let (w, h) = (x2 - x1, y2 - y1);
    match rotation {
        90 => ([0.0, 1.0, -1.0, 0.0, x2, y1], h, w),
        180 => ([-1.0, 0.0, 0.0, -1.0, x2, y2], w, h),
        270 => ([0.0, -1.0, 1.0, 0.0, x1, y2], h, w),
        _ => ([1.0, 0.0, 0.0, 1.0, x1, y1], w, h),
    }
}

/// Generate the normal appearance of `dto`, whose final `/Rect` is `rect`, on a page with
/// `/Rotate` `rotation` (0, 90, 180 or 270).
pub fn build(
    dto: &AnnotationDto,
    rect: Rect,
    rotation: i64,
    ctx: &mut ApContext,
) -> Result<Appearance> {
    let mut ap = Appearance::new(rect);
    match dto.kind {
        AnnotKind::Highlight
        | AnnotKind::Underline
        | AnnotKind::Strikeout
        | AnnotKind::Squiggly => {
            markup::draw(&mut ap, dto, &quads(dto)?);
        }
        AnnotKind::Note => note::draw(&mut ap, dto),
        AnnotKind::Freetext => freetext::draw(&mut ap, dto, ctx, rotation),
        AnnotKind::Ink => shapes::ink(&mut ap, dto, &ink_strokes(dto)?),
        AnnotKind::Square | AnnotKind::Circle => shapes::square_circle(&mut ap, dto),
        AnnotKind::Line => {
            let (a, b) = line_points(dto)?;
            shapes::line(&mut ap, dto, a, b);
        }
        AnnotKind::Polygon | AnnotKind::Polyline => shapes::poly(&mut ap, dto, &vertices(dto)?),
        AnnotKind::Stamp => stamp::draw(&mut ap, dto, ctx, rotation)?,
    }
    Ok(ap)
}

/// Apply stroke settings (width, colour, dash) for a bordered shape. Returns whether the
/// shape is stroked at all.
fn stroke_style(ap: &mut Appearance, dto: &AnnotationDto) -> bool {
    let width = border_width(dto);
    let Some(color) = dto.color.filter(|_| width > 0.0) else {
        return false;
    };
    ap.content.stroke_rgb(color).line_width(width);
    if dto.border_style == BorderStyle::Dashed {
        ap.content.dash(&dash_pattern(dto), 0.0);
    }
    true
}

#[cfg(test)]
pub(crate) mod tests;
