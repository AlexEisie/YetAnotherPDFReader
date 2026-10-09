mod common;

use common::*;
use lopdf::{Dictionary, Document, Object, ObjectId};
use yapr_pdf::*;

/// 2×2 RGBA pixels with partial transparency.
const PIXELS: [u8; 16] = [
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255,
];

fn with_nm(mut d: AnnotationDto, nm: &str) -> AnnotationDto {
    d.nm = nm.to_string();
    d
}

/// One annotation of every kind on page 0, plus replies.
fn every_kind(sample: &Sample) -> Vec<AnnotationDto> {
    let r = [100.0, 600.0, 220.0, 680.0];
    let mut highlight = with_nm(dto(AnnotKind::Highlight, 0, r), "highlight");
    highlight.quad_points = vec![72.0, 760.0, 300.0, 760.0, 72.0, 740.0, 300.0, 740.0];
    highlight.color = Some([1.0, 1.0, 0.0]);
    highlight.opacity = 0.5;
    let mut underline = with_nm(dto(AnnotKind::Underline, 0, r), "underline");
    underline.quad_points = vec![72.0, 730.0, 200.0, 730.0, 72.0, 716.0, 200.0, 716.0];
    let mut strike = with_nm(dto(AnnotKind::Strikeout, 0, r), "strike");
    strike.quad_points = vec![72.0, 710.0, 200.0, 710.0, 72.0, 696.0, 200.0, 696.0];
    let mut squiggly = with_nm(dto(AnnotKind::Squiggly, 0, r), "squiggly");
    // Rotated text running upwards.
    squiggly.quad_points = vec![40.0, 300.0, 40.0, 500.0, 54.0, 300.0, 54.0, 500.0];
    let mut note = with_nm(
        dto(AnnotKind::Note, 0, [400.0, 780.0, 500.0, 820.0]),
        "note-1",
    );
    note.icon = Some("Help".into());
    note.color = Some([1.0, 0.85, 0.0]);
    note.subject = Some("Question".into());
    let mut freetext = with_nm(
        dto(AnnotKind::Freetext, 0, [72.0, 500.0, 272.0, 580.0]),
        "freetext",
    );
    freetext.contents = "A text box with some words that need wrapping.\nSecond line".into();
    freetext.font_size = 11.0;
    freetext.font_color = Some([0.0, 0.0, 0.5]);
    freetext.interior_color = Some([1.0, 1.0, 0.9]);
    freetext.text_align = TextAlign::Center;
    let mut cjk = with_nm(
        dto(AnnotKind::Freetext, 0, [300.0, 500.0, 500.0, 580.0]),
        "freetext-cjk",
    );
    cjk.contents = "中文批注 mixed テキスト".into();
    cjk.border_width = 0.0;
    let mut ink = with_nm(dto(AnnotKind::Ink, 0, r), "ink");
    ink.ink_list = vec![
        vec![100.0, 400.0, 120.0, 430.0, 150.0, 410.0, 170.0, 440.0],
        vec![200.0, 400.0],
    ];
    ink.border_width = 2.0;
    let mut square = with_nm(
        dto(AnnotKind::Square, 0, [300.0, 400.0, 380.0, 460.0]),
        "square",
    );
    square.interior_color = Some([0.8, 0.9, 1.0]);
    square.border_style = BorderStyle::Dashed;
    square.dash = vec![4.0, 2.0];
    let mut circle = with_nm(
        dto(AnnotKind::Circle, 0, [400.0, 400.0, 480.0, 460.0]),
        "circle",
    );
    circle.border_style = BorderStyle::Cloudy;
    let mut line = with_nm(dto(AnnotKind::Line, 0, r), "line");
    line.line = Some([72.0, 350.0, 250.0, 380.0]);
    line.line_endings = [LineEnding::Circle, LineEnding::ClosedArrow];
    line.interior_color = Some([0.0, 1.0, 0.0]);
    let mut polygon = with_nm(dto(AnnotKind::Polygon, 0, r), "polygon");
    polygon.vertices = vec![300.0, 300.0, 350.0, 360.0, 400.0, 300.0];
    polygon.interior_color = Some([1.0, 0.8, 0.8]);
    let mut polyline = with_nm(dto(AnnotKind::Polyline, 0, r), "polyline");
    polyline.vertices = vec![420.0, 300.0, 460.0, 350.0, 500.0, 300.0, 540.0, 350.0];
    polyline.line_endings = [LineEnding::Slash, LineEnding::OpenArrow];
    let mut stamp = with_nm(
        dto(AnnotKind::Stamp, 0, [72.0, 200.0, 252.0, 260.0]),
        "stamp-text",
    );
    stamp.stamp_label = Some("APPROVED".into());
    stamp.stamp_sublabel = Some("Tester, 2026-10-08 14:30".into());
    let mut image = with_nm(
        dto(AnnotKind::Stamp, 0, [300.0, 200.0, 360.0, 260.0]),
        "stamp-image",
    );
    image.stamp_image = Some(StampImage {
        blob: 0,
        width: 2,
        height: 2,
    });
    let mut reply = with_nm(dto(AnnotKind::Note, 0, [0.0, 0.0, 0.0, 0.0]), "reply-1");
    reply.in_reply_to_nm = Some("note-1".into());
    reply.contents = "A reply".into();
    reply.state = Some("Accepted".into());
    reply.state_model = Some("Review".into());
    let mut reply_ref = with_nm(dto(AnnotKind::Note, 2, [0.0, 0.0, 0.0, 0.0]), "reply-2");
    reply_ref.in_reply_to_ref = Some(sample.square.clone());
    reply_ref.contents = "Reply to the existing square".into();
    // The reply comes before its parent in the batch: ids are reserved up front.
    vec![
        reply, highlight, underline, strike, squiggly, note, freetext, cjk, ink, square, circle,
        line, polygon, polyline, stamp, image, reply_ref,
    ]
}

fn changes(add: Vec<AnnotationDto>) -> DocumentChanges {
    DocumentChanges {
        annotations: AnnotationChanges {
            add,
            ..Default::default()
        },
        mod_date: Some("2026-10-08T15:00:00+02:00".into()),
        ..Default::default()
    }
}

fn add_every_kind(sample: &Sample, password: Option<&str>) -> (Vec<AnnotationDto>, Vec<u8>) {
    let dtos = every_kind(sample);
    let out = apply_document_changes(&sample.bytes, password, &changes(dtos.clone()), &[&PIXELS])
        .unwrap();
    (dtos, out)
}

fn by_nm<'a>(annots: &'a [(ObjectId, Dictionary)], nm: &str) -> &'a (ObjectId, Dictionary) {
    annots
        .iter()
        .find(|(_, d)| d.get(b"NM").ok().and_then(|n| n.as_str().ok()) == Some(nm.as_bytes()))
        .unwrap_or_else(|| panic!("annotation {nm} not found"))
}

fn ap_stream<'a>(doc: &'a Document, dict: &Dictionary) -> &'a lopdf::Stream {
    let ap = dict.get(b"AP").unwrap().as_dict().unwrap();
    let id = ap.get(b"N").unwrap().as_reference().unwrap();
    doc.get_object(id).unwrap().as_stream().unwrap()
}

#[test]
fn adds_every_kind_incrementally() {
    let sample = sample();
    let (dtos, out) = add_every_kind(&sample, None);
    assert!(
        out.starts_with(&sample.bytes),
        "incremental update must preserve the original bytes"
    );
    std::fs::write(output_dir().join("every_kind.pdf"), &out).unwrap();

    let doc = load(&out, None);
    let annots = page_annots(&doc, 0);
    // 16 annotations + the note's pop-up.
    assert_eq!(annots.len(), dtos.len() - 1 + 1);
    let page0 = page_ids(&doc)[0];
    for d in dtos.iter().filter(|d| d.page_index == 0) {
        let (_, dict) = by_nm(&annots, &d.nm);
        assert_eq!(subtype(dict), d.kind.subtype(), "{}", d.nm);
        assert_eq!(dict.get(b"P").unwrap().as_reference().unwrap(), page0);
        assert_eq!(dict.get(b"T").unwrap().as_str().unwrap(), b"Tester");
        assert!(dict.has(b"M") && dict.has(b"CreationDate") && dict.has(b"CA") && dict.has(b"F"));
        if d.in_reply_to_nm.is_some() {
            assert!(!dict.has(b"AP"), "replies have no appearance");
            continue;
        }
        let stream = ap_stream(&doc, dict);
        assert_eq!(
            numbers(stream.dict.get(b"BBox").unwrap()),
            numbers(dict.get(b"Rect").unwrap()),
            "{}",
            d.nm
        );
        assert_eq!(
            stream.dict.get(b"Subtype").unwrap().as_name().unwrap(),
            b"Form"
        );
    }

    let (_, highlight) = by_nm(&annots, "highlight");
    assert_eq!(
        numbers(highlight.get(b"QuadPoints").unwrap()),
        dtos[1].quad_points
    );
    let rect = numbers(highlight.get(b"Rect").unwrap());
    assert!(rect[0] < 72.0 && rect[2] > 300.0 && rect[1] < 740.0 && rect[3] > 760.0);

    let (note_id, note) = by_nm(&annots, "note-1");
    assert_eq!(note.get(b"Name").unwrap().as_name().unwrap(), b"Help");
    assert_eq!(note.get(b"F").unwrap().as_i64().unwrap(), 4 | 8 | 16);
    assert_eq!(
        numbers(note.get(b"Rect").unwrap()),
        vec![400.0, 800.0, 420.0, 820.0]
    );
    let popup_id = note.get(b"Popup").unwrap().as_reference().unwrap();
    let popup = doc.get_dictionary(popup_id).unwrap();
    assert_eq!(subtype(popup), "Popup");
    assert_eq!(
        popup.get(b"Parent").unwrap().as_reference().unwrap(),
        *note_id
    );
    assert!(annots.iter().any(|(id, _)| *id == popup_id));

    let (_, reply) = by_nm(&annots, "reply-1");
    assert_eq!(reply.get(b"IRT").unwrap().as_reference().unwrap(), *note_id);
    assert_eq!(reply.get(b"RT").unwrap().as_name().unwrap(), b"R");
    assert_eq!(reply.get(b"F").unwrap().as_i64().unwrap(), 4 | 8 | 16);
    assert_eq!(reply.get(b"State").unwrap().as_str().unwrap(), b"Accepted");

    let (_, freetext) = by_nm(&annots, "freetext");
    assert_eq!(
        freetext.get(b"DA").unwrap().as_str().unwrap(),
        b"/Helv 11 Tf 0 0 0.5 rg"
    );
    assert_eq!(freetext.get(b"Q").unwrap().as_i64().unwrap(), 1);
    assert!(freetext.get(b"DS").is_ok() && freetext.get(b"RC").is_ok());
    let (_, cjk) = by_nm(&annots, "freetext-cjk");
    let fonts = ap_stream(&doc, cjk)
        .dict
        .get(b"Resources")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"Font")
        .unwrap()
        .as_dict()
        .unwrap();
    // Kana in the text forces the Japanese collection.
    let cjk_font = doc
        .get_dictionary(fonts.get(b"CJKja").unwrap().as_reference().unwrap())
        .unwrap();
    assert_eq!(
        cjk_font.get(b"Subtype").unwrap().as_name().unwrap(),
        b"Type0"
    );
    assert_eq!(
        cjk_font.get(b"Encoding").unwrap().as_name().unwrap(),
        b"UniJIS-UCS2-H"
    );

    let (_, line) = by_nm(&annots, "line");
    assert_eq!(
        numbers(line.get(b"L").unwrap()),
        vec![72.0, 350.0, 250.0, 380.0]
    );
    let le: Vec<&[u8]> = line
        .get(b"LE")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_name().unwrap())
        .collect();
    assert_eq!(le, vec![b"Circle".as_slice(), b"ClosedArrow"]);
    assert_eq!(numbers(line.get(b"IC").unwrap()), vec![0.0, 1.0, 0.0]);

    let (_, square) = by_nm(&annots, "square");
    let bs = square.get(b"BS").unwrap().as_dict().unwrap();
    assert_eq!(bs.get(b"S").unwrap().as_name().unwrap(), b"D");
    assert_eq!(numbers(bs.get(b"D").unwrap()), vec![4.0, 2.0]);

    let (_, image) = by_nm(&annots, "stamp-image");
    let xobjects = ap_stream(&doc, image)
        .dict
        .get(b"Resources")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"XObject")
        .unwrap()
        .as_dict()
        .unwrap();
    let img = doc
        .get_object(xobjects.get(b"Im0").unwrap().as_reference().unwrap())
        .unwrap()
        .as_stream()
        .unwrap();
    assert_eq!(img.dict.get(b"Width").unwrap().as_i64().unwrap(), 2);
    assert!(
        img.dict.get(b"SMask").is_ok(),
        "partially transparent image has a soft mask"
    );
    let (_, stamp) = by_nm(&annots, "stamp-text");
    assert_eq!(stamp.get(b"Name").unwrap().as_name().unwrap(), b"Approved");

    // Page 3 keeps its indirect /Annots array, which now also holds the reply.
    let page_c = page(&doc, 2);
    assert_eq!(
        page_c.get(b"Annots").unwrap().as_reference().unwrap(),
        sample.annots_array
    );
    let annots_c = page_annots(&doc, 2);
    assert_eq!(annots_c.len(), 3);
    let square_id = parse_ref(&sample.square).unwrap();
    assert_eq!(
        annots_c[2].1.get(b"IRT").unwrap().as_reference().unwrap(),
        square_id
    );

    let info = doc
        .get_dictionary(doc.trailer.get(b"Info").unwrap().as_reference().unwrap())
        .unwrap();
    assert_eq!(
        info.get(b"ModDate").unwrap().as_str().unwrap(),
        b"D:20261008150000+02'00'"
    );
}

fn approx(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-3)
}

#[test]
fn read_annotations_round_trips_dtos() {
    let sample = sample();
    let (dtos, out) = add_every_kind(&sample, None);
    let existing = read_annotations(&out, None).unwrap();
    // Original square + link, 16 new annotations and one pop-up.
    assert_eq!(existing.len(), 2 + dtos.len() + 1);
    assert!(existing
        .windows(2)
        .all(|w| w[0].page_index <= w[1].page_index));
    let link = existing
        .iter()
        .find(|e| e.reference == sample.link)
        .unwrap();
    assert_eq!(link.subtype, "Link");
    assert!(link.annotation.is_none());
    assert_eq!(link.rect, [300.0, 300.0, 400.0, 320.0]);

    for d in &dtos {
        let found = existing
            .iter()
            .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == d.nm))
            .unwrap();
        let a = found.annotation.as_ref().unwrap();
        assert_eq!(found.page_index, d.page_index);
        assert_eq!(a.kind, d.kind, "{}", d.nm);
        assert_eq!(a.contents, d.contents);
        assert_eq!(a.author, d.author);
        assert_eq!(a.subject, d.subject);
        assert_eq!(a.created, d.created);
        assert_eq!(a.modified, d.modified);
        assert_eq!(found.modified, d.modified);
        assert_eq!(a.color, d.color, "{}", d.nm);
        assert!((a.opacity - d.opacity).abs() < 1e-3);
        assert_eq!((a.hidden, a.print, a.locked), (d.hidden, d.print, d.locked));
        assert!(approx(&a.quad_points, &d.quad_points) || !d.kind.is_text_markup());
        assert_eq!(
            a.ink_list.len(),
            if d.kind == AnnotKind::Ink {
                d.ink_list.len()
            } else {
                0
            }
        );
        if matches!(d.kind, AnnotKind::Polygon | AnnotKind::Polyline) {
            assert!(approx(&a.vertices, &d.vertices));
        }
        if matches!(d.kind, AnnotKind::Line | AnnotKind::Polyline) {
            assert_eq!(a.line_endings, d.line_endings, "{}", d.nm);
        }
        if matches!(
            d.kind,
            AnnotKind::Square | AnnotKind::Circle | AnnotKind::Freetext | AnnotKind::Stamp
        ) {
            assert!(approx(&a.rect, &d.rect), "{}", d.nm);
            assert!(found.has_appearance);
        }
        if matches!(
            d.kind,
            AnnotKind::Square
                | AnnotKind::Circle
                | AnnotKind::Line
                | AnnotKind::Ink
                | AnnotKind::Polygon
        ) {
            assert!((a.border_width - d.border_width).abs() < 1e-6, "{}", d.nm);
            assert_eq!(a.border_style, d.border_style, "{}", d.nm);
            assert_eq!(a.interior_color, d.interior_color, "{}", d.nm);
        }
        match d.nm.as_str() {
            "line" => assert_eq!(a.line, d.line),
            "note-1" => {
                assert_eq!(a.icon.as_deref(), Some("Help"));
                assert!(found.popup_ref.is_some());
            }
            "freetext" => {
                assert_eq!(a.font_size, 11.0);
                assert_eq!(a.font_color, d.font_color);
                assert_eq!(a.text_align, TextAlign::Center);
                assert_eq!(a.interior_color, d.interior_color);
            }
            "square" => assert!(approx(&a.dash, &d.dash)),
            "stamp-text" => {
                assert_eq!(a.stamp_label, d.stamp_label);
                assert_eq!(a.stamp_sublabel, d.stamp_sublabel);
            }
            "reply-1" | "reply-2" => {
                assert!(!found.has_appearance);
                assert_eq!(found.reply_type.as_deref(), Some("R"));
                assert_eq!(found.in_reply_to_ref, a.in_reply_to_ref);
                assert_eq!(a.state, d.state);
            }
            _ => {}
        }
    }
    let note = existing
        .iter()
        .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == "note-1"))
        .unwrap();
    let reply = existing
        .iter()
        .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == "reply-1"))
        .unwrap();
    assert_eq!(
        reply.in_reply_to_ref.as_deref(),
        Some(note.reference.as_str())
    );
    let reply2 = existing
        .iter()
        .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == "reply-2"))
        .unwrap();
    assert_eq!(
        reply2.in_reply_to_ref.as_deref(),
        Some(sample.square.as_str())
    );
}

#[test]
fn empty_changes_return_input() {
    let sample = sample();
    let out =
        apply_document_changes(&sample.bytes, None, &DocumentChanges::default(), &[]).unwrap();
    assert_eq!(out, sample.bytes);
    let garbage = b"not a pdf at all";
    assert_eq!(
        apply_document_changes(garbage, None, &DocumentChanges::default(), &[]).unwrap(),
        garbage
    );
}

fn modify(reference: &str, annotation: AnnotationDto, regenerate: bool) -> DocumentChanges {
    DocumentChanges {
        annotations: AnnotationChanges {
            modify: vec![AnnotationModify {
                reference: reference.to_string(),
                annotation,
                regenerate_appearance: regenerate,
            }],
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn modify_keeps_object_numbers() {
    let sample = sample();
    let (_, out) = add_every_kind(&sample, None);
    let existing = read_annotations(&out, None).unwrap();
    let note = existing
        .iter()
        .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == "note-1"))
        .unwrap();
    let doc = load(&out, None);
    let note_id = parse_ref(&note.reference).unwrap();
    let old_ap = doc
        .get_dictionary(note_id)
        .unwrap()
        .get(b"AP")
        .unwrap()
        .clone();
    let popup_id = parse_ref(note.popup_ref.as_ref().unwrap()).unwrap();
    let old_popup = numbers(doc.get_dictionary(popup_id).unwrap().get(b"Rect").unwrap());

    // Text-only change: the appearance is kept, the rectangle moves (and the pop-up with it).
    let mut edited = note.annotation.clone().unwrap();
    edited.contents = "Edited contents".into();
    edited.author = "Bob".into();
    edited.color = Some([0.0, 0.5, 1.0]);
    edited.rect = [410.0, 790.0, 430.0, 810.0];
    edited.locked = true;
    let out2 = apply_document_changes(
        &out,
        None,
        &modify(&note.reference, edited.clone(), false),
        &[],
    )
    .unwrap();
    assert!(out2.starts_with(&out));
    let doc2 = load(&out2, None);
    let dict = doc2.get_dictionary(note_id).unwrap();
    assert_eq!(dict.get(b"AP").unwrap(), &old_ap);
    assert_eq!(
        dict.get(b"Contents").unwrap().as_str().unwrap(),
        b"Edited contents"
    );
    assert_eq!(dict.get(b"F").unwrap().as_i64().unwrap(), 4 | 8 | 16 | 128);
    assert_eq!(
        numbers(dict.get(b"Rect").unwrap()),
        vec![410.0, 790.0, 430.0, 810.0]
    );
    let popup = numbers(doc2.get_dictionary(popup_id).unwrap().get(b"Rect").unwrap());
    assert!(approx(
        &popup,
        &[
            old_popup[0] + 10.0,
            old_popup[1] - 10.0,
            old_popup[2] + 10.0,
            old_popup[3] - 10.0
        ]
    ));
    assert_eq!(page_annots(&doc2, 0).len(), page_annots(&doc, 0).len());

    // Regeneration rewrites the appearance but keeps /P, /Popup and the object number.
    edited.icon = Some("Star".into());
    let out3 =
        apply_document_changes(&out2, None, &modify(&note.reference, edited, true), &[]).unwrap();
    let doc3 = load(&out3, None);
    let dict = doc3.get_dictionary(note_id).unwrap();
    assert_ne!(dict.get(b"AP").unwrap(), &old_ap);
    assert_eq!(dict.get(b"Name").unwrap().as_name().unwrap(), b"Star");
    assert_eq!(
        dict.get(b"Popup").unwrap().as_reference().unwrap(),
        popup_id
    );
    assert!(dict.get(b"P").is_ok());
    assert_eq!(dict.get(b"NM").unwrap().as_str().unwrap(), b"note-1");

    // Turning the existing square into a filled, thick one regenerates its appearance.
    let square = existing
        .iter()
        .find(|e| e.reference == sample.square)
        .unwrap();
    let mut d = square.annotation.clone().unwrap();
    d.interior_color = Some([0.0, 1.0, 0.0]);
    d.border_width = 4.0;
    let out4 = apply_document_changes(&out3, None, &modify(&sample.square, d, true), &[]).unwrap();
    std::fs::write(output_dir().join("modified.pdf"), &out4).unwrap();
    let after = read_annotations(&out4, None).unwrap();
    let square = after.iter().find(|e| e.reference == sample.square).unwrap();
    let a = square.annotation.as_ref().unwrap();
    assert_eq!(a.interior_color, Some([0.0, 1.0, 0.0]));
    assert_eq!(a.border_width, 4.0);
    assert_eq!(a.nm, "existing-square");
}

#[test]
fn modify_and_delete_unknown_reference_fail() {
    let sample = sample();
    let d = dto(AnnotKind::Square, 0, [0.0, 0.0, 10.0, 10.0]);
    let err =
        apply_document_changes(&sample.bytes, None, &modify("9999R", d, true), &[]).unwrap_err();
    assert!(matches!(err, PdfError::AnnotationNotFound(r) if r == "9999R"));
    let changes = DocumentChanges {
        annotations: AnnotationChanges {
            delete: vec!["9999R".into()],
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(matches!(
        apply_document_changes(&sample.bytes, None, &changes, &[]),
        Err(PdfError::AnnotationNotFound(_))
    ));
    let changes = DocumentChanges {
        annotations: AnnotationChanges {
            delete: vec!["garbage".into()],
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(matches!(
        apply_document_changes(&sample.bytes, None, &changes, &[]),
        Err(PdfError::InvalidRequest(_))
    ));
}

#[test]
fn delete_removes_popup_and_replies() {
    let sample = sample();
    let (_, out) = add_every_kind(&sample, None);
    let existing = read_annotations(&out, None).unwrap();
    let note = existing
        .iter()
        .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == "note-1"))
        .unwrap();
    // Reply to the reply: deleted recursively.
    let mut nested = dto(AnnotKind::Note, 0, [0.0; 4]);
    nested.nm = "nested".into();
    let reply = existing
        .iter()
        .find(|e| e.annotation.as_ref().is_some_and(|a| a.nm == "reply-1"))
        .unwrap();
    nested.in_reply_to_ref = Some(reply.reference.clone());
    let out = apply_document_changes(&out, None, &changes(vec![nested]), &[]).unwrap();
    let before = read_annotations(&out, None).unwrap();

    let changes = DocumentChanges {
        annotations: AnnotationChanges {
            delete: vec![note.reference.clone(), sample.link.clone()],
            ..Default::default()
        },
        ..Default::default()
    };
    let out2 = apply_document_changes(&out, None, &changes, &[]).unwrap();
    assert!(out2.starts_with(&out));
    let after = read_annotations(&out2, None).unwrap();
    // note + popup + reply + nested reply on page 0, link on page 2.
    assert_eq!(after.len(), before.len() - 5);
    let gone = [
        note.reference.as_str(),
        note.popup_ref.as_deref().unwrap(),
        reply.reference.as_str(),
        sample.link.as_str(),
    ];
    assert!(after.iter().all(|e| !gone.contains(&e.reference.as_str())));
    assert!(after
        .iter()
        .all(|e| e.annotation.as_ref().is_none_or(|a| a.nm != "nested")));
    assert!(after.iter().any(|e| e.reference == sample.square));
}

#[test]
fn info_update_and_mod_date() {
    let sample = sample();
    let changes = DocumentChanges {
        info: Some(InfoUpdate {
            title: Some("Neuer Titel – ünïcödé".into()),
            author: Some(String::new()),
            keywords: Some("a, b".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let out = apply_document_changes(&sample.bytes, None, &changes, &[]).unwrap();
    assert!(out.starts_with(&sample.bytes));
    let doc = load(&out, None);
    let info = doc
        .get_dictionary(doc.trailer.get(b"Info").unwrap().as_reference().unwrap())
        .unwrap();
    assert_eq!(
        yapr_pdf::text::decode_text(info.get(b"Title").unwrap().as_str().unwrap()),
        "Neuer Titel – ünïcödé"
    );
    assert!(info.get(b"Author").is_err());
    assert_eq!(info.get(b"Keywords").unwrap().as_str().unwrap(), b"a, b");
    assert!(info
        .get(b"ModDate")
        .unwrap()
        .as_str()
        .unwrap()
        .starts_with(b"D:20"));
}

#[test]
fn invalid_requests_are_rejected() {
    let sample = sample();
    let bad_page = dto(AnnotKind::Square, 7, [0.0, 0.0, 10.0, 10.0]);
    assert!(matches!(
        apply_document_changes(&sample.bytes, None, &changes(vec![bad_page]), &[]),
        Err(PdfError::InvalidRequest(_))
    ));
    let mut missing_blob = dto(AnnotKind::Stamp, 0, [0.0, 0.0, 10.0, 10.0]);
    missing_blob.stamp_image = Some(StampImage {
        blob: 3,
        width: 1,
        height: 1,
    });
    assert!(matches!(
        apply_document_changes(&sample.bytes, None, &changes(vec![missing_blob]), &[]),
        Err(PdfError::InvalidRequest(_))
    ));
    let mut orphan = dto(AnnotKind::Note, 0, [0.0; 4]);
    orphan.in_reply_to_nm = Some("nobody".into());
    assert!(matches!(
        apply_document_changes(&sample.bytes, None, &changes(vec![orphan]), &[]),
        Err(PdfError::InvalidRequest(_))
    ));
}

#[test]
fn object_stream_documents_are_supported() {
    let sample = modern_sample();
    let before = read_annotations(&sample.bytes, None).unwrap();
    assert_eq!(before.len(), 2);
    assert_eq!(page_count(&sample.bytes, None).unwrap(), 3);
    let (dtos, out) = add_every_kind(&sample, None);
    assert!(out.starts_with(&sample.bytes));
    std::fs::write(output_dir().join("every_kind_objstm.pdf"), &out).unwrap();
    let after = read_annotations(&out, None).unwrap();
    assert_eq!(after.len(), 2 + dtos.len() + 1);
    assert_eq!(markers(&out, None), vec!["PAGE-A", "PAGE-B", "PAGE-C"]);
}

#[test]
fn encrypted_documents() {
    let sample = encrypted_sample();
    assert!(matches!(
        read_annotations(&sample.bytes, None),
        Err(PdfError::Password)
    ));
    assert!(matches!(
        read_annotations(&sample.bytes, Some("wrong")),
        Err(PdfError::Password)
    ));
    assert!(matches!(
        page_count(&sample.bytes, Some("nope")),
        Err(PdfError::Password)
    ));
    let wrong = apply_document_changes(
        &sample.bytes,
        Some("wrong"),
        &changes(every_kind(&sample)),
        &[&PIXELS],
    );
    assert!(matches!(wrong, Err(PdfError::Password)));

    let before = read_annotations(&sample.bytes, Some(USER_PASSWORD)).unwrap();
    assert_eq!(
        before
            .iter()
            .find(|e| e.reference == sample.square)
            .unwrap()
            .contents,
        "Existing square"
    );
    let (dtos, out) = add_every_kind(&sample, Some(USER_PASSWORD));
    assert!(out.starts_with(&sample.bytes));
    std::fs::write(output_dir().join("every_kind_encrypted.pdf"), &out).unwrap();
    // Appended objects are encrypted too: the plain text must not appear in the file.
    let needle = b"Second line";
    assert!(!out.windows(needle.len()).any(|w| w == needle));
    let after = read_annotations(&out, Some(USER_PASSWORD)).unwrap();
    assert_eq!(after.len(), 2 + dtos.len() + 1);
    let freetext = after
        .iter()
        .find_map(|e| e.annotation.as_ref().filter(|a| a.nm == "freetext"))
        .unwrap();
    assert_eq!(freetext.contents, dtos[6].contents);
    assert!(matches!(
        read_annotations(&out, None),
        Err(PdfError::Password)
    ));
}

/// Every note icon, every line ending and more text variants (written for visual checks with
/// `scripts/verify_with_pdfjs.mjs --render=...`).
#[test]
fn gallery_of_variants() {
    let sample = sample();
    let icons = [
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
    ];
    let mut add: Vec<AnnotationDto> = icons
        .iter()
        .enumerate()
        .map(|(i, icon)| {
            let x = 40.0 + i as f64 * 45.0;
            let mut d = dto(AnnotKind::Note, 0, [x, 780.0, x + 20.0, 800.0]);
            d.icon = Some(icon.to_string());
            d.color = Some([1.0, 0.85, 0.2]);
            d
        })
        .collect();
    let endings = [
        LineEnding::Square,
        LineEnding::Circle,
        LineEnding::Diamond,
        LineEnding::OpenArrow,
        LineEnding::ClosedArrow,
        LineEnding::Butt,
        LineEnding::ROpenArrow,
        LineEnding::RClosedArrow,
        LineEnding::Slash,
    ];
    for (i, ending) in endings.iter().enumerate() {
        let y = 740.0 - i as f64 * 22.0;
        let mut d = dto(AnnotKind::Line, 0, [0.0; 4]);
        d.line = Some([60.0, y, 220.0, y]);
        d.line_endings = [*ending, *ending];
        d.border_width = 1.5;
        d.color = Some([0.0, 0.3, 0.8]);
        add.push(d);
    }
    let mut right = dto(AnnotKind::Freetext, 0, [300.0, 600.0, 520.0, 740.0]);
    right.contents = "Right aligned text that wraps over several lines, with a long-word-that-cannot-be-split-anywhere and\n\nan empty line above. 한국어 텍스트".into();
    right.text_align = TextAlign::Right;
    right.border_width = 2.0;
    right.border_style = BorderStyle::Dashed;
    right.font_size = 10.0;
    add.push(right);
    let mut stamp = dto(AnnotKind::Stamp, 0, [60.0, 420.0, 260.0, 480.0]);
    stamp.stamp_label = Some("已审核 Reviewed".into());
    stamp.stamp_sublabel = Some("张三 2026-10-08".into());
    stamp.color = Some([0.1, 0.5, 0.1]);
    stamp.opacity = 0.8;
    add.push(stamp);
    let mut plain = dto(AnnotKind::Stamp, 0, [300.0, 420.0, 520.0, 520.0]);
    plain.stamp_label = Some("CONFIDENTIAL".into());
    plain.interior_color = Some([1.0, 0.95, 0.95]);
    add.push(plain);
    let mut polygon = dto(AnnotKind::Polygon, 0, [0.0; 4]);
    polygon.vertices = vec![
        80.0, 300.0, 160.0, 380.0, 240.0, 300.0, 200.0, 260.0, 120.0, 260.0,
    ];
    polygon.border_style = BorderStyle::Dashed;
    polygon.border_width = 2.0;
    add.push(polygon);
    let mut circle = dto(AnnotKind::Circle, 0, [300.0, 260.0, 400.0, 380.0]);
    circle.interior_color = Some([0.9, 0.9, 1.0]);
    circle.border_width = 4.0;
    add.push(circle);
    // Cloudy borders.
    let mut cloud_square = dto(AnnotKind::Square, 0, [60.0, 120.0, 200.0, 220.0]);
    cloud_square.border_style = BorderStyle::Cloudy;
    cloud_square.interior_color = Some([1.0, 1.0, 0.8]);
    add.push(cloud_square);
    let mut cloud_circle = dto(AnnotKind::Circle, 0, [230.0, 120.0, 370.0, 220.0]);
    cloud_circle.border_style = BorderStyle::Cloudy;
    add.push(cloud_circle);
    let mut cloud_polygon = dto(AnnotKind::Polygon, 0, [0.0; 4]);
    cloud_polygon.vertices = vec![400.0, 120.0, 540.0, 120.0, 470.0, 230.0];
    cloud_polygon.border_style = BorderStyle::Cloudy;
    cloud_polygon.border_width = 1.5;
    add.push(cloud_polygon);
    // Text box and stamps on the rotated page 2 must read upright in the viewer. In user
    // space the box is taller than wide because the page is displayed rotated by 90°.
    let mut rotated_text = dto(AnnotKind::Freetext, 1, [400.0, 100.0, 480.0, 300.0]);
    rotated_text.contents = "Upright on a rotated page".into();
    rotated_text.interior_color = Some([0.9, 1.0, 0.9]);
    rotated_text.nm = "rotated-text".into();
    add.push(rotated_text);
    let mut rotated_stamp = dto(AnnotKind::Stamp, 1, [300.0, 100.0, 360.0, 300.0]);
    rotated_stamp.stamp_label = Some("ROTATED".into());
    add.push(rotated_stamp);
    // Markup on the rotated page 2 (text runs bottom-to-top).
    for (i, kind) in [
        AnnotKind::Highlight,
        AnnotKind::Underline,
        AnnotKind::Strikeout,
        AnnotKind::Squiggly,
    ]
    .iter()
    .enumerate()
    {
        let x = 100.0 + i as f64 * 30.0;
        let mut d = dto(*kind, 1, [0.0; 4]);
        d.quad_points = vec![x, 100.0, x, 400.0, x + 16.0, 100.0, x + 16.0, 400.0];
        d.color = Some([0.9, 0.2, 0.6]);
        add.push(d);
    }
    let count = add.len();
    let out = apply_document_changes(&sample.bytes, None, &changes(add), &[]).unwrap();
    std::fs::write(output_dir().join("gallery.pdf"), &out).unwrap();
    let existing = read_annotations(&out, None).unwrap();
    // Plus one pop-up per note and the two original annotations.
    assert_eq!(existing.len(), count + icons.len() + 2);
    assert!(existing
        .iter()
        .filter(|e| e.subtype != "Popup" && e.subtype != "Link")
        .all(|e| e.has_appearance));
    let doc = load(&out, None);
    let (_, rotated) = page_annots(&doc, 1)
        .into_iter()
        .find(|(_, d)| {
            d.get(b"NM").ok().and_then(|n| n.as_str().ok()) == Some(b"rotated-text".as_slice())
        })
        .unwrap();
    assert_eq!(rotated.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
}

#[test]
fn damaged_cross_reference_falls_back_to_full_rewrite() {
    let sample = sample();
    // Point startxref at garbage: lopdf has to reconstruct the cross-reference table, so
    // there is no valid section to chain an incremental update to.
    let text = String::from_utf8_lossy(&sample.bytes).into_owned();
    let pos = text.rfind("startxref").unwrap();
    let mut damaged = sample.bytes[..pos].to_vec();
    damaged.extend_from_slice(b"startxref\n12\n%%EOF");
    assert_eq!(read_annotations(&damaged, None).unwrap().len(), 2);
    let add = vec![dto(AnnotKind::Square, 0, [10.0, 10.0, 50.0, 50.0])];
    let out = apply_document_changes(&damaged, None, &changes(add), &[]).unwrap();
    assert!(!out.starts_with(&damaged));
    assert_eq!(read_annotations(&out, None).unwrap().len(), 3);
    assert_eq!(markers(&out, None), vec!["PAGE-A", "PAGE-B", "PAGE-C"]);
}

#[test]
fn inline_annotations_are_skipped() {
    let (mut doc, mut sample) = build_sample();
    let page_a = page_ids(&doc)[0];
    let inline = lopdf::dictionary! { "Type" => "Annot", "Subtype" => "Square", "Rect" => vec![0.into(), 0.into(), 5.into(), 5.into()] };
    doc.get_dictionary_mut(page_a)
        .unwrap()
        .set("Annots", vec![Object::Dictionary(inline), Object::Null]);
    doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
    doc.save_to(&mut sample.bytes).unwrap();
    let existing = read_annotations(&sample.bytes, None).unwrap();
    assert_eq!(existing.len(), 2);
    // Adding to a page with inline entries keeps them.
    let out = apply_document_changes(
        &sample.bytes,
        None,
        &changes(vec![dto(AnnotKind::Square, 0, [10.0, 10.0, 50.0, 50.0])]),
        &[],
    )
    .unwrap();
    let doc = load(&out, None);
    assert_eq!(
        page(&doc, 0)
            .get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        3
    );
}
