//! Loading documents (passwords, memory-saving filter) and writing incremental revisions.

use lopdf::xref::XrefType;
use lopdf::{Dictionary, Document, IncrementalDocument, LoadOptions, Object, ObjectId};

use crate::error::{PdfError, Result};
use crate::objects::ObjectSource;

/// What to do with stream contents while parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Streams {
    /// Keep every stream (needed when streams are copied or rewritten).
    Keep,
    /// Empty the content of every stream except object streams, keeping its dictionary.
    ///
    /// Safe whenever streams are only *referenced*: incremental updates write the original
    /// bytes verbatim, so the emptied in-memory copies are never serialised.
    Drop,
}

/// Parse `input`, decrypting it with `password` (the empty password when `None`).
pub fn load_document(input: &[u8], password: Option<&str>, streams: Streams) -> Result<Document> {
    let mut options = LoadOptions::with_password(password.unwrap_or(""));
    if streams == Streams::Drop {
        options.filter = Some(drop_stream_content);
    }
    let doc = Document::load_mem_with_options(input, options).map_err(map_load_error)?;
    if doc.is_encrypted() {
        return Err(PdfError::Password);
    }
    Ok(doc)
}

/// Load filter that releases stream contents as soon as each object is parsed.
///
/// Object streams must survive: lopdf runs the filter on the container *before* expanding
/// it, so emptying an `/ObjStm` would lose every object stored inside. Cross-reference streams
/// are parsed before any object is loaded, so emptying them is harmless. `/Length` is set to
/// zero because lopdf re-reads streams whose content is empty after filtering.
///
/// lopdf keeps the *mutated* object for top-level objects but the *returned* one for members
/// of object streams, so both must hold the object. Streams are never stored inside object
/// streams, hence the returned value of a stream is irrelevant and need not be cloned.
fn drop_stream_content(id: ObjectId, object: &mut Object) -> Option<(ObjectId, Object)> {
    match object {
        Object::Stream(stream) => {
            if !stream.dict.has_type(b"ObjStm") {
                stream.content = Vec::new();
                stream.dict.set("Length", 0);
            }
            Some((id, Object::Null))
        }
        other => Some((id, other.clone())),
    }
}

fn map_load_error(err: lopdf::Error) -> PdfError {
    use lopdf::encryption::DecryptionError;
    match err {
        lopdf::Error::InvalidPassword
        | lopdf::Error::Decryption(DecryptionError::IncorrectPassword) => PdfError::Password,
        lopdf::Error::UnsupportedSecurityHandler(handler) => PdfError::Unsupported(format!(
            "security handler {}",
            String::from_utf8_lossy(&handler)
        )),
        lopdf::Error::Decryption(inner) => PdfError::Unsupported(format!("encryption: {inner}")),
        other => PdfError::Parse(other.to_string()),
    }
}

/// Offset of the `%PDF-` header (garbage before it is preserved but not parsed).
fn header_offset(input: &[u8]) -> usize {
    input.windows(5).position(|w| w == b"%PDF-").unwrap_or(0)
}

/// A pending incremental update of an existing document.
pub struct Revision {
    inc: IncrementalDocument,
    /// Bytes before the `%PDF-` header; offsets inside the file are relative to the header.
    prefix: Vec<u8>,
    streams: Streams,
    password: Option<String>,
}

impl Revision {
    /// Open `input` for an incremental update.
    pub fn open(input: &[u8], password: Option<&str>, streams: Streams) -> Result<Self> {
        let (prefix, body) = input.split_at(header_offset(input));
        let doc = load_document(body, password, streams)?;
        Ok(Self {
            inc: IncrementalDocument::create_from(body.to_vec(), doc),
            prefix: prefix.to_vec(),
            streams,
            password: password.map(str::to_string),
        })
    }

    /// The document as it was loaded.
    pub fn prev(&self) -> &Document {
        self.inc.get_prev_documents()
    }

    /// The trailer that will be written with this revision.
    pub fn trailer(&self) -> &Dictionary {
        &self.inc.new_document.trailer
    }

    pub fn trailer_mut(&mut self) -> &mut Dictionary {
        &mut self.inc.new_document.trailer
    }

    /// Store a new object and return its id.
    pub fn add(&mut self, object: impl Into<Object>) -> ObjectId {
        self.inc.new_document.add_object(object)
    }

    /// Reserve an id for an object that is stored later with [`Revision::set`].
    pub fn new_id(&mut self) -> ObjectId {
        self.inc.new_document.new_object_id()
    }

    pub fn set(&mut self, id: ObjectId, object: impl Into<Object>) {
        self.inc.new_document.set_object(id, object);
    }

    /// Mutable access to `id`, copying it into the new revision first.
    pub fn object_mut(&mut self, id: ObjectId) -> Result<&mut Object> {
        if !self.inc.new_document.objects.contains_key(&id) {
            let object =
                self.prev().objects.get(&id).ok_or_else(|| {
                    PdfError::Parse(format!("object {} {} R is missing", id.0, id.1))
                })?;
            if self.streams == Streams::Drop && matches!(object, Object::Stream(_)) {
                return Err(PdfError::Unsupported(format!(
                    "object {} {} R is a stream and cannot be rewritten in place",
                    id.0, id.1
                )));
            }
            let copy = object.clone();
            self.inc.new_document.objects.insert(id, copy);
        }
        self.inc
            .new_document
            .objects
            .get_mut(&id)
            .ok_or_else(|| PdfError::Parse(format!("object {} {} R is missing", id.0, id.1)))
    }

    /// Mutable access to the dictionary stored under `id` (copied into the new revision).
    pub fn dict_mut(&mut self, id: ObjectId) -> Result<&mut Dictionary> {
        match self.object_mut(id)? {
            Object::Dictionary(dict) => Ok(dict),
            _ => Err(PdfError::Unsupported(format!(
                "object {} {} R is not a dictionary",
                id.0, id.1
            ))),
        }
    }

    /// Serialise the original bytes followed by the appended revision.
    pub fn save(mut self) -> Result<Vec<u8>> {
        let xref_type = self.prev().reference_table.cross_reference_type;
        sanitize_trailer(&mut self.inc.new_document.trailer, xref_type);
        if self.prev().xref_start == 0 {
            return self.save_full();
        }
        let prev_len = self.inc.get_prev_documents_bytes().len();
        let mut out = Vec::with_capacity(self.prefix.len() + prev_len + 16 * 1024);
        out.extend_from_slice(&self.prefix);
        self.inc
            .save_to(&mut out)
            .map_err(|e| PdfError::Write(e.to_string()))?;
        Ok(out)
    }

    /// Full rewrite, used when the input's cross-reference data was damaged (lopdf had to
    /// reconstruct it), so there is no valid previous section to chain to with `/Prev`.
    fn save_full(self) -> Result<Vec<u8>> {
        if self.prev().encryption_state.is_some() {
            return Err(PdfError::Unsupported(
                "the encrypted document has a damaged cross-reference table".into(),
            ));
        }
        let bytes = self.inc.get_prev_documents_bytes();
        let mut doc = load_document(bytes, self.password.as_deref(), Streams::Keep)?;
        let new = self.inc.new_document;
        doc.max_id = doc.max_id.max(new.max_id);
        doc.objects.extend(new.objects);
        doc.trailer = new.trailer;
        doc.trailer.remove(b"Prev");
        sanitize_trailer(&mut doc.trailer, XrefType::CrossReferenceTable);
        doc.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
        let mut out = Vec::new();
        doc.save_to(&mut out)
            .map_err(|e| PdfError::Write(e.to_string()))?;
        Ok(out)
    }
}

impl ObjectSource for Revision {
    fn raw_object(&self, id: ObjectId) -> Option<&Object> {
        self.inc
            .new_document
            .objects
            .get(&id)
            .or_else(|| self.prev().objects.get(&id))
    }
}

/// Remove trailer keys inherited from the previous section that must not be repeated.
fn sanitize_trailer(trailer: &mut Dictionary, xref_type: XrefType) {
    for key in [b"XRefStm".as_slice(), b"DecodeParms"] {
        trailer.remove(key);
    }
    if matches!(xref_type, XrefType::CrossReferenceTable) {
        for key in [b"Type".as_slice(), b"W", b"Index", b"Length", b"Filter"] {
            trailer.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn sample() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let content = doc.add_object(Stream::new(dictionary! {}, b"0 0 m 10 10 l S".to_vec()));
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => content,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
        });
        doc.objects.insert(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }.into(),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn drop_filter_empties_streams() {
        let bytes = sample();
        let doc = load_document(&bytes, None, Streams::Drop).unwrap();
        let streams: Vec<_> = doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .collect();
        assert!(!streams.is_empty());
        assert!(streams.iter().all(|s| s.content.is_empty()));
        let full = load_document(&bytes, None, Streams::Keep).unwrap();
        assert!(full
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .all(|s| !s.content.is_empty()));
    }

    #[test]
    fn revision_appends_and_refuses_dropped_streams() {
        let bytes = sample();
        let mut rev = Revision::open(&bytes, None, Streams::Drop).unwrap();
        let stream_id = *rev
            .prev()
            .objects
            .iter()
            .find(|(_, o)| o.as_stream().is_ok())
            .unwrap()
            .0;
        assert!(matches!(
            rev.object_mut(stream_id),
            Err(PdfError::Unsupported(_))
        ));
        rev.add(dictionary! { "Marker" => 1 });
        let out = rev.save().unwrap();
        assert!(out.starts_with(&bytes));
        assert!(out.len() > bytes.len());
        let reread = load_document(&out, None, Streams::Keep).unwrap();
        assert!(reread
            .objects
            .values()
            .any(|o| o.as_dict().is_ok_and(|d| d.has(b"Marker"))));
    }

    #[test]
    fn preserves_leading_garbage() {
        let mut bytes = b"junk before header\n".to_vec();
        bytes.extend(sample());
        let mut rev = Revision::open(&bytes, None, Streams::Drop).unwrap();
        rev.add(dictionary! { "Marker" => 1 });
        let out = rev.save().unwrap();
        assert!(out.starts_with(&bytes));
        assert!(load_document(&out, None, Streams::Keep).is_ok());
    }

    #[test]
    fn garbage_is_a_parse_error() {
        assert!(matches!(
            load_document(b"not a pdf", None, Streams::Keep),
            Err(PdfError::Parse(_))
        ));
    }
}
