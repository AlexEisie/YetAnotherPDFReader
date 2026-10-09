//! Object references in pdf.js notation.
//!
//! pdf.js identifies annotations by `"<num>R"` for generation 0 and `"<num>R<gen>"` otherwise
//! (e.g. `"12R"` = `12 0 R`, `"12R3"` = `12 3 R`). The parser is lenient and also accepts the
//! classic PDF spelling `"12 0 R"`.

use lopdf::ObjectId;

use crate::error::{PdfError, Result};

/// Parse a pdf.js object reference such as `"12R"` or `"12R3"`.
pub fn parse_ref(text: &str) -> Result<ObjectId> {
    parse_inner(text.trim())
        .ok_or_else(|| PdfError::InvalidRequest(format!("invalid object reference {text:?}")))
}

/// Format an object id in pdf.js notation.
pub fn format_ref(id: ObjectId) -> String {
    if id.1 == 0 {
        format!("{}R", id.0)
    } else {
        format!("{}R{}", id.0, id.1)
    }
}

fn parse_inner(text: &str) -> Option<ObjectId> {
    if let Some((num, generation)) = parse_classic(text) {
        return valid(num, generation);
    }
    let (num, generation) = text.split_once(['R', 'r'])?;
    let num: u32 = parse_digits(num)?;
    let generation: u16 = if generation.is_empty() {
        0
    } else {
        parse_digits(generation)?
    };
    valid(num, generation)
}

/// `"12 0 R"` (whitespace separated, as written inside PDF files).
fn parse_classic(text: &str) -> Option<(u32, u16)> {
    let mut parts = text.split_whitespace();
    let num = parse_digits(parts.next()?)?;
    let generation = parse_digits(parts.next()?)?;
    match (parts.next(), parts.next()) {
        (Some("R"), None) => Some((num, generation)),
        _ => None,
    }
}

fn parse_digits<T: std::str::FromStr>(text: &str) -> Option<T> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn valid(num: u32, generation: u16) -> Option<ObjectId> {
    (num > 0).then_some((num, generation))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pdfjs_notation() {
        assert_eq!(parse_ref("12R").unwrap(), (12, 0));
        assert_eq!(parse_ref("12R3").unwrap(), (12, 3));
        assert_eq!(parse_ref(" 7R0 ").unwrap(), (7, 0));
        assert_eq!(parse_ref("12 0 R").unwrap(), (12, 0));
        assert_eq!(parse_ref("12 5 R").unwrap(), (12, 5));
    }

    #[test]
    fn rejects_garbage() {
        for bad in [
            "", "R", "12", "R3", "0R", "-1R", "12R-1", "12RR", "aR", "12 R", "12R70000", "1.5R",
        ] {
            assert!(parse_ref(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn formats_round_trip() {
        assert_eq!(format_ref((12, 0)), "12R");
        assert_eq!(format_ref((12, 3)), "12R3");
        for id in [(1, 0), (99999, 0), (5, 65535)] {
            assert_eq!(parse_ref(&format_ref(id)).unwrap(), id);
        }
    }
}
