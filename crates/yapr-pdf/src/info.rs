//! Document information dictionary (`/Info`) updates.

use lopdf::{Dictionary, Object, ObjectId};

use crate::dto::InfoUpdate;
use crate::error::Result;
use crate::load::Revision;
use crate::objects::ObjectSource;
use crate::text::text_string;

/// Apply `update` (if any) and set `/ModDate` to `mod_date` (a PDF date string).
pub fn apply(rev: &mut Revision, update: Option<&InfoUpdate>, mod_date: &str) -> Result<()> {
    let id = info_id(rev);
    let info = rev.dict_mut(id)?;
    if let Some(update) = update {
        let fields = [
            ("Title", &update.title),
            ("Author", &update.author),
            ("Subject", &update.subject),
            ("Keywords", &update.keywords),
            ("Creator", &update.creator),
        ];
        for (key, value) in fields {
            set_field(info, key, value.as_deref());
        }
    }
    info.set("ModDate", text_string(mod_date));
    Ok(())
}

/// `None` leaves the entry alone, `Some("")` removes it, anything else replaces it.
fn set_field(info: &mut Dictionary, key: &str, value: Option<&str>) {
    match value {
        None => {}
        Some("") => {
            info.remove(key.as_bytes());
        }
        Some(text) => info.set(key, text_string(text)),
    }
}

/// The id of the (indirect) Info dictionary, creating one when it is missing, dangling or
/// stored directly in the trailer.
fn info_id(rev: &mut Revision) -> ObjectId {
    let current = rev.trailer().get(b"Info").ok().cloned();
    if let Some(Object::Reference(id)) = current {
        if matches!(rev.raw_object(id), Some(Object::Dictionary(_))) {
            return id;
        }
    }
    let dict = match current {
        Some(Object::Dictionary(dict)) => dict,
        _ => Dictionary::new(),
    };
    let id = rev.add(dict);
    rev.trailer_mut().set("Info", id);
    id
}
