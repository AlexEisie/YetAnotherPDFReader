//! Extracting pages into a new, standalone (unencrypted) document.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::error::{PdfError, Result};
use crate::load::{load_document, Streams};
use crate::objects::ObjectSource;
use crate::pages::{annot_ids, collect_pages, inherited, root_pages_id, PageRef, INHERITABLE};

/// Catalog entries that describe the whole original document and would keep removed pages
/// alive (or become wrong) after extraction.
const DROPPED_CATALOG_KEYS: [&[u8]; 6] = [
    b"Outlines",
    b"PageLabels",
    b"StructTreeRoot",
    b"MarkInfo",
    b"Dests",
    b"Threads",
];

/// Maximum depth followed in the AcroForm field hierarchy.
const MAX_FIELD_DEPTH: usize = 32;

/// Build a new document containing `selection` (0-based, in order; duplicates allowed).
pub fn extract(input: &[u8], password: Option<&str>, selection: &[u32]) -> Result<Vec<u8>> {
    if selection.is_empty() {
        return Err(PdfError::InvalidRequest("no pages selected".into()));
    }
    let mut doc = load_document(input, password, Streams::Keep)?;
    let root = root_pages_id(&doc, &doc.trailer)?;
    let pages = collect_pages(&doc, root);
    let chosen: Vec<&PageRef> = selection
        .iter()
        .map(|&i| {
            pages.get(i as usize).ok_or_else(|| {
                PdfError::InvalidRequest(format!(
                    "page index {i} is out of range (document has {} pages)",
                    pages.len()
                ))
            })
        })
        .collect::<Result<_>>()?;
    let kids = flatten_pages(&mut doc, root, &chosen);
    let kept: HashSet<ObjectId> = kids.iter().copied().collect();
    let dead: HashSet<ObjectId> = pages
        .iter()
        .flat_map(|p| std::iter::once(p.id).chain(p.ancestors.iter().copied()))
        .filter(|id| *id != root && !kept.contains(id))
        .collect();
    for object in doc.objects.values_mut() {
        null_references(object, &dead);
    }
    for id in &dead {
        doc.objects.remove(id);
    }
    clean_catalog(&mut doc, &kids);
    finish(doc)
}

/// Rewrite the kept pages as direct children of `root`; returns the new `/Kids`.
fn flatten_pages(doc: &mut Document, root: ObjectId, chosen: &[&PageRef]) -> Vec<ObjectId> {
    let mut used = HashSet::new();
    let mut kids = Vec::with_capacity(chosen.len());
    for page in chosen {
        let mut dict = doc.dict(page.id).cloned().unwrap_or_default();
        for key in INHERITABLE {
            if !dict.has(key) {
                if let Some(value) = inherited(&*doc, page, key) {
                    dict.set(key, value.clone());
                }
            }
        }
        dict.set("Type", "Page");
        dict.set("Parent", root);
        if used.insert(page.id) {
            doc.objects.insert(page.id, Object::Dictionary(dict));
            kids.push(page.id);
        } else {
            // A repeated page becomes a shallow copy sharing contents and resources; its
            // annotations stay with the first occurrence.
            dict.remove(b"Annots");
            kids.push(doc.add_object(dict));
        }
    }
    let mut tree = Dictionary::new();
    tree.set("Type", "Pages");
    tree.set(
        "Kids",
        kids.iter()
            .map(|id| Object::Reference(*id))
            .collect::<Vec<_>>(),
    );
    tree.set("Count", kids.len() as i64);
    doc.objects.insert(root, Object::Dictionary(tree));
    kids
}

/// Replace every reference to a removed object by `null`.
fn null_references(object: &mut Object, dead: &HashSet<ObjectId>) {
    match object {
        Object::Reference(id) if dead.contains(id) => *object = Object::Null,
        Object::Array(items) => items.iter_mut().for_each(|o| null_references(o, dead)),
        Object::Dictionary(dict) => dict.iter_mut().for_each(|(_, o)| null_references(o, dead)),
        Object::Stream(stream) => stream
            .dict
            .iter_mut()
            .for_each(|(_, o)| null_references(o, dead)),
        _ => {}
    }
}

/// Drop document-wide navigation structures and prune form fields to the kept widgets.
fn clean_catalog(doc: &mut Document, kids: &[ObjectId]) {
    let kept_annots: HashSet<ObjectId> = kids
        .iter()
        .filter_map(|id| doc.dict(*id))
        .flat_map(|page| annot_ids(&*doc, page))
        .collect();
    let fields = doc
        .catalog()
        .ok()
        .and_then(|c| doc.get_dict(c, b"AcroForm"))
        .and_then(|form| doc.get_array(form, b"Fields"))
        .map(<[Object]>::to_vec);
    if let Some(fields) = fields {
        let kept: Vec<Object> = fields
            .into_iter()
            .filter(|f| keep_field(doc, f, &kept_annots, 0))
            .collect();
        set_acroform_fields(doc, kept);
    }
    let Ok(catalog) = doc.catalog_mut() else {
        return;
    };
    for key in DROPPED_CATALOG_KEYS {
        catalog.remove(key);
    }
    // A destination array whose page was removed now starts with null.
    if matches!(catalog.get(b"OpenAction"), Ok(Object::Array(dest)) if dest.first().is_some_and(Object::is_null))
    {
        catalog.remove(b"OpenAction");
    }
    if let Ok(Object::Dictionary(names)) = catalog.get_mut(b"Names") {
        names.remove(b"Dests");
    }
}

/// Whether a field (or one of its kids) has a widget on a kept page; prunes `/Kids` too.
fn keep_field(doc: &mut Document, field: &Object, kept: &HashSet<ObjectId>, depth: usize) -> bool {
    let Ok(id) = field.as_reference() else {
        return false;
    };
    if kept.contains(&id) {
        return true;
    }
    if depth >= MAX_FIELD_DEPTH {
        return false;
    }
    let Some(kids) = doc
        .dict(id)
        .and_then(|d| d.get(b"Kids").ok())
        .and_then(|k| k.as_array().ok())
        .cloned()
    else {
        return false;
    };
    let remaining: Vec<Object> = kids
        .into_iter()
        .filter(|kid| keep_field(doc, kid, kept, depth + 1))
        .collect();
    let keep = !remaining.is_empty();
    if let Some(Object::Dictionary(dict)) = doc.objects.get_mut(&id) {
        dict.set("Kids", remaining);
    }
    keep
}

fn set_acroform_fields(doc: &mut Document, fields: Vec<Object>) {
    let form_ref = doc
        .catalog()
        .ok()
        .and_then(|c| c.get(b"AcroForm").ok())
        .and_then(|f| f.as_reference().ok());
    let form = match form_ref {
        Some(id) => doc.objects.get_mut(&id).and_then(|o| o.as_dict_mut().ok()),
        None => doc
            .catalog_mut()
            .ok()
            .and_then(|c| c.get_mut(b"AcroForm").ok())
            .and_then(|f| f.as_dict_mut().ok()),
    };
    if let Some(form) = form {
        form.set("Fields", fields);
    }
}

/// Remove encryption and unreachable objects, then save with object streams.
fn finish(mut doc: Document) -> Result<Vec<u8>> {
    let mut trailer = Dictionary::new();
    for key in [b"Root".as_slice(), b"Info", b"ID"] {
        if let Ok(value) = doc.trailer.get(key) {
            trailer.set(key, value.clone());
        }
    }
    doc.trailer = trailer;
    doc.encryption_state = None;
    doc.objects.retain(|_, o| {
        !matches!(o.type_name(), Ok(b"ObjStm" | b"XRef" | b"Linearized"))
            && !o.as_dict().is_ok_and(|d| d.has(b"Linearized"))
    });
    doc.prune_objects();
    doc.renumber_objects();
    let mut out = Vec::new();
    doc.save_modern(&mut out)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(out)
}
