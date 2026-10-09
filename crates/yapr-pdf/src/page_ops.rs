//! Structural page operations (rotate, delete, reorder, insert), written as an incremental
//! update.
//!
//! Operations are applied to an in-memory page list. When the structure changes, the page
//! tree is rebuilt as one flat `/Pages` node that reuses the root's object id: inherited
//! attributes are copied into every page first, so no page depends on the old tree.

use std::collections::{HashMap, HashSet};

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

use crate::dto::PageOp;
use crate::error::{PdfError, Result};
use crate::load::{load_document, Revision, Streams};
use crate::objects::{num_array, ObjectSource};
use crate::{page_tools, watermark};
use crate::pages::{
    collect_pages, inherited, normalize_rotation, page_rotation, root_pages_id, PageRef,
    DEFAULT_MEDIA_BOX, INHERITABLE,
};

/// Largest page side accepted for blank pages (the PDF implementation limit).
const MAX_PAGE_SIDE: f64 = 14_400.0;
/// Upper bound for the number of blank pages inserted by one operation.
const MAX_BLANK_PAGES: u32 = 10_000;

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
}

/// Apply `ops` sequentially to `rev`. Returns whether anything changed.
pub fn apply(rev: &mut Revision, ops: &[PageOp], blobs: &[&[u8]]) -> Result<bool> {
    let root = root_pages_id(&*rev, rev.trailer())?;
    let mut pages = collect_pages(&*rev, root);
    let mut structural = false;
    for op in ops {
        match op {
            PageOp::Rotate {
                pages: selected,
                delta,
            } => rotate(rev, &pages, selected, *delta)?,
            PageOp::Delete { pages: selected } => pages = delete(pages, selected)?,
            PageOp::Reorder { order } => pages = reorder(pages, order)?,
            PageOp::InsertBlank {
                at,
                count,
                width,
                height,
            } => {
                let blank = blank_pages(rev, root, *count, *width, *height)?;
                insert(&mut pages, *at, blank)?;
            }
            PageOp::InsertFromBlob {
                at,
                blob,
                password,
                pages: selected,
            } => {
                let source = blobs
                    .get(*blob)
                    .ok_or_else(|| invalid(format!("blob {blob} is missing")))?;
                check_insert_position(&pages, *at)?;
                let copied = copy_from(rev, source, password.as_deref(), selected.as_deref())?;
                insert(&mut pages, *at, copied)?;
            }
            PageOp::InsertImages {
                at,
                images,
                page_size,
                margin,
            } => {
                check_insert_position(&pages, *at)?;
                let new_pages = page_tools::image_pages(rev, root, images, blobs, *page_size, *margin)?;
                insert(&mut pages, *at, new_pages)?;
            }
            PageOp::Flip {
                pages: selected,
                horizontal,
            } => page_tools::flip(rev, &pages, selected, *horizontal)?,
            PageOp::Duplicate { pages: selected, at } => {
                check_insert_position(&pages, *at)?;
                let copies = page_tools::duplicate(rev, &pages, selected)?;
                insert(&mut pages, *at, copies)?;
            }
            PageOp::Watermark {
                pages: selected,
                watermark,
            } => watermark::apply_watermark(rev, &pages, selected, watermark, blobs)?,
        }
        structural |= !matches!(op, PageOp::Rotate { .. } | PageOp::Flip { .. } | PageOp::Watermark { .. });
    }
    if structural {
        rebuild_tree(rev, root, &pages)?;
    }
    Ok(!ops.is_empty())
}

fn check_index(pages: &[PageRef], index: u32) -> Result<usize> {
    let i = index as usize;
    if i < pages.len() {
        Ok(i)
    } else {
        Err(invalid(format!(
            "page index {index} is out of range (document has {} pages)",
            pages.len()
        )))
    }
}

fn check_insert_position(pages: &[PageRef], at: u32) -> Result<usize> {
    let i = at as usize;
    if i <= pages.len() {
        Ok(i)
    } else {
        Err(invalid(format!(
            "insert position {at} is out of range (document has {} pages)",
            pages.len()
        )))
    }
}

fn rotate(rev: &mut Revision, pages: &[PageRef], selected: &[u32], delta: i32) -> Result<()> {
    if delta % 90 != 0 {
        return Err(invalid(format!("rotation {delta} is not a multiple of 90")));
    }
    let indices: Vec<usize> = selected
        .iter()
        .map(|&i| check_index(pages, i))
        .collect::<Result<_>>()?;
    let mut done = HashSet::new();
    for i in indices {
        let page = &pages[i];
        if !done.insert(page.id) {
            continue;
        }
        let rotation = normalize_rotation(page_rotation(&*rev, page) + i64::from(delta));
        rev.dict_mut(page.id)?.set("Rotate", rotation);
    }
    Ok(())
}

fn delete(pages: Vec<PageRef>, selected: &[u32]) -> Result<Vec<PageRef>> {
    let remove: HashSet<usize> = selected
        .iter()
        .map(|&i| check_index(&pages, i))
        .collect::<Result<_>>()?;
    if remove.len() == pages.len() {
        return Err(invalid("cannot delete every page of the document"));
    }
    Ok(pages
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !remove.contains(i))
        .map(|(_, p)| p)
        .collect())
}

fn reorder(pages: Vec<PageRef>, order: &[u32]) -> Result<Vec<PageRef>> {
    if order.len() != pages.len() {
        return Err(invalid(format!(
            "reorder needs {} indices, got {}",
            pages.len(),
            order.len()
        )));
    }
    let mut seen = HashSet::new();
    for &i in order {
        check_index(&pages, i)?;
        if !seen.insert(i) {
            return Err(invalid(format!(
                "reorder is not a permutation: index {i} appears twice"
            )));
        }
    }
    Ok(order.iter().map(|&i| pages[i as usize].clone()).collect())
}

fn insert(pages: &mut Vec<PageRef>, at: u32, new_pages: Vec<PageRef>) -> Result<()> {
    let at = check_insert_position(pages, at)?;
    pages.splice(at..at, new_pages);
    Ok(())
}

fn blank_pages(
    rev: &mut Revision,
    root: ObjectId,
    count: u32,
    width: f64,
    height: f64,
) -> Result<Vec<PageRef>> {
    let valid = |v: f64| v.is_finite() && v > 0.0 && v <= MAX_PAGE_SIDE;
    if !valid(width) || !valid(height) {
        return Err(invalid(format!(
            "blank page size {width} x {height} is invalid"
        )));
    }
    if count > MAX_BLANK_PAGES {
        return Err(invalid(format!(
            "cannot insert more than {MAX_BLANK_PAGES} blank pages at once"
        )));
    }
    Ok((0..count)
        .map(|_| {
            let contents = rev.add(Stream::new(Dictionary::new(), Vec::new()));
            let id = rev.add(dictionary! {
                "Type" => "Page",
                "Parent" => root,
                "MediaBox" => num_array(&[0.0, 0.0, width, height]),
                "Resources" => Dictionary::new(),
                "Contents" => contents,
            });
            PageRef {
                id,
                ancestors: Vec::new(),
            }
        })
        .collect())
}

/// Copy pages of another PDF into `rev` (all pages when `selected` is `None`).
fn copy_from(
    rev: &mut Revision,
    source: &[u8],
    password: Option<&str>,
    selected: Option<&[u32]>,
) -> Result<Vec<PageRef>> {
    let doc = load_document(source, password, Streams::Keep)?;
    let root = root_pages_id(&doc, &doc.trailer)?;
    let pages = collect_pages(&doc, root);
    let chosen: Vec<PageRef> = match selected {
        None => pages.clone(),
        Some(indices) => indices
            .iter()
            .map(|&i| {
                pages.get(i as usize).cloned().ok_or_else(|| {
                    invalid(format!(
                        "source page index {i} is out of range (source has {} pages)",
                        pages.len()
                    ))
                })
            })
            .collect::<Result<_>>()?,
    };
    if chosen.is_empty() {
        return Err(invalid("no source pages to insert"));
    }
    let mut copier = Copier::new(&doc, &pages);
    Ok(copier.copy_pages(rev, &chosen))
}

/// Deep copy of source objects into the target revision with renumbered ids.
struct Copier<'s> {
    src: &'s Document,
    /// Source id -> target id of every copied object.
    map: HashMap<ObjectId, ObjectId>,
    /// Source objects whose target id is reserved but whose copy is not written yet.
    pending: Vec<ObjectId>,
    /// Every page of the source; references to pages that are not copied become `null`.
    source_pages: HashSet<ObjectId>,
    /// Page-tree nodes and the catalog are never copied.
    stop: HashSet<ObjectId>,
}

impl<'s> Copier<'s> {
    fn new(src: &'s Document, pages: &[PageRef]) -> Self {
        let mut stop: HashSet<ObjectId> = pages
            .iter()
            .flat_map(|p| p.ancestors.iter().copied())
            .collect();
        if let Ok(Object::Reference(catalog)) = src.trailer.get(b"Root") {
            stop.insert(*catalog);
        }
        Self {
            src,
            map: HashMap::new(),
            pending: Vec::new(),
            source_pages: pages.iter().map(|p| p.id).collect(),
            stop,
        }
    }

    fn copy_pages(&mut self, rev: &mut Revision, chosen: &[PageRef]) -> Vec<PageRef> {
        // Reserve ids for the pages first so that links between copied pages are kept.
        let targets: Vec<ObjectId> = chosen.iter().map(|_| rev.new_id()).collect();
        for (page, target) in chosen.iter().zip(&targets) {
            self.map.entry(page.id).or_insert(*target);
        }
        for (page, target) in chosen.iter().zip(&targets) {
            let mut dict = self.src.dict(page.id).cloned().unwrap_or_default();
            for key in INHERITABLE {
                if !dict.has(key) {
                    if let Some(value) = inherited(self.src, page, key) {
                        dict.set(key, value.clone());
                    }
                }
            }
            dict.remove(b"Parent");
            dict.set("Type", "Page");
            let copy = self.map_dict(rev, dict);
            rev.set(*target, copy);
        }
        while let Some(source_id) = self.pending.pop() {
            let (Some(target), Some(object)) = (
                self.map.get(&source_id).copied(),
                self.src.objects.get(&source_id),
            ) else {
                continue;
            };
            let copy = self.map_object(rev, object.clone());
            rev.set(target, copy);
        }
        targets
            .into_iter()
            .map(|id| PageRef {
                id,
                ancestors: Vec::new(),
            })
            .collect()
    }

    fn map_ref(&mut self, rev: &mut Revision, id: ObjectId) -> Object {
        if let Some(target) = self.map.get(&id) {
            return Object::Reference(*target);
        }
        if self.source_pages.contains(&id)
            || self.stop.contains(&id)
            || !self.src.objects.contains_key(&id)
        {
            return Object::Null;
        }
        let target = rev.new_id();
        self.map.insert(id, target);
        self.pending.push(id);
        Object::Reference(target)
    }

    fn map_object(&mut self, rev: &mut Revision, object: Object) -> Object {
        match object {
            Object::Reference(id) => self.map_ref(rev, id),
            Object::Array(items) => {
                Object::Array(items.into_iter().map(|o| self.map_object(rev, o)).collect())
            }
            Object::Dictionary(dict) => Object::Dictionary(self.map_dict(rev, dict)),
            Object::Stream(mut stream) => {
                stream.dict = self.map_dict(rev, stream.dict);
                let length = stream.content.len() as i64;
                stream.dict.set("Length", length);
                Object::Stream(stream)
            }
            other => other,
        }
    }

    fn map_dict(&mut self, rev: &mut Revision, dict: Dictionary) -> Dictionary {
        dict.into_iter()
            .map(|(key, value)| (key, self.map_object(rev, value)))
            .collect()
    }
}

/// Replace the page tree by a single `/Pages` node (reusing `root`) listing `pages`.
fn rebuild_tree(rev: &mut Revision, root: ObjectId, pages: &[PageRef]) -> Result<()> {
    for page in pages {
        let missing: Vec<(&[u8], Object)> = INHERITABLE
            .iter()
            .filter(|key| rev.dict(page.id).is_some_and(|d| !d.has(key)))
            .filter_map(|key| inherited(&*rev, page, key).map(|v| (*key, v.clone())))
            .collect();
        let dict = rev
            .dict(page.id)
            .ok_or_else(|| PdfError::Parse("page object is missing".into()))?;
        let parent_ok = matches!(dict.get(b"Parent"), Ok(Object::Reference(p)) if *p == root);
        let has_media_box = dict.has(b"MediaBox") || missing.iter().any(|(k, _)| *k == b"MediaBox");
        if parent_ok && missing.is_empty() && has_media_box && dict.has_type(b"Page") {
            continue;
        }
        let dict = rev.dict_mut(page.id)?;
        for (key, value) in missing {
            dict.set(key, value);
        }
        if !has_media_box {
            dict.set("MediaBox", num_array(&DEFAULT_MEDIA_BOX));
        }
        dict.set("Type", "Page");
        dict.set("Parent", root);
    }
    let count = i64::try_from(pages.len()).map_err(|_| invalid("too many pages"))?;
    let tree = rev.dict_mut(root)?;
    for key in INHERITABLE {
        tree.remove(key);
    }
    tree.remove(b"Parent");
    tree.set("Type", "Pages");
    tree.set(
        "Kids",
        pages
            .iter()
            .map(|p| Object::Reference(p.id))
            .collect::<Vec<_>>(),
    );
    tree.set("Count", count);
    Ok(())
}
