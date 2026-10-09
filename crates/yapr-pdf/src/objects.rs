//! Lenient, panic-free helpers for reading and creating lopdf objects.

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::dto::{Rect, Rgb};
use crate::geometry::normalize_rect;
use crate::text::object_text;

static NULL: Object = Object::Null;

/// Maximum length of a reference chain that is followed before giving up.
const MAX_DEREF: usize = 32;

/// Anything that can look up indirect objects by id.
pub trait ObjectSource {
    /// The object stored under `id`, without following references.
    fn raw_object(&self, id: ObjectId) -> Option<&Object>;

    /// Follow references until a direct object is reached (`null` when dangling).
    fn resolve<'a>(&'a self, object: &'a Object) -> &'a Object {
        let mut current = object;
        for _ in 0..MAX_DEREF {
            match current {
                Object::Reference(id) => match self.raw_object(*id) {
                    Some(next) => current = next,
                    None => return &NULL,
                },
                _ => return current,
            }
        }
        &NULL
    }

    /// The resolved, non-null object stored under `id`.
    fn object(&self, id: ObjectId) -> Option<&Object> {
        let object = self.resolve(self.raw_object(id)?);
        (!object.is_null()).then_some(object)
    }

    /// The dictionary (or stream dictionary) stored under `id`.
    fn dict(&self, id: ObjectId) -> Option<&Dictionary> {
        as_dict(self.object(id)?)
    }

    /// The resolved, non-null value of `key`.
    fn get<'a>(&'a self, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
        let object = self.resolve(dict.get(key).ok()?);
        (!object.is_null()).then_some(object)
    }

    fn get_dict<'a>(&'a self, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
        as_dict(self.get(dict, key)?)
    }

    fn get_array<'a>(&'a self, dict: &'a Dictionary, key: &[u8]) -> Option<&'a [Object]> {
        self.get(dict, key)?.as_array().ok().map(Vec::as_slice)
    }

    fn get_name<'a>(&'a self, dict: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
        self.get(dict, key)?.as_name().ok()
    }

    fn get_f64(&self, dict: &Dictionary, key: &[u8]) -> Option<f64> {
        as_f64(self.get(dict, key)?)
    }

    fn get_text(&self, dict: &Dictionary, key: &[u8]) -> Option<String> {
        object_text(self.get(dict, key)?)
    }

    /// An array of numbers (each element may itself be a reference).
    fn numbers(&self, object: &Object) -> Option<Vec<f64>> {
        let array = self.resolve(object).as_array().ok()?;
        array
            .iter()
            .map(|item| as_f64(self.resolve(item)))
            .collect()
    }

    fn get_numbers(&self, dict: &Dictionary, key: &[u8]) -> Option<Vec<f64>> {
        self.numbers(dict.get(key).ok()?)
    }

    /// A normalised rectangle.
    fn get_rect(&self, dict: &Dictionary, key: &[u8]) -> Option<Rect> {
        let values = self.get_numbers(dict, key)?;
        match values.as_slice() {
            [a, b, c, d, ..] => Some(normalize_rect([*a, *b, *c, *d])),
            _ => None,
        }
    }
}

impl ObjectSource for Document {
    fn raw_object(&self, id: ObjectId) -> Option<&Object> {
        self.objects.get(&id)
    }
}

/// The dictionary of a dictionary or stream object.
pub fn as_dict(object: &Object) -> Option<&Dictionary> {
    match object {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// A numeric value (integer or real).
///
/// lopdf stores reals as `f32`; they are widened through their shortest decimal form so that
/// `0.85` reads back as `0.85` rather than `0.8500000238418579`.
pub fn as_f64(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(v) => Some(*v as f64),
        Object::Real(v) if v.is_finite() => Some(v.to_string().parse().unwrap_or(f64::from(*v))),
        _ => None,
    }
}

/// A numeric PDF object: integral values become integers, others reals.
pub fn num(value: f64) -> Object {
    let value = if value.is_finite() { value } else { 0.0 };
    let rounded = (value * 10_000.0).round() / 10_000.0;
    if rounded.fract() == 0.0 && rounded.abs() < 1e15 {
        Object::Integer(rounded as i64)
    } else {
        Object::Real(rounded as f32)
    }
}

/// An array of numbers.
pub fn num_array(values: &[f64]) -> Object {
    Object::Array(values.iter().map(|&v| num(v)).collect())
}

/// A colour array `[r g b]` (components clamped to `0..=1`).
pub fn color_array(color: Rgb) -> Object {
    num_array(&color.map(|v| v.clamp(0.0, 1.0)))
}

/// Read a colour array with 0 (transparent), 1 (gray), 3 (RGB) or 4 (CMYK) components.
pub fn parse_color(values: &[f64]) -> Option<Rgb> {
    let c = |v: f64| v.clamp(0.0, 1.0);
    match values {
        [g] => Some([c(*g); 3]),
        [r, g, b] => Some([c(*r), c(*g), c(*b)]),
        [cy, m, y, k] => Some([
            (1.0 - c(*cy)) * (1.0 - c(*k)),
            (1.0 - c(*m)) * (1.0 - c(*k)),
            (1.0 - c(*y)) * (1.0 - c(*k)),
        ]),
        _ => None,
    }
}

/// A name object.
pub fn name(value: &str) -> Object {
    Object::Name(value.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn numbers_prefer_integers() {
        assert_eq!(num(3.0), Object::Integer(3));
        assert_eq!(num(-0.00001), Object::Integer(0));
        assert_eq!(num(2.5), Object::Real(2.5));
        assert_eq!(num(f64::INFINITY), Object::Integer(0));
    }

    #[test]
    fn resolves_references_leniently() {
        let mut doc = Document::new();
        let target = doc.add_object(Object::Array(vec![
            10.into(),
            Object::Real(20.5),
            0.into(),
            5.into(),
        ]));
        let chain = doc.add_object(Object::Reference(target));
        let dangling = (999, 0);
        let dict = dictionary! { "Rect" => Object::Reference(chain), "Bad" => Object::Reference(dangling) };
        assert_eq!(
            doc.get_rect(&dict, b"Rect").unwrap(),
            [0.0, 5.0, 10.0, 20.5]
        );
        assert!(doc.get(&dict, b"Bad").is_none());
        // A reference cycle terminates.
        let a = doc.new_object_id();
        doc.objects.insert(a, Object::Reference(a));
        assert!(doc.object(a).is_none());
    }

    #[test]
    fn parses_colours() {
        assert_eq!(parse_color(&[0.5]).unwrap(), [0.5; 3]);
        assert_eq!(parse_color(&[1.0, 0.0, 0.0]).unwrap(), [1.0, 0.0, 0.0]);
        assert_eq!(parse_color(&[0.0, 0.0, 0.0, 1.0]).unwrap(), [0.0, 0.0, 0.0]);
        assert!(parse_color(&[]).is_none());
    }
}
