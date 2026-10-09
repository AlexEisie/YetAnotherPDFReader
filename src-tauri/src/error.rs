//! Application error type.
//!
//! Every command returns `Result<T, AppError>`. Errors are serialised as
//! `{ "code": "NOT_FOUND", "message": "...", "detail": "..." }` so the front-end can show a
//! localised, user-friendly message (keyed by `code`) while keeping the technical detail
//! available for the "Show details" disclosure and the log file.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use std::io;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("access denied: {0}")]
    PermissionDenied(String),
    #[error("the file is locked by another program: {0}")]
    FileLocked(String),
    #[error("the file is read-only: {0}")]
    ReadOnly(String),
    #[error("not enough disk space")]
    DiskFull,
    #[error("the file is not a PDF document")]
    NotPdf,
    #[error("the file is empty")]
    EmptyFile,
    #[error("the file is too large ({0} bytes)")]
    TooLarge(u64),
    #[error("the file was changed by another program")]
    FileChanged,
    #[error("the document session no longer exists")]
    UnknownSession,
    #[error("the password is missing or incorrect")]
    Password,
    #[error("the permissions password is missing or incorrect")]
    OwnerPassword,
    #[error("the PDF could not be processed: {0}")]
    Pdf(String),
    #[error("this operation is not supported for this document: {0}")]
    Unsupported(String),
    #[error("invalid request: {0}")]
    InvalidArgument(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("the clipboard is not available: {0}")]
    Clipboard(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine readable code used by the front-end for localisation.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "NOT_FOUND",
            AppError::PermissionDenied(_) => "PERMISSION_DENIED",
            AppError::FileLocked(_) => "FILE_LOCKED",
            AppError::ReadOnly(_) => "READ_ONLY",
            AppError::DiskFull => "DISK_FULL",
            AppError::NotPdf => "NOT_PDF",
            AppError::EmptyFile => "EMPTY_FILE",
            AppError::TooLarge(_) => "TOO_LARGE",
            AppError::FileChanged => "FILE_CHANGED",
            AppError::UnknownSession => "UNKNOWN_SESSION",
            AppError::Password => "PASSWORD",
            AppError::OwnerPassword => "OWNER_PASSWORD",
            AppError::Pdf(_) => "PDF_ERROR",
            AppError::Unsupported(_) => "UNSUPPORTED",
            AppError::InvalidArgument(_) => "INVALID_ARGUMENT",
            AppError::Io(_) => "IO_ERROR",
            AppError::Clipboard(_) => "CLIPBOARD",
            AppError::Internal(_) => "INTERNAL",
        }
    }

    /// Map an I/O error to the most specific variant, attaching the offending path.
    pub fn from_io(err: io::Error, path: &Path) -> Self {
        let shown = path.display().to_string();
        // Windows specific error codes that `io::ErrorKind` does not distinguish.
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        const ERROR_HANDLE_DISK_FULL: i32 = 39;
        const ERROR_DISK_FULL: i32 = 112;
        const ERROR_WRITE_PROTECT: i32 = 19;
        match err.raw_os_error() {
            Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION) => {
                return AppError::FileLocked(shown)
            }
            Some(ERROR_DISK_FULL) | Some(ERROR_HANDLE_DISK_FULL) => return AppError::DiskFull,
            Some(ERROR_WRITE_PROTECT) => return AppError::ReadOnly(shown),
            _ => {}
        }
        match err.kind() {
            io::ErrorKind::NotFound => AppError::NotFound(shown),
            io::ErrorKind::PermissionDenied => AppError::PermissionDenied(shown),
            io::ErrorKind::StorageFull => AppError::DiskFull,
            io::ErrorKind::ReadOnlyFilesystem => AppError::ReadOnly(shown),
            _ => AppError::Io(format!("{shown}: {err}")),
        }
    }
}

impl From<yapr_pdf::PdfError> for AppError {
    fn from(err: yapr_pdf::PdfError) -> Self {
        use yapr_pdf::PdfError as E;
        match err {
            E::Password => AppError::Password,
            E::OwnerPassword => AppError::OwnerPassword,
            E::Unsupported(msg) => AppError::Unsupported(msg),
            E::InvalidRequest(msg) => AppError::InvalidArgument(msg),
            other => AppError::Pdf(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::InvalidArgument(err.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(err: tauri::Error) -> Self {
        AppError::Internal(err.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        let detail = match self {
            AppError::NotFound(d)
            | AppError::PermissionDenied(d)
            | AppError::FileLocked(d)
            | AppError::ReadOnly(d)
            | AppError::Pdf(d)
            | AppError::Unsupported(d)
            | AppError::InvalidArgument(d)
            | AppError::Io(d)
            | AppError::Clipboard(d)
            | AppError::Internal(d) => Some(d.clone()),
            AppError::TooLarge(size) => Some(size.to_string()),
            _ => None,
        };
        s.serialize_field("detail", &detail)?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_map_to_specific_variants() {
        let p = Path::new("C:/x.pdf");
        let e = AppError::from_io(io::Error::from(io::ErrorKind::NotFound), p);
        assert_eq!(e.code(), "NOT_FOUND");
        let e = AppError::from_io(io::Error::from_raw_os_error(32), p);
        assert_eq!(e.code(), "FILE_LOCKED");
        let e = AppError::from_io(io::Error::from_raw_os_error(112), p);
        assert_eq!(e.code(), "DISK_FULL");
    }

    #[test]
    fn serialises_code_message_and_detail() {
        let json = serde_json::to_value(AppError::NotFound("a.pdf".into())).unwrap();
        assert_eq!(json["code"], "NOT_FOUND");
        assert_eq!(json["detail"], "a.pdf");
        assert!(json["message"].as_str().unwrap().contains("a.pdf"));
    }
}
