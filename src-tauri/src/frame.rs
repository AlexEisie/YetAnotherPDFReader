//! Binary request framing.
//!
//! Commands that move large binary payloads (PDF bytes, image pixels) receive a raw IPC body
//! instead of JSON, which avoids base64 inflation and extra copies. Layout (little endian):
//!
//! ```text
//! u32 meta_len | u32 blob_count | u64 blob_len × blob_count | meta (UTF-8 JSON) | blobs...
//! ```
//!
//! The matching encoder lives in `src/lib/ipc.ts` (`encodeFrame`).

use crate::error::{AppError, AppResult};
use serde::de::DeserializeOwned;

pub struct Frame<'a> {
    pub meta: &'a [u8],
    pub blobs: Vec<&'a [u8]>,
}

impl<'a> Frame<'a> {
    pub fn parse(body: &'a [u8]) -> AppResult<Self> {
        let bad = |msg: &str| AppError::InvalidArgument(format!("malformed request frame: {msg}"));
        let read_u32 = |at: usize| -> AppResult<u32> {
            body.get(at..at + 4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .ok_or_else(|| bad("truncated header"))
        };
        let meta_len = read_u32(0)? as usize;
        let blob_count = read_u32(4)? as usize;
        if blob_count > 4096 {
            return Err(bad("too many blobs"));
        }
        let mut offset = 8usize;
        let mut lengths = Vec::with_capacity(blob_count);
        for _ in 0..blob_count {
            let raw = body.get(offset..offset + 8).ok_or_else(|| bad("truncated blob table"))?;
            let mut le = [0u8; 8];
            le.copy_from_slice(raw);
            lengths.push(usize::try_from(u64::from_le_bytes(le)).map_err(|_| bad("blob too large"))?);
            offset += 8;
        }
        let meta = body.get(offset..offset + meta_len).ok_or_else(|| bad("truncated metadata"))?;
        offset += meta_len;
        let mut blobs = Vec::with_capacity(blob_count);
        for len in lengths {
            let end = offset.checked_add(len).ok_or_else(|| bad("blob length overflow"))?;
            blobs.push(body.get(offset..end).ok_or_else(|| bad("truncated blob"))?);
            offset = end;
        }
        if offset != body.len() {
            return Err(bad("trailing bytes"));
        }
        Ok(Self { meta, blobs })
    }

    pub fn meta<T: DeserializeOwned>(&self) -> AppResult<T> {
        Ok(serde_json::from_slice(self.meta)?)
    }

    /// The first blob is, by convention, the PDF document.
    pub fn document(&self) -> AppResult<&'a [u8]> {
        self.blobs
            .first()
            .copied()
            .filter(|b| !b.is_empty())
            .ok_or_else(|| AppError::InvalidArgument("request contains no document".into()))
    }
}

pub fn raw_body<'a>(request: &'a tauri::ipc::Request<'_>) -> AppResult<&'a [u8]> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        tauri::ipc::InvokeBody::Json(_) => Err(AppError::InvalidArgument("expected a binary request body".into())),
    }
}

#[cfg(test)]
pub fn encode(meta: &[u8], blobs: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&(blobs.len() as u32).to_le_bytes());
    for b in blobs {
        out.extend_from_slice(&(b.len() as u64).to_le_bytes());
    }
    out.extend_from_slice(meta);
    for b in blobs {
        out.extend_from_slice(b);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let body = encode(br#"{"a":1}"#, &[b"%PDF-1.7", b"", b"xyz"]);
        let frame = Frame::parse(&body).unwrap();
        assert_eq!(frame.meta, br#"{"a":1}"#);
        assert_eq!(frame.blobs, vec![&b"%PDF-1.7"[..], &b""[..], &b"xyz"[..]]);
        assert_eq!(frame.document().unwrap(), b"%PDF-1.7");
        let v: serde_json::Value = frame.meta().unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn rejects_truncated_input() {
        let body = encode(b"{}", &[b"abc"]);
        assert!(Frame::parse(&body[..body.len() - 1]).is_err());
        assert!(Frame::parse(&body[..5]).is_err());
        let mut extra = body.clone();
        extra.push(0);
        assert!(Frame::parse(&extra).is_err());
    }
}
