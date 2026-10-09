//! Open document sessions.
//!
//! A session keeps a read handle on an opened PDF so that pdf.js can stream byte ranges on
//! demand (fast first paint for very large files, low memory). The file's size and
//! modification time are recorded on open; every read verifies them so that a file rewritten
//! by another program is detected instead of silently feeding corrupt data to the renderer.

use crate::error::{AppError, AppResult};
use crate::fsutil;
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{File, Metadata};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// How far into the file the `%PDF-` header may appear (the spec allows leading garbage).
const HEADER_SEARCH_WINDOW: usize = 1024;

pub struct DocSession {
    pub id: u64,
    pub path: PathBuf,
    pub size: u64,
    pub modified: Option<SystemTime>,
    file: File,
}

/// Information returned to the front-end when a document is opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub session_id: u64,
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch.
    pub modified_ms: Option<u64>,
    pub read_only: bool,
}

/// Result of [`DocSession::check`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStatus {
    pub exists: bool,
    pub changed: bool,
}

pub fn system_time_ms(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

impl DocSession {
    fn open(id: u64, path: &Path) -> AppResult<Self> {
        let file = File::open(path).map_err(|e| AppError::from_io(e, path))?;
        let meta = file.metadata().map_err(|e| AppError::from_io(e, path))?;
        if !meta.is_file() {
            return Err(AppError::InvalidArgument(format!("{} is not a file", path.display())));
        }
        if meta.len() == 0 {
            return Err(AppError::EmptyFile);
        }
        let head = fsutil::read_at(&file, 0, HEADER_SEARCH_WINDOW).map_err(|e| AppError::from_io(e, path))?;
        if !head.windows(5).any(|w| w == b"%PDF-") {
            return Err(AppError::NotPdf);
        }
        Ok(Self { id, path: path.to_path_buf(), size: meta.len(), modified: meta.modified().ok(), file })
    }

    pub fn info(&self) -> DocInfo {
        let read_only = std::fs::metadata(&self.path).map(|m| m.permissions().readonly()).unwrap_or(false);
        DocInfo {
            session_id: self.id,
            path: self.path.display().to_string(),
            file_name: self
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.path.display().to_string()),
            size: self.size,
            modified_ms: system_time_ms(self.modified),
            read_only,
        }
    }

    fn matches(&self, meta: &Metadata) -> bool {
        meta.len() == self.size && meta.modified().ok() == self.modified
    }

    /// Read `[begin, end)`. Fails with `FileChanged` if the file was modified since it was opened.
    pub fn read_range(&self, begin: u64, end: u64) -> AppResult<Vec<u8>> {
        if begin > end || end > self.size {
            return Err(AppError::InvalidArgument(format!(
                "range {begin}..{end} outside of 0..{}",
                self.size
            )));
        }
        let meta = self.file.metadata().map_err(|e| AppError::from_io(e, &self.path))?;
        if !self.matches(&meta) {
            return Err(AppError::FileChanged);
        }
        let len = usize::try_from(end - begin).map_err(|_| AppError::TooLarge(end - begin))?;
        let data = fsutil::read_at(&self.file, begin, len).map_err(|e| AppError::from_io(e, &self.path))?;
        if data.len() != len {
            return Err(AppError::FileChanged);
        }
        Ok(data)
    }

    pub fn read_all(&self) -> AppResult<Vec<u8>> {
        self.read_range(0, self.size)
    }

    /// Compare the file currently on disk at the session path with the opened version.
    pub fn check(&self) -> DiskStatus {
        match std::fs::metadata(&self.path) {
            Ok(meta) => DiskStatus { exists: true, changed: !self.matches(&meta) },
            Err(_) => DiskStatus { exists: false, changed: true },
        }
    }
}

#[derive(Default)]
pub struct Sessions {
    map: RwLock<HashMap<u64, Arc<DocSession>>>,
    next_id: AtomicU64,
}

impl Sessions {
    pub fn open(&self, path: &Path) -> AppResult<Arc<DocSession>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Arc::new(DocSession::open(id, path)?);
        self.map.write().insert(id, session.clone());
        log::info!("opened session {id}: {} ({} bytes)", path.display(), session.size);
        Ok(session)
    }

    pub fn get(&self, id: u64) -> AppResult<Arc<DocSession>> {
        self.map.read().get(&id).cloned().ok_or(AppError::UnknownSession)
    }

    pub fn close(&self, id: u64) -> bool {
        let removed = self.map.write().remove(&id).is_some();
        if removed {
            log::info!("closed session {id}");
        }
        removed
    }

    pub fn len(&self) -> usize {
        self.map.read().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(dir: &tempfile::TempDir, name: &str, data: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::File::create(&path).unwrap().write_all(data).unwrap();
        path
    }

    #[test]
    fn rejects_non_pdf_and_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Sessions::default();
        let txt = write_temp(&dir, "a.pdf", b"hello world");
        assert!(matches!(sessions.open(&txt), Err(AppError::NotPdf)));
        let empty = write_temp(&dir, "b.pdf", b"");
        assert!(matches!(sessions.open(&empty), Err(AppError::EmptyFile)));
        assert!(matches!(sessions.open(&dir.path().join("missing.pdf")), Err(AppError::NotFound(_))));
    }

    #[test]
    fn reads_ranges_and_detects_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Sessions::default();
        let path = write_temp(&dir, "c.pdf", b"%PDF-1.7\nabcdef");
        let session = sessions.open(&path).unwrap();
        assert_eq!(session.read_range(0, 5).unwrap(), b"%PDF-");
        assert!(session.read_range(4, 100).is_err());
        assert!(!session.check().changed);

        std::fs::write(&path, b"%PDF-1.7\nchanged content").unwrap();
        assert!(session.check().changed);
        assert!(matches!(session.read_range(0, 5), Err(AppError::FileChanged)));

        assert!(sessions.close(session.id));
        assert!(matches!(sessions.get(session.id), Err(AppError::UnknownSession)));
    }
}
