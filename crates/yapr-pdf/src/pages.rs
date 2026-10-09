//! Page tree traversal, inherited attributes and `/Annots` arrays.

use std::collections::HashSet;

use lopdf::{Dictionary, Object, ObjectId};

use crate::dto::Rect;
use crate::error::{PdfError, Result};
use crate::geometry::normalize_rect;
use crate::load::Revision;
use crate::objects::ObjectSource;

/// Page attributes that may be inherited from ancestor `/Pages` nodes.
pub const INHERITABLE: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// US Letter, used when a page has no usable `/MediaBox` at all.
pub const DEFAULT_MEDIA_BOX: Rect = [0.0, 0.0, 612.0, 792.0];

/// Maximum page-tree depth that is followed (protects against hostile files).
const MAX_DEPTH: usize = 64;

/// A leaf of the page tree together with its ancestors (nearest first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRef {
    pub id: ObjectId,
    pub ancestors: Vec<ObjectId>,
}

/// The id of the root `/Pages` node (`/Root /Pages`).
pub fn root_pages_id(src: &impl ObjectSource, trailer: &Dictionary) -> Result<ObjectId> {
    let catalog = src
        .get_dict(trailer, b"Root")
        .ok_or_else(|| PdfError::Parse("the document has no catalog".into()))?;
    match catalog.get(b"Pages") {
        Ok(Object::Reference(id)) if src.dict(*id).is_some() => Ok(*id),
        _ => Err(PdfError::Parse("the catalog has no page tree".into())),
    }
}

/// Whether a page-tree node is an intermediate `/Pages` node (lenient about `/Type`).
fn is_pages_node(src: &impl ObjectSource, dict: &Dictionary) -> bool {
    match dict.get(b"Type").ok().and_then(|t| t.as_name().ok()) {
        Some(b"Pages") => true,
        Some(b"Page") => false,
        _ => src.get_array(dict, b"Kids").is_some(),
    }
}

/// All pages in document order. Cycles, dangling kids and non-dictionary kids are skipped.
pub fn collect_pages(src: &impl ObjectSource, root: ObjectId) -> Vec<PageRef> {
    let mut pages = Vec::new();
    let mut seen = HashSet::new();
    // Depth-first with an explicit stack; children are pushed in reverse to keep order.
    let mut stack = vec![(root, Vec::new())];
    while let Some((id, ancestors)) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        let Some(dict) = src.dict(id) else { continue };
        if !is_pages_node(src, dict) {
            pages.push(PageRef { id, ancestors });
            continue;
        }
        if ancestors.len() >= MAX_DEPTH {
            continue;
        }
        let kids = src.get_array(dict, b"Kids").unwrap_or_default();
        let mut child_ancestors = Vec::with_capacity(ancestors.len() + 1);
        child_ancestors.push(id);
        child_ancestors.extend_from_slice(&ancestors);
        for kid in kids.iter().rev() {
            if let Object::Reference(kid_id) = kid {
                stack.push((*kid_id, child_ancestors.clone()));
            }
        }
    }
    pages
}

/// Pages of the document whose trailer is `trailer`.
pub fn document_pages(src: &impl ObjectSource, trailer: &Dictionary) -> Result<Vec<PageRef>> {
    let root = root_pages_id(src, trailer)?;
    Ok(collect_pages(src, root))
}

/// The raw (unresolved) value of an inheritable attribute: the page's own or the nearest
/// ancestor's.
pub fn inherited<'a>(src: &'a impl ObjectSource, page: &PageRef, key: &[u8]) -> Option<&'a Object> {
    std::iter::once(page.id)
        .chain(page.ancestors.iter().copied())
        .filter_map(|id| src.dict(id))
        .find_map(|dict| dict.get(key).ok().filter(|v| !src.resolve(v).is_null()))
}

/// The visible page box (CropBox clipped to MediaBox) in default user space.
pub fn page_box(src: &impl ObjectSource, page: &PageRef) -> Rect {
    let rect = |key: &[u8]| -> Option<Rect> {
        let values = src.numbers(inherited(src, page, key)?)?;
        match values.as_slice() {
            [a, b, c, d, ..] => Some(normalize_rect([*a, *b, *c, *d])),
            _ => None,
        }
    };
    let media = rect(b"MediaBox").unwrap_or(DEFAULT_MEDIA_BOX);
    match rect(b"CropBox") {
        Some(crop) => {
            let clipped = [
                crop[0].max(media[0]),
                crop[1].max(media[1]),
                crop[2].min(media[2]),
                crop[3].min(media[3]),
            ];
            if clipped[0] < clipped[2] && clipped[1] < clipped[3] {
                clipped
            } else {
                media
            }
        }
        None => media,
    }
}

/// The page rotation in degrees (0, 90, 180 or 270).
pub fn page_rotation(src: &impl ObjectSource, page: &PageRef) -> i64 {
    let value = inherited(src, page, b"Rotate")
        .and_then(|v| crate::objects::as_f64(src.resolve(v)))
        .unwrap_or(0.0);
    normalize_rotation(value.round() as i64)
}

/// Normalise any angle to the nearest multiple of 90 in `0..360`.
pub fn normalize_rotation(degrees: i64) -> i64 {
    let quarter = (degrees as f64 / 90.0).round() as i64;
    quarter.rem_euclid(4) * 90
}

/// The raw entries of the page's `/Annots` array (inline or indirect).
pub fn annot_entries<'a>(src: &'a impl ObjectSource, page: &'a Dictionary) -> &'a [Object] {
    src.get_array(page, b"Annots").unwrap_or_default()
}

/// The ids of the annotations listed in the page's `/Annots` (direct dictionaries skipped).
pub fn annot_ids(src: &impl ObjectSource, page: &Dictionary) -> Vec<ObjectId> {
    annot_entries(src, page)
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .collect()
}

/// Where a page keeps its `/Annots` array.
enum AnnotsLocation {
    /// An indirect array object.
    Indirect(ObjectId),
    /// Inline in the page dictionary (or missing / unusable).
    Inline,
}

fn annots_location(rev: &Revision, page_id: ObjectId) -> Result<AnnotsLocation> {
    let page = rev
        .dict(page_id)
        .ok_or_else(|| PdfError::Parse("page object is missing".into()))?;
    let mut current = page.get(b"Annots").ok();
    let mut target = None;
    // Follow a (possibly chained) reference to the array object.
    for _ in 0..8 {
        match current {
            Some(Object::Reference(id)) => {
                target = Some(*id);
                current = rev.raw_object(*id);
            }
            Some(Object::Array(_)) => {
                return Ok(target.map_or(AnnotsLocation::Inline, AnnotsLocation::Indirect));
            }
            _ => break,
        }
    }
    Ok(AnnotsLocation::Inline)
}

/// Mutable access to the page's `/Annots` array, creating or repairing it as needed.
fn annots_mut(rev: &mut Revision, page_id: ObjectId) -> Result<&mut Vec<Object>> {
    match annots_location(rev, page_id)? {
        AnnotsLocation::Indirect(array_id) => match rev.object_mut(array_id)? {
            Object::Array(array) => Ok(array),
            _ => Err(PdfError::Unsupported("/Annots is not an array".into())),
        },
        AnnotsLocation::Inline => {
            let page = rev.dict_mut(page_id)?;
            if !matches!(page.get(b"Annots"), Ok(Object::Array(_))) {
                page.set("Annots", Object::Array(Vec::new()));
            }
            match page.get_mut(b"Annots") {
                Ok(Object::Array(array)) => Ok(array),
                _ => Err(PdfError::Unsupported("/Annots is not an array".into())),
            }
        }
    }
}

/// Append annotation references to the page's `/Annots`.
pub fn append_annots(rev: &mut Revision, page_id: ObjectId, ids: &[ObjectId]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let annots = annots_mut(rev, page_id)?;
    annots.extend(ids.iter().map(|&id| Object::Reference(id)));
    Ok(())
}

/// Remove references to `ids` from the page's `/Annots`. Returns whether anything changed.
pub fn remove_annots(
    rev: &mut Revision,
    page_id: ObjectId,
    ids: &HashSet<ObjectId>,
) -> Result<bool> {
    let present = rev
        .dict(page_id)
        .map(|page| annot_ids(rev, page).iter().any(|id| ids.contains(id)))
        .unwrap_or(false);
    if !present {
        return Ok(false);
    }
    let annots = annots_mut(rev, page_id)?;
    annots.retain(|o| !o.as_reference().is_ok_and(|id| ids.contains(&id)));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document};

    /// Root(/Pages, MediaBox) -> [A, Mid(/Rotate 90) -> [B, C]]; C lacks /Type.
    fn tree() -> (Document, ObjectId, Vec<ObjectId>) {
        let mut doc = Document::new();
        let root = doc.new_object_id();
        let mid = doc.new_object_id();
        let a = doc.add_object(dictionary! { "Type" => "Page", "Parent" => root });
        let b = doc.add_object(dictionary! { "Type" => "Page", "Parent" => mid, "Rotate" => 450 });
        let c = doc.add_object(dictionary! { "Parent" => mid });
        doc.objects.insert(mid, dictionary! { "Kids" => vec![b.into(), c.into(), mid.into()], "Parent" => root, "Rotate" => 90 }.into());
        doc.objects.insert(root, dictionary! {
            "Type" => "Pages", "Kids" => vec![a.into(), mid.into(), Object::Null, (99, 0).into()],
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 300.into()],
        }.into());
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => root });
        doc.trailer.set("Root", catalog);
        (doc, root, vec![a, b, c])
    }

    #[test]
    fn walks_tree_leniently() {
        let (doc, root, ids) = tree();
        let pages = document_pages(&doc, &doc.trailer).unwrap();
        assert_eq!(pages.iter().map(|p| p.id).collect::<Vec<_>>(), ids);
        assert_eq!(pages[2].ancestors.len(), 2);
        assert_eq!(pages[2].ancestors[1], root);
    }

    #[test]
    fn resolves_inherited_attributes() {
        let (doc, _, _) = tree();
        let pages = document_pages(&doc, &doc.trailer).unwrap();
        assert_eq!(page_box(&doc, &pages[0]), [0.0, 0.0, 200.0, 300.0]);
        assert_eq!(page_rotation(&doc, &pages[0]), 0);
        assert_eq!(page_rotation(&doc, &pages[1]), 90);
        assert_eq!(page_rotation(&doc, &pages[2]), 90);
    }

    #[test]
    fn normalises_rotation() {
        assert_eq!(normalize_rotation(-90), 270);
        assert_eq!(normalize_rotation(360), 0);
        assert_eq!(normalize_rotation(450), 90);
        assert_eq!(normalize_rotation(100), 90);
    }
}
