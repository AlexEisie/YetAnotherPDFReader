//! Free-text (text box) appearance: background, border and wrapped, aligned text.

use super::{border_width, stroke_style, upright_frame, ApContext, Appearance};
use crate::content::fmt_num;
use crate::dto::{AnnotationDto, Rgb, TextAlign};
use crate::fonts::{is_wide, split_runs, CjkCollection, FontKey, Measure};

/// Baseline distance as a multiple of the font size.
const LINE_HEIGHT: f64 = 1.2;
/// Distance from the top of a line to its baseline, as a multiple of the font size.
const ASCENT: f64 = 0.85;
/// Inner padding between the border and the text.
const PADDING: f64 = 2.0;

/// Font size clamped to a sane range.
pub fn font_size(dto: &AnnotationDto) -> f64 {
    if dto.font_size.is_finite() {
        dto.font_size.clamp(1.0, 500.0)
    } else {
        12.0
    }
}

fn font_color(dto: &AnnotationDto) -> Rgb {
    dto.font_color.unwrap_or([0.0; 3])
}

fn hex_color(c: Rgb) -> String {
    let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02X}{:02X}{:02X}", byte(c[0]), byte(c[1]), byte(c[2]))
}

fn align_name(align: TextAlign) -> &'static str {
    match align {
        TextAlign::Left => "left",
        TextAlign::Center => "center",
        TextAlign::Right => "right",
    }
}

/// `/DA` default appearance string, e.g. `/Helv 12 Tf 0 0 0 rg`.
pub fn default_appearance(dto: &AnnotationDto) -> String {
    let [r, g, b] = font_color(dto);
    format!(
        "/Helv {} Tf {} {} {} rg",
        fmt_num(font_size(dto)),
        fmt_num(r),
        fmt_num(g),
        fmt_num(b)
    )
}

/// `/DS` default style string (CSS-like).
pub fn default_style(dto: &AnnotationDto) -> String {
    format!(
        "font: {}pt Helvetica; text-align:{}; color:{}",
        fmt_num(font_size(dto)),
        align_name(dto.text_align),
        hex_color(font_color(dto))
    )
}

/// `/RC` rich text: one XHTML paragraph per line of the contents.
pub fn rich_text(dto: &AnnotationDto) -> String {
    let style = format!(
        "font-size:{}pt;text-align:{};color:{};font-family:Helvetica",
        fmt_num(font_size(dto)),
        align_name(dto.text_align),
        hex_color(font_color(dto))
    );
    let mut out = format!(
        "<?xml version=\"1.0\"?><body xmlns=\"http://www.w3.org/1999/xhtml\" \
         xmlns:xfa=\"http://www.xfa.org/schema/xfa-data/1.0/\" xfa:APIVersion=\"Acrobat:11.0.0\" \
         xfa:spec=\"2.0.2\" style=\"{style}\">"
    );
    for line in normalize_newlines(&dto.contents).split('\n') {
        out.push_str("<p dir=\"ltr\">");
        out.push_str(&escape_xml(line));
        out.push_str("</p>");
    }
    out.push_str("</body>");
    out
}

/// Escape text for XHTML. Non-ASCII characters become numeric character references so the
/// whole `/RC` stays ASCII: pdf.js hands the raw string bytes to its XML parser without
/// decoding UTF-16, which would otherwise break rich text containing e.g. CJK characters.
fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() && c != '\t' => {}
            c if !c.is_ascii() => out.push_str(&format!("&#x{:X};", u32::from(c))),
            c => out.push(c),
        }
    }
    out
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Draw the text box. The content is counter-rotated by the page `rotation` so that the
/// text reads upright in the viewer.
pub fn draw(ap: &mut Appearance, dto: &AnnotationDto, ctx: &mut ApContext, rotation: i64) {
    let (frame, w, h) = upright_frame(ap.bbox, rotation);
    ap.opacity(dto.opacity, None);
    ap.content.save().transform(frame);
    if let Some(background) = dto.interior_color {
        ap.content.fill_rgb(background).rect(0.0, 0.0, w, h).fill();
    }
    let border = if dto.color.is_some() {
        border_width(dto)
    } else {
        0.0
    };
    if border > 0.0 {
        ap.content.save();
        stroke_style(ap, dto);
        let half = border / 2.0;
        ap.content
            .rect(half, half, w - border, h - border)
            .stroke()
            .restore();
    }
    ap.content
        .rect(border, border, w - 2.0 * border, h - 2.0 * border)
        .clip();
    let size = font_size(dto);
    let pad = PADDING + border;
    let max_width = (w - 2.0 * pad).max(1.0);
    let cjk = CjkCollection::for_text(&dto.contents, ctx.cjk);
    let lines = wrap(&dto.contents, FontKey::Helvetica, cjk, size, max_width);
    let origin = (pad, h - pad - ASCENT * size);
    draw_lines(ap, ctx, &lines, origin, max_width, size, dto);
    ap.content.restore();
}

/// Emit the wrapped lines starting with the first baseline at `origin`.
fn draw_lines(
    ap: &mut Appearance,
    ctx: &mut ApContext,
    lines: &[Line],
    origin: (f64, f64),
    max_width: f64,
    size: f64,
    dto: &AnnotationDto,
) {
    if lines.iter().all(|l| l.text.is_empty()) {
        return;
    }
    ap.content.begin_text().fill_rgb(font_color(dto));
    let mut current_font = None;
    for (i, line) in lines.iter().enumerate() {
        if line.text.is_empty() {
            continue;
        }
        let offset = match dto.text_align {
            TextAlign::Left => 0.0,
            TextAlign::Center => (max_width - line.width) / 2.0,
            TextAlign::Right => max_width - line.width,
        };
        ap.content
            .text_origin(origin.0 + offset, origin.1 - i as f64 * LINE_HEIGHT * size);
        for run in split_runs(&line.text, line.latin, line.cjk) {
            if current_font != Some(run.font) {
                let name = ap.use_font(ctx, run.font);
                ap.content.font(name, size);
                current_font = Some(run.font);
            }
            match run.font {
                FontKey::Cjk(_) => ap.content.show_hex(&run.encode()),
                _ => ap.content.show_literal(&run.encode()),
            };
        }
    }
    ap.content.end_text();
}

/// One laid-out line of text.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub text: String,
    /// Width in points.
    pub width: f64,
    latin: FontKey,
    cjk: CjkCollection,
}

/// Wrap `text` into lines no wider than `max_width` (explicit newlines are honoured).
pub fn wrap(
    text: &str,
    latin: FontKey,
    cjk: CjkCollection,
    size: f64,
    max_width: f64,
) -> Vec<Line> {
    let measure = Measure { latin, cjk, size };
    let mut lines = Vec::new();
    for paragraph in normalize_newlines(text).split('\n') {
        for line in wrap_paragraph(paragraph, &measure, max_width) {
            let width = measure.text(&line);
            lines.push(Line {
                text: line,
                width,
                latin,
                cjk,
            });
        }
    }
    lines
}

/// Break a paragraph into tokens: words, single whitespace characters and single wide
/// (CJK) characters, so lines may break between any two ideographs.
fn tokens(paragraph: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut word_start = None;
    for (i, c) in paragraph.char_indices() {
        if c.is_whitespace() || is_wide(c) {
            if let Some(start) = word_start.take() {
                tokens.push(&paragraph[start..i]);
            }
            tokens.push(&paragraph[i..i + c.len_utf8()]);
        } else if word_start.is_none() {
            word_start = Some(i);
        }
    }
    if let Some(start) = word_start {
        tokens.push(&paragraph[start..]);
    }
    tokens
}

/// Greedy line breaking of one paragraph. Always yields at least one (possibly empty) line.
fn wrap_paragraph(paragraph: &str, measure: &Measure, max_width: f64) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut width = 0.0;
    let mut flush = |line: &mut String, width: &mut f64| {
        lines.push(line.trim_end().to_string());
        line.clear();
        *width = 0.0;
    };
    for token in tokens(paragraph) {
        let w = measure.text(token);
        if width + w <= max_width {
            line.push_str(token);
            width += w;
            continue;
        }
        if !line.is_empty() {
            flush(&mut line, &mut width);
            if token.trim().is_empty() {
                continue;
            }
        }
        if w <= max_width {
            line.push_str(token);
            width = w;
            continue;
        }
        for c in token.chars() {
            let cw = measure.char(c);
            if width + cw > max_width && !line.is_empty() {
                flush(&mut line, &mut width);
            }
            line.push(c);
            width += cw;
        }
    }
    flush(&mut line, &mut width);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[Line]) -> Vec<&str> {
        lines.iter().map(|l| l.text.as_str()).collect()
    }

    #[test]
    fn wraps_words_and_newlines() {
        // "aaa " = 3*556+278 = 1946 units -> 19.46pt at 10pt.
        let lines = wrap(
            "aaa aaa aaa\n\nbb",
            FontKey::Helvetica,
            CjkCollection::Gb1,
            10.0,
            40.0,
        );
        assert_eq!(texts(&lines), vec!["aaa aaa", "aaa", "", "bb"]);
        assert!(lines.iter().all(|l| l.width <= 40.0));
    }

    #[test]
    fn breaks_long_words_and_cjk() {
        let lines = wrap(
            "abcdefghij",
            FontKey::Helvetica,
            CjkCollection::Gb1,
            10.0,
            20.0,
        );
        assert!(lines.len() > 1);
        assert_eq!(lines.concat_text(), "abcdefghij");
        let lines = wrap(
            "你好世界和平",
            FontKey::Helvetica,
            CjkCollection::Gb1,
            10.0,
            25.0,
        );
        assert_eq!(texts(&lines), vec!["你好", "世界", "和平"]);
    }

    trait ConcatText {
        fn concat_text(&self) -> String;
    }

    impl ConcatText for Vec<Line> {
        fn concat_text(&self) -> String {
            self.iter().map(|l| l.text.as_str()).collect()
        }
    }

    #[test]
    fn rich_text_is_escaped() {
        let dto = AnnotationDto {
            contents: "a<b>&\"c\"\nline 2".into(),
            ..crate::appearance::tests::dto(crate::dto::AnnotKind::Freetext)
        };
        let rc = rich_text(&dto);
        assert!(
            rc.contains("<p dir=\"ltr\">a&lt;b&gt;&amp;&quot;c&quot;</p><p dir=\"ltr\">line 2</p>")
        );
        let cjk = AnnotationDto {
            contents: "中é".into(),
            ..dto.clone()
        };
        assert!(rich_text(&cjk).contains("<p dir=\"ltr\">&#x4E2D;&#xE9;</p>"));
        assert!(rich_text(&cjk).is_ascii());
        assert_eq!(default_appearance(&dto), "/Helv 12 Tf 0 0 0 rg");
        assert_eq!(
            default_style(&dto),
            "font: 12pt Helvetica; text-align:left; color:#000000"
        );
    }
}
