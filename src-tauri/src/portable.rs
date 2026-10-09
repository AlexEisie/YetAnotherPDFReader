//! Portable mode: when a file named `portable` (or `portable.txt`) sits next to the executable,
//! settings, recent files, logs and the WebView cache are kept in a `data` folder beside it
//! instead of the user profile, so the whole folder can be carried on a USB stick.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};

const MARKERS: [&str; 2] = ["portable", "portable.txt"];

/// The `data` folder of a portable installation, or `None` for a normal installation.
pub fn root() -> Option<&'static Path> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        MARKERS.iter().any(|m| dir.join(m).is_file()).then(|| dir.join("data"))
    })
    .as_deref()
}

/// Must run before the first window is created (WebView2 reads it when it starts).
pub fn configure_webview() {
    if let Some(root) = root() {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", root.join("webview"));
        }
    }
}

/// Folder of the settings / library store.
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    match root() {
        Some(root) => Ok(root.to_path_buf()),
        None => app.path().app_data_dir(),
    }
}

/// Folder of the application log files.
pub fn log_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<PathBuf> {
    match root() {
        Some(root) => Ok(root.join("logs")),
        None => app.path().app_log_dir(),
    }
}
