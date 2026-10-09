//! Helpers for editing page content without rewriting existing streams: new content is added
//! as extra streams around the original ones, and resources are copied into the page.

use lopdf::{Dictionary, Object, ObjectId, Stream};

use crate::error::{PdfError, Result};
use crate::load::Revision;
use crate::objects::ObjectSource;
use crate::pages::{inherited, page_box, page_rotation, PageRef};

/// An affine matrix `[a b c d e f]` in PDF (row vector) convention.
pub type Matrix = [f64; 6];

pub const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` followed by `b` (a point is transformed by `a` first).
pub fn mul(a: Matrix, b: Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

pub fn invert(m: Matrix) -> Matrix {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return IDENTITY;
    }
    let a = m[3] / det;
    let b = -m[1] / det;
    let c = -m[2] / det;
    let d = m[0] / det;
    [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)]
}

pub fn apply(m: Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

pub fn translate(x: f64, y: f64) -> Matrix {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

/// Counter-clockwise rotation by `degrees`.
pub fn rotate(degrees: f64) -> Matrix {
    let (s, c) = degrees.to_radians().sin_cos();
    [c, s, -s, c, 0.0, 0.0]
}

/// The page as the user sees it: size of the displayed page and the matrix from displayed
/// coordinates (origin bottom-left, honouring `/Rotate` and the crop box) to user space.
pub struct View {
    pub width: f64,
    pub height: f64,
    pub to_user: Matrix,
}

pub fn view(src: &impl ObjectSource, page: &PageRef) -> View {
    let [x1, y1, x2, y2] = page_box(src, page);
    let (w, h) = (x2 - x1, y2 - y1);
    match page_rotation(src, page) {
        90 => View { width: h, height: w, to_user: [0.0, 1.0, -1.0, 0.0, x2, y1] },
        180 => View { width: w, height: h, to_user: [-1.0, 0.0, 0.0, -1.0, x2, y2] },
        270 => View { width: h, height: w, to_user: [0.0, -1.0, 1.0, 0.0, x1, y2] },
        _ => View { width: w, height: h, to_user: [1.0, 0.0, 0.0, 1.0, x1, y1] },
    }
}

/// The page's content streams as a list of references (inline arrays are flattened).
fn content_entries(rev: &Revision, page_id: ObjectId) -> Vec<Object> {
    let Some(dict) = rev.dict(page_id) else {
        return Vec::new();
    };
    match dict.get(b"Contents") {
        Ok(Object::Reference(id)) => match rev.object(*id) {
            Some(Object::Array(items)) => items.clone(),
            Some(_) => vec![Object::Reference(*id)],
            None => Vec::new(),
        },
        Ok(Object::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// Rewrite `/Contents` as `[under + "q" + cm, …original…, "Q" + over]`.
///
/// The original content is isolated in its own graphics state, so whatever state it leaves
/// behind cannot affect `over`, and `transform` (when given) applies to it alone.
pub fn wrap_contents(
    rev: &mut Revision,
    page_id: ObjectId,
    under: &[u8],
    transform: Option<Matrix>,
    over: &[u8],
) -> Result<()> {
    let original = content_entries(rev, page_id);
    let mut head = under.to_vec();
    head.extend_from_slice(b"q\n");
    if let Some(m) = transform {
        let nums: Vec<String> = m.iter().map(|v| crate::content::fmt_num(*v)).collect();
        head.extend_from_slice(format!("{} cm\n", nums.join(" ")).as_bytes());
    }
    let mut tail = b"\nQ\n".to_vec();
    tail.extend_from_slice(over);
    let head_id = rev.add(Stream::new(Dictionary::new(), head));
    let tail_id = rev.add(Stream::new(Dictionary::new(), tail));
    let mut contents = vec![Object::Reference(head_id)];
    contents.extend(original);
    contents.push(Object::Reference(tail_id));
    rev.dict_mut(page_id)?.set("Contents", contents);
    Ok(())
}

/// Add `value` to the page resource category `category` (e.g. `XObject`) under a fresh name
/// starting with `prefix`, copying the page's (possibly inherited or shared) resources into the
/// page first. Returns the name used.
pub fn add_resource(
    rev: &mut Revision,
    page: &PageRef,
    category: &str,
    prefix: &str,
    value: Object,
) -> Result<String> {
    let mut resources = inherited(&*rev, page, b"Resources")
        .and_then(|r| rev.resolve(r).as_dict().ok())
        .cloned()
        .unwrap_or_default();
    let mut entries = resources
        .get(category.as_bytes())
        .ok()
        .and_then(|r| rev.resolve(r).as_dict().ok())
        .cloned()
        .unwrap_or_default();
    let name = (0..)
        .map(|n| format!("{prefix}{n}"))
        .find(|n| !entries.has(n.as_bytes()))
        .ok_or_else(|| PdfError::Write("no free resource name".into()))?;
    entries.set(name.as_bytes(), value);
    resources.set(category.as_bytes(), entries);
    rev.dict_mut(page.id)?.set("Resources", resources);
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Matrix, b: Matrix) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
    }

    #[test]
    fn matrix_inverse_and_product() {
        let m = mul(rotate(30.0), translate(5.0, -2.0));
        assert!(close(mul(m, invert(m)), IDENTITY));
        let (x, y) = apply(translate(3.0, 4.0), 1.0, 1.0);
        assert_eq!((x, y), (4.0, 5.0));
        let (x, y) = apply(rotate(90.0), 1.0, 0.0);
        assert!((x).abs() < 1e-9 && (y - 1.0).abs() < 1e-9);
    }
}
