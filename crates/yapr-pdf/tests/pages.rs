mod common;

use common::*;
use lopdf::Object;
use yapr_pdf::*;

fn ops(bytes: &[u8], ops: &[PageOp], blobs: &[&[u8]]) -> Result<Vec<u8>> {
    apply_page_ops(bytes, None, ops, blobs)
}

fn rotation(doc: &lopdf::Document, index: usize) -> i64 {
    page(doc, index)
        .get(b"Rotate")
        .map(|r| r.as_i64().unwrap())
        .unwrap_or(0)
}

#[test]
fn page_count_counts_leaves() {
    assert_eq!(page_count(&sample().bytes, None).unwrap(), 3);
    assert_eq!(page_count(&simple_pdf(5, "S"), None).unwrap(), 5);
    assert!(matches!(
        page_count(b"%PDF-1.4 garbage", None),
        Err(PdfError::Parse(_))
    ));
}

#[test]
fn rotate_adds_to_inherited_rotation() {
    let sample = sample();
    let out = ops(
        &sample.bytes,
        &[PageOp::Rotate {
            pages: vec![0, 1],
            delta: -90,
        }],
        &[],
    )
    .unwrap();
    assert!(out.starts_with(&sample.bytes));
    let doc = load(&out, None);
    assert_eq!(rotation(&doc, 0), 270);
    // Page B inherited /Rotate 90 from its parent node.
    assert_eq!(rotation(&doc, 1), 0);
    assert_eq!(markers(&out, None), vec!["PAGE-A", "PAGE-B", "PAGE-C"]);
    let out = ops(
        &out,
        &[PageOp::Rotate {
            pages: vec![2],
            delta: 450,
        }],
        &[],
    )
    .unwrap();
    assert_eq!(rotation(&load(&out, None), 2), 180);
    let err = ops(
        &sample.bytes,
        &[PageOp::Rotate {
            pages: vec![0],
            delta: 45,
        }],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::InvalidRequest(_)));
    let err = ops(
        &sample.bytes,
        &[PageOp::Rotate {
            pages: vec![3],
            delta: 90,
        }],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::InvalidRequest(_)));
}

#[test]
fn delete_and_reorder() {
    let sample = sample();
    let out = ops(
        &sample.bytes,
        &[PageOp::Reorder {
            order: vec![2, 0, 1],
        }],
        &[],
    )
    .unwrap();
    assert!(out.starts_with(&sample.bytes));
    assert_eq!(markers(&out, None), vec!["PAGE-C", "PAGE-A", "PAGE-B"]);
    let doc = load(&out, None);
    // Inherited attributes were copied into the pages of the flattened tree.
    let b = page(&doc, 2);
    assert!(b.get(b"MediaBox").is_ok() && b.get(b"Resources").is_ok());
    assert_eq!(rotation(&doc, 2), 90);
    assert_eq!(rotation(&doc, 0), 90);
    assert_eq!(rotation(&doc, 1), 0);
    assert_eq!(page_count(&out, None).unwrap(), 3);
    // Annotations survive and still point at their page.
    let annots = read_annotations(&out, None).unwrap();
    assert!(annots.iter().all(|a| a.page_index == 0));

    let out = ops(&out, &[PageOp::Delete { pages: vec![0, 2] }], &[]).unwrap();
    assert_eq!(markers(&out, None), vec!["PAGE-A"]);
    assert!(read_annotations(&out, None).unwrap().is_empty());

    for bad in [
        PageOp::Delete {
            pages: vec![0, 1, 2],
        },
        PageOp::Delete { pages: vec![5] },
        PageOp::Reorder {
            order: vec![0, 0, 1],
        },
        PageOp::Reorder { order: vec![0, 1] },
    ] {
        assert!(matches!(
            ops(&sample.bytes, &[bad], &[]),
            Err(PdfError::InvalidRequest(_))
        ));
    }
}

#[test]
fn insert_blank_and_from_blob() {
    let sample = sample();
    let other = simple_pdf(3, "OTHER-");
    let out = ops(
        &sample.bytes,
        &[
            PageOp::InsertBlank {
                at: 1,
                count: 2,
                width: 200.0,
                height: 300.0,
            },
            PageOp::InsertFromBlob {
                at: 5,
                blob: 0,
                password: None,
                pages: Some(vec![2, 0]),
            },
            PageOp::InsertFromBlob {
                at: 0,
                blob: 0,
                password: None,
                pages: None,
            },
        ],
        &[&other],
    )
    .unwrap();
    assert!(out.starts_with(&sample.bytes));
    std::fs::write(output_dir().join("page_ops.pdf"), &out).unwrap();
    assert_eq!(
        markers(&out, None),
        vec![
            "OTHER-1", "OTHER-2", "OTHER-3", "PAGE-A", "", "", "PAGE-B", "PAGE-C", "OTHER-3",
            "OTHER-1"
        ]
    );
    let doc = load(&out, None);
    let blank = page(&doc, 4);
    assert_eq!(
        numbers(blank.get(b"MediaBox").unwrap()),
        vec![0.0, 0.0, 200.0, 300.0]
    );
    let copied = page(&doc, 8);
    assert_eq!(
        numbers(copied.get(b"MediaBox").unwrap()),
        vec![0.0, 0.0, 300.0, 400.0]
    );
    let root = doc
        .catalog()
        .unwrap()
        .get(b"Pages")
        .unwrap()
        .as_reference()
        .unwrap();
    assert_eq!(copied.get(b"Parent").unwrap().as_reference().unwrap(), root);
    assert_eq!(page_count(&out, None).unwrap(), 10);

    let err = ops(
        &sample.bytes,
        &[PageOp::InsertBlank {
            at: 9,
            count: 1,
            width: 10.0,
            height: 10.0,
        }],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::InvalidRequest(_)));
    let err = ops(
        &sample.bytes,
        &[PageOp::InsertBlank {
            at: 0,
            count: 1,
            width: -1.0,
            height: 10.0,
        }],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::InvalidRequest(_)));
    let err = ops(
        &sample.bytes,
        &[PageOp::InsertFromBlob {
            at: 0,
            blob: 1,
            password: None,
            pages: None,
        }],
        &[&other],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::InvalidRequest(_)));
    let err = ops(
        &sample.bytes,
        &[PageOp::InsertFromBlob {
            at: 0,
            blob: 0,
            password: None,
            pages: Some(vec![3]),
        }],
        &[&other],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::InvalidRequest(_)));
}

#[test]
fn page_ops_on_object_stream_documents() {
    let sample = modern_sample();
    assert_eq!(ops(&sample.bytes, &[], &[]).unwrap(), sample.bytes);
    let out = ops(
        &sample.bytes,
        &[
            PageOp::Reorder {
                order: vec![1, 2, 0],
            },
            PageOp::Rotate {
                pages: vec![2],
                delta: 90,
            },
            PageOp::Delete { pages: vec![0] },
            PageOp::InsertBlank {
                at: 2,
                count: 1,
                width: 100.0,
                height: 100.0,
            },
        ],
        &[],
    )
    .unwrap();
    assert!(out.starts_with(&sample.bytes));
    std::fs::write(output_dir().join("page_ops_objstm.pdf"), &out).unwrap();
    assert_eq!(markers(&out, None), vec!["PAGE-C", "PAGE-A", ""]);
    let doc = load(&out, None);
    assert_eq!(rotation(&doc, 1), 90);
    assert_eq!(read_annotations(&out, None).unwrap().len(), 2);
}

#[test]
fn insert_copies_annotations_and_resources() {
    let target = simple_pdf(1, "T");
    let source = sample();
    let out = ops(
        &target,
        &[PageOp::InsertFromBlob {
            at: 1,
            blob: 0,
            password: None,
            pages: Some(vec![2, 1]),
        }],
        &[&source.bytes],
    )
    .unwrap();
    assert_eq!(markers(&out, None), vec!["T1", "PAGE-C", "PAGE-B"]);
    let doc = load(&out, None);
    // Inherited rotation and resources come along.
    assert_eq!(rotation(&doc, 1), 90);
    assert!(page(&doc, 2).get(b"Resources").is_ok());
    let annots = read_annotations(&out, None).unwrap();
    assert_eq!(annots.len(), 2);
    let square = annots.iter().find(|a| a.subtype == "Square").unwrap();
    assert_eq!(square.page_index, 1);
    assert!(square.has_appearance);
    let id = parse_ref(&square.reference).unwrap();
    let p = doc
        .get_dictionary(id)
        .unwrap()
        .get(b"P")
        .unwrap()
        .as_reference()
        .unwrap();
    assert_eq!(p, page_ids(&doc)[1]);
}

#[test]
fn page_ops_on_encrypted_documents() {
    let sample = encrypted_sample();
    let source = encrypted_sample();
    let err = apply_page_ops(
        &sample.bytes,
        Some("bad"),
        &[PageOp::Delete { pages: vec![0] }],
        &[],
    )
    .unwrap_err();
    assert!(matches!(err, PdfError::Password));
    let op = PageOp::InsertFromBlob {
        at: 0,
        blob: 0,
        password: None,
        pages: Some(vec![0]),
    };
    let err =
        apply_page_ops(&sample.bytes, Some(USER_PASSWORD), &[op], &[&source.bytes]).unwrap_err();
    assert!(matches!(err, PdfError::Password));
    let out = apply_page_ops(
        &sample.bytes,
        Some(USER_PASSWORD),
        &[
            PageOp::Delete { pages: vec![1] },
            PageOp::InsertFromBlob {
                at: 0,
                blob: 0,
                password: Some(USER_PASSWORD.into()),
                pages: Some(vec![1]),
            },
        ],
        &[&source.bytes],
    )
    .unwrap();
    assert!(out.starts_with(&sample.bytes));
    assert_eq!(
        markers(&out, Some(USER_PASSWORD)),
        vec!["PAGE-B", "PAGE-A", "PAGE-C"]
    );
}

#[test]
fn extract_pages_builds_standalone_document() {
    let sample = encrypted_sample();
    let out = extract_pages(&sample.bytes, Some(USER_PASSWORD), &[2, 0, 2]).unwrap();
    std::fs::write(output_dir().join("extracted.pdf"), &out).unwrap();
    assert!(!out.starts_with(&sample.bytes));
    let doc = load(&out, None);
    assert!(
        doc.trailer.get(b"Encrypt").is_err(),
        "output is not encrypted"
    );
    assert!(doc.catalog().unwrap().get(b"Outlines").is_err());
    assert_eq!(markers(&out, None), vec!["PAGE-C", "PAGE-A", "PAGE-C"]);
    assert_eq!(page_count(&out, None).unwrap(), 3);
    // Inherited attributes were made explicit.
    assert_eq!(rotation(&doc, 0), 90);
    assert!(page(&doc, 0).get(b"MediaBox").is_ok());
    // Annotations stay with the first occurrence of page C.
    let annots = read_annotations(&out, None).unwrap();
    assert_eq!(annots.len(), 2);
    assert!(annots.iter().all(|a| a.page_index == 0));
    // Only reachable objects are written: page B's content is gone.
    assert!(!doc.objects.values().any(|o| o
        .as_stream()
        .is_ok_and(|s| s.content.windows(6).any(|w| w == b"PAGE-B"))));
    let other = doc
        .objects
        .values()
        .filter(|o| matches!(o, Object::Dictionary(d) if d.has_type(b"Page")))
        .count();
    assert_eq!(other, 3);

    assert!(matches!(
        extract_pages(&sample.bytes, Some(USER_PASSWORD), &[]),
        Err(PdfError::InvalidRequest(_))
    ));
    assert!(matches!(
        extract_pages(&sample.bytes, Some(USER_PASSWORD), &[3]),
        Err(PdfError::InvalidRequest(_))
    ));
    assert!(matches!(
        extract_pages(&sample.bytes, None, &[0]),
        Err(PdfError::Password)
    ));
}

#[test]
fn dto_contract_serialisation() {
    let op: PageOp =
        serde_json::from_str(r#"{"op":"insertBlank","at":0,"count":1,"width":612,"height":792}"#)
            .unwrap();
    assert_eq!(
        op,
        PageOp::InsertBlank {
            at: 0,
            count: 1,
            width: 612.0,
            height: 792.0
        }
    );
    let op: PageOp = serde_json::from_str(r#"{"op":"insertFromBlob","at":2,"blob":0}"#).unwrap();
    assert_eq!(
        op,
        PageOp::InsertFromBlob {
            at: 2,
            blob: 0,
            password: None,
            pages: None
        }
    );
    let changes: DocumentChanges =
        serde_json::from_str(r#"{"annotations":{"delete":["12R"]}}"#).unwrap();
    assert_eq!(changes.annotations.delete, vec!["12R".to_string()]);
}
