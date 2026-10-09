//! Small JSON key/value store for settings, recent files, per-document view state, saved
//! signatures, etc.
//!
//! Each entry is one JSON file under the app data directory. Writes are atomic and the previous
//! version is kept as `<name>.bak.json`, so a crash during a write or a corrupted file never
//! loses the user's configuration: on load we fall back to the backup, and if both are broken
//! the unreadable file is set aside (`<name>.corrupt-<timestamp>.json`) and the caller is told
//! so it can inform the user.

use crate::error::{AppError, AppResult};
use crate::fsutil::{self, WriteOptions};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Hard limit for a single entry, protects against runaway growth.
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

pub struct Store {
    dir: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRead {
    pub value: Option<Value>,
    /// The primary file was unreadable; `value` (if any) came from the backup or is missing.
    pub recovered: bool,
}

fn validate_name(name: &str) -> AppResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 48
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!("invalid store entry name {name:?}")))
    }
}

fn parse(path: &Path) -> Option<Result<Value, ()>> {
    if !path.exists() {
        return None;
    }
    Some(
        fsutil::read_limited(path, MAX_ENTRY_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or(()),
    )
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.json"))
    }

    pub fn read(&self, name: &str) -> AppResult<StoreRead> {
        validate_name(name)?;
        let primary = self.path(name);
        match parse(&primary) {
            None => Ok(StoreRead { value: None, recovered: false }),
            Some(Ok(value)) => Ok(StoreRead { value: Some(value), recovered: false }),
            Some(Err(())) => {
                log::warn!("store entry {name} is corrupted, trying the backup");
                let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
                let quarantine = self.dir.join(format!("{name}.corrupt-{stamp}.json"));
                if let Err(err) = std::fs::rename(&primary, &quarantine) {
                    log::error!("could not move corrupted {name} aside: {err}");
                }
                let value = match parse(&fsutil::backup_path(&primary)) {
                    Some(Ok(v)) => Some(v),
                    _ => None,
                };
                Ok(StoreRead { value, recovered: true })
            }
        }
    }

    pub fn write(&self, name: &str, value: &Value) -> AppResult<()> {
        validate_name(name)?;
        std::fs::create_dir_all(&self.dir).map_err(|e| AppError::from_io(e, &self.dir))?;
        let data = serde_json::to_vec_pretty(value)?;
        if data.len() as u64 > MAX_ENTRY_BYTES {
            return Err(AppError::TooLarge(data.len() as u64));
        }
        fsutil::write_atomic(&self.path(name), &data, WriteOptions { keep_backup: true })
    }

    pub fn remove(&self, name: &str) -> AppResult<()> {
        validate_name(name)?;
        for path in [self.path(name), fsutil::backup_path(&self.path(name))] {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| AppError::from_io(e, &path))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn write_read_and_recover_from_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("store"));
        assert!(store.read("settings").unwrap().value.is_none());

        store.write("settings", &json!({"theme": "dark"})).unwrap();
        store.write("settings", &json!({"theme": "light"})).unwrap();
        assert_eq!(store.read("settings").unwrap().value.unwrap()["theme"], "light");

        std::fs::write(dir.path().join("store/settings.json"), b"{ not json").unwrap();
        let read = store.read("settings").unwrap();
        assert!(read.recovered);
        assert_eq!(read.value.unwrap()["theme"], "dark");

        store.remove("settings").unwrap();
        assert!(store.read("settings").unwrap().value.is_none());
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        assert!(store.read("../evil").is_err());
        assert!(store.write("A", &json!(1)).is_err());
    }
}
