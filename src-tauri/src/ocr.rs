//! Optical character recognition (PaddleOCR PP-OCRv6 tiny through ONNX Runtime).
//!
//! The models are compiled into the executable, so recognition works offline. The engine is
//! created on first use (about 0.1 s) and then shared; recognising a page rendered at 150–200
//! dpi takes a fraction of a second on a typical CPU.

use std::sync::{Arc, Mutex, OnceLock};

use oar_ocr::core::config::OrtSessionConfig;
use oar_ocr::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::ipc::Request;

use crate::error::{AppError, AppResult};
use crate::frame::{raw_body, Frame};

const DET_MODEL: &[u8] = include_bytes!("../ocr/pp-ocrv6_tiny_det.onnx");
const REC_MODEL: &[u8] = include_bytes!("../ocr/pp-ocrv6_tiny_rec.onnx");
const DICTIONARY: &str = include_str!("../ocr/ppocrv6_tiny_dict.txt");

/// Largest image accepted (pixels); bigger pages are rendered smaller by the front-end.
const MAX_PIXELS: u64 = 60_000_000;

/// One recognised line of text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    pub confidence: f32,
    /// Corners in image pixels: top-left, top-right, bottom-right, bottom-left (as read).
    pub points: [[f32; 2]; 4],
}

fn ocr_error(message: impl std::fmt::Display) -> AppError {
    AppError::Ocr(message.to_string())
}

/// Linux packages ship the official ONNX Runtime shared library next to the application
/// (`/usr/lib/yapr/` for deb / rpm, `usr/lib/yapr/` inside the AppImage), the Intel Mac app in
/// `Contents/Frameworks/`; load it before the first session is created.
#[cfg(any(target_os = "linux", all(target_os = "macos", target_arch = "x86_64")))]
fn load_runtime() -> AppResult<()> {
    // Bundled file name, and the name tried last (a system-wide installation).
    #[cfg(target_os = "linux")]
    const LIBRARY: (&str, &str) = ("libonnxruntime.so", "libonnxruntime.so.1");
    #[cfg(target_os = "macos")]
    const LIBRARY: (&str, &str) = ("libonnxruntime.dylib", "libonnxruntime.dylib");

    static LOADED: OnceLock<Result<(), String>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(std::path::Path::to_path_buf));
            let mut candidates: Vec<std::path::PathBuf> = Vec::new();
            for var in ["YAPR_ONNXRUNTIME", "ORT_DYLIB_PATH"] {
                if let Some(path) = std::env::var_os(var) {
                    candidates.push(path.into());
                }
            }
            if let Some(dir) = &exe_dir {
                candidates.push(dir.join(LIBRARY.0));
                candidates.push(dir.join("../lib/yapr").join(LIBRARY.0));
                candidates.push(dir.join("../Frameworks").join(LIBRARY.0));
            }
            candidates.push(std::path::Path::new("/usr/lib/yapr").join(LIBRARY.0));
            let path = candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| LIBRARY.1.into());
            ort::init_from(&path).map_err(|e| format!("ONNX Runtime ({}) could not be loaded: {e}", path.display()))?.commit();
            log::info!("ONNX Runtime loaded from {}", path.display());
            Ok(())
        })
        .clone()
        .map_err(AppError::Ocr)
}

#[cfg(not(any(target_os = "linux", all(target_os = "macos", target_arch = "x86_64"))))]
fn load_runtime() -> AppResult<()> {
    Ok(())
}

fn engine() -> AppResult<Arc<Mutex<OAROCR>>> {
    static ENGINE: OnceLock<Arc<Mutex<OAROCR>>> = OnceLock::new();
    static INIT: Mutex<()> = Mutex::new(());
    if let Some(engine) = ENGINE.get() {
        return Ok(engine.clone());
    }
    let _guard = INIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(engine) = ENGINE.get() {
        return Ok(engine.clone());
    }
    load_runtime()?;
    let threads = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 4));
    let session = OrtSessionConfig { intra_threads: Some(threads), ..Default::default() };
    let started = std::time::Instant::now();
    let ocr = OAROCRBuilder::new(DET_MODEL, REC_MODEL, "")
        .character_dict_content(DICTIONARY)
        .ort_session(session)
        .build()
        .map_err(ocr_error)?;
    log::info!("OCR engine ready in {} ms", started.elapsed().as_millis());
    Ok(ENGINE.get_or_init(|| Arc::new(Mutex::new(ocr))).clone())
}

/// Composite RGBA pixels over white.
fn to_rgb(width: u32, height: u32, rgba: &[u8]) -> AppResult<image::RgbImage> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixels > MAX_PIXELS || rgba.len() as u64 != pixels * 4 {
        return Err(AppError::InvalidArgument(format!("image of {width}x{height} with {} bytes", rgba.len())));
    }
    let rgb: Vec<u8> = rgba
        .chunks_exact(4)
        .flat_map(|p| {
            let a = u16::from(p[3]);
            let blend = |c: u8| ((u16::from(c) * a + 255 * (255 - a)) / 255) as u8;
            [blend(p[0]), blend(p[1]), blend(p[2])]
        })
        .collect();
    image::RgbImage::from_raw(width, height, rgb).ok_or_else(|| ocr_error("invalid image buffer"))
}

/// Sort lines in reading order: top to bottom, left to right for boxes on the same line.
pub fn reading_order(lines: &mut [OcrLine]) {
    let top = |l: &OcrLine| l.points.iter().map(|p| p[1]).fold(f32::MAX, f32::min);
    let left = |l: &OcrLine| l.points.iter().map(|p| p[0]).fold(f32::MAX, f32::min);
    let height = |l: &OcrLine| {
        let ys = l.points.iter().map(|p| p[1]);
        ys.clone().fold(f32::MIN, f32::max) - ys.fold(f32::MAX, f32::min)
    };
    lines.sort_by(|a, b| {
        let tolerance = height(a).min(height(b)) * 0.5;
        if (top(a) - top(b)).abs() <= tolerance {
            left(a).total_cmp(&left(b))
        } else {
            top(a).total_cmp(&top(b))
        }
    });
}

/// Recognise the text of an RGB image.
pub fn recognize_rgb(image: image::RgbImage) -> AppResult<Vec<OcrLine>> {
    let engine = engine()?;
    let ocr = engine.lock().unwrap_or_else(|e| e.into_inner());
    let results = ocr.predict(vec![image]).map_err(ocr_error)?;
    let mut lines: Vec<OcrLine> = results
        .into_iter()
        .next()
        .map(|r| r.text_regions)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|region| {
            let text = region.text.as_deref()?.trim().to_string();
            if text.is_empty() || region.bounding_box.points.len() < 4 {
                return None;
            }
            let p = &region.bounding_box.points;
            Some(OcrLine {
                text,
                confidence: region.confidence.unwrap_or(0.0),
                points: [[p[0].x, p[0].y], [p[1].x, p[1].y], [p[2].x, p[2].y], [p[3].x, p[3].y]],
            })
        })
        .collect();
    reading_order(&mut lines);
    Ok(lines)
}

#[derive(Debug, Deserialize)]
struct OcrMeta {
    width: u32,
    height: u32,
}

/// Recognise text in an image. Blob 0: RGBA pixels (`width * height * 4` bytes).
#[tauri::command]
pub async fn ocr_recognize(request: Request<'_>) -> AppResult<Vec<OcrLine>> {
    let body = raw_body(&request)?.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let frame = Frame::parse(&body)?;
        let meta: OcrMeta = frame.meta()?;
        let pixels = frame.blobs.first().copied().unwrap_or_default();
        let started = std::time::Instant::now();
        let lines = recognize_rgb(to_rgb(meta.width, meta.height, pixels)?)?;
        log::debug!("OCR {}x{}: {} lines in {} ms", meta.width, meta.height, lines.len(), started.elapsed().as_millis());
        Ok(lines)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> image::RgbImage {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
        image::open(path).expect("fixture").to_rgb8()
    }

    fn joined(lines: &[OcrLine]) -> String {
        lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn recognises_chinese_and_english() {
        let lines = recognize_rgb(fixture("ocr-mixed.png")).unwrap();
        let text = joined(&lines);
        assert!(text.contains("城市夜空观测手册"), "{text}");
        assert!(text.contains("为什么要记录夜空亮度"), "{text}");
        assert!(lines.iter().all(|l| l.confidence > 0.5), "{lines:?}");
        // Reading order: the title comes before the section heading.
        let title = lines.iter().position(|l| l.text.contains("城市夜空观测手册")).unwrap();
        let heading = lines.iter().position(|l| l.text.contains("为什么")).unwrap();
        assert!(title < heading);
    }

    #[test]
    fn recognises_a_noisy_scan() {
        let text = joined(&recognize_rgb(fixture("ocr-scan.png")).unwrap());
        assert!(text.contains("Portable Document Format"), "{text}");
    }

    #[test]
    fn rgba_is_composited_on_white() {
        let rgb = to_rgb(2, 1, &[0, 0, 0, 0, 255, 0, 0, 255]).unwrap();
        assert_eq!(rgb.get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(rgb.get_pixel(1, 0).0, [255, 0, 0]);
        assert!(to_rgb(2, 2, &[0; 4]).is_err());
    }

    #[test]
    fn sorts_lines_in_reading_order() {
        let line = |text: &str, x: f32, y: f32| OcrLine {
            text: text.into(),
            confidence: 1.0,
            points: [[x, y], [x + 50.0, y], [x + 50.0, y + 20.0], [x, y + 20.0]],
        };
        let mut lines = vec![line("c", 0.0, 60.0), line("b", 100.0, 3.0), line("a", 0.0, 0.0)];
        reading_order(&mut lines);
        assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["a", "b", "c"]);
    }
}
