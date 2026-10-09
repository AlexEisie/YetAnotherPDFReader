mod common;

use common::*;
use lopdf::{dictionary, Document, Object, Stream};
use yapr_pdf::*;

/// Two pages: page 1 uses Courier (shared) and an embedded TrueType subset; page 2 uses
/// Courier directly and a CID font through a form XObject; an annotation appearance uses
/// Helvetica.
fn font_sample() -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let courier = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
    let file2 = doc.add_object(Stream::new(dictionary! {}, vec![0u8; 16]));
    let descriptor = doc.add_object(dictionary! { "Type" => "FontDescriptor", "FontName" => "ABCDEF+Calibri", "FontFile2" => file2 });
    let calibri = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "TrueType", "BaseFont" => "ABCDEF+Calibri",
        "Encoding" => "WinAnsiEncoding", "FontDescriptor" => descriptor,
    });
    let cid = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "SimSun",
        "FontDescriptor" => dictionary! { "Type" => "FontDescriptor", "FontName" => "SimSun" },
    });
    let type0 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "SimSun", "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(cid)],
    });
    let form = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect([0, 0, 10, 10]),
            "Resources" => dictionary! { "Font" => dictionary! { "F9" => type0 } } },
        b"BT /F9 1 Tf ET".to_vec(),
    ));
    let appearance = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect([0, 0, 10, 10]),
            "Resources" => dictionary! { "Font" => dictionary! {
                "Helv" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" } } } },
        b"BT /Helv 9 Tf ET".to_vec(),
    ));
    let annot = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "FreeText", "Rect" => rect([0, 0, 10, 10]),
        "AP" => dictionary! { "N" => appearance },
    });
    let root = doc.new_object_id();
    let page1 = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => root, "MediaBox" => rect([0, 0, 300, 400]),
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => courier, "F2" => calibri } },
    });
    let page2 = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => root, "MediaBox" => rect([0, 0, 300, 400]),
        "Resources" => dictionary! { "Font" => dictionary! { "F1" => courier }, "XObject" => dictionary! { "X1" => form } },
        "Annots" => vec![Object::Reference(annot)],
    });
    doc.objects.insert(
        root,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page1), Object::Reference(page2)], "Count" => 2 }.into(),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => root });
    doc.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
fn lists_fonts_of_pages_forms_and_appearances() {
    let fonts = list_fonts(&font_sample(), None).unwrap();
    let summary: Vec<_> = fonts
        .iter()
        .map(|f| (f.name.as_str(), f.kind.as_str(), f.embedded, f.subset, f.first_page, f.page_count))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("Courier", "Type 1", false, false, 1, 2),
            ("Calibri", "TrueType", true, true, 1, 1),
            ("SimSun", "TrueType (CID)", false, false, 2, 1),
            ("Helvetica", "Type 1", false, false, 2, 1),
        ]
    );
    assert_eq!(fonts[1].encoding.as_deref(), Some("WinAnsiEncoding"));
    assert_eq!(fonts[2].encoding.as_deref(), Some("Identity-H"));
    assert_eq!(fonts[0].encoding, None);
}

#[test]
fn lists_fonts_of_simple_and_encrypted_documents() {
    let fonts = list_fonts(&simple_pdf(3, "S"), None).unwrap();
    assert_eq!(fonts.len(), 1);
    assert_eq!((fonts[0].name.as_str(), fonts[0].page_count), ("Courier", 3));
    let enc = encrypted_sample();
    assert!(matches!(list_fonts(&enc.bytes, Some("wrong")), Err(PdfError::Password)));
}
