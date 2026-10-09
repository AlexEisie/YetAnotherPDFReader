//! File-system helpers: crash-safe writes and positional reads.

use crate::error::{AppError, AppResult};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Options for [`write_atomic`].
#[derive(Debug, Clone, Copy, Default)]
pub struct WriteOptions {
    /// Keep the previous version next to the file as `<name>.bak.<ext>`.
    pub keep_backup: bool,
}

/// Path of the backup copy that [`write_atomic`] keeps when `keep_backup` is set.
pub fn backup_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = match path.extension() {
        Some(ext) => format!("{stem}.bak.{}", ext.to_string_lossy()),
        None => format!("{stem}.bak"),
    };
    path.with_file_name(name)
}

/// Write `data` to `path` so that a crash or power loss never leaves a truncated file behind:
/// the data goes to a temporary file in the same directory, is flushed to disk and then renamed
/// over the destination.
pub fn write_atomic(path: &Path, data: &[u8], options: WriteOptions) -> AppResult<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::InvalidArgument(format!("invalid target path: {}", path.display())))?;
    if !dir.is_dir() {
        return Err(AppError::NotFound(dir.display().to_string()));
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.is_dir() {
            return Err(AppError::InvalidArgument(format!("{} is a folder", path.display())));
        }
        if meta.permissions().readonly() {
            return Err(AppError::ReadOnly(path.display().to_string()));
        }
    }

    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(
        ".{file_name}.{}-{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| AppError::from_io(e, path))?;
        file.write_all(data).map_err(|e| AppError::from_io(e, path))?;
        file.sync_all().map_err(|e| AppError::from_io(e, path))?;
        drop(file);

        if options.keep_backup && path.exists() {
            let backup = backup_path(path);
            fs::rename(path, &backup).map_err(|e| AppError::from_io(e, path))?;
            if let Err(err) = fs::rename(&tmp, path) {
                // Put the original back so the user never ends up without a file.
                let _ = fs::rename(&backup, path);
                return Err(AppError::from_io(err, path));
            }
        } else {
            replace_file(&tmp, path).map_err(|e| AppError::from_io(e, path))?;
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Rename `from` over `to`, retrying briefly when another process (an indexer or antivirus
/// scanner, typically) holds the destination open.
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) if attempt < 5 && is_transient(&err) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(60 * attempt));
            }
            Err(err) => return Err(err),
        }
    }
}

fn is_transient(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(5) | Some(32) | Some(33))
}

/// Read exactly `len` bytes at `offset` (shorter at end of file).
pub fn read_at(file: &File, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len];
    let mut filled = 0usize;
    while filled < len {
        let n = positional_read(file, &mut buf[filled..], offset + filled as u64)?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(buf)
}

#[cfg(windows)]
fn positional_read(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buf, offset)
}

#[cfg(unix)]
fn positional_read(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buf, offset)
}

/// Read a whole file, refusing anything larger than `max_len`.
pub fn read_limited(path: &Path, max_len: u64) -> AppResult<Vec<u8>> {
    let meta = fs::metadata(path).map_err(|e| AppError::from_io(e, path))?;
    if !meta.is_file() {
        return Err(AppError::InvalidArgument(format!("{} is not a file", path.display())));
    }
    if meta.len() > max_len {
        return Err(AppError::TooLarge(meta.len()));
    }
    fs::read(path).map_err(|e| AppError::from_io(e, path))
}

/// Require an absolute path (all paths coming from the UI originate from dialogs or the OS).
pub fn absolute_path(raw: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(raw);
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err(AppError::InvalidArgument(format!("expected an absolute path, got {raw:?}")));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("doc.pdf");
        write_atomic(&target, b"one", WriteOptions::default()).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"one");
        write_atomic(&target, b"two", WriteOptions { keep_backup: true }).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        assert_eq!(fs::read(backup_path(&target)).unwrap(), b"one");
        // No temporary files are left behind.
        let leftovers = fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn positional_reads_clamp_at_eof() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.bin");
        fs::write(&target, b"0123456789").unwrap();
        let file = File::open(&target).unwrap();
        assert_eq!(read_at(&file, 2, 3).unwrap(), b"234");
        assert_eq!(read_at(&file, 8, 10).unwrap(), b"89");
    }

    #[test]
    fn backup_name_keeps_extension() {
        assert_eq!(backup_path(Path::new("C:/a/b.pdf")), PathBuf::from("C:/a/b.bak.pdf"));
    }

    #[test]
    fn relative_paths_are_rejected() {
        assert!(absolute_path("foo.pdf").is_err());
        assert!(absolute_path("").is_err());
    }
}
