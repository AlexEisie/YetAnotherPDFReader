//! PDF text strings (encoding / decoding) and date conversion.

use chrono::{DateTime, FixedOffset, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone};
use lopdf::{Object, StringFormat};

/// Encode `text` as a PDF text string object.
///
/// Pure ASCII becomes a literal string; anything else is written as UTF-16BE with a byte
/// order mark (hexadecimal form, so arbitrary bytes survive every reader).
pub fn text_string(text: &str) -> Object {
    if text.is_ascii() {
        Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        Object::String(utf16be_with_bom(text), StringFormat::Hexadecimal)
    }
}

/// UTF-16BE bytes of `text`, prefixed with the `FE FF` byte order mark.
pub fn utf16be_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    bytes.extend_from_slice(&[0xFE, 0xFF]);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    bytes
}

/// Decode the bytes of a PDF text string (UTF-16BE/LE with BOM, UTF-8 with BOM or
/// PDFDocEncoding).
pub fn decode_text(bytes: &[u8]) -> String {
    match bytes {
        [0xFE, 0xFF, rest @ ..] => decode_utf16(rest, u16::from_be_bytes),
        [0xFF, 0xFE, rest @ ..] => decode_utf16(rest, u16::from_le_bytes),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => bytes.iter().filter_map(|&b| pdf_doc_char(b)).collect(),
    }
}

/// Decode UTF-16 code units, dropping embedded language escape sequences (`ESC ... ESC`).
fn decode_utf16(bytes: &[u8], to_unit: fn([u8; 2]) -> u16) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|pair| to_unit([pair[0], pair[1]]));
    let mut in_escape = false;
    let filtered = units.filter(|&unit| {
        if unit == 0x1B {
            in_escape = !in_escape;
            return false;
        }
        !in_escape
    });
    char::decode_utf16(filtered)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// PDFDocEncoding (ISO 32000-1, Annex D.2) to Unicode. Undefined codes yield `None`.
fn pdf_doc_char(byte: u8) -> Option<char> {
    const HIGH: [u16; 33] = [
        0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203A, 0x2212,
        0x2030, 0x201E, 0x201C, 0x201D, 0x2018, 0x2019, 0x201A, 0x2122, 0xFB01, 0xFB02, 0x0141,
        0x0152, 0x0160, 0x0178, 0x017D, 0x0131, 0x0142, 0x0153, 0x0161, 0x017E, 0x0000, 0x20AC,
    ];
    const LOW: [u16; 8] = [
        0x02D8, 0x02C7, 0x02C6, 0x02D9, 0x02DD, 0x02DB, 0x02DA, 0x02DC,
    ];
    let code = match byte {
        0x18..=0x1F => LOW[usize::from(byte - 0x18)],
        0x80..=0xA0 => HIGH[usize::from(byte - 0x80)],
        0xAD => return None,
        0x7F => return None,
        _ => u16::from(byte),
    };
    if code == 0 && byte != 0 {
        return None;
    }
    char::from_u32(u32::from(code)).filter(|&c| c != '\0')
}

/// Decode a PDF object holding text (string, or name as a fallback).
pub fn object_text(object: &Object) -> Option<String> {
    match object {
        Object::String(bytes, _) => Some(decode_text(bytes)),
        Object::Name(name) => Some(String::from_utf8_lossy(name).into_owned()),
        _ => None,
    }
}

/// Convert an RFC 3339 timestamp to a PDF date string (`D:YYYYMMDDHHmmSS+HH'mm'`).
///
/// Lenient: also accepts a bare date (`2026-10-08`) or a timestamp without offset (UTC).
pub fn rfc3339_to_pdf_date(value: &str) -> Option<String> {
    parse_rfc3339(value.trim()).map(|date| format_pdf_date(&date))
}

/// Convert a PDF date string to RFC 3339 (`Z` for UTC). Lenient about missing parts.
pub fn pdf_date_to_rfc3339(value: &str) -> Option<String> {
    parse_pdf_date(value).map(|date| date.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// The current local time as a PDF date string.
pub fn pdf_date_now() -> String {
    format_pdf_date(&Local::now().fixed_offset())
}

fn parse_rfc3339(value: &str) -> Option<DateTime<FixedOffset>> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Some(date);
    }
    let utc = FixedOffset::east_opt(0)?;
    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return utc.from_local_datetime(&naive).single();
    }
    let naive = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)?;
    utc.from_local_datetime(&naive).single()
}

fn format_pdf_date(date: &DateTime<FixedOffset>) -> String {
    let offset = date.offset().local_minus_utc();
    let sign = if offset < 0 { '-' } else { '+' };
    let minutes = offset.unsigned_abs() / 60;
    format!(
        "D:{}{sign}{:02}'{:02}'",
        date.format("%Y%m%d%H%M%S"),
        minutes / 60,
        minutes % 60
    )
}

/// Parse `D:YYYYMMDDHHmmSSOHH'mm'` where everything after the year is optional.
fn parse_pdf_date(value: &str) -> Option<DateTime<FixedOffset>> {
    let text = value.trim();
    let text = text.strip_prefix("D:").unwrap_or(text);
    let bytes = text.as_bytes();
    let mut pos = 0;
    let mut field = |len: usize, default: u32| -> Option<u32> {
        let digits = bytes
            .get(pos..pos + len)
            .filter(|d| d.iter().all(u8::is_ascii_digit));
        match digits {
            Some(digits) => {
                pos += len;
                std::str::from_utf8(digits).ok()?.parse().ok()
            }
            None => Some(default),
        }
    };
    let year = field(4, u32::MAX)?;
    if year == u32::MAX {
        return None;
    }
    let month = field(2, 1)?.clamp(1, 12);
    let day = field(2, 1)?.clamp(1, 31);
    let hour = field(2, 0)?.min(23);
    let minute = field(2, 0)?.min(59);
    let second = field(2, 0)?.min(59);
    let offset = parse_offset(bytes.get(pos..).unwrap_or_default())?;
    let date = NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, month, day)
        .or_else(|| NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, month, 28))?;
    let naive = date.and_hms_opt(hour, minute, second)?;
    offset.from_local_datetime(&naive).single()
}

fn parse_offset(rest: &[u8]) -> Option<FixedOffset> {
    let sign = match rest.first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return FixedOffset::east_opt(0),
    };
    let digits: Vec<u32> = rest[1..]
        .split(|b| !b.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| std::str::from_utf8(part).ok()?.parse().ok())
        .collect();
    let hours = digits.first().copied().unwrap_or(0).min(23);
    let minutes = digits.get(1).copied().unwrap_or(0).min(59);
    let seconds = i32::try_from(hours * 3600 + minutes * 60).ok()?;
    FixedOffset::east_opt(sign * seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(object: &Object) -> &[u8] {
        match object {
            Object::String(bytes, _) => bytes,
            _ => panic!("not a string"),
        }
    }

    #[test]
    fn ascii_is_literal() {
        let object = text_string("Hello (world)");
        assert!(matches!(object, Object::String(_, StringFormat::Literal)));
        assert_eq!(bytes(&object), b"Hello (world)");
    }

    #[test]
    fn unicode_is_utf16_with_bom() {
        let object = text_string("Grüße 你好 😀");
        assert!(matches!(
            object,
            Object::String(_, StringFormat::Hexadecimal)
        ));
        assert_eq!(&bytes(&object)[..2], &[0xFE, 0xFF]);
        assert_eq!(decode_text(bytes(&object)), "Grüße 你好 😀");
    }

    #[test]
    fn decodes_all_encodings() {
        assert_eq!(decode_text(b"plain"), "plain");
        assert_eq!(
            decode_text(&[0x80, 0x93, 0xA0, 0xE9]),
            "\u{2022}\u{FB01}\u{20AC}é"
        );
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, 0xE4, 0xBD, 0xA0]), "你");
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x60, 0x4F]), "你");
        // Language escape sequence ESC "en" ESC is dropped.
        assert_eq!(
            decode_text(&[0xFE, 0xFF, 0x00, 0x1B, 0x00, b'e', 0x00, b'n', 0x00, 0x1B, 0x00, b'A']),
            "A"
        );
    }

    #[test]
    fn rfc3339_round_trip() {
        let pdf = rfc3339_to_pdf_date("2026-10-08T14:30:05+02:00").unwrap();
        assert_eq!(pdf, "D:20261008143005+02'00'");
        assert_eq!(
            pdf_date_to_rfc3339(&pdf).unwrap(),
            "2026-10-08T14:30:05+02:00"
        );
        let utc = rfc3339_to_pdf_date("2026-10-08T14:30:05Z").unwrap();
        assert_eq!(utc, "D:20261008143005+00'00'");
        assert_eq!(pdf_date_to_rfc3339(&utc).unwrap(), "2026-10-08T14:30:05Z");
        assert_eq!(
            rfc3339_to_pdf_date("2026-01-02").unwrap(),
            "D:20260102000000+00'00'"
        );
        assert_eq!(
            rfc3339_to_pdf_date("2026-01-02T03:04:05").unwrap(),
            "D:20260102030405+00'00'"
        );
        assert!(rfc3339_to_pdf_date("yesterday").is_none());
    }

    #[test]
    fn lenient_pdf_dates() {
        assert_eq!(
            pdf_date_to_rfc3339("D:2026").unwrap(),
            "2026-01-01T00:00:00Z"
        );
        assert_eq!(
            pdf_date_to_rfc3339("D:202610081430Z").unwrap(),
            "2026-10-08T14:30:00Z"
        );
        assert_eq!(
            pdf_date_to_rfc3339("20261008143000-05'30").unwrap(),
            "2026-10-08T14:30:00-05:30"
        );
        assert_eq!(
            pdf_date_to_rfc3339("D:20261008143000+08'00'").unwrap(),
            "2026-10-08T14:30:00+08:00"
        );
        assert_eq!(
            pdf_date_to_rfc3339("D:20260231").unwrap(),
            "2026-02-28T00:00:00Z"
        );
        assert!(pdf_date_to_rfc3339("D:").is_none());
        assert!(pdf_date_to_rfc3339("garbage").is_none());
    }

    #[test]
    fn now_is_parseable() {
        assert!(pdf_date_to_rfc3339(&pdf_date_now()).is_some());
    }
}
