//! Inventory of the fonts a document uses (Document Properties ▸ Fonts).
//!
//! Fonts are collected from the resources of every page, of the form XObjects and Type 3
//! fonts they reference (recursively, with a depth limit) and of the normal appearance
//! streams of the page's annotations. Only dictionaries are inspected, so the document can be
//! loaded with stream contents dropped.

use std::collections::{HashMap, HashSet};

use lopdf::{Dictionary, Object, ObjectId};

use crate::dto::DocumentFont;
use crate::objects::{as_dict, ObjectSource};
use crate::pages::{annot_entries, inherited, PageRef};

/// Nesting limit for form XObjects / Type 3 fonts (protects against hostile files).
const MAX_DEPTH: usize = 12;

/// Identity of a font: its object id, or its name + type for direct font dictionaries.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum FontKey {
    Object(ObjectId),
    Direct(String, String),
}

struct Collector<'a, S: ObjectSource> {
    src: &'a S,
    fonts: Vec<DocumentFont>,
    index: HashMap<FontKey, usize>,
    /// 1-based number of the page being scanned.
    page: u32,
    /// Resource dictionaries / XObjects already visited on the current page.
    visited: HashSet<ObjectId>,
}

/// Every distinct font, ordered by first use.
pub fn list(src: &impl ObjectSource, pages: &[PageRef]) -> Vec<DocumentFont> {
    let mut collector = Collector { src, fonts: Vec::new(), index: HashMap::new(), page: 0, visited: HashSet::new() };
    for (index, page) in pages.iter().enumerate() {
        collector.page = u32::try_from(index + 1).unwrap_or(u32::MAX);
        collector.visited.clear();
        if let Some(resources) = inherited(src, page, b"Resources") {
            collector.scan_resources(resources, 0);
        }
        if let Some(dict) = src.dict(page.id) {
            for annot in annot_entries(src, dict) {
                collector.scan_appearance(annot);
            }
        }
    }
    collector.fonts
}

impl<S: ObjectSource> Collector<'_, S> {
    /// `true` when `object` is a reference that was already visited on this page.
    fn seen(&mut self, object: &Object) -> bool {
        match object {
            Object::Reference(id) => !self.visited.insert(*id),
            _ => false,
        }
    }

    fn scan_resources(&mut self, resources: &Object, depth: usize) {
        if depth > MAX_DEPTH || self.seen(resources) {
            return;
        }
        let src = self.src;
        let Some(res) = as_dict(src.resolve(resources)) else { return };
        if let Some(fonts) = src.get_dict(res, b"Font") {
            for (_, font) in fonts.iter() {
                self.record(font, depth);
            }
        }
        if let Some(xobjects) = src.get_dict(res, b"XObject") {
            for (_, xobject) in xobjects.iter() {
                self.scan_form(xobject, depth + 1);
            }
        }
    }

    /// Follow a form XObject (images and other XObjects are ignored).
    fn scan_form(&mut self, xobject: &Object, depth: usize) {
        if depth > MAX_DEPTH || self.seen(xobject) {
            return;
        }
        let src = self.src;
        let Some(dict) = as_dict(src.resolve(xobject)) else { return };
        if !matches!(src.get_name(dict, b"Subtype"), Some(b"Form")) {
            return;
        }
        if let Ok(resources) = dict.get(b"Resources") {
            self.scan_resources(resources, depth);
        }
    }

    /// Fonts of an annotation's normal appearance (a stream, or a dictionary of states).
    fn scan_appearance(&mut self, annot: &Object) {
        let src = self.src;
        let Some(dict) = as_dict(src.resolve(annot)) else { return };
        let Some(normal) = src.get_dict(dict, b"AP").and_then(|ap| ap.get(b"N").ok()) else { return };
        match src.resolve(normal) {
            Object::Stream(_) => self.scan_form(normal, 1),
            Object::Dictionary(states) => {
                for (_, state) in states.iter() {
                    self.scan_form(state, 1);
                }
            }
            _ => {}
        }
    }

    fn record(&mut self, font: &Object, depth: usize) {
        let src = self.src;
        let Some(dict) = as_dict(src.resolve(font)) else { return };
        let mut info = describe(src, dict);
        let key = match font {
            Object::Reference(id) => FontKey::Object(*id),
            _ => FontKey::Direct(info.name.clone(), info.kind.clone()),
        };
        match self.index.get(&key) {
            Some(&i) => {
                let existing = &mut self.fonts[i];
                if existing.last_page != self.page {
                    existing.last_page = self.page;
                    existing.page_count += 1;
                }
            }
            None => {
                info.first_page = self.page;
                info.last_page = self.page;
                info.page_count = 1;
                self.index.insert(key, self.fonts.len());
                self.fonts.push(info);
            }
        }
        // Type 3 glyph procedures may use other fonts.
        if matches!(src.get_name(dict, b"Subtype"), Some(b"Type3")) {
            if let Ok(resources) = dict.get(b"Resources") {
                self.scan_resources(resources, depth + 1);
            }
        }
    }
}

/// Split a subset tag (`ABCDEF+Name`) from a font name.
fn strip_subset(name: &str) -> (String, bool) {
    let bytes = name.as_bytes();
    if bytes.len() > 7 && bytes[6] == b'+' && bytes[..6].iter().all(u8::is_ascii_uppercase) {
        (name[7..].to_string(), true)
    } else {
        (name.to_string(), false)
    }
}

fn name_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn describe(src: &impl ObjectSource, font: &Dictionary) -> DocumentFont {
    let subtype = src.get_name(font, b"Subtype").map(name_string).unwrap_or_default();
    let descendant = (subtype == "Type0")
        .then(|| src.get_array(font, b"DescendantFonts"))
        .flatten()
        .and_then(|kids| kids.first())
        .and_then(|kid| as_dict(src.resolve(kid)));
    let descriptor = src.get_dict(descendant.unwrap_or(font), b"FontDescriptor");
    let font_file3 = descriptor.and_then(|d| src.get(d, b"FontFile3")).and_then(|f| as_dict(f));
    let open_type = font_file3.is_some_and(|f| matches!(src.get_name(f, b"Subtype"), Some(b"OpenType")));

    let raw_name = src
        .get_name(font, b"BaseFont")
        .or_else(|| src.get_name(font, b"Name"))
        .map(name_string)
        .unwrap_or_default();
    let (name, subset) = strip_subset(&raw_name);

    let kind = match subtype.as_str() {
        "Type1" | "MMType1" if open_type => "OpenType".to_string(),
        "Type1" => "Type 1".to_string(),
        "MMType1" => "Type 1 (Multiple Master)".to_string(),
        "TrueType" if open_type => "OpenType".to_string(),
        "TrueType" => "TrueType".to_string(),
        "Type3" => "Type 3".to_string(),
        "Type0" => match descendant.and_then(|d| src.get_name(d, b"Subtype")) {
            _ if open_type => "OpenType (CID)".to_string(),
            Some(b"CIDFontType2") => "TrueType (CID)".to_string(),
            Some(b"CIDFontType0") => "Type 1 (CID)".to_string(),
            _ => "Type 0".to_string(),
        },
        "" => "Unknown".to_string(),
        other => other.to_string(),
    };

    let encoding = match font.get(b"Encoding").ok().map(|e| src.resolve(e)) {
        Some(Object::Name(n)) => Some(name_string(n)),
        Some(Object::Dictionary(d)) => {
            Some(src.get_name(d, b"BaseEncoding").map(name_string).unwrap_or_else(|| "Custom".to_string()))
        }
        Some(Object::Stream(s)) => Some(
            src.get_name(&s.dict, b"CMapName").map(name_string).unwrap_or_else(|| "Embedded CMap".to_string()),
        ),
        _ => None,
    };

    let embedded = subtype == "Type3"
        || descriptor.is_some_and(|d| [b"FontFile".as_slice(), b"FontFile2", b"FontFile3"].iter().any(|k| src.get(d, k).is_some()));

    DocumentFont {
        name: if name.is_empty() { "(unnamed)".to_string() } else { name },
        subset,
        kind,
        encoding,
        embedded,
        first_page: 0,
        last_page: 0,
        page_count: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_subset_tags() {
        assert_eq!(strip_subset("ABCDEF+Calibri"), ("Calibri".to_string(), true));
        assert_eq!(strip_subset("Helvetica"), ("Helvetica".to_string(), false));
        assert_eq!(strip_subset("abcdef+X"), ("abcdef+X".to_string(), false));
        assert_eq!(strip_subset("ABCDEF+"), ("ABCDEF+".to_string(), false));
    }
}
