use std::collections::HashMap;

use lopdf::Document;

use super::*;
use crate::dto::{StampImage, TextAlign};

/// A minimal DTO of `kind` with sensible geometry.
pub(crate) fn dto(kind: AnnotKind) -> AnnotationDto {
    AnnotationDto {
        kind,
        page_index: 0,
        rect: [100.0, 100.0, 200.0, 150.0],
        color: Some([1.0, 0.0, 0.0]),
        interior_color: None,
        opacity: 1.0,
        border_width: 1.0,
        border_style: BorderStyle::Solid,
        dash: Vec::new(),
        contents: String::new(),
        author: String::new(),
        subject: None,
        nm: String::new(),
        created: None,
        modified: None,
        hidden: false,
        print: true,
        locked: false,
        quad_points: vec![100.0, 120.0, 200.0, 120.0, 100.0, 100.0, 200.0, 100.0],
        ink_list: vec![vec![100.0, 100.0, 120.0, 130.0, 150.0, 110.0, 170.0, 140.0]],
        vertices: vec![100.0, 100.0, 150.0, 140.0, 200.0, 100.0],
        line: Some([100.0, 100.0, 200.0, 150.0]),
        line_endings: [LineEnding::None, LineEnding::None],
        icon: None,
        font_size: 12.0,
        font_color: None,
        text_align: TextAlign::Left,
        stamp_label: None,
        stamp_sublabel: None,
        stamp_image: None,
        in_reply_to_ref: None,
        in_reply_to_nm: None,
        state: None,
        state_model: None,
        open: false,
    }
}

fn render(
    dto: &AnnotationDto,
    doc: &mut Document,
    blobs: &[&[u8]],
) -> Result<(Rect, String, Dictionary)> {
    render_rotated(dto, doc, blobs, 0)
}

fn render_rotated(
    dto: &AnnotationDto,
    doc: &mut Document,
    blobs: &[&[u8]],
    rotation: i64,
) -> Result<(Rect, String, Dictionary)> {
    let rect = annotation_rect(dto)?;
    let mut fonts = HashMap::new();
    let mut ctx = ApContext {
        sink: doc,
        fonts: &mut fonts,
        cjk: CjkCollection::Gb1,
        blobs,
    };
    let ap = build(dto, rect, rotation, &mut ctx)?;
    let resources = ap.resources();
    let content = String::from_utf8_lossy(&ap.content.clone().into_bytes()).into_owned();
    Ok((rect, content, resources))
}

#[test]
fn every_kind_renders() {
    for kind in [
        AnnotKind::Highlight,
        AnnotKind::Underline,
        AnnotKind::Strikeout,
        AnnotKind::Squiggly,
        AnnotKind::Note,
        AnnotKind::Freetext,
        AnnotKind::Ink,
        AnnotKind::Square,
        AnnotKind::Circle,
        AnnotKind::Line,
        AnnotKind::Polygon,
        AnnotKind::Polyline,
        AnnotKind::Stamp,
    ] {
        let mut d = dto(kind);
        d.contents = "Hello".into();
        let (rect, content, _) = render(&d, &mut Document::new(), &[]).unwrap();
        assert!(rect[0] < rect[2] && rect[1] < rect[3], "{kind:?}");
        assert!(!content.is_empty(), "{kind:?} produced no content");
    }
}

#[test]
fn highlight_uses_multiply_and_quads() {
    let mut d = dto(AnnotKind::Highlight);
    d.opacity = 0.5;
    let (rect, content, resources) = render(&d, &mut Document::new(), &[]).unwrap();
    assert!(rect[0] < 100.0 && rect[2] > 200.0);
    assert!(content.contains("/GS0 gs"));
    assert!(content.contains("100 100 m"));
    let gs = resources
        .get(b"ExtGState")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"GS0")
        .unwrap()
        .as_dict()
        .unwrap();
    assert_eq!(gs.get(b"BM").unwrap().as_name().unwrap(), b"Multiply");
}

#[test]
fn note_rect_is_icon_sized() {
    let d = dto(AnnotKind::Note);
    assert_eq!(annotation_rect(&d).unwrap(), [100.0, 130.0, 120.0, 150.0]);
    for icon in [
        "Comment",
        "Note",
        "Help",
        "Key",
        "Insert",
        "Paragraph",
        "NewParagraph",
        "Check",
        "Cross",
        "Star",
        "Circle",
    ] {
        let mut d = dto(AnnotKind::Note);
        d.icon = Some(icon.into());
        let (_, content, _) = render(&d, &mut Document::new(), &[]).unwrap();
        assert!(content.starts_with("1 0 0 1 100 130 cm"), "{icon}");
    }
}

#[test]
fn line_rect_encloses_endings() {
    let mut d = dto(AnnotKind::Line);
    d.line = Some([100.0, 100.0, 200.0, 100.0]);
    d.line_endings = [LineEnding::ClosedArrow, LineEnding::Circle];
    d.border_width = 3.0;
    let rect = annotation_rect(&d).unwrap();
    assert!(rect[0] <= 100.0 - 9.0 && rect[2] >= 200.0 + 9.0 && rect[1] <= 100.0 - 9.0);
    let (_, content, _) = render(&d, &mut Document::new(), &[]).unwrap();
    assert!(
        content.contains("\nB\n"),
        "closed arrow is filled and stroked"
    );
}

#[test]
fn freetext_uses_fonts_per_script() {
    let mut d = dto(AnnotKind::Freetext);
    d.contents = "Hello 你好".into();
    d.text_align = TextAlign::Center;
    d.interior_color = Some([1.0, 1.0, 0.8]);
    let mut doc = Document::new();
    let (_, content, resources) = render(&d, &mut doc, &[]).unwrap();
    let fonts = resources.get(b"Font").unwrap().as_dict().unwrap();
    assert!(fonts.has(b"Helv") && fonts.has(b"CJKsc"));
    assert!(content.contains("<4F60597D> Tj"));
    assert!(content.contains("(Hello ) Tj"));
    // Type0 font + descendant + descriptor + Helvetica.
    assert_eq!(doc.objects.len(), 4);
}

#[test]
fn image_stamp_with_and_without_alpha() {
    let opaque = [10u8, 20, 30, 255, 40, 50, 60, 255];
    let transparent = [10u8, 20, 30, 0, 40, 50, 60, 128];
    for (pixels, objects) in [(&opaque, 1), (&transparent, 2)] {
        let mut d = dto(AnnotKind::Stamp);
        d.stamp_image = Some(StampImage {
            blob: 0,
            width: 2,
            height: 1,
        });
        let mut doc = Document::new();
        let (_, content, resources) = render(&d, &mut doc, &[pixels]).unwrap();
        assert!(content.contains("/Im0 Do"));
        assert!(resources.get(b"XObject").is_ok());
        assert_eq!(doc.objects.len(), objects);
    }
    let mut d = dto(AnnotKind::Stamp);
    d.stamp_image = Some(StampImage {
        blob: 0,
        width: 4,
        height: 4,
    });
    assert!(matches!(
        render(&d, &mut Document::new(), &[&[0u8; 8]]),
        Err(PdfError::InvalidRequest(_))
    ));
    assert!(matches!(
        render(&d, &mut Document::new(), &[]),
        Err(PdfError::InvalidRequest(_))
    ));
}

#[test]
fn text_and_stamps_are_counter_rotated() {
    // Rect [100 100 200 150] on pages rotated by 0/90/180/270 degrees.
    let expected = [
        (0, "1 0 0 1 100 100 cm"),
        (90, "0 1 -1 0 200 100 cm"),
        (180, "-1 0 0 -1 200 150 cm"),
        (270, "0 -1 1 0 100 150 cm"),
    ];
    for kind in [AnnotKind::Freetext, AnnotKind::Stamp] {
        for (rotation, matrix) in expected {
            let mut d = dto(kind);
            d.contents = "Upright".into();
            let (_, content, _) = render_rotated(&d, &mut Document::new(), &[], rotation).unwrap();
            assert!(
                content.starts_with(&format!("q\n{matrix}\n")),
                "{kind:?} {rotation}: {content}"
            );
        }
    }
    // Geometry-based kinds are not rotated.
    let (_, content, _) =
        render_rotated(&dto(AnnotKind::Square), &mut Document::new(), &[], 90).unwrap();
    assert!(!content.contains(" cm\n"));
    assert!(is_upright_kind(AnnotKind::Stamp) && !is_upright_kind(AnnotKind::Ink));
}

#[test]
fn text_stamp_names() {
    assert_eq!(stamp_name("APPROVED"), "Approved");
    assert_eq!(stamp_name("Not Approved"), "NotApproved");
    assert_eq!(stamp_name("Reviewed by QA!"), "ReviewedbyQA");
    assert_eq!(stamp_name("已审核"), "Stamp");
}

#[test]
fn invalid_geometry_is_rejected() {
    let mut d = dto(AnnotKind::Highlight);
    d.quad_points = vec![1.0, 2.0, 3.0];
    assert!(matches!(
        annotation_rect(&d),
        Err(PdfError::InvalidRequest(_))
    ));
    let mut d = dto(AnnotKind::Ink);
    d.ink_list = vec![vec![1.0, f64::NAN]];
    assert!(annotation_rect(&d).is_err());
    let mut d = dto(AnnotKind::Square);
    d.rect = [5.0, 5.0, 5.0, 10.0];
    assert!(annotation_rect(&d).is_err());
    let mut d = dto(AnnotKind::Line);
    d.line = None;
    assert!(annotation_rect(&d).is_err());
}
