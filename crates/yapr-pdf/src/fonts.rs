//! Fonts used by generated appearance streams.
//!
//! * WinAnsi-encodable text uses the (non-embedded) standard 14 fonts Helvetica and
//!   Helvetica-Bold with `/WinAnsiEncoding`; their AFM widths are included for measuring.
//! * Everything else uses a non-embedded Adobe CJK font (Type0 + predefined UCS-2 CMap), text
//!   written as UTF-16BE code units (BMP only).

use lopdf::{dictionary, Dictionary, Object, StringFormat};

/// Font families an appearance stream can reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FontKey {
    Helvetica,
    HelveticaBold,
    Cjk(CjkCollection),
}

impl FontKey {
    /// Resource name used inside appearance streams.
    pub fn resource_name(self) -> &'static str {
        match self {
            FontKey::Helvetica => "Helv",
            FontKey::HelveticaBold => "HeBo",
            FontKey::Cjk(CjkCollection::Gb1) => "CJKsc",
            FontKey::Cjk(CjkCollection::Cns1) => "CJKtc",
            FontKey::Cjk(CjkCollection::Japan1) => "CJKja",
            FontKey::Cjk(CjkCollection::Korea1) => "CJKko",
        }
    }
}

/// Adobe CJK character collections with their standard non-embedded fonts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum CjkCollection {
    /// Simplified Chinese (`STSong-Light`).
    #[default]
    Gb1,
    /// Traditional Chinese (`MSung-Light`).
    Cns1,
    /// Japanese (`HeiseiKakuGo-W5`).
    Japan1,
    /// Korean (`HYGoThic-Medium`).
    Korea1,
}

struct CjkFontInfo {
    base_font: &'static str,
    encoding: &'static str,
    ordering: &'static str,
    supplement: i64,
    flags: i64,
    bbox: [i64; 4],
    ascent: i64,
    descent: i64,
    cap_height: i64,
    stem_v: i64,
}

impl CjkCollection {
    /// Collection from a language hint (`zh-CN`, `zh-TW`, `ja`, `ko`; default simplified Chinese).
    pub fn from_hint(hint: Option<&str>) -> Self {
        let hint = hint.unwrap_or_default().trim().to_ascii_lowercase();
        if hint.starts_with("ja") {
            CjkCollection::Japan1
        } else if hint.starts_with("ko") {
            CjkCollection::Korea1
        } else if ["zh-tw", "zh-hk", "zh-mo", "zh-hant"]
            .iter()
            .any(|p| hint.starts_with(p))
        {
            CjkCollection::Cns1
        } else {
            CjkCollection::Gb1
        }
    }

    /// The collection to use for `text`: kana forces Japanese, Hangul forces Korean.
    pub fn for_text(text: &str, hint: CjkCollection) -> Self {
        for c in text.chars() {
            if is_kana(c) {
                return CjkCollection::Japan1;
            }
            if is_hangul(c) {
                return CjkCollection::Korea1;
            }
        }
        hint
    }

    fn info(self) -> CjkFontInfo {
        match self {
            CjkCollection::Gb1 => CjkFontInfo {
                base_font: "STSong-Light",
                encoding: "UniGB-UCS2-H",
                ordering: "GB1",
                supplement: 2,
                flags: 6,
                bbox: [-25, -254, 1000, 880],
                ascent: 880,
                descent: -120,
                cap_height: 880,
                stem_v: 93,
            },
            CjkCollection::Cns1 => CjkFontInfo {
                base_font: "MSung-Light",
                encoding: "UniCNS-UCS2-H",
                ordering: "CNS1",
                supplement: 0,
                flags: 6,
                bbox: [-160, -249, 1015, 888],
                ascent: 880,
                descent: -120,
                cap_height: 880,
                stem_v: 93,
            },
            CjkCollection::Japan1 => CjkFontInfo {
                base_font: "HeiseiKakuGo-W5",
                encoding: "UniJIS-UCS2-H",
                ordering: "Japan1",
                supplement: 2,
                flags: 4,
                bbox: [-92, -250, 1010, 922],
                ascent: 752,
                descent: -221,
                cap_height: 737,
                stem_v: 114,
            },
            CjkCollection::Korea1 => CjkFontInfo {
                base_font: "HYGoThic-Medium",
                encoding: "UniKS-UCS2-H",
                ordering: "Korea1",
                supplement: 1,
                flags: 4,
                bbox: [-6, -145, 1003, 880],
                ascent: 880,
                descent: -120,
                cap_height: 880,
                stem_v: 93,
            },
        }
    }
}

/// The dictionaries that make up a font. For CJK fonts `descendant` holds the CIDFont and its
/// font descriptor; the caller stores them as indirect objects and links them through
/// `/DescendantFonts` and `/FontDescriptor`.
pub struct FontObjects {
    pub font: Dictionary,
    pub descendant: Option<(Dictionary, Dictionary)>,
}

/// Build the dictionaries for `key`.
pub fn font_objects(key: FontKey) -> FontObjects {
    let simple = |base: &str| {
        dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => base.to_string(),
            "Encoding" => "WinAnsiEncoding",
        }
    };
    match key {
        FontKey::Helvetica => FontObjects {
            font: simple("Helvetica"),
            descendant: None,
        },
        FontKey::HelveticaBold => FontObjects {
            font: simple("Helvetica-Bold"),
            descendant: None,
        },
        FontKey::Cjk(collection) => cjk_font_objects(collection),
    }
}

fn cjk_font_objects(collection: CjkCollection) -> FontObjects {
    let info = collection.info();
    let descriptor = dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => info.base_font,
        "Flags" => info.flags,
        "FontBBox" => info.bbox.iter().map(|&v| Object::Integer(v)).collect::<Vec<_>>(),
        "ItalicAngle" => 0,
        "Ascent" => info.ascent,
        "Descent" => info.descent,
        "CapHeight" => info.cap_height,
        "StemV" => info.stem_v,
    };
    let cid_font = dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType0",
        "BaseFont" => info.base_font,
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::String(b"Adobe".to_vec(), StringFormat::Literal),
            "Ordering" => Object::String(info.ordering.as_bytes().to_vec(), StringFormat::Literal),
            "Supplement" => info.supplement,
        },
        "DW" => 1000,
    };
    let font = dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => info.base_font,
        "Encoding" => info.encoding,
    };
    FontObjects {
        font,
        descendant: Some((cid_font, descriptor)),
    }
}

/// Map a character to its WinAnsiEncoding code (printable characters only).
pub fn winansi_code(c: char) -> Option<u8> {
    const HIGH: [(char, u8); 27] = [
        ('\u{20AC}', 0x80),
        ('\u{201A}', 0x82),
        ('\u{0192}', 0x83),
        ('\u{201E}', 0x84),
        ('\u{2026}', 0x85),
        ('\u{2020}', 0x86),
        ('\u{2021}', 0x87),
        ('\u{02C6}', 0x88),
        ('\u{2030}', 0x89),
        ('\u{0160}', 0x8A),
        ('\u{2039}', 0x8B),
        ('\u{0152}', 0x8C),
        ('\u{017D}', 0x8E),
        ('\u{2018}', 0x91),
        ('\u{2019}', 0x92),
        ('\u{201C}', 0x93),
        ('\u{201D}', 0x94),
        ('\u{2022}', 0x95),
        ('\u{2013}', 0x96),
        ('\u{2014}', 0x97),
        ('\u{02DC}', 0x98),
        ('\u{2122}', 0x99),
        ('\u{0161}', 0x9A),
        ('\u{203A}', 0x9B),
        ('\u{0153}', 0x9C),
        ('\u{017E}', 0x9E),
        ('\u{0178}', 0x9F),
    ];
    match u32::from(c) {
        code @ (0x20..=0x7E | 0xA0..=0xFF) => u8::try_from(code).ok(),
        _ => HIGH.iter().find(|(ch, _)| *ch == c).map(|&(_, code)| code),
    }
}

/// Helvetica glyph widths (1/1000 em) indexed by WinAnsi code.
const HELVETICA_WIDTHS: [u16; 256] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, //
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, //
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, //
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, //
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, //
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350, //
    556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, //
    350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667, //
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, //
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, //
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, //
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, //
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, //
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500, //
];

/// Helvetica-Bold glyph widths (1/1000 em) indexed by WinAnsi code.
const HELVETICA_BOLD_WIDTHS: [u16; 256] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, //
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, //
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, //
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, //
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, //
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, //
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350, //
    556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350, //
    350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667, //
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, //
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, //
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, //
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, //
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, //
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556, //
];

/// True for CJK ideographs, kana, Hangul and full-width forms. Line breaks are allowed between
/// any two such characters.
pub fn is_wide(c: char) -> bool {
    matches!(u32::from(c),
        0x1100..=0x11FF
        | 0x2E80..=0x303F
        | 0x3040..=0x30FF
        | 0x3100..=0x312F
        | 0x3130..=0x318F
        | 0x31A0..=0x31FF
        | 0x3200..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA960..=0xA97F
        | 0xAC00..=0xD7FF
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6)
}

fn is_kana(c: char) -> bool {
    matches!(u32::from(c), 0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F)
}

fn is_hangul(c: char) -> bool {
    matches!(u32::from(c), 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7AF)
}

/// Advance width in 1/1000 em of every character drawn with a CJK font.
///
/// The CID fonts declare only `/DW 1000` (no `/W`, since CIDs differ per collection), so every
/// glyph advances a full em in every viewer; measuring with the same value keeps wrapping and
/// centring consistent with what is rendered. Only characters that are not WinAnsi-encodable
/// reach the CJK font, and in the Adobe collections those (ideographs, kana, Hangul, Greek,
/// Cyrillic, symbols) are full-width glyphs anyway.
pub const CJK_ADVANCE: f64 = 1000.0;

/// A run of text that is drawn with a single font.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub font: FontKey,
    pub text: String,
}

impl Run {
    /// The encoded string bytes for the run's font.
    pub fn encode(&self) -> Vec<u8> {
        encode(&self.text, self.font)
    }
}

/// Replace characters no font can show (non-BMP, controls) with substitutes.
pub fn sanitize_char(c: char) -> char {
    match c {
        '\t' => ' ',
        c if u32::from(c) > 0xFFFF => '?',
        c if c.is_control() => ' ',
        c => c,
    }
}

/// Split `text` into runs: WinAnsi-encodable characters use `latin`, the rest the CJK font.
pub fn split_runs(text: &str, latin: FontKey, cjk: CjkCollection) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for c in text.chars().map(sanitize_char) {
        let font = if winansi_code(c).is_some() {
            latin
        } else {
            FontKey::Cjk(cjk)
        };
        match runs.last_mut() {
            Some(run) if run.font == font => run.text.push(c),
            _ => runs.push(Run {
                font,
                text: c.to_string(),
            }),
        }
    }
    runs
}

/// Width of a single character in 1/1000 em for `font`.
pub fn char_width(c: char, font: FontKey) -> f64 {
    let table = match font {
        FontKey::Helvetica => &HELVETICA_WIDTHS,
        FontKey::HelveticaBold => &HELVETICA_BOLD_WIDTHS,
        FontKey::Cjk(_) => return CJK_ADVANCE,
    };
    winansi_code(c).map_or(500.0, |code| f64::from(table[usize::from(code)]))
}

/// Measures text drawn with a Latin font plus the CJK fallback, as [`split_runs`] draws it.
#[derive(Debug, Clone, Copy)]
pub struct Measure {
    pub latin: FontKey,
    pub cjk: CjkCollection,
    pub size: f64,
}

impl Measure {
    /// Width of `c` in points.
    pub fn char(&self, c: char) -> f64 {
        let c = sanitize_char(c);
        let font = if winansi_code(c).is_some() {
            self.latin
        } else {
            FontKey::Cjk(self.cjk)
        };
        char_width(c, font) * self.size / 1000.0
    }

    /// Width of `text` in points.
    pub fn text(&self, text: &str) -> f64 {
        text.chars().map(|c| self.char(c)).sum()
    }
}

/// Encode `text` for `font`: WinAnsi bytes or UTF-16BE code units.
pub fn encode(text: &str, font: FontKey) -> Vec<u8> {
    match font {
        FontKey::Cjk(_) => text
            .chars()
            .map(sanitize_char)
            .flat_map(|c| ucs2(c).to_be_bytes())
            .collect(),
        _ => text
            .chars()
            .map(|c| winansi_code(c).unwrap_or(b'?'))
            .collect(),
    }
}

fn ucs2(c: char) -> u16 {
    u16::try_from(u32::from(c)).unwrap_or(u16::from(b'?'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winansi_mapping() {
        assert_eq!(winansi_code('A'), Some(0x41));
        assert_eq!(winansi_code('é'), Some(0xE9));
        assert_eq!(winansi_code('€'), Some(0x80));
        assert_eq!(winansi_code('—'), Some(0x97));
        assert_eq!(winansi_code('\n'), None);
        assert_eq!(winansi_code('你'), None);
        assert_eq!(winansi_code('Ж'), None);
    }

    #[test]
    fn measures_helvetica() {
        let measure = |latin| Measure {
            latin,
            cjk: CjkCollection::Gb1,
            size: 10.0,
        };
        // "Hello": H=722 e=556 l=222 l=222 o=556 -> 2278.
        assert!((measure(FontKey::Helvetica).text("Hello") - 22.78).abs() < 1e-9);
        assert!((measure(FontKey::HelveticaBold).text("Hello") - 24.45).abs() < 1e-9);
        // "Hi " = 722 + 222 + 278 units, then two full-width ideographs.
        assert!((measure(FontKey::Helvetica).text("Hi 你好") - (12.22 + 20.0)).abs() < 1e-9);
    }

    #[test]
    fn splits_runs() {
        let runs = split_runs("Hi 你好!", FontKey::Helvetica, CjkCollection::Gb1);
        assert_eq!(runs.len(), 3);
        assert_eq!(
            runs[0],
            Run {
                font: FontKey::Helvetica,
                text: "Hi ".into()
            }
        );
        assert_eq!(runs[1].font, FontKey::Cjk(CjkCollection::Gb1));
        assert_eq!(runs[1].encode(), vec![0x4F, 0x60, 0x59, 0x7D]);
        assert_eq!(runs[2].encode(), b"!".to_vec());
        // Non-BMP characters become '?', which is WinAnsi.
        let runs = split_runs("😀", FontKey::Helvetica, CjkCollection::Gb1);
        assert_eq!(runs[0].text, "?");
    }

    #[test]
    fn picks_collection() {
        assert_eq!(CjkCollection::from_hint(None), CjkCollection::Gb1);
        assert_eq!(CjkCollection::from_hint(Some("zh-TW")), CjkCollection::Cns1);
        assert_eq!(
            CjkCollection::from_hint(Some("ja-JP")),
            CjkCollection::Japan1
        );
        assert_eq!(CjkCollection::from_hint(Some("ko")), CjkCollection::Korea1);
        assert_eq!(
            CjkCollection::for_text("漢字かな", CjkCollection::Gb1),
            CjkCollection::Japan1
        );
        assert_eq!(
            CjkCollection::for_text("한국어", CjkCollection::Cns1),
            CjkCollection::Korea1
        );
        assert_eq!(
            CjkCollection::for_text("汉字", CjkCollection::Cns1),
            CjkCollection::Cns1
        );
    }

    #[test]
    fn cjk_font_dictionaries() {
        let objects = font_objects(FontKey::Cjk(CjkCollection::Japan1));
        assert_eq!(
            objects.font.get(b"Encoding").unwrap().as_name().unwrap(),
            b"UniJIS-UCS2-H"
        );
        let (cid, descriptor) = objects.descendant.unwrap();
        assert_eq!(
            cid.get(b"Subtype").unwrap().as_name().unwrap(),
            b"CIDFontType0"
        );
        assert_eq!(
            descriptor.get(b"FontName").unwrap().as_name().unwrap(),
            b"HeiseiKakuGo-W5"
        );
    }
}
