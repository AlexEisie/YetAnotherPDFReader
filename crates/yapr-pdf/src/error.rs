use thiserror::Error;

/// Errors produced by the PDF core.
#[derive(Debug, Error)]
pub enum PdfError {
    /// The input could not be parsed as a PDF.
    #[error("the document could not be parsed: {0}")]
    Parse(String),
    /// The document is encrypted and the supplied password (if any) is wrong.
    #[error("the document is encrypted and the password is missing or wrong")]
    Password,
    /// The document structure is not supported for the requested operation.
    #[error("unsupported document structure: {0}")]
    Unsupported(String),
    /// The request itself is inconsistent (bad page index, missing blob, ...).
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    /// An annotation reference does not exist in the document.
    #[error("annotation {0} was not found in the document")]
    AnnotationNotFound(String),
    /// Writing the output failed.
    #[error("failed to write the document: {0}")]
    Write(String),
}

impl From<lopdf::Error> for PdfError {
    fn from(err: lopdf::Error) -> Self {
        let text = err.to_string();
        let lower = text.to_ascii_lowercase();
        if lower.contains("password") || lower.contains("decrypt") {
            PdfError::Password
        } else {
            PdfError::Parse(text)
        }
    }
}

pub type Result<T> = std::result::Result<T, PdfError>;
