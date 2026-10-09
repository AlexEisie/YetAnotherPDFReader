//! Picture XObjects: JPEG files embedded unchanged and RGBA pixels (Flate + soft mask).

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{dictionary, Object, ObjectId, Stream};

use crate::dto::{ImageFormat, PageImage};
use crate::error::{PdfError, Result};
use crate::objects::num_array;

fn invalid(message: impl Into<String>) -> PdfError {
    PdfError::InvalidRequest(message.into())
}

/// zlib-compress `data`.
pub fn deflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(
        Vec::with_capacity(data.len() / 4 + 64),
        Compression::default(),
    );
    encoder
        .write_all(data)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    encoder.finish().map_err(|e| PdfError::Write(e.to_string()))
}

/// An 8-bit Flate-compressed image stream.
pub fn flate_image(width: u32, height: u32, color_space: &str, data: &[u8]) -> Result<Stream> {
    let dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => width,
        "Height" => height,
        "ColorSpace" => color_space,
        "BitsPerComponent" => 8,
        "Filter" => "FlateDecode",
    };
    Ok(Stream::new(dict, deflate(data)?).with_compression(false))
}

/// What a JPEG file header tells about the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegInfo {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    /// Adobe APP14 marker present (CMYK data is stored inverted).
    pub adobe: bool,
    /// EXIF orientation 1..=8 (1 = as stored).
    pub orientation: u8,
}

/// Parse the markers of a JPEG file up to its frame header.
pub fn jpeg_info(data: &[u8]) -> Result<JpegInfo> {
    let bad = || invalid("the picture is not a valid JPEG file");
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err(bad());
    }
    let mut info = JpegInfo {
        width: 0,
        height: 0,
        components: 0,
        adobe: false,
        orientation: 1,
    };
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            return Err(bad());
        }
        let marker = data[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = usize::from(u16::from_be_bytes([data[i + 2], data[i + 3]]));
        let segment = data.get(i + 4..i + 2 + len).ok_or_else(bad)?;
        match marker {
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                if segment.len() < 6 {
                    return Err(bad());
                }
                info.height = u32::from(u16::from_be_bytes([segment[1], segment[2]]));
                info.width = u32::from(u16::from_be_bytes([segment[3], segment[4]]));
                info.components = segment[5];
                if info.width == 0 || info.height == 0 || !matches!(info.components, 1 | 3 | 4) {
                    return Err(invalid("unsupported JPEG picture"));
                }
                return Ok(info);
            }
            0xE1 => {
                if let Some(o) = exif_orientation(segment) {
                    info.orientation = o;
                }
            }
            0xEE if segment.starts_with(b"Adobe") => info.adobe = true,
            0xDA | 0xD9 => break,
            _ => {}
        }
        i += 2 + len;
    }
    Err(bad())
}

/// EXIF orientation tag (0x0112) of an APP1 segment.
fn exif_orientation(segment: &[u8]) -> Option<u8> {
    let tiff = segment.strip_prefix(b"Exif\0\0")?;
    let little = match tiff.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = tiff.get(at..at + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = tiff.get(at..at + 4)?;
        Some(if little {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };
    let ifd = usize::try_from(u32_at(4)?).ok()?;
    let count = usize::from(u16_at(ifd)?);
    (0..count.min(256)).find_map(|n| {
        let entry = ifd + 2 + n * 12;
        (u16_at(entry)? == 0x0112)
            .then(|| u16_at(entry + 8))
            .flatten()
            .and_then(|v| u8::try_from(v).ok())
            .filter(|v| (1..=8).contains(v))
    })
}

/// A picture ready to be drawn: the XObject and its displayed size in pixels.
pub struct Picture {
    pub id: ObjectId,
    /// Width and height as displayed (after the EXIF orientation).
    pub width: u32,
    pub height: u32,
    pub orientation: u8,
}

impl Picture {
    /// Matrix that draws the picture into the rectangle `(x, y, w, h)` (PDF coordinates),
    /// applying the EXIF orientation.
    pub fn placement(&self, x: f64, y: f64, w: f64, h: f64) -> [f64; 6] {
        // Displayed normalised position (X right, Y down) of a stored pixel position.
        let displayed = |sx: f64, sy: f64| -> (f64, f64) {
            match self.orientation {
                2 => (1.0 - sx, sy),
                3 => (1.0 - sx, 1.0 - sy),
                4 => (sx, 1.0 - sy),
                5 => (sy, sx),
                6 => (1.0 - sy, sx),
                7 => (1.0 - sy, 1.0 - sx),
                8 => (sy, 1.0 - sx),
                _ => (sx, sy),
            }
        };
        // Image space (u, v): u = stored x, v = 1 - stored y.
        let page = |u: f64, v: f64| -> (f64, f64) {
            let (dx, dy) = displayed(u, 1.0 - v);
            (x + dx * w, y + (1.0 - dy) * h)
        };
        let (e, f) = page(0.0, 0.0);
        let (ax, ay) = page(1.0, 0.0);
        let (cx, cy) = page(0.0, 1.0);
        [ax - e, ay - f, cx - e, cy - f, e, f]
    }
}

/// Store the picture of `image` (blob from `blobs`) through `add` and describe it.
pub fn add_picture(
    image: &PageImage,
    blobs: &[&[u8]],
    mut add: impl FnMut(Object) -> ObjectId,
) -> Result<Picture> {
    let blob = blobs
        .get(image.blob)
        .ok_or_else(|| invalid(format!("picture blob {} is missing", image.blob)))?;
    match image.format {
        ImageFormat::Jpeg => {
            let info = jpeg_info(blob)?;
            let color_space = match info.components {
                1 => "DeviceGray",
                4 => "DeviceCMYK",
                _ => "DeviceRGB",
            };
            let mut dict = dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => info.width,
                "Height" => info.height,
                "ColorSpace" => color_space,
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            };
            if info.components == 4 && info.adobe {
                dict.set("Decode", num_array(&[1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0]));
            }
            let id = add(Object::Stream(
                Stream::new(dict, blob.to_vec()).with_compression(false),
            ));
            let swap = info.orientation >= 5;
            Ok(Picture {
                id,
                width: if swap { info.height } else { info.width },
                height: if swap { info.width } else { info.height },
                orientation: info.orientation,
            })
        }
        ImageFormat::Rgba => {
            let pixels = (image.width as usize)
                .checked_mul(image.height as usize)
                .filter(|&n| n > 0)
                .ok_or_else(|| invalid("the picture has no pixels"))?;
            let needed = pixels
                .checked_mul(4)
                .ok_or_else(|| invalid("the picture is too large"))?;
            let rgba = blob.get(..needed).ok_or_else(|| {
                invalid(format!(
                    "picture blob needs {needed} bytes, got {}",
                    blob.len()
                ))
            })?;
            let rgb: Vec<u8> = rgba
                .chunks_exact(4)
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect();
            let alpha: Vec<u8> = rgba.chunks_exact(4).map(|p| p[3]).collect();
            let mut stream = flate_image(image.width, image.height, "DeviceRGB", &rgb)?;
            if alpha.iter().any(|&a| a != 255) {
                let mask = flate_image(image.width, image.height, "DeviceGray", &alpha)?;
                let mask_id = add(Object::Stream(mask));
                stream.dict.set("SMask", mask_id);
            }
            let id = add(Object::Stream(stream));
            Ok(Picture {
                id,
                width: image.width,
                height: image.height,
                orientation: 1,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal JPEG header: SOI, optional APP1 (EXIF orientation), SOF0.
    pub fn fake_jpeg(width: u16, height: u16, orientation: Option<u16>) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8];
        if let Some(o) = orientation {
            let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec();
            tiff.extend_from_slice(&1u16.to_be_bytes());
            tiff.extend_from_slice(&0x0112u16.to_be_bytes());
            tiff.extend_from_slice(&3u16.to_be_bytes());
            tiff.extend_from_slice(&1u32.to_be_bytes());
            tiff.extend_from_slice(&o.to_be_bytes());
            tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
            let mut seg = b"Exif\0\0".to_vec();
            seg.extend(tiff);
            out.extend_from_slice(&[0xFF, 0xE1]);
            out.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
            out.extend(seg);
        }
        out.extend_from_slice(&[0xFF, 0xC0, 0, 17, 8]);
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        out.extend_from_slice(&[0xFF, 0xD9]);
        out
    }

    #[test]
    fn reads_jpeg_size_and_orientation() {
        let info = jpeg_info(&fake_jpeg(640, 480, Some(6))).unwrap();
        assert_eq!((info.width, info.height, info.components, info.orientation), (640, 480, 3, 6));
        assert_eq!(jpeg_info(&fake_jpeg(10, 20, None)).unwrap().orientation, 1);
        assert!(jpeg_info(b"\x89PNG....").is_err());
    }

    #[test]
    fn orientation_placement_maps_corners() {
        let pic = |orientation| Picture { id: (1, 0), width: 1, height: 1, orientation };
        // As stored: identity scaled into the box.
        assert_eq!(pic(1).placement(10.0, 20.0, 100.0, 50.0), [100.0, 0.0, 0.0, 50.0, 10.0, 20.0]);
        // Rotated 90° clockwise: image u axis runs downwards, v axis to the right.
        let m = pic(6).placement(0.0, 0.0, 100.0, 50.0);
        assert_eq!(m, [0.0, -50.0, 100.0, 0.0, 0.0, 50.0]);
    }
}
