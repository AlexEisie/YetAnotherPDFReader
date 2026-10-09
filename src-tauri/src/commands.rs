//! Tauri command handlers. Thin wrappers that validate input, move blocking work off the
//! async runtime and convert errors into [`AppError`].

use crate::error::{AppError, AppResult};
use crate::frame::{raw_body, Frame};
use crate::fsutil::{self, WriteOptions};
use crate::session::{system_time_ms, DiskStatus, DocInfo};
use crate::store::StoreRead;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use yapr_pdf::{DocumentChanges, DocumentFont, ExistingAnnotation, PageOp};

/// Upper bound for files read wholesale through `fs_read` (images, settings imports, PDFs to merge).
const DEFAULT_READ_LIMIT: u64 = 512 * 1024 * 1024;

async fn blocking<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| AppError::Internal(format!("background task failed: {e}")))?
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn doc_open(state: State<'_, AppState>, path: String) -> AppResult<DocInfo> {
    let path = fsutil::absolute_path(&path)?;
    let sessions = state.sessions.clone();
    blocking(move || sessions.open(&path).map(|s| s.info())).await
}

#[tauri::command]
pub async fn doc_read(state: State<'_, AppState>, session_id: u64, begin: u64, end: u64) -> AppResult<Response> {
    let session = state.sessions.get(session_id)?;
    blocking(move || session.read_range(begin, end).map(Response::new)).await
}

#[tauri::command]
pub async fn doc_read_all(state: State<'_, AppState>, session_id: u64) -> AppResult<Response> {
    let session = state.sessions.get(session_id)?;
    blocking(move || session.read_all().map(Response::new)).await
}

#[tauri::command]
pub async fn doc_close(state: State<'_, AppState>, session_id: u64) -> AppResult<bool> {
    Ok(state.sessions.close(session_id))
}

#[tauri::command]
pub async fn doc_check(state: State<'_, AppState>, session_id: u64) -> AppResult<DiskStatus> {
    Ok(state.sessions.get(session_id)?.check())
}

/// Full-fidelity list of the annotations stored in the opened file (read in the background).
#[tauri::command]
pub async fn doc_annotations(
    state: State<'_, AppState>,
    session_id: u64,
    password: Option<String>,
) -> AppResult<Vec<ExistingAnnotation>> {
    let session = state.sessions.get(session_id)?;
    blocking(move || {
        let bytes = session.read_all()?;
        Ok(yapr_pdf::read_annotations(&bytes, password.as_deref())?)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// PDF writing
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMeta {
    target: String,
    /// Read the document straight from this session instead of blob 0 (saves a round trip of
    /// the whole file through the front-end when only annotations changed).
    #[serde(default)]
    source_session: Option<u64>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    changes: DocumentChanges,
    #[serde(default)]
    keep_backup: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildMeta {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    changes: DocumentChanges,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageOpsMeta {
    #[serde(default)]
    password: Option<String>,
    ops: Vec<PageOp>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtractMeta {
    #[serde(default)]
    password: Option<String>,
    pages: Vec<u32>,
    target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub backup_path: Option<String>,
}

fn save_result(path: &std::path::Path, keep_backup: bool) -> SaveResult {
    let meta = std::fs::metadata(path).ok();
    SaveResult {
        path: path.display().to_string(),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        modified_ms: system_time_ms(meta.and_then(|m| m.modified().ok())),
        backup_path: keep_backup.then(|| fsutil::backup_path(path).display().to_string()),
    }
}

/// Apply annotation/metadata changes to the supplied document bytes and write the result.
/// Blob 0: document (as produced by pdf.js `saveDocument`, i.e. including form values);
/// blobs 1..: images referenced by `StampImage::blob` (index 0 = blob 1).
#[tauri::command]
pub async fn pdf_save(state: State<'_, AppState>, request: Request<'_>) -> AppResult<SaveResult> {
    let body = raw_body(&request)?.to_vec();
    let sessions = state.sessions.clone();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: SaveMeta = frame.meta()?;
        let target = fsutil::absolute_path(&meta.target)?;
        let from_session = match meta.source_session {
            Some(id) => Some(sessions.get(id)?.read_all()?),
            None => None,
        };
        let document = match &from_session {
            Some(bytes) => bytes.as_slice(),
            None => frame.document()?,
        };
        let output = yapr_pdf::apply_document_changes(
            document,
            meta.password.as_deref(),
            &meta.changes,
            &frame.blobs[1..],
        )?;
        fsutil::write_atomic(&target, &output, WriteOptions { keep_backup: meta.keep_backup })?;
        log::info!("saved {} ({} bytes)", target.display(), output.len());
        Ok(save_result(&target, meta.keep_backup))
    })
    .await
}

/// Same as [`pdf_save`] but returns the bytes instead of writing them (printing, page ops,
/// "flatten to new document" flows).
#[tauri::command]
pub async fn pdf_build(request: Request<'_>) -> AppResult<Response> {
    let body = raw_body(&request)?.to_vec();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: BuildMeta = frame.meta()?;
        let output = yapr_pdf::apply_document_changes(
            frame.document()?,
            meta.password.as_deref(),
            &meta.changes,
            &frame.blobs[1..],
        )?;
        Ok(Response::new(output))
    })
    .await
}

/// Structural page operations. Blob 0: document; blobs 1..: source documents referenced by
/// `InsertFromBlob::blob` (index 0 = blob 1).
#[tauri::command]
pub async fn pdf_page_ops(request: Request<'_>) -> AppResult<Response> {
    let body = raw_body(&request)?.to_vec();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: PageOpsMeta = frame.meta()?;
        let output =
            yapr_pdf::apply_page_ops(frame.document()?, meta.password.as_deref(), &meta.ops, &frame.blobs[1..])?;
        Ok(Response::new(output))
    })
    .await
}

#[tauri::command]
pub async fn pdf_extract(request: Request<'_>) -> AppResult<SaveResult> {
    let body = raw_body(&request)?.to_vec();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: ExtractMeta = frame.meta()?;
        let target = fsutil::absolute_path(&meta.target)?;
        let output = yapr_pdf::extract_pages(frame.document()?, meta.password.as_deref(), &meta.pages)?;
        fsutil::write_atomic(&target, &output, WriteOptions::default())?;
        Ok(save_result(&target, false))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordMeta {
    #[serde(default)]
    password: Option<String>,
}

/// Same as [`doc_annotations`] for in-memory documents (after page operations).
#[tauri::command]
pub async fn pdf_read_annotations(request: Request<'_>) -> AppResult<Vec<ExistingAnnotation>> {
    let body = raw_body(&request)?.to_vec();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: PasswordMeta = frame.meta()?;
        Ok(yapr_pdf::read_annotations(frame.document()?, meta.password.as_deref())?)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FontsMeta {
    /// Read the document from this session instead of blob 0.
    #[serde(default)]
    source_session: Option<u64>,
    #[serde(default)]
    password: Option<String>,
}

/// Fonts used by a document (Document Properties ▸ Fonts).
#[tauri::command]
pub async fn pdf_fonts(state: State<'_, AppState>, request: Request<'_>) -> AppResult<Vec<DocumentFont>> {
    let body = raw_body(&request)?.to_vec();
    let sessions = state.sessions.clone();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: FontsMeta = frame.meta()?;
        let fonts = match meta.source_session {
            Some(id) => yapr_pdf::list_fonts(&sessions.get(id)?.read_all()?, meta.password.as_deref())?,
            None => yapr_pdf::list_fonts(frame.document()?, meta.password.as_deref())?,
        };
        Ok(fonts)
    })
    .await
}

#[tauri::command]
pub async fn pdf_page_count(path: String, password: Option<String>) -> AppResult<u32> {
    let path = fsutil::absolute_path(&path)?;
    blocking(move || {
        let bytes = fsutil::read_limited(&path, DEFAULT_READ_LIMIT)?;
        Ok(yapr_pdf::page_count(&bytes, password.as_deref())?)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Generic files
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub is_file: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub read_only: bool,
}

#[tauri::command]
pub async fn fs_stat(path: String) -> AppResult<FileStat> {
    let path = fsutil::absolute_path(&path)?;
    Ok(match std::fs::metadata(&path) {
        Ok(m) => FileStat {
            exists: true,
            is_file: m.is_file(),
            size: m.len(),
            modified_ms: system_time_ms(m.modified().ok()),
            read_only: m.permissions().readonly(),
        },
        Err(_) => FileStat { exists: false, is_file: false, size: 0, modified_ms: None, read_only: false },
    })
}

#[tauri::command]
pub async fn fs_read(path: String, max_bytes: Option<u64>) -> AppResult<Response> {
    let path = fsutil::absolute_path(&path)?;
    let limit = max_bytes.unwrap_or(DEFAULT_READ_LIMIT).min(DEFAULT_READ_LIMIT);
    blocking(move || fsutil::read_limited(&path, limit).map(Response::new)).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteMeta {
    path: String,
    #[serde(default)]
    keep_backup: bool,
}

/// Write arbitrary bytes (exported attachments, text, images, settings). Blob 0 is the content.
#[tauri::command]
pub async fn fs_write(request: Request<'_>) -> AppResult<()> {
    let body = raw_body(&request)?.to_vec();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: WriteMeta = frame.meta()?;
        let target = fsutil::absolute_path(&meta.path)?;
        let data = frame.blobs.first().copied().unwrap_or_default();
        fsutil::write_atomic(&target, data, WriteOptions { keep_backup: meta.keep_backup })
    })
    .await
}

/// Largest image accepted by `clipboard_write_image` (RGBA bytes).
const MAX_CLIPBOARD_IMAGE: usize = 256 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ImageMeta {
    width: usize,
    height: usize,
}

/// Put an image on the system clipboard (snapshot tool). Blob 0 holds `width * height` RGBA
/// pixels. Done natively because the web clipboard API needs a fresh user gesture, which is
/// gone once the region has been rendered.
#[tauri::command]
pub async fn clipboard_write_image(request: Request<'_>) -> AppResult<()> {
    let body = raw_body(&request)?.to_vec();
    blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: ImageMeta = frame.meta()?;
        let pixels = frame.blobs.first().copied().unwrap_or_default();
        let expected = meta.width.checked_mul(meta.height).and_then(|n| n.checked_mul(4));
        match expected {
            Some(n) if n > 0 && n <= MAX_CLIPBOARD_IMAGE && n == pixels.len() => {}
            _ => {
                return Err(AppError::InvalidArgument(format!(
                    "image of {}x{} with {} bytes",
                    meta.width,
                    meta.height,
                    pixels.len()
                )))
            }
        }
        let clipboard_error = |e: arboard::Error| AppError::Clipboard(e.to_string());
        let mut clipboard = arboard::Clipboard::new().map_err(clipboard_error)?;
        clipboard
            .set_image(arboard::ImageData {
                width: meta.width,
                height: meta.height,
                bytes: std::borrow::Cow::Borrowed(pixels),
            })
            .map_err(clipboard_error)
    })
    .await
}

/// Copy a file atomically ("Save As" of an unmodified document).
#[tauri::command]
pub async fn fs_copy(from: String, to: String) -> AppResult<SaveResult> {
    let from = fsutil::absolute_path(&from)?;
    let to = fsutil::absolute_path(&to)?;
    blocking(move || {
        if from == to {
            return Ok(save_result(&to, false));
        }
        let data = fsutil::read_limited(&from, u64::MAX)?;
        fsutil::write_atomic(&to, &data, WriteOptions::default())?;
        Ok(save_result(&to, false))
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn store_read(state: State<'_, AppState>, name: String) -> AppResult<StoreRead> {
    let store = state.store.clone();
    blocking(move || store.read(&name)).await
}

#[tauri::command]
pub async fn store_write(state: State<'_, AppState>, name: String, value: Value) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || store.write(&name, &value)).await
}

#[tauri::command]
pub async fn store_remove(state: State<'_, AppState>, name: String) -> AppResult<()> {
    let store = state.store.clone();
    blocking(move || store.remove(&name)).await
}

// ---------------------------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub debug: bool,
    pub data_dir: String,
    pub log_dir: String,
    /// Operating-system user name, used as the default comment author.
    pub user_name: String,
    pub launch_files: Vec<String>,
}

/// Called once by the front-end when the UI is mounted: shows the (initially hidden) window and
/// hands over the files passed on the command line.
#[tauri::command]
pub async fn app_ready(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) -> AppResult<AppInfo> {
    state.mark_ready();
    if !window.is_visible().unwrap_or(true) {
        window.show()?;
    }
    let _ = window.set_focus();
    let log_dir = crate::portable::log_dir(&app).map(|p| p.display().to_string()).unwrap_or_default();
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        debug: cfg!(debug_assertions),
        data_dir: state.store.dir().display().to_string(),
        log_dir,
        user_name: std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
        launch_files: state.take_pending_files(),
    })
}

#[tauri::command]
pub async fn app_take_pending_files(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.take_pending_files())
}

/// Forward front-end log lines into the application log file.
#[tauri::command]
pub async fn app_log(level: String, message: String) -> AppResult<()> {
    let message: String = message.chars().take(8000).collect();
    match level.as_str() {
        "error" => log::error!(target: "frontend", "{message}"),
        "warn" => log::warn!(target: "frontend", "{message}"),
        "debug" => log::debug!(target: "frontend", "{message}"),
        _ => log::info!(target: "frontend", "{message}"),
    }
    Ok(())
}

/// Open one of the application folders in the system file manager.
#[tauri::command]
pub async fn app_open_folder(app: AppHandle, state: State<'_, AppState>, kind: String) -> AppResult<()> {
    let dir = match kind.as_str() {
        "data" => state.store.dir().to_path_buf(),
        "logs" => crate::portable::log_dir(&app)?,
        other => return Err(AppError::InvalidArgument(format!("unknown folder {other:?}"))),
    };
    std::fs::create_dir_all(&dir).map_err(|e| AppError::from_io(e, &dir))?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| AppError::Internal(e.to_string()))
}
