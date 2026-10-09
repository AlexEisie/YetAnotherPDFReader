//! Contract test: JSON exactly as produced by the TypeScript serializer
//! (`src/annotations/serialize.ts` → `toDto`) must deserialize and apply cleanly.

mod common;

use yapr_pdf::{apply_document_changes, read_annotations, DocumentChanges};

/// Shape emitted by `serializeChanges()` on the front-end: every optional field present,
/// unset ones as `null`, defaults spelled out.
const FRONTEND_JSON: &str = r#"{
  "annotations": {
    "add": [
      {
        "kind": "highlight", "pageIndex": 0, "rect": [100, 600, 300, 620],
        "color": [1, 0.83, 0], "interiorColor": null, "opacity": 0.45, "borderWidth": 1,
        "borderStyle": "solid", "dash": [], "contents": "高亮的评论", "author": "测试者",
        "subject": null, "nm": "yapr-1", "created": "2026-10-09T08:00:00.000Z",
        "modified": "2026-10-09T08:00:00.000Z", "hidden": false, "print": true, "locked": false,
        "quadPoints": [100, 620, 300, 620, 100, 600, 300, 600], "inkList": [], "vertices": [],
        "line": null, "lineEndings": ["None", "None"], "icon": null, "fontSize": 12,
        "fontColor": null, "textAlign": "left", "stampLabel": null, "stampSublabel": null,
        "stampImage": null, "inReplyToRef": null, "inReplyToNm": null, "state": null,
        "stateModel": null, "open": false
      },
      {
        "kind": "note", "pageIndex": 0, "rect": [90, 610, 110, 630],
        "color": [1, 0.83, 0], "interiorColor": null, "opacity": 1, "borderWidth": 1,
        "borderStyle": "solid", "dash": [], "contents": "A reply", "author": "Bob",
        "subject": null, "nm": "yapr-2", "created": "2026-10-09T08:01:00.000Z",
        "modified": "2026-10-09T08:01:00.000Z", "hidden": false, "print": true, "locked": false,
        "quadPoints": [], "inkList": [], "vertices": [], "line": null,
        "lineEndings": ["None", "None"], "icon": "Comment", "fontSize": 12, "fontColor": null,
        "textAlign": "left", "stampLabel": null, "stampSublabel": null, "stampImage": null,
        "inReplyToRef": null, "inReplyToNm": "yapr-1", "state": "Accepted", "stateModel": "Review",
        "open": false
      },
      {
        "kind": "freetext", "pageIndex": 0, "rect": [100, 400, 300, 440],
        "color": null, "interiorColor": [1, 1, 0.8], "opacity": 1, "borderWidth": 0,
        "borderStyle": "solid", "dash": [], "contents": "Text box 文本框", "author": "",
        "subject": null, "nm": "yapr-3", "created": null, "modified": null, "hidden": false,
        "print": true, "locked": false, "quadPoints": [], "inkList": [], "vertices": [],
        "line": null, "lineEndings": ["None", "None"], "icon": null, "fontSize": 14,
        "fontColor": [0.1, 0.1, 0.1], "textAlign": "center", "stampLabel": null,
        "stampSublabel": null, "stampImage": null, "inReplyToRef": null, "inReplyToNm": null,
        "state": null, "stateModel": null, "open": false
      },
      {
        "kind": "line", "pageIndex": 0, "rect": [40, 40, 210, 120],
        "color": [1, 0, 0], "interiorColor": null, "opacity": 1, "borderWidth": 2,
        "borderStyle": "dashed", "dash": [3, 3], "contents": "", "author": "", "subject": null,
        "nm": "yapr-4", "created": null, "modified": null, "hidden": false, "print": true,
        "locked": false, "quadPoints": [], "inkList": [], "vertices": [],
        "line": [50, 50, 200, 110], "lineEndings": ["None", "OpenArrow"], "icon": null,
        "fontSize": 12, "fontColor": null, "textAlign": "left", "stampLabel": null,
        "stampSublabel": null, "stampImage": {"blob": 0, "width": 2, "height": 1},
        "inReplyToRef": null, "inReplyToNm": null, "state": null, "stateModel": null, "open": false
      }
    ],
    "modify": [],
    "delete": []
  },
  "info": { "title": "Contract title", "author": null },
  "cjkHint": "zh-CN"
}"#;

#[test]
fn frontend_payload_applies() {
    let changes: DocumentChanges = serde_json::from_str(FRONTEND_JSON).expect("payload deserializes");
    assert_eq!(changes.annotations.add.len(), 4);
    let input = common::simple_pdf(2, "contract");
    let pixels = [255u8, 0, 0, 255, 0, 0, 255, 128];
    let output = apply_document_changes(&input, None, &changes, &[&pixels]).expect("changes apply");
    assert!(output.starts_with(&input), "incremental update keeps the original bytes");

    let read = read_annotations(&output, None).expect("output parses");
    let kinds: Vec<_> = read.iter().filter_map(|a| a.annotation.as_ref().map(|d| d.kind)).collect();
    assert!(kinds.len() >= 4, "all annotations read back: {kinds:?}");
    let reply = read.iter().find(|a| a.annotation.as_ref().map(|d| d.nm.as_str()) == Some("yapr-2")).expect("reply present");
    assert!(reply.in_reply_to_ref.is_some(), "reply is linked to its parent");
    let highlight = read
        .iter()
        .find(|a| a.annotation.as_ref().map(|d| d.nm.as_str()) == Some("yapr-1"))
        .expect("highlight present");
    assert_eq!(highlight.author, "测试者");
    assert_eq!(highlight.contents, "高亮的评论");
}
