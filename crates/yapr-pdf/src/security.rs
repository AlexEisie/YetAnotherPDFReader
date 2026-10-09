//! Password protection: inspect, apply (AES-256) and remove.
//!
//! Changing the security handler re-encrypts every object, so these functions write the whole
//! document instead of an incremental update.

use std::collections::BTreeMap;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::xref::XrefType;
use lopdf::{dictionary, Dictionary, Document, EncryptionState, EncryptionVersion, Object, ObjectId, Permissions, StringFormat};

use crate::dto::{DocumentPermissions, SecurityInfo, SecuritySettings};
use crate::error::{PdfError, Result};
use crate::load::{load_document, Streams};

const MAX_PASSWORD_CHARS: usize = 127;

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
}

fn to_flags(p: &DocumentPermissions) -> Permissions {
    let mut flags = Permissions::COPYABLE_FOR_ACCESSIBILITY;
    let mut set = |on: bool, flag: Permissions| {
        if on {
            flags |= flag;
        }
    };
    set(p.print, Permissions::PRINTABLE);
    set(p.print && p.print_high_quality, Permissions::PRINTABLE_IN_HIGH_QUALITY);
    set(p.copy, Permissions::COPYABLE);
    set(p.modify, Permissions::MODIFIABLE);
    set(p.annotate, Permissions::ANNOTABLE);
    set(p.fill_forms || p.annotate, Permissions::FILLABLE);
    set(p.assemble || p.modify, Permissions::ASSEMBLABLE);
    flags
}

fn from_p(p: i64, revision: i64) -> DocumentPermissions {
    let bit = |n: u32| p & (1 << (n - 1)) != 0;
    let r3 = revision >= 3;
    DocumentPermissions {
        print: bit(3),
        print_high_quality: bit(3) && (!r3 || bit(12)),
        copy: bit(5),
        modify: bit(4),
        annotate: bit(6),
        fill_forms: bit(6) || (r3 && bit(9)),
        assemble: bit(4) || (r3 && bit(11)),
    }
}

/// The security handler dictionary of a loaded (decrypted) document, rebuilt from the
/// encryption state, with the object id it had in the file.
fn encrypt_dict(doc: &Document) -> Option<(ObjectId, Dictionary)> {
    let state = doc.encryption_state.as_ref()?;
    let dict = state.encode().ok()?;
    Some((state.encrypt_object_id().unwrap_or((doc.max_id + 1, 0)), dict))
}

/// A minimal encrypted document (handler + file ID) to check passwords against.
fn handler_document(doc: &Document, id: ObjectId, dict: &Dictionary) -> Document {
    let mut probe = Document::with_version(doc.version.clone());
    probe.objects.insert(id, Object::Dictionary(dict.clone()));
    probe.trailer.set("Encrypt", Object::Reference(id));
    if let Ok(file_id) = doc.trailer.get(b"ID") {
        probe.trailer.set("ID", file_id.clone());
    }
    probe
}

fn method_name(dict: &Dictionary) -> String {
    let v = dict.get(b"V").and_then(Object::as_i64).unwrap_or(0);
    let length = dict.get(b"Length").and_then(Object::as_i64).unwrap_or(40);
    let cfm = dict
        .get(b"CF")
        .and_then(Object::as_dict)
        .ok()
        .and_then(|cf| cf.iter().next())
        .and_then(|(_, f)| f.as_dict().ok())
        .and_then(|f| f.get(b"CFM").and_then(Object::as_name).ok())
        .map(|n| String::from_utf8_lossy(n).into_owned());
    match (v, cfm.as_deref()) {
        (5, _) | (_, Some("AESV3")) => "AES-256".into(),
        (4, Some("AESV2")) => "AES-128".into(),
        (4, _) => "RC4 128-bit".into(),
        _ => format!("RC4 {length}-bit"),
    }
}

/// Describe the protection of `input`; `password` is the password the document was opened with.
pub fn security_info(input: &[u8], password: Option<&str>) -> Result<SecurityInfo> {
    let doc = load_document(input, password, Streams::Drop)?;
    let Some((id, dict)) = encrypt_dict(&doc) else {
        return Ok(SecurityInfo {
            encrypted: false,
            method: None,
            open_password: false,
            restricted: false,
            permissions: DocumentPermissions::ALL,
            owner_access: true,
        });
    };
    let revision = dict.get(b"R").and_then(Object::as_i64).unwrap_or(2);
    let p = dict.get(b"P").and_then(Object::as_i64).unwrap_or(-1);
    let permissions = from_p(p, revision);
    let restricted = permissions != DocumentPermissions::ALL;
    let probe = handler_document(&doc, id, &dict);
    let open_password = probe.authenticate_user_password("").is_err();
    let owner_access = !restricted || probe.authenticate_owner_password(password.unwrap_or("")).is_ok();
    Ok(SecurityInfo {
        encrypted: true,
        method: Some(method_name(&dict)),
        open_password,
        restricted,
        permissions,
        owner_access,
    })
}

/// Refuse to change the security of a restricted document without its permissions password.
fn require_owner(doc: &Document, password: Option<&str>, owner_password: Option<&str>) -> Result<()> {
    let Some((id, dict)) = encrypt_dict(doc) else {
        return Ok(());
    };
    let revision = dict.get(b"R").and_then(Object::as_i64).unwrap_or(2);
    let p = dict.get(b"P").and_then(Object::as_i64).unwrap_or(-1);
    if from_p(p, revision) == DocumentPermissions::ALL {
        return Ok(());
    }
    let probe = handler_document(doc, id, &dict);
    let candidates = [owner_password, password];
    if candidates
        .iter()
        .flatten()
        .any(|pw| probe.authenticate_owner_password(pw).is_ok())
    {
        Ok(())
    } else {
        Err(PdfError::OwnerPassword)
    }
}

/// Strip everything that belongs to the old file layout or security handler.
fn plain_document(mut doc: Document) -> Document {
    if let Some(id) = doc.encryption_state.as_ref().and_then(|s| s.encrypt_object_id()) {
        doc.objects.remove(&id);
    }
    doc.encryption_state = None;
    doc.objects.retain(|_, object| {
        !object
            .as_stream()
            .is_ok_and(|s| s.dict.has_type(b"ObjStm") || s.dict.has_type(b"XRef"))
    });
    for key in [b"Encrypt".as_slice(), b"Prev", b"XRefStm", b"Type", b"W", b"Index", b"Length", b"Filter", b"DecodeParms"] {
        doc.trailer.remove(key);
    }
    doc.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
    doc
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).map_err(|e| PdfError::Write(format!("random generator: {e}")))?;
    Ok(out)
}

fn save(mut doc: Document) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| PdfError::Write(e.to_string()))?;
    Ok(out)
}

fn check_password(value: &str, what: &str) -> Result<()> {
    if value.chars().count() > MAX_PASSWORD_CHARS {
        return Err(invalid(format!("the {what} is longer than {MAX_PASSWORD_CHARS} characters")));
    }
    Ok(())
}

/// Protect the document with AES-256. `password` opens the current document;
/// `owner_password` is needed when it is already restricted.
pub fn set_security(
    input: &[u8],
    password: Option<&str>,
    owner_password: Option<&str>,
    settings: &SecuritySettings,
) -> Result<Vec<u8>> {
    check_password(&settings.open_password, "open password")?;
    check_password(&settings.permissions_password, "permissions password")?;
    let restricting = to_flags(&settings.permissions) != to_flags(&DocumentPermissions::ALL);
    if settings.open_password.is_empty() && (settings.permissions_password.is_empty() || !restricting) {
        return Err(invalid("set an open password or restrict permissions with a permissions password"));
    }
    if restricting && settings.permissions_password.is_empty() {
        return Err(invalid("restricting permissions needs a permissions password"));
    }
    if !settings.permissions_password.is_empty() && settings.permissions_password == settings.open_password {
        return Err(invalid("the permissions password must differ from the open password"));
    }
    let doc = load_document(input, password, Streams::Keep)?;
    require_owner(&doc, password, owner_password)?;
    let mut doc = plain_document(doc);
    if !doc.trailer.has(b"ID") {
        let id = random_bytes::<16>()?.to_vec();
        doc.trailer.set(
            "ID",
            vec![Object::String(id.clone(), StringFormat::Hexadecimal), Object::String(id, StringFormat::Hexadecimal)],
        );
    }
    // Without a permissions password the owner password is random: nobody needs it, since
    // nothing is restricted.
    let random_owner;
    let owner = if settings.permissions_password.is_empty() {
        random_owner = random_bytes::<24>()?.iter().map(|b| format!("{b:02x}")).collect::<String>();
        random_owner.as_str()
    } else {
        settings.permissions_password.as_str()
    };
    let key = random_bytes::<32>()?;
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let state = EncryptionState::try_from(EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: owner,
        user_password: &settings.open_password,
        permissions: if restricting { to_flags(&settings.permissions) } else { Permissions::all() },
    })
    .map_err(|e| PdfError::Write(format!("encryption: {e}")))?;
    doc.encrypt(&state).map_err(|e| PdfError::Write(format!("encryption: {e}")))?;
    if doc.version.as_str() < "1.7" {
        doc.version = "1.7".into();
    }
    // AES-256 is an extension of PDF 1.7 (level 3).
    if let Ok(Object::Reference(root)) = doc.trailer.get(b"Root").cloned() {
        if let Ok(catalog) = doc.get_object_mut(root).and_then(Object::as_dict_mut) {
            catalog.set(
                "Extensions",
                dictionary! { "ADBE" => dictionary! { "BaseVersion" => Object::Name(b"1.7".to_vec()), "ExtensionLevel" => 3 } },
            );
        }
    }
    save(doc)
}

/// Remove password protection. `owner_password` is needed when the document is restricted
/// and was opened with its open password only.
pub fn remove_security(input: &[u8], password: Option<&str>, owner_password: Option<&str>) -> Result<Vec<u8>> {
    let doc = load_document(input, password, Streams::Keep)?;
    if doc.encryption_state.is_none() {
        return Err(invalid("the document is not password protected"));
    }
    require_owner(&doc, password, owner_password)?;
    save(plain_document(doc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let content = doc.add_object(lopdf::Stream::new(dictionary! {}, b"BT /F1 12 Tf 10 10 Td (Hello) Tj ET".to_vec()));
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => content,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        });
        doc.objects.insert(pages, dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }.into());
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let info = doc.add_object(dictionary! { "Title" => Object::string_literal("Secret title") });
        doc.trailer.set("Info", info);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn settings(open: &str, owner: &str, permissions: DocumentPermissions) -> SecuritySettings {
        SecuritySettings { open_password: open.into(), permissions_password: owner.into(), permissions }
    }

    #[test]
    fn open_password_round_trip() {
        let plain = sample();
        let locked = set_security(&plain, None, None, &settings("user", "", DocumentPermissions::ALL)).unwrap();
        assert!(matches!(load_document(&locked, None, Streams::Keep), Err(PdfError::Password)));
        let info = security_info(&locked, Some("user")).unwrap();
        assert!(info.encrypted && info.open_password && !info.restricted && info.owner_access);
        assert_eq!(info.method.as_deref(), Some("AES-256"));
        // Content is not readable without the key.
        assert!(!locked.windows(5).any(|w| w == b"Hello"));
        let unlocked = remove_security(&locked, Some("user"), None).unwrap();
        let doc = load_document(&unlocked, None, Streams::Keep).unwrap();
        assert!(doc.encryption_state.is_none());
        assert!(!security_info(&unlocked, None).unwrap().encrypted);
    }

    #[test]
    fn restrictions_need_the_permissions_password() {
        let plain = sample();
        let mut p = DocumentPermissions::ALL;
        p.print = false;
        p.copy = false;
        let locked = set_security(&plain, None, None, &settings("", "owner", p)).unwrap();
        let info = security_info(&locked, None).unwrap();
        assert!(info.encrypted && !info.open_password && info.restricted && !info.owner_access);
        assert!(!info.permissions.print && !info.permissions.copy && info.permissions.annotate);
        assert!(security_info(&locked, Some("owner")).unwrap().owner_access);
        assert!(matches!(remove_security(&locked, None, None), Err(PdfError::OwnerPassword)));
        assert!(matches!(remove_security(&locked, None, Some("wrong")), Err(PdfError::OwnerPassword)));
        assert!(remove_security(&locked, None, Some("owner")).is_ok());
    }

    #[test]
    fn rejects_meaningless_settings() {
        let plain = sample();
        assert!(set_security(&plain, None, None, &settings("", "", DocumentPermissions::ALL)).is_err());
        let mut p = DocumentPermissions::ALL;
        p.modify = false;
        assert!(set_security(&plain, None, None, &settings("a", "", p)).is_err());
        assert!(set_security(&plain, None, None, &settings("same", "same", p)).is_err());
    }
}
