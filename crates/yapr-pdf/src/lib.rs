//! PDF manipulation core for YetAnotherPDFReader.
//!
//! The crate is deliberately free of any UI / Tauri dependency so it can be unit tested in
//! isolation. Rendering is done by pdf.js in the front-end; this crate is responsible for
//! everything that *writes* PDF data:
//!
//! * annotations (create / modify / delete) including appearance-stream generation,
//! * document information updates,
//! * structural page operations (rotate, flip, delete, reorder, duplicate, insert pages from
//!   other documents or pictures, merge) and watermarks,
//! * password protection (AES-256),
//! * page extraction into a new document.
//!
//! All edits of existing files are written as **incremental updates**: the original bytes are
//! preserved verbatim and the changed objects are appended. This keeps digital signatures of
//! earlier revisions intact and makes saving fast even for very large documents.

mod annotations;
mod appearance;
mod content;
pub mod dto;
pub mod error;
mod extract;
mod font_list;
mod fonts;
mod geometry;
mod imaging;
mod info;
mod load;
mod objects;
mod page_edit;
mod page_ops;
mod page_tools;
mod pages;
pub mod refs;
mod security;
pub mod text;
mod watermark;

pub use dto::*;
pub use error::{PdfError, Result};
pub use refs::{format_ref, parse_ref};

use load::{load_document, Revision, Streams};
use text::{pdf_date_now, rfc3339_to_pdf_date};

/// Apply annotation and metadata changes to `input`, returning the complete new file.
///
/// * `password` – user/owner password for encrypted documents (`None` = empty password).
/// * `blobs` – binary attachments referenced by the DTOs (e.g. stamp image pixels).
///
/// When `changes` contains nothing to do, the input is returned unchanged.
pub fn apply_document_changes(
    input: &[u8],
    password: Option<&str>,
    changes: &DocumentChanges,
    blobs: &[&[u8]],
) -> Result<Vec<u8>> {
    let info = changes.info.as_ref().filter(|info| !info.is_empty());
    if changes.annotations.is_empty() && info.is_none() {
        return Ok(input.to_vec());
    }
    let mut rev = Revision::open(input, password, Streams::Drop)?;
    let now = changes
        .mod_date
        .as_deref()
        .and_then(rfc3339_to_pdf_date)
        .unwrap_or_else(pdf_date_now);
    if !changes.annotations.is_empty() {
        let mut editor =
            annotations::Editor::new(&mut rev, now.clone(), changes.cjk_hint.as_deref(), blobs)?;
        editor.apply(&changes.annotations)?;
    }
    info::apply(&mut rev, info, &now)?;
    rev.save()
}

/// Apply structural page operations sequentially, returning the complete new file.
pub fn apply_page_ops(
    input: &[u8],
    password: Option<&str>,
    ops: &[PageOp],
    blobs: &[&[u8]],
) -> Result<Vec<u8>> {
    if ops.is_empty() {
        return Ok(input.to_vec());
    }
    let mut rev = Revision::open(input, password, Streams::Drop)?;
    page_ops::apply(&mut rev, ops, blobs)?;
    info::apply(&mut rev, None, &pdf_date_now())?;
    rev.save()
}

/// Describe the password protection of a document opened with `password`.
pub fn security_info(input: &[u8], password: Option<&str>) -> Result<SecurityInfo> {
    security::security_info(input, password)
}

/// Protect a document with AES-256 (full rewrite). `owner_password` is required when the
/// document is already restricted and `password` is only its open password.
pub fn set_security(
    input: &[u8],
    password: Option<&str>,
    owner_password: Option<&str>,
    settings: &SecuritySettings,
) -> Result<Vec<u8>> {
    security::set_security(input, password, owner_password, settings)
}

/// Remove the password protection of a document (full rewrite).
pub fn remove_security(input: &[u8], password: Option<&str>, owner_password: Option<&str>) -> Result<Vec<u8>> {
    security::remove_security(input, password, owner_password)
}

/// Build a new standalone document that contains only `pages` (0-based, in the given order).
pub fn extract_pages(input: &[u8], password: Option<&str>, pages: &[u32]) -> Result<Vec<u8>> {
    extract::extract(input, password, pages)
}

/// List every annotation of every page, in page order then `/Annots` order.
///
/// Must be cheap in memory: stream contents are not needed and are dropped while loading
/// (the front-end calls this in the background right after a document is opened).
pub fn read_annotations(input: &[u8], password: Option<&str>) -> Result<Vec<ExistingAnnotation>> {
    let doc = load_document(input, password, Streams::Drop)?;
    annotations::read_all(&doc, &doc.trailer)
}

/// Every distinct font used by the pages of a document (and their forms / annotations).
pub fn list_fonts(input: &[u8], password: Option<&str>) -> Result<Vec<DocumentFont>> {
    let doc = load_document(input, password, Streams::Drop)?;
    let pages = pages::document_pages(&doc, &doc.trailer)?;
    Ok(font_list::list(&doc, &pages))
}

/// Number of pages of a document (used for validation and merge previews).
pub fn page_count(input: &[u8], password: Option<&str>) -> Result<u32> {
    let doc = load_document(input, password, Streams::Drop)?;
    let pages = pages::document_pages(&doc, &doc.trailer)?;
    u32::try_from(pages.len()).map_err(|_| PdfError::Unsupported("too many pages".into()))
}
