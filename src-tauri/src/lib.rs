//! YetAnotherPDFReader application shell.
//!
//! Responsibilities of the Rust side:
//! * file access for the renderer (sessions with range reads, see [`session`]),
//! * every operation that writes PDF data (delegated to the `yapr-pdf` crate),
//! * crash-safe persistence of settings and other user data ([`store`]),
//! * OS integration: single instance, file associations / command-line files, logging.

mod commands;
mod error;
mod frame;
mod fsutil;
mod ocr;
mod portable;
mod session;
mod store;

use parking_lot::Mutex;
use serde::Serialize;
use session::Sessions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use store::Store;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

/// Event emitted to the main window when the OS asks us to open files while running.
pub const OPEN_FILES_EVENT: &str = "app://open-files";

pub struct AppState {
    pub sessions: Arc<Sessions>,
    pub store: Arc<Store>,
    pending_files: Mutex<Vec<String>>,
    ready: AtomicBool,
}

impl AppState {
    fn new(store_dir: std::path::PathBuf) -> Self {
        Self {
            sessions: Arc::new(Sessions::default()),
            store: Arc::new(Store::new(store_dir)),
            pending_files: Mutex::new(Vec::new()),
            ready: AtomicBool::new(false),
        }
    }

    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn take_pending_files(&self) -> Vec<String> {
        std::mem::take(&mut *self.pending_files.lock())
    }

    fn queue_files(&self, files: Vec<String>) {
        self.pending_files.lock().extend(files);
    }
}

#[derive(Clone, Serialize)]
struct OpenFilesPayload {
    files: Vec<String>,
}

/// Keep only arguments that point at existing files, resolved against `cwd`.
fn files_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| {
            let p = Path::new(&a);
            let full = normalize(&if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) });
            full.is_file().then(|| full.display().to_string())
        })
        .collect()
}

/// Lexically remove `.` and `..` segments (`C:\docs\.\a\..\b.pdf` → `C:\docs\b.pdf`), so the
/// same file always gets the same path in the recent list and view-state store.
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// Deliver files to the front-end: immediately via an event when it is listening, otherwise
/// queued until it calls `app_ready` / `app_take_pending_files`.
fn deliver_files(app: &AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    if state.is_ready() {
        if let Err(err) = app.emit_to("main", OPEN_FILES_EVENT, OpenFilesPayload { files: files.clone() }) {
            log::error!("failed to forward files to the window: {err}");
            state.queue_files(files);
        }
    } else {
        state.queue_files(files);
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Never let the webview navigate away from the application (e.g. a link inside a PDF that
/// slipped past the front-end handler). External links are opened by the front-end through
/// the opener plugin after the user's confirmation.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let allowed = match url.scheme() {
                "tauri" | "asset" | "ipc" | "about" | "data" | "blob" => true,
                "http" | "https" => matches!(url.host_str(), Some("localhost") | Some("tauri.localhost") | Some("127.0.0.1")),
                _ => false,
            };
            if !allowed {
                log::warn!("blocked navigation to {url}");
            }
            allowed
        })
        .build()
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    portable::configure_webview();
    let log_target = match portable::root() {
        Some(root) => tauri_plugin_log::TargetKind::Folder { path: root.join("logs"), file_name: None },
        None => tauri_plugin_log::TargetKind::LogDir { file_name: None },
    };

    let log_level = if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info };

    let app = tauri::Builder::default()
        // Must be registered first so a second launch is forwarded before anything else runs.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = files_from_args(argv.into_iter().skip(1), Path::new(&cwd));
            log::info!("second instance forwarded {} file(s)", files.len());
            deliver_files(app, files);
            focus_main_window(app);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .max_file_size(4 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .targets([
                    tauri_plugin_log::Target::new(log_target),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility is controlled by the front-end (window starts hidden to avoid a
                // white flash, then `app_ready` shows it).
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            let data_dir = portable::data_dir(app.handle())?;
            app.manage(AppState::new(data_dir.join("store")));

            let cwd = std::env::current_dir().unwrap_or_default();
            let files = files_from_args(std::env::args().skip(1), &cwd);
            app.state::<AppState>().queue_files(files);

            log::info!(
                "YetAnotherPDFReader {} starting ({} {})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            if let Some(root) = portable::root() {
                log::info!("portable mode, data in {}", root.display());
            }

            // Safety net: if the front-end failed to boot, still show the window so the user
            // is not left with an invisible process.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                if !handle.state::<AppState>().is_ready() {
                    log::warn!("front-end did not report ready in time; showing the window anyway");
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::doc_open,
            commands::doc_read,
            commands::doc_read_all,
            commands::doc_close,
            commands::doc_check,
            commands::doc_annotations,
            commands::pdf_save,
            commands::pdf_build,
            commands::pdf_page_ops,
            commands::pdf_extract,
            commands::pdf_security_info,
            commands::pdf_security,
            ocr::ocr_recognize,
            commands::pdf_read_annotations,
            commands::pdf_fonts,
            commands::pdf_page_count,
            commands::fs_stat,
            commands::fs_read,
            commands::fs_write,
            commands::fs_copy,
            commands::clipboard_write_image,
            commands::store_read,
            commands::store_write,
            commands::store_remove,
            commands::app_ready,
            commands::app_take_pending_files,
            commands::app_log,
            commands::app_open_folder,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application");

    app.run(|app, event| {
        // macOS delivers file-association opens as an event instead of argv.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.display().to_string())
                .collect();
            deliver_files(app, files);
        }
        if let tauri::RunEvent::Exit = event {
            let open = app.state::<AppState>().sessions.len();
            log::info!("exiting ({open} document session(s) still open)");
            // On Intel Macs ONNX Runtime is a shared library whose static destructors abort the
            // process ("mutex lock failed") once OCR has run. Everything is saved by now (window
            // state is saved by its plugin before this callback), so end without running them.
            #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
            if ocr::engine_loaded() {
                log::logger().flush();
                unsafe extern "C" {
                    fn _exit(status: std::os::raw::c_int) -> !;
                }
                // SAFETY: terminates the process; nothing runs afterwards.
                unsafe { _exit(0) }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_files_are_taken_from_args() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.pdf"), b"%PDF-1.4").unwrap();
        let files = files_from_args(
            vec!["a.pdf".to_string(), "--flag".to_string(), "missing.pdf".to_string()],
            dir.path(),
        );
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("a.pdf"));
    }

    #[test]
    fn relative_args_resolve_to_one_spelling() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("a.pdf"), b"%PDF-1.4").unwrap();
        let direct = files_from_args(vec!["a.pdf".to_string()], dir.path());
        let dotted = files_from_args(vec![format!(".{0}sub{0}..{0}a.pdf", std::path::MAIN_SEPARATOR)], dir.path());
        assert_eq!(direct, dotted);
        assert_eq!(normalize(Path::new("/x/../../y/./z")), PathBuf::from("/y/z"));
    }
}
