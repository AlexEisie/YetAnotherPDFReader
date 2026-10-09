//! Rubber stamps: image stamps (RGBA pixels) and text stamps (label + sub-label).

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{dictionary, Object, Stream};

use super::{invalid, upright_frame, ApContext, Appearance};
use crate::dto::{AnnotationDto, StampImage};
use crate::error::{PdfError, Result};
use crate::fonts::{split_runs, CjkCollection, FontKey, Measure};

/// Standard stamp names (ISO 32000-1, table 181).
const STANDARD_NAMES: [&str; 14] = [
    "Approved",
    "Experimental",
    "NotApproved",
    "AsIs",
    "Expired",
    "NotForPublicRelease",
    "Confidential",
    "Final",
    "Sold",
    "Departmental",
    "ForComment",
    "TopSecret",
    "Draft",
    "ForPublicRelease",
];

/// `/Name` for a text stamp: a standard name when the label matches one, otherwise the
/// label's ASCII letters and digits (`Stamp` when none are left).
pub fn stamp_name(label: &str) -> String {
    let key: String = label.chars().filter(char::is_ascii_alphanumeric).collect();
    if let Some(standard) = STANDARD_NAMES.iter().find(|n| n.eq_ignore_ascii_case(&key)) {
        return (*standard).to_string();
    }
    if key.is_empty() {
        "Stamp".to_string()
    } else {
        key.chars().take(64).collect()
    }
}

/// Draw the stamp counter-rotated by the page `rotation`, so it appears upright in the viewer.
pub fn draw(
    ap: &mut Appearance,
    dto: &AnnotationDto,
    ctx: &mut ApContext,
    rotation: i64,
) -> Result<()> {
    let (frame, w, h) = upright_frame(ap.bbox, rotation);
    ap.opacity(dto.opacity, None);
    ap.content.save().transform(frame);
    match &dto.stamp_image {
        Some(image) => image_stamp(ap, image, ctx, (w, h))?,
        None => text_stamp(ap, dto, ctx, (w, h)),
    }
    ap.content.restore();
    Ok(())
}

fn deflate(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(
        Vec::with_capacity(data.len() / 4 + 64),
        Compression::default(),
    );
    encoder
        .write_all(data)
        .map_err(|e| PdfError::Write(e.to_string()))?;
    encoder.finish().map_err(|e| PdfError::Write(e.to_string()))
}

fn image_stream(width: u32, height: u32, color_space: &str, data: &[u8]) -> Result<Stream> {
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

/// Image XObject (RGB + optional DeviceGray soft mask) scaled to fill the `w`×`h` box.
fn image_stamp(
    ap: &mut Appearance,
    image: &StampImage,
    ctx: &mut ApContext,
    (w, h): (f64, f64),
) -> Result<()> {
    let blob = ctx
        .blobs
        .get(image.blob)
        .ok_or_else(|| invalid(format!("stamp image refers to missing blob {}", image.blob)))?;
    let pixels = (image.width as usize)
        .checked_mul(image.height as usize)
        .filter(|&n| n > 0)
        .ok_or_else(|| invalid("stamp image has no pixels"))?;
    let needed = pixels
        .checked_mul(4)
        .ok_or_else(|| invalid("stamp image is too large"))?;
    let rgba = blob.get(..needed).ok_or_else(|| {
        invalid(format!(
            "stamp image blob needs {needed} bytes, got {}",
            blob.len()
        ))
    })?;
    let rgb: Vec<u8> = rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let alpha: Vec<u8> = rgba.chunks_exact(4).map(|p| p[3]).collect();
    let mut stream = image_stream(image.width, image.height, "DeviceRGB", &rgb)?;
    if alpha.iter().any(|&a| a != 255) {
        let mask = image_stream(image.width, image.height, "DeviceGray", &alpha)?;
        let mask_id = ctx.sink.add_object(mask.into());
        stream.dict.set("SMask", mask_id);
    }
    let image_id = ctx.sink.add_object(Object::Stream(stream));
    ap.use_xobject("Im0", image_id);
    ap.content
        .save()
        .transform([w, 0.0, 0.0, h, 0.0, 0.0])
        .xobject("Im0")
        .restore();
    Ok(())
}

/// Rounded double border with a bold, auto-fitted label and an optional sub-label, drawn in
/// the `w`×`h` box at the origin.
fn text_stamp(ap: &mut Appearance, dto: &AnnotationDto, ctx: &mut ApContext, (w, h): (f64, f64)) {
    let color = dto.color.unwrap_or([0.0; 3]);
    let line = (w.min(h) / 25.0).clamp(0.75, 4.0);
    let radius = w.min(h) * 0.15;
    if let Some(fill) = dto.interior_color {
        ap.content
            .fill_rgb(fill)
            .rounded_rect(0.0, 0.0, w, h, radius)
            .fill();
    }
    if dto.color.is_some() {
        let outer = line / 2.0;
        let inner = line * 2.5;
        ap.content.stroke_rgb(color).line_width(line);
        ap.content
            .rounded_rect(outer, outer, w - 2.0 * outer, h - 2.0 * outer, radius)
            .stroke();
        ap.content.line_width(line / 2.0);
        let inner_radius = (radius - inner + outer).max(0.0);
        ap.content
            .rounded_rect(inner, inner, w - 2.0 * inner, h - 2.0 * inner, inner_radius)
            .stroke();
    }
    let label = dto
        .stamp_label
        .as_deref()
        .filter(|l| !l.trim().is_empty())
        .unwrap_or("DRAFT");
    let sublabel = dto
        .stamp_sublabel
        .as_deref()
        .filter(|l| !l.trim().is_empty());
    let all_text = format!("{label}{}", sublabel.unwrap_or_default());
    let cjk = CjkCollection::for_text(&all_text, ctx.cjk);
    let margin = line * 3.5 + 2.0;
    let (avail_w, avail_h) = ((w - 2.0 * margin).max(1.0), (h - 2.0 * margin).max(1.0));
    let fit = |text: &str, font: FontKey, height: f64| {
        let unit = Measure {
            latin: font,
            cjk,
            size: 1.0,
        }
        .text(text);
        if unit > 0.0 {
            height.min(avail_w / unit)
        } else {
            height
        }
    };
    let (cx, cy) = (w / 2.0, h / 2.0);
    ap.content.save().rect(0.0, 0.0, w, h).clip();
    ap.content.begin_text().fill_rgb(color);
    match sublabel {
        None => {
            let size = fit(label, FontKey::HelveticaBold, avail_h * 0.75);
            centered_text(
                ap,
                ctx,
                label,
                FontKey::HelveticaBold,
                cjk,
                size,
                (cx, cy - size * 0.36),
            );
        }
        Some(sub) => {
            let size = fit(label, FontKey::HelveticaBold, avail_h * 0.55);
            let sub_size = fit(sub, FontKey::Helvetica, avail_h * 0.25).min(size * 0.6);
            let gap = size * 0.2;
            let block = size * 0.72 + gap + sub_size * 0.72;
            let baseline = cy + block / 2.0 - size * 0.72;
            centered_text(
                ap,
                ctx,
                label,
                FontKey::HelveticaBold,
                cjk,
                size,
                (cx, baseline),
            );
            let sub_baseline = baseline - gap - sub_size * 0.72;
            centered_text(
                ap,
                ctx,
                sub,
                FontKey::Helvetica,
                cjk,
                sub_size,
                (cx, sub_baseline),
            );
        }
    }
    ap.content.end_text().restore();
}

/// Show `text` centred horizontally on `center.0` with its baseline at `center.1`.
fn centered_text(
    ap: &mut Appearance,
    ctx: &mut ApContext,
    text: &str,
    latin: FontKey,
    cjk: CjkCollection,
    size: f64,
    center: (f64, f64),
) {
    let width = Measure { latin, cjk, size }.text(text);
    ap.content.text_origin(center.0 - width / 2.0, center.1);
    for run in split_runs(text, latin, cjk) {
        let name = ap.use_font(ctx, run.font);
        ap.content.font(name, size);
        match run.font {
            FontKey::Cjk(_) => ap.content.show_hex(&run.encode()),
            _ => ap.content.show_literal(&run.encode()),
        };
    }
}
