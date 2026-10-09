//! Data transfer objects shared with the front-end.
//!
//! These types are the *contract* between the TypeScript annotation model
//! (`src/lib/annotations/serialize.ts`) and the PDF writer. Every field is
//! serialised in `camelCase`. Geometry is always expressed in **PDF user
//! space of the unrotated page** (origin bottom-left, y grows upwards), i.e.
//! exactly the coordinate system pdf.js reports in `getAnnotations()`.

use serde::{Deserialize, Serialize};

/// RGB colour, every component in `0.0..=1.0`.
pub type Rgb = [f64; 3];

/// Rectangle `[x1, y1, x2, y2]`. Corner order is not guaranteed; writers normalise it.
pub type Rect = [f64; 4];

/// The annotation kinds the application can create and regenerate appearances for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AnnotKind {
    Highlight,
    Underline,
    Strikeout,
    Squiggly,
    /// Sticky note (`/Subtype /Text`).
    #[default]
    Note,
    /// Text box (`/Subtype /FreeText`).
    Freetext,
    Ink,
    Square,
    Circle,
    Line,
    Polygon,
    Polyline,
    /// Rubber stamp: either a text stamp or an image stamp (signatures are image stamps).
    Stamp,
}

impl AnnotKind {
    /// The PDF `/Subtype` name for this kind.
    pub fn subtype(self) -> &'static str {
        match self {
            AnnotKind::Highlight => "Highlight",
            AnnotKind::Underline => "Underline",
            AnnotKind::Strikeout => "StrikeOut",
            AnnotKind::Squiggly => "Squiggly",
            AnnotKind::Note => "Text",
            AnnotKind::Freetext => "FreeText",
            AnnotKind::Ink => "Ink",
            AnnotKind::Square => "Square",
            AnnotKind::Circle => "Circle",
            AnnotKind::Line => "Line",
            AnnotKind::Polygon => "Polygon",
            AnnotKind::Polyline => "PolyLine",
            AnnotKind::Stamp => "Stamp",
        }
    }

    /// Text-markup annotations carry `/QuadPoints`.
    pub fn is_text_markup(self) -> bool {
        matches!(
            self,
            AnnotKind::Highlight
                | AnnotKind::Underline
                | AnnotKind::Strikeout
                | AnnotKind::Squiggly
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BorderStyle {
    #[default]
    Solid,
    Dashed,
    /// Cloudy border effect (`/BE << /S /C >>`), supported for square, circle and polygon.
    Cloudy,
}

/// Line ending styles, serialised with their exact PDF names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum LineEnding {
    #[default]
    None,
    Square,
    Circle,
    Diamond,
    OpenArrow,
    ClosedArrow,
    Butt,
    ROpenArrow,
    RClosedArrow,
    Slash,
}

impl LineEnding {
    pub fn pdf_name(self) -> &'static str {
        match self {
            LineEnding::None => "None",
            LineEnding::Square => "Square",
            LineEnding::Circle => "Circle",
            LineEnding::Diamond => "Diamond",
            LineEnding::OpenArrow => "OpenArrow",
            LineEnding::ClosedArrow => "ClosedArrow",
            LineEnding::Butt => "Butt",
            LineEnding::ROpenArrow => "ROpenArrow",
            LineEnding::RClosedArrow => "RClosedArrow",
            LineEnding::Slash => "Slash",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// Raw image pixels referenced by an image stamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampImage {
    /// Index into the request's binary blobs. The blob holds `width * height * 4`
    /// bytes of non-premultiplied RGBA8 pixels, row-major, top row first.
    pub blob: usize,
    pub width: u32,
    pub height: u32,
}

fn default_opacity() -> f64 {
    1.0
}
fn default_border_width() -> f64 {
    1.0
}
fn default_font_size() -> f64 {
    12.0
}
fn default_true() -> bool {
    true
}

/// A complete description of one annotation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDto {
    pub kind: AnnotKind,
    /// 0-based page index.
    pub page_index: u32,
    /// Bounding rectangle in page user space.
    pub rect: Rect,
    /// Stroke / markup colour (`/C`). `None` means transparent.
    #[serde(default)]
    pub color: Option<Rgb>,
    /// Fill colour (`/IC`) for square, circle, polygon, line endings; background for free text.
    #[serde(default)]
    pub interior_color: Option<Rgb>,
    /// Constant opacity (`/CA`), `0.0..=1.0`.
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Border / stroke width in points.
    #[serde(default = "default_border_width")]
    pub border_width: f64,
    #[serde(default)]
    pub border_style: BorderStyle,
    /// Dash pattern used when `border_style == Dashed` (defaults to `[3, 3]` if empty).
    #[serde(default)]
    pub dash: Vec<f64>,
    /// Comment text (`/Contents`). For free text this is also the displayed text.
    #[serde(default)]
    pub contents: String,
    /// Author (`/T`).
    #[serde(default)]
    pub author: String,
    /// Subject (`/Subj`).
    #[serde(default)]
    pub subject: Option<String>,
    /// Unique annotation name (`/NM`). Used to link replies created in the same batch.
    #[serde(default)]
    pub nm: String,
    /// Creation date, RFC 3339 (converted to a PDF date string).
    #[serde(default)]
    pub created: Option<String>,
    /// Modification date, RFC 3339.
    #[serde(default)]
    pub modified: Option<String>,
    /// `/F` Hidden flag.
    #[serde(default)]
    pub hidden: bool,
    /// `/F` Print flag (default `true`).
    #[serde(default = "default_true")]
    pub print: bool,
    /// `/F` Locked flag.
    #[serde(default)]
    pub locked: bool,
    /// Text markup quads: 8 numbers per quad, in the order Acrobat uses:
    /// upper-left, upper-right, lower-left, lower-right (`x1 y1 x2 y2 x3 y3 x4 y4`).
    #[serde(default)]
    pub quad_points: Vec<f64>,
    /// Ink strokes; each stroke is a flat `[x0, y0, x1, y1, ...]` list.
    #[serde(default)]
    pub ink_list: Vec<Vec<f64>>,
    /// Polygon / polyline vertices, flat `[x0, y0, x1, y1, ...]`.
    #[serde(default)]
    pub vertices: Vec<f64>,
    /// Line coordinates `[x1, y1, x2, y2]`.
    #[serde(default)]
    pub line: Option<[f64; 4]>,
    /// Line endings `[start, end]` for line and polyline.
    #[serde(default)]
    pub line_endings: [LineEnding; 2],
    /// Sticky-note icon name (`Comment`, `Note`, `Help`, `Insert`, `Key`, `NewParagraph`,
    /// `Paragraph`, `Check`, `Circle`, `Cross`, `Star`). Defaults to `Comment`.
    #[serde(default)]
    pub icon: Option<String>,
    /// Free text font size in points.
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    /// Free text font colour (defaults to black).
    #[serde(default)]
    pub font_color: Option<Rgb>,
    #[serde(default)]
    pub text_align: TextAlign,
    /// Main label of a text stamp, e.g. `APPROVED`.
    #[serde(default)]
    pub stamp_label: Option<String>,
    /// Optional second line of a text stamp, e.g. `Alice, 2026-10-08 14:30`.
    #[serde(default)]
    pub stamp_sublabel: Option<String>,
    /// Image for image stamps / signatures. Takes precedence over the text label.
    #[serde(default)]
    pub stamp_image: Option<StampImage>,
    /// Reply target: object reference of an existing annotation (e.g. `"12R"`).
    #[serde(default)]
    pub in_reply_to_ref: Option<String>,
    /// Reply target: `nm` of another annotation created in the same request.
    #[serde(default)]
    pub in_reply_to_nm: Option<String>,
    /// Review state for state replies (`Accepted`, `Rejected`, `Cancelled`, `Completed`, `None`,
    /// `Marked`, `Unmarked`).
    #[serde(default)]
    pub state: Option<String>,
    /// `Review` or `Marked`.
    #[serde(default)]
    pub state_model: Option<String>,
    /// Whether the pop-up should be initially open.
    #[serde(default)]
    pub open: bool,
}

/// Modification of an annotation that already exists in the file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationModify {
    /// Object reference as reported by pdf.js, e.g. `"12R"` or `"12R3"` (generation 3).
    #[serde(rename = "ref")]
    pub reference: String,
    pub annotation: AnnotationDto,
    /// `true`: rewrite geometry and regenerate `/AP` from the DTO.
    /// `false`: only update `/Contents`, `/T`, `/Subj`, `/M`, `/C`, `/CA`, `/F`, `/Rect`
    /// (when moved) and keep the existing appearance stream.
    #[serde(default)]
    pub regenerate_appearance: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AnnotationChanges {
    pub add: Vec<AnnotationDto>,
    pub modify: Vec<AnnotationModify>,
    /// Object references of annotations to remove (their `/Popup` is removed too).
    pub delete: Vec<String>,
}

impl AnnotationChanges {
    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.modify.is_empty() && self.delete.is_empty()
    }
}

/// Document information dictionary update. `Some("")` removes the entry, `None` leaves it as is.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InfoUpdate {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
}

impl InfoUpdate {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.author.is_none()
            && self.subject.is_none()
            && self.keywords.is_none()
            && self.creator.is_none()
    }
}

/// Everything that can be applied to a document as one incremental update.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DocumentChanges {
    pub annotations: AnnotationChanges,
    pub info: Option<InfoUpdate>,
    /// Preferred CJK collection for text that is not WinAnsi encodable:
    /// `"zh-CN"` (default), `"zh-TW"`, `"ja"`, `"ko"`. Hangul and kana are detected automatically.
    pub cjk_hint: Option<String>,
    /// Value for the `/ModDate` entry, RFC 3339. Defaults to "now".
    pub mod_date: Option<String>,
}

/// An annotation found in an existing document (see [`crate::read_annotations`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingAnnotation {
    /// Object reference in pdf.js notation: `"12R"`, or `"12R3"` for generation 3.
    #[serde(rename = "ref")]
    pub reference: String,
    /// 0-based page index.
    pub page_index: u32,
    /// Raw `/Subtype` name (`Highlight`, `Link`, `Widget`, `Popup`, ...).
    pub subtype: String,
    /// Full description when the subtype maps to an [`AnnotKind`]; `None` otherwise
    /// (links, widgets, pop-ups, file attachments, ...).
    pub annotation: Option<AnnotationDto>,
    /// Bounding rectangle (always present, even for unsupported subtypes).
    pub rect: Rect,
    pub has_appearance: bool,
    /// `/Popup` reference, if any.
    pub popup_ref: Option<String>,
    /// `/IRT` reference, if this annotation is a reply.
    pub in_reply_to_ref: Option<String>,
    /// `/RT` (`R` or `Group`) when this is a reply.
    pub reply_type: Option<String>,
    /// Raw `/F` flags.
    pub flags: u32,
    /// Contents / author for unsupported subtypes too (empty when absent).
    pub contents: String,
    pub author: String,
    pub modified: Option<String>,
}

/// Structural page operations, applied sequentially. Page indices are 0-based and
/// always refer to the document state produced by the previous operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum PageOp {
    /// Add `delta` degrees (multiple of 90, may be negative) to `/Rotate`.
    #[serde(rename_all = "camelCase")]
    Rotate { pages: Vec<u32>, delta: i32 },
    /// Remove pages. Removing every page is an error.
    #[serde(rename_all = "camelCase")]
    Delete { pages: Vec<u32> },
    /// New page order: a permutation of `0..page_count`.
    #[serde(rename_all = "camelCase")]
    Reorder { order: Vec<u32> },
    /// Insert `count` blank pages of `width` x `height` points before index `at`
    /// (`at == page_count` appends).
    #[serde(rename_all = "camelCase")]
    InsertBlank {
        at: u32,
        count: u32,
        width: f64,
        height: f64,
    },
    /// Insert pages of another PDF (request blob `blob`) before index `at`.
    /// `pages` selects 0-based source pages (all when `None`).
    #[serde(rename_all = "camelCase")]
    InsertFromBlob {
        at: u32,
        blob: usize,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        pages: Option<Vec<u32>>,
    },
    /// Insert one page per image before index `at`.
    ///
    /// With `page_size` every page has that size (swapped to landscape for landscape
    /// pictures) and the picture is fitted inside `margin`; without it the page takes the
    /// picture's size at 96 dpi.
    #[serde(rename_all = "camelCase")]
    InsertImages {
        at: u32,
        images: Vec<PageImage>,
        #[serde(default)]
        page_size: Option<[f64; 2]>,
        #[serde(default)]
        margin: f64,
    },
    /// Mirror pages horizontally (left ↔ right as displayed) or vertically.
    #[serde(rename_all = "camelCase")]
    Flip { pages: Vec<u32>, horizontal: bool },
    /// Copy pages (with their comments) and insert the copies, in order, before index `at`.
    #[serde(rename_all = "camelCase")]
    Duplicate { pages: Vec<u32>, at: u32 },
    /// Stamp a text or picture watermark into the content of `pages`.
    #[serde(rename_all = "camelCase")]
    Watermark {
        pages: Vec<u32>,
        watermark: WatermarkSpec,
    },
}

/// Encoding of a picture blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    /// A complete JPEG file, embedded unchanged (EXIF orientation is honoured).
    Jpeg,
    /// `width * height * 4` bytes of non-premultiplied RGBA8, top row first.
    Rgba,
}

/// A picture stored in a request blob.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageImage {
    pub blob: usize,
    pub format: ImageFormat,
    /// Pixel size (required for RGBA; for JPEG it is read from the file).
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
}

/// Where a watermark is placed on the (displayed) page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkPosition {
    #[default]
    Center,
    Top,
    Bottom,
    Left,
    Right,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
    /// Repeated over the whole page.
    Tile,
}

/// Whether a watermark is drawn over or under the page content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkLayer {
    #[default]
    Above,
    Below,
}

/// A text or picture watermark (the picture wins when both are given).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkSpec {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default = "default_watermark_font_size")]
    pub font_size: f64,
    #[serde(default)]
    pub bold: bool,
    #[serde(default = "default_watermark_color")]
    pub color: Rgb,
    #[serde(default)]
    pub image: Option<PageImage>,
    /// Picture width as a fraction of the page width.
    #[serde(default = "default_watermark_scale")]
    pub image_scale: f64,
    #[serde(default = "default_watermark_opacity")]
    pub opacity: f64,
    /// Counter-clockwise rotation in degrees.
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub position: WatermarkPosition,
    #[serde(default)]
    pub layer: WatermarkLayer,
    /// Language hint for CJK text (`zh-CN`, `ja`, ...).
    #[serde(default)]
    pub cjk_hint: Option<String>,
}

fn default_watermark_font_size() -> f64 {
    48.0
}

fn default_watermark_color() -> Rgb {
    [0.5, 0.5, 0.5]
}

fn default_watermark_scale() -> f64 {
    0.4
}

fn default_watermark_opacity() -> f64 {
    0.3
}

/// What a protected document allows (ISO 32000 user access permissions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPermissions {
    pub print: bool,
    /// Print at full quality (otherwise a low-resolution rendering only).
    pub print_high_quality: bool,
    pub copy: bool,
    pub modify: bool,
    pub annotate: bool,
    pub fill_forms: bool,
    pub assemble: bool,
}

impl DocumentPermissions {
    pub const ALL: Self = Self {
        print: true,
        print_high_quality: true,
        copy: true,
        modify: true,
        annotate: true,
        fill_forms: true,
        assemble: true,
    };
}

/// Password protection to apply (AES-256).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecuritySettings {
    /// Required to open the document (empty: opens without a password).
    #[serde(default)]
    pub open_password: String,
    /// Required to change permissions or security (empty: no restrictions are enforced).
    #[serde(default)]
    pub permissions_password: String,
    pub permissions: DocumentPermissions,
}

/// The protection of a document (see [`crate::security_info`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityInfo {
    pub encrypted: bool,
    /// Human-readable method, e.g. `"AES-256"`.
    pub method: Option<String>,
    /// A password is needed to open the document.
    pub open_password: bool,
    /// Some permissions are withheld.
    pub restricted: bool,
    pub permissions: DocumentPermissions,
    /// The given password grants full (owner) access, or nothing is restricted.
    pub owner_access: bool,
}

/// A font used by the document (see [`crate::list_fonts`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFont {
    /// `/BaseFont` without the subset tag.
    pub name: String,
    /// The embedded font program only contains the glyphs used (`ABCDEF+` tag).
    pub subset: bool,
    /// Human-readable font technology, e.g. `"TrueType (CID)"`.
    pub kind: String,
    /// Encoding name (`WinAnsiEncoding`, `Identity-H`, ...), when one is given.
    pub encoding: Option<String>,
    pub embedded: bool,
    /// 1-based number of the first page using the font.
    pub first_page: u32,
    /// Number of pages using the font.
    pub page_count: u32,
    #[serde(skip)]
    pub last_page: u32,
}
