//! Test fixtures: small PDFs generated with lopdf.
#![allow(dead_code)]

use std::path::PathBuf;

use lopdf::xref::XrefType;
use lopdf::{
    dictionary, Dictionary, Document, EncryptionState, EncryptionVersion, Object, ObjectId,
    Permissions, Stream, StringFormat,
};
use yapr_pdf::*;

pub const USER_PASSWORD: &str = "user";

/// A generated sample document and the references of its pre-existing annotations.
pub struct Sample {
    pub bytes: Vec<u8>,
    /// `Square` annotation (with appearance) on page 3.
    pub square: String,
    /// `Link` annotation on page 3.
    pub link: String,
    /// The indirect `/Annots` array of page 3.
    pub annots_array: ObjectId,
}

fn literal(text: &str) -> Object {
    Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
}

pub fn rect(values: [i64; 4]) -> Object {
    Object::Array(values.iter().map(|&v| Object::Integer(v)).collect())
}

/// Content stream that shows a unique marker.
pub fn marker_content(marker: &str) -> Stream {
    Stream::new(
        Dictionary::new(),
        format!("BT /F1 24 Tf 72 700 Td ({marker}) Tj ET").into_bytes(),
    )
}

/// Three pages A, B, C:
/// * A has its own MediaBox (A4) and Resources,
/// * B inherits MediaBox / Resources from the root and `/Rotate 90` from an intermediate node,
/// * C has no `/Type`, an indirect `/Annots` array with a Square and a Link annotation.
pub fn build_sample() -> (Document, Sample) {
    let mut doc = Document::with_version("1.7");
    let font = doc.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
    );
    let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let root = doc.new_object_id();
    let mid = doc.new_object_id();
    let page_c = doc.new_object_id();
    let contents: Vec<ObjectId> = ["PAGE-A", "PAGE-B", "PAGE-C"]
        .iter()
        .map(|m| doc.add_object(marker_content(m)))
        .collect();
    let page_a = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => root, "MediaBox" => rect([0, 0, 595, 842]),
        "Resources" => resources, "Contents" => contents[0],
    });
    let page_b = doc
        .add_object(dictionary! { "Type" => "Page", "Parent" => mid, "Contents" => contents[1] });
    let square_ap = doc.add_object(Stream::new(
        dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => rect([100, 100, 200, 200]) },
        b"0 0 1 RG 100.5 100.5 99 99 re S".to_vec(),
    ));
    let square = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Square", "Rect" => rect([100, 100, 200, 200]),
        "C" => vec![0.into(), 0.into(), 1.into()], "P" => page_c, "NM" => literal("existing-square"),
        "T" => literal("Alice"), "Contents" => literal("Existing square"), "F" => 4,
        "AP" => dictionary! { "N" => square_ap },
    });
    let link = doc.add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Link", "Rect" => rect([300, 300, 400, 320]),
        "Border" => vec![0.into(), 0.into(), 0.into()],
        "A" => dictionary! { "S" => "URI", "URI" => literal("https://example.com") },
    });
    let annots_array = doc.add_object(vec![Object::Reference(square), Object::Reference(link)]);
    doc.objects.insert(
        page_c,
        dictionary! { "Parent" => mid, "Contents" => contents[2], "Annots" => annots_array }.into(),
    );
    doc.objects.insert(
        mid,
        dictionary! { "Type" => "Pages", "Parent" => root, "Kids" => vec![page_b.into(), page_c.into()], "Count" => 2, "Rotate" => 90 }.into(),
    );
    doc.objects.insert(
        root,
        dictionary! {
            "Type" => "Pages", "Kids" => vec![page_a.into(), mid.into()], "Count" => 3,
            "MediaBox" => rect([0, 0, 612, 792]), "Resources" => resources,
        }
        .into(),
    );
    let outline = doc.new_object_id();
    let item = doc.add_object(dictionary! {
        "Title" => literal("Page B"), "Parent" => outline, "Dest" => vec![page_b.into(), "Fit".into()],
    });
    doc.objects.insert(
        outline,
        dictionary! { "Type" => "Outlines", "First" => item, "Last" => item, "Count" => 1 }.into(),
    );
    let catalog =
        doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => root, "Outlines" => outline });
    let info =
        doc.add_object(dictionary! { "Title" => literal("Sample"), "Author" => literal("Tester") });
    doc.trailer.set("Root", catalog);
    doc.trailer.set("Info", info);
    let id = Object::String(b"0123456789abcdef".to_vec(), StringFormat::Hexadecimal);
    doc.trailer.set("ID", vec![id.clone(), id]);
    let sample = Sample {
        bytes: Vec::new(),
        square: format_ref(square),
        link: format_ref(link),
        annots_array,
    };
    (doc, sample)
}

/// The sample saved with a classic cross-reference table.
pub fn sample() -> Sample {
    let (mut doc, mut sample) = build_sample();
    doc.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
    doc.save_to(&mut sample.bytes).unwrap();
    sample
}

/// The sample saved with object streams and a cross-reference stream.
pub fn modern_sample() -> Sample {
    let (mut doc, mut sample) = build_sample();
    doc.save_modern(&mut sample.bytes).unwrap();
    sample
}

/// The sample encrypted (RC4-128) with user password [`USER_PASSWORD`].
pub fn encrypted_sample() -> Sample {
    let (mut doc, mut sample) = build_sample();
    doc.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
    let state = EncryptionState::try_from(EncryptionVersion::V2 {
        document: &doc,
        owner_password: "owner",
        user_password: USER_PASSWORD,
        key_length: 128,
        permissions: Permissions::all(),
    })
    .unwrap();
    doc.encrypt(&state).unwrap();
    doc.save_to(&mut sample.bytes).unwrap();
    sample
}

/// A document of `count` pages with markers `{prefix}1..`.
pub fn simple_pdf(count: usize, prefix: &str) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let font = doc.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" },
    );
    let root = doc.new_object_id();
    let kids: Vec<Object> = (1..=count)
        .map(|i| {
            let contents = doc.add_object(marker_content(&format!("{prefix}{i}")));
            doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => root, "MediaBox" => rect([0, 0, 300, 400]), "Contents" => contents,
                "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            })
            .into()
        })
        .collect();
    doc.objects.insert(
        root,
        dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count as i64 }.into(),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => root });
    doc.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

/// Load a document fully (decrypting with `password`).
pub fn load(bytes: &[u8], password: Option<&str>) -> Document {
    let options = lopdf::LoadOptions::with_password(password.unwrap_or(""));
    Document::load_mem_with_options(bytes, options).unwrap()
}

/// Page ids in page-tree order (lenient about `/Type`).
pub fn page_ids(doc: &Document) -> Vec<ObjectId> {
    fn walk(doc: &Document, id: ObjectId, out: &mut Vec<ObjectId>, depth: usize) {
        let Ok(dict) = doc.get_dictionary(id) else {
            return;
        };
        match dict.get(b"Kids").and_then(|k| k.as_array()) {
            Ok(kids) if depth < 32 && !dict.has_type(b"Page") => {
                for kid in kids {
                    if let Ok(kid) = kid.as_reference() {
                        walk(doc, kid, out, depth + 1);
                    }
                }
            }
            _ => out.push(id),
        }
    }
    let mut out = Vec::new();
    let root = doc
        .catalog()
        .unwrap()
        .get(b"Pages")
        .unwrap()
        .as_reference()
        .unwrap();
    walk(doc, root, &mut out, 0);
    out
}

/// The marker shown by each page, in order.
pub fn markers(bytes: &[u8], password: Option<&str>) -> Vec<String> {
    let doc = load(bytes, password);
    page_ids(&doc)
        .into_iter()
        .map(|id| {
            let content = String::from_utf8_lossy(&doc.get_page_content(id)).into_owned();
            content
                .split('(')
                .nth(1)
                .and_then(|s| s.split(')').next())
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

/// The page dictionary at `index`.
pub fn page(doc: &Document, index: usize) -> &Dictionary {
    doc.get_dictionary(page_ids(doc)[index]).unwrap()
}

/// The resolved annotation dictionaries of a page.
pub fn page_annots(doc: &Document, index: usize) -> Vec<(ObjectId, Dictionary)> {
    let page = page(doc, index);
    let annots = match page.get(b"Annots") {
        Ok(Object::Reference(id)) => doc.get_object(*id).unwrap().as_array().unwrap().clone(),
        Ok(Object::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    annots
        .iter()
        .map(|o| {
            let id = o.as_reference().unwrap();
            (id, doc.get_dictionary(id).unwrap().clone())
        })
        .collect()
}

pub fn subtype(dict: &Dictionary) -> String {
    String::from_utf8_lossy(dict.get(b"Subtype").unwrap().as_name().unwrap()).into_owned()
}

pub fn numbers(object: &Object) -> Vec<f64> {
    object
        .as_array()
        .unwrap()
        .iter()
        .map(|o| match o {
            Object::Integer(v) => *v as f64,
            Object::Real(v) => f64::from(*v),
            other => panic!("not a number: {other:?}"),
        })
        .collect()
}

/// Directory for generated files that the pdf.js verification script reads.
pub fn output_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("yapr-pdf-samples");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A DTO with defaults for `kind` on `page`.
pub fn dto(kind: AnnotKind, page: u32, rect: Rect) -> AnnotationDto {
    serde_json::from_value(serde_json::json!({
        "kind": kind,
        "pageIndex": page,
        "rect": rect,
        "color": [1.0, 0.0, 0.0],
        "author": "Tester",
        "contents": format!("{kind:?} contents"),
        "created": "2026-10-08T12:00:00Z",
        "modified": "2026-10-08T12:30:00Z",
    }))
    .unwrap()
}
