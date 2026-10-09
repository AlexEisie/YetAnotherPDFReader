//! Creating, modifying, deleting and reading annotations.

mod build;
mod read;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use lopdf::{dictionary, Dictionary, Object, ObjectId};

use crate::appearance::{self, ApContext};
use crate::dto::{AnnotKind, AnnotationChanges, AnnotationDto, AnnotationModify, Rect};
use crate::error::{PdfError, Result};
use crate::fonts::{CjkCollection, FontKey};
use crate::geometry::normalize_rect;
use crate::load::Revision;
use crate::objects::{num_array, ObjectSource};
use crate::pages::{
    annot_ids, append_annots, document_pages, page_box, page_rotation, remove_annots, PageRef,
};
use crate::refs::{format_ref, parse_ref};

use build::{
    annotation_dict, apply_common, apply_state, is_reply, merged_flags, popup_dict, reply_dict,
    MANAGED_KEYS,
};
pub use read::read_all;

/// Reply / pop-up relations of the annotations that are currently on the pages.
#[derive(Default)]
struct AnnotIndex {
    /// Page indices whose `/Annots` list each annotation.
    pages_of: HashMap<ObjectId, Vec<usize>>,
    /// Replies (`/IRT`) of each annotation.
    replies: HashMap<ObjectId, Vec<ObjectId>>,
}

/// Applies [`AnnotationChanges`] to a [`Revision`].
pub struct Editor<'a> {
    rev: &'a mut Revision,
    pages: Vec<PageRef>,
    fonts: HashMap<FontKey, ObjectId>,
    cjk: CjkCollection,
    now: String,
    blobs: &'a [&'a [u8]],
    index: Option<AnnotIndex>,
    generated: u32,
}

impl<'a> Editor<'a> {
    pub fn new(
        rev: &'a mut Revision,
        now: String,
        cjk_hint: Option<&str>,
        blobs: &'a [&'a [u8]],
    ) -> Result<Self> {
        let pages = document_pages(&*rev, rev.trailer())?;
        Ok(Self {
            rev,
            pages,
            fonts: HashMap::new(),
            cjk: CjkCollection::from_hint(cjk_hint),
            now,
            blobs,
            index: None,
            generated: 0,
        })
    }

    /// Deletions first, then modifications, then additions.
    pub fn apply(&mut self, changes: &AnnotationChanges) -> Result<()> {
        for reference in &changes.delete {
            self.delete(reference)?;
        }
        for modify in &changes.modify {
            self.modify(modify)?;
        }
        self.add(&changes.add)
    }

    fn page(&self, index: u32) -> Result<&PageRef> {
        self.pages.get(index as usize).ok_or_else(|| {
            PdfError::InvalidRequest(format!(
                "page index {index} is out of range (document has {} pages)",
                self.pages.len()
            ))
        })
    }

    /// A unique `/NM` for annotations created without one.
    fn generate_nm(&mut self) -> String {
        self.generated += 1;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        format!("yapr-{nanos:x}-{}", self.generated)
    }

    /// The `/Rotate` of the page `page_id` (falling back to the page at `index`).
    fn rotation(&self, page_id: Option<ObjectId>, index: u32) -> i64 {
        let page = page_id
            .and_then(|id| self.pages.iter().find(|p| p.id == id))
            .or_else(|| self.pages.get(index as usize));
        page.map_or(0, |page| page_rotation(&*self.rev, page))
    }

    /// Generate the appearance stream of `dto` and link it into `dict` as `/AP /N`. Text and
    /// stamps are counter-rotated on rotated pages; `/Rotate` records that for pdf.js editors.
    fn attach_appearance(
        &mut self,
        dict: &mut Dictionary,
        dto: &AnnotationDto,
        rect: Rect,
        rotation: i64,
    ) -> Result<()> {
        let mut ctx = ApContext {
            sink: &mut *self.rev,
            fonts: &mut self.fonts,
            cjk: self.cjk,
            blobs: self.blobs,
        };
        let ap = appearance::build(dto, rect, rotation, &mut ctx)?;
        let id = self.rev.add(ap.into_stream());
        dict.set("AP", dictionary! { "N" => id });
        if rotation != 0 && appearance::is_upright_kind(dto.kind) {
            dict.set("Rotate", rotation);
        }
        Ok(())
    }

    /// The annotation dictionary for `reference`, or `AnnotationNotFound`.
    fn existing(&self, reference: &str) -> Result<(ObjectId, &Dictionary)> {
        let id = parse_ref(reference)?;
        let dict = self
            .rev
            .dict(id)
            .filter(|d| d.has(b"Subtype") || d.has_type(b"Annot"))
            .ok_or_else(|| PdfError::AnnotationNotFound(reference.to_string()))?;
        Ok((id, dict))
    }

    // ----- add ---------------------------------------------------------------------------

    /// Create all annotations of one batch. Ids are reserved first so replies can refer to
    /// annotations of the same batch by `nm`.
    fn add(&mut self, dtos: &[AnnotationDto]) -> Result<()> {
        let mut planned = Vec::with_capacity(dtos.len());
        let mut by_nm: HashMap<&str, usize> = HashMap::new();
        for (i, dto) in dtos.iter().enumerate() {
            self.page(dto.page_index)?;
            let nm = if dto.nm.trim().is_empty() {
                self.generate_nm()
            } else {
                dto.nm.clone()
            };
            if !dto.nm.trim().is_empty() {
                by_nm.insert(dto.nm.as_str(), i);
            }
            planned.push((self.rev.new_id(), nm));
        }
        let mut per_page: BTreeMap<usize, Vec<ObjectId>> = BTreeMap::new();
        for (i, dto) in dtos.iter().enumerate() {
            let (id, nm) = &planned[i];
            let ids = if is_reply(dto) {
                let (parent, parent_rect) = self.reply_target(dto, dtos, &by_nm, &planned)?;
                self.add_reply(dto, *id, nm, parent, parent_rect)?
            } else {
                self.add_annotation(dto, *id, nm)?
            };
            per_page
                .entry(dto.page_index as usize)
                .or_default()
                .extend(ids);
        }
        for (page_index, ids) in per_page {
            let page_id = self.pages[page_index].id;
            append_annots(self.rev, page_id, &ids)?;
        }
        Ok(())
    }

    /// Store a regular annotation (plus pop-up for notes); returns the ids for `/Annots`.
    fn add_annotation(
        &mut self,
        dto: &AnnotationDto,
        id: ObjectId,
        nm: &str,
    ) -> Result<Vec<ObjectId>> {
        let page = self.page(dto.page_index)?.clone();
        let rect = appearance::annotation_rect(dto)?;
        let mut dict = annotation_dict(dto, rect, nm, &self.now);
        dict.set("P", page.id);
        let rotation = page_rotation(&*self.rev, &page);
        self.attach_appearance(&mut dict, dto, rect, rotation)?;
        let mut ids = vec![id];
        if dto.kind == AnnotKind::Note {
            let popup_id = self
                .rev
                .add(popup_dict(id, rect, page_box(&*self.rev, &page)));
            dict.set("Popup", popup_id);
            ids.push(popup_id);
        }
        self.rev.set(id, dict);
        Ok(ids)
    }

    fn add_reply(
        &mut self,
        dto: &AnnotationDto,
        id: ObjectId,
        nm: &str,
        parent: ObjectId,
        parent_rect: Rect,
    ) -> Result<Vec<ObjectId>> {
        let page_id = self.page(dto.page_index)?.id;
        let mut dict = reply_dict(dto, parent, parent_rect, nm, &self.now);
        dict.set("P", page_id);
        self.rev.set(id, dict);
        Ok(vec![id])
    }

    /// The parent of a reply: an existing object (`inReplyToRef`) or a sibling of the batch
    /// (`inReplyToNm`), together with the parent's rectangle.
    fn reply_target(
        &self,
        dto: &AnnotationDto,
        dtos: &[AnnotationDto],
        by_nm: &HashMap<&str, usize>,
        planned: &[(ObjectId, String)],
    ) -> Result<(ObjectId, Rect)> {
        if let Some(reference) = &dto.in_reply_to_ref {
            let (id, dict) = self.existing(reference)?;
            return Ok((id, self.rev.get_rect(dict, b"Rect").unwrap_or_default()));
        }
        let nm = dto.in_reply_to_nm.as_deref().unwrap_or_default();
        let index = *by_nm.get(nm).ok_or_else(|| {
            PdfError::InvalidRequest(format!(
                "reply target nm {nm:?} is not part of this request"
            ))
        })?;
        let parent = &dtos[index];
        if std::ptr::eq(parent, dto) {
            return Err(PdfError::InvalidRequest(format!(
                "annotation {nm:?} cannot reply to itself"
            )));
        }
        let rect = if is_reply(parent) {
            normalize_rect(parent.rect)
        } else {
            appearance::annotation_rect(parent)?
        };
        Ok((planned[index].0, rect))
    }

    // ----- modify ------------------------------------------------------------------------

    fn modify(&mut self, change: &AnnotationModify) -> Result<()> {
        let (id, dict) = self.existing(&change.reference)?;
        let old_rect = self.rev.get_rect(dict, b"Rect");
        let popup = dict.get(b"Popup").ok().and_then(|p| p.as_reference().ok());
        let reply = dict.has(b"IRT");
        let dto = &change.annotation;
        let new_rect = if change.regenerate_appearance && !reply {
            self.regenerate(id, dto)?
        } else {
            self.update_in_place(id, dto, old_rect, reply)?
        };
        if let (Some(old), Some(popup)) = (old_rect, popup) {
            self.move_popup(popup, old, new_rect)?;
        }
        Ok(())
    }

    /// Rewrite geometry, style and appearance from the DTO, keeping unrelated keys such as
    /// `/P`, `/Popup`, `/StructParent` or `/OC`. Returns the new rectangle.
    fn regenerate(&mut self, id: ObjectId, dto: &AnnotationDto) -> Result<Rect> {
        let rect = appearance::annotation_rect(dto)?;
        let existing = self
            .rev
            .dict(id)
            .ok_or_else(|| PdfError::AnnotationNotFound(format_ref(id)))?;
        let old_nm = self.rev.get_text(existing, b"NM").filter(|n| !n.is_empty());
        let created = existing.get(b"CreationDate").ok().cloned();
        let flags = self.rev.get_f64(existing, b"F").unwrap_or(0.0) as i64;
        let page_id = existing.get(b"P").ok().and_then(|p| p.as_reference().ok());
        let rotation = self.rotation(page_id, dto.page_index);
        let nm = match dto.nm.trim() {
            "" => old_nm.unwrap_or_else(|| self.generate_nm()),
            _ => dto.nm.clone(),
        };
        let mut fresh = annotation_dict(dto, rect, &nm, &self.now);
        if let (None, Some(created)) = (&dto.created, created) {
            fresh.set("CreationDate", created);
        }
        fresh.set("F", merged_flags(flags, dto));
        self.attach_appearance(&mut fresh, dto, rect, rotation)?;
        let dict = self.rev.dict_mut(id)?;
        for key in MANAGED_KEYS {
            dict.remove(key);
        }
        for (key, value) in fresh {
            dict.set(key, value);
        }
        Ok(rect)
    }

    /// Update the descriptive keys (and `/Rect` when it moved), keeping the appearance.
    fn update_in_place(
        &mut self,
        id: ObjectId,
        dto: &AnnotationDto,
        old_rect: Option<Rect>,
        reply: bool,
    ) -> Result<Rect> {
        let now = self.now.clone();
        let rect = normalize_rect(dto.rect);
        let dict = self.rev.dict_mut(id)?;
        apply_common(dict, dto, &now);
        if reply {
            for key in [b"State".as_slice(), b"StateModel"] {
                dict.remove(key);
            }
            apply_state(dict, dto);
        }
        // An all-zero rectangle means "not provided": keep the current one.
        let provided = rect.iter().all(|v| v.is_finite()) && rect.iter().any(|v| *v != 0.0);
        let moved = provided && old_rect.is_none_or(|old| !same_rect(old, rect));
        if moved {
            dict.set("Rect", num_array(&rect));
            return Ok(rect);
        }
        Ok(old_rect.unwrap_or(rect))
    }

    /// Translate the pop-up by the movement of the parent's top-left corner.
    fn move_popup(&mut self, popup: ObjectId, old: Rect, new: Rect) -> Result<()> {
        let (dx, dy) = (new[0] - old[0], new[3] - old[3]);
        if dx.abs() < 1e-6 && dy.abs() < 1e-6 {
            return Ok(());
        }
        let Some(rect) = self
            .rev
            .dict(popup)
            .and_then(|d| self.rev.get_rect(d, b"Rect"))
        else {
            return Ok(());
        };
        if matches!(self.rev.raw_object(popup), Some(Object::Dictionary(_))) {
            let moved = [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy];
            self.rev.dict_mut(popup)?.set("Rect", num_array(&moved));
        }
        Ok(())
    }

    // ----- delete ------------------------------------------------------------------------

    /// The annotation index, built on first use.
    fn index(&mut self) -> &AnnotIndex {
        let (rev, pages) = (&*self.rev, &self.pages);
        self.index.get_or_insert_with(|| build_index(rev, pages))
    }

    /// Remove an annotation, its pop-up and (recursively) its replies from the pages.
    fn delete(&mut self, reference: &str) -> Result<()> {
        let (id, _) = self.existing(reference)?;
        let mut remove = HashSet::new();
        let mut queue = vec![id];
        while let Some(current) = queue.pop() {
            if !remove.insert(current) {
                continue;
            }
            let popup = self
                .rev
                .dict(current)
                .and_then(|d| d.get(b"Popup").ok())
                .and_then(|p| p.as_reference().ok());
            remove.extend(popup);
            queue.extend(
                self.index()
                    .replies
                    .get(&current)
                    .into_iter()
                    .flatten()
                    .copied(),
            );
        }
        let pages: HashSet<usize> = remove
            .iter()
            .flat_map(|id| self.index().pages_of.get(id).cloned().unwrap_or_default())
            .collect();
        for page_index in pages {
            let page_id = self.pages[page_index].id;
            remove_annots(self.rev, page_id, &remove)?;
        }
        Ok(())
    }
}

fn same_rect(a: Rect, b: Rect) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 0.01)
}

fn build_index(src: &impl ObjectSource, pages: &[PageRef]) -> AnnotIndex {
    let mut index = AnnotIndex::default();
    for (page_index, page) in pages.iter().enumerate() {
        let Some(page_dict) = src.dict(page.id) else {
            continue;
        };
        for id in annot_ids(src, page_dict) {
            index.pages_of.entry(id).or_default().push(page_index);
            let parent = src
                .dict(id)
                .and_then(|d| d.get(b"IRT").ok())
                .and_then(|p| p.as_reference().ok());
            if let Some(parent) = parent {
                index.replies.entry(parent).or_default().push(id);
            }
        }
    }
    index
}
