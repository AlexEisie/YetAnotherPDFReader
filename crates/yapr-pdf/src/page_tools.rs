//! Page operations that create or transform page content: pictures as pages, mirroring and
//! duplicating pages.

use std::collections::{HashMap, HashSet};

use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};

use crate::dto::PageImage;
use crate::error::{PdfError, Result};
use crate::imaging::add_picture;
use crate::load::Revision;
use crate::objects::{num_array, ObjectSource};
use crate::page_edit::{apply, invert, mul, view, wrap_contents, Matrix};
use crate::pages::{annot_entries, inherited, PageRef, INHERITABLE};

/// Largest page side accepted by PDF viewers (the implementation limit).
const MAX_PAGE_SIDE: f64 = 14_400.0;
/// Pixels to points for pictures without a target page size (96 dpi).
const PX_TO_PT: f64 = 72.0 / 96.0;
/// Upper bound for the number of pictures inserted by one operation.
const MAX_IMAGES: usize = 2_000;

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
}

/// Annotation kinds whose appearance is pure geometry: after mirroring, their appearance
/// stream is dropped so viewers redraw them from the transformed coordinates.
const GEOMETRIC_KINDS: [&[u8]; 10] = [
    b"Line", b"Square", b"Circle", b"Polygon", b"PolyLine", b"Ink", b"Highlight",
    b"Underline", b"StrikeOut", b"Squiggly",
];

// ------------------------------------------------------------------------------ pictures

/// One new page per picture.
pub fn image_pages(
    rev: &mut Revision,
    root: ObjectId,
    images: &[PageImage],
    blobs: &[&[u8]],
    page_size: Option<[f64; 2]>,
    margin: f64,
) -> Result<Vec<PageRef>> {
    if images.is_empty() {
        return Err(invalid("no pictures to insert"));
    }
    if images.len() > MAX_IMAGES {
        return Err(invalid(format!("cannot insert more than {MAX_IMAGES} pictures at once")));
    }
    if let Some([w, h]) = page_size {
        let ok = |v: f64| (36.0..=MAX_PAGE_SIDE).contains(&v);
        if !ok(w) || !ok(h) {
            return Err(invalid(format!("page size {w} x {h} is invalid")));
        }
    }
    let margin = if margin.is_finite() { margin.max(0.0) } else { 0.0 };
    let mut out = Vec::with_capacity(images.len());
    for image in images {
        let picture = add_picture(image, blobs, |o| rev.add(o))?;
        let (pw, ph) = (f64::from(picture.width), f64::from(picture.height));
        let (page_w, page_h) = match page_size {
            Some([w, h]) => {
                // Portrait page for portrait pictures, landscape for landscape ones.
                if (pw > ph) == (w > h) { (w, h) } else { (h, w) }
            }
            None => {
                let (w, h) = (pw * PX_TO_PT + 2.0 * margin, ph * PX_TO_PT + 2.0 * margin);
                let shrink = (MAX_PAGE_SIDE / w.max(h)).min(1.0);
                ((w * shrink).max(1.0), (h * shrink).max(1.0))
            }
        };
        let (box_w, box_h) = ((page_w - 2.0 * margin).max(1.0), (page_h - 2.0 * margin).max(1.0));
        let scale = (box_w / pw).min(box_h / ph);
        let (w, h) = (pw * scale, ph * scale);
        let (x, y) = ((page_w - w) / 2.0, (page_h - h) / 2.0);
        let m = picture.placement(x, y, w, h);
        let nums: Vec<String> = m.iter().map(|v| crate::content::fmt_num(*v)).collect();
        let content = format!("q {} cm /Im0 Do Q\n", nums.join(" "));
        let contents = rev.add(Stream::new(Dictionary::new(), content.into_bytes()));
        let id = rev.add(dictionary! {
            "Type" => "Page",
            "Parent" => root,
            "MediaBox" => num_array(&[0.0, 0.0, page_w, page_h]),
            "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => picture.id } },
            "Contents" => contents,
        });
        out.push(PageRef { id, ancestors: Vec::new() });
    }
    Ok(out)
}

// ------------------------------------------------------------------------------ mirroring

fn transform_points(values: &[f64], m: Matrix) -> Vec<f64> {
    values
        .chunks_exact(2)
        .flat_map(|p| {
            let (x, y) = apply(m, p[0], p[1]);
            [x, y]
        })
        .collect()
}

/// Transform the geometry entries of an annotation dictionary by `m`.
fn transform_annotation(rev: &Revision, dict: &mut Dictionary, m: Matrix) {
    if let Some(rect) = rev.get_numbers(dict, b"Rect").filter(|r| r.len() >= 4) {
        let corners = transform_points(
            &[rect[0], rect[1], rect[2], rect[1], rect[2], rect[3], rect[0], rect[3]],
            m,
        );
        let xs = corners.iter().step_by(2);
        let ys = corners.iter().skip(1).step_by(2);
        let (x1, x2) = xs.fold((f64::MAX, f64::MIN), |(a, b), &v| (a.min(v), b.max(v)));
        let (y1, y2) = ys.fold((f64::MAX, f64::MIN), |(a, b), &v| (a.min(v), b.max(v)));
        dict.set("Rect", num_array(&[x1, y1, x2, y2]));
    }
    for key in [b"QuadPoints".as_slice(), b"Vertices", b"L", b"CL"] {
        if let Some(values) = rev.get_numbers(dict, key) {
            dict.set(key, num_array(&transform_points(&values, m)));
        }
    }
    if let Some(strokes) = rev.get_array(dict, b"InkList").map(<[Object]>::to_vec) {
        let mapped: Vec<Object> = strokes
            .iter()
            .filter_map(|s| rev.numbers(s))
            .map(|s| num_array(&transform_points(&s, m)))
            .collect();
        dict.set("InkList", mapped);
    }
    let geometric = rev
        .get_name(dict, b"Subtype")
        .is_some_and(|s| GEOMETRIC_KINDS.contains(&s));
    if geometric {
        dict.remove(b"AP");
    }
}

/// Mirror the selected pages (as displayed) horizontally or vertically.
pub fn flip(rev: &mut Revision, pages: &[PageRef], selected: &[u32], horizontal: bool) -> Result<()> {
    let mut done = HashSet::new();
    for &index in selected {
        let page = pages.get(index as usize).ok_or_else(|| {
            invalid(format!("page index {index} is out of range (document has {} pages)", pages.len()))
        })?;
        if !done.insert(page.id) {
            continue;
        }
        let v = view(&*rev, page);
        let mirror: Matrix = if horizontal {
            [-1.0, 0.0, 0.0, 1.0, v.width, 0.0]
        } else {
            [1.0, 0.0, 0.0, -1.0, 0.0, v.height]
        };
        let m = mul(mul(invert(v.to_user), mirror), v.to_user);
        wrap_contents(rev, page.id, b"", Some(m), b"")?;

        let entries: Vec<Object> = rev
            .dict(page.id)
            .map(|d| annot_entries(&*rev, d).to_vec())
            .unwrap_or_default();
        let mut inline_changed = false;
        let mut rebuilt = Vec::with_capacity(entries.len());
        for entry in entries {
            match entry {
                Object::Reference(id) => {
                    if let Some(mut dict) = rev.dict(id).cloned() {
                        transform_annotation(rev, &mut dict, m);
                        rev.set(id, dict);
                    }
                    rebuilt.push(Object::Reference(id));
                }
                Object::Dictionary(mut dict) => {
                    transform_annotation(rev, &mut dict, m);
                    inline_changed = true;
                    rebuilt.push(Object::Dictionary(dict));
                }
                other => rebuilt.push(other),
            }
        }
        if inline_changed {
            rev.dict_mut(page.id)?.set("Annots", rebuilt);
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------ duplicating

/// Copies of the selected pages (in selection order). Content and resources are shared with
/// the originals; comments are copied (form fields are not, they belong to a single page).
pub fn duplicate(rev: &mut Revision, pages: &[PageRef], selected: &[u32]) -> Result<Vec<PageRef>> {
    if selected.is_empty() {
        return Err(invalid("no pages to duplicate"));
    }
    let mut out = Vec::with_capacity(selected.len());
    for &index in selected {
        let page = pages.get(index as usize).ok_or_else(|| {
            invalid(format!("page index {index} is out of range (document has {} pages)", pages.len()))
        })?;
        let mut dict = rev
            .dict(page.id)
            .cloned()
            .ok_or_else(|| PdfError::Parse("page object is missing".into()))?;
        for key in INHERITABLE {
            if !dict.has(key) {
                if let Some(value) = inherited(&*rev, page, key) {
                    dict.set(key, value.clone());
                }
            }
        }
        for key in [b"Parent".as_slice(), b"StructParents", b"B", b"Annots"] {
            dict.remove(key);
        }
        let new_id = rev.new_id();
        let annots = copy_annotations(rev, page.id, new_id);
        if !annots.is_empty() {
            dict.set("Annots", annots);
        }
        rev.set(new_id, dict);
        out.push(PageRef { id: new_id, ancestors: Vec::new() });
    }
    Ok(out)
}

/// Copy the non-widget annotations of `from` for the page `to`, keeping links between them.
fn copy_annotations(rev: &mut Revision, from: ObjectId, to: ObjectId) -> Vec<Object> {
    let entries: Vec<Object> = rev
        .dict(from)
        .map(|d| annot_entries(&*rev, d).to_vec())
        .unwrap_or_default();
    let is_widget = |rev: &Revision, d: &Dictionary| rev.get_name(d, b"Subtype") == Some(b"Widget");
    // Reserve ids first so /Popup, /Parent and /IRT can be remapped.
    let mut map: HashMap<ObjectId, ObjectId> = HashMap::new();
    for entry in &entries {
        if let Object::Reference(id) = entry {
            if rev.dict(*id).is_some_and(|d| !is_widget(rev, d)) {
                let new = rev.new_id();
                map.insert(*id, new);
            }
        }
    }
    let remap = |dict: &mut Dictionary, map: &HashMap<ObjectId, ObjectId>| {
        for key in [b"Popup".as_slice(), b"Parent", b"IRT"] {
            if let Ok(Object::Reference(id)) = dict.get(key) {
                match map.get(id) {
                    Some(new) => dict.set(key, *new),
                    None if key != b"IRT" => {
                        dict.remove(key);
                    }
                    None => {}
                }
            }
        }
        dict.remove(b"NM");
        dict.set("P", to);
    };
    let mut out = Vec::new();
    for entry in entries {
        match entry {
            Object::Reference(id) => {
                let Some(&new) = map.get(&id) else { continue };
                let Some(mut dict) = rev.dict(id).cloned() else { continue };
                remap(&mut dict, &map);
                rev.set(new, dict);
                out.push(Object::Reference(new));
            }
            Object::Dictionary(mut dict) if !is_widget(rev, &dict) => {
                remap(&mut dict, &map);
                out.push(Object::Dictionary(dict));
            }
            _ => {}
        }
    }
    out
}
