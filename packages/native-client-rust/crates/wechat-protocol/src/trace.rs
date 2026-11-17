//! Protocol chain tracing for grey-scale debugging.
//!
//! Disabled by default. Set `WX_PROTOCOL_TRACE=1` to emit one stderr line per
//! protocol stage (pack header, MMTLS exchange, response envelope, decode).
//! Lines carry only lengths, codes and hex heads of already-encrypted bytes —
//! never cookie, key material, or ticket/username contents — so traces can be
//! pasted into issue reports without leaking account material.
#![allow(dead_code)]
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether chain tracing is enabled (`WX_PROTOCOL_TRACE=1`).
pub fn enabled() -> bool {
    std::env::var("WX_PROTOCOL_TRACE").ok().as_deref() == Some("1")
}

/// Emit one trace line. `fields` are key/value pairs appended after the stage.
pub fn stage(name: &str, fields: &[(&str, String)]) {
    if !enabled() {
        return;
    }
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let body = fields
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!("wx-trace {millis} {name} {body}");
}

/// Hex head of at most `max` bytes, prefixed with the total length.
pub fn head(bytes: &[u8], max: usize) -> String {
    let head = bytes
        .iter()
        .take(max)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("{}B:{}", bytes.len(), head)
}

/// Compact top-level protobuf shape: field number, wire kind, and size or
/// varint value. Messages are described without their contents.
pub fn shape(bytes: &[u8]) -> String {
    match crate::protobuf::decode(bytes) {
        Ok(fields) => fields
            .iter()
            .map(|f| match &f.value {
                crate::protobuf::Value::Varint(v) => format!("f{}=v({v})", f.number),
                crate::protobuf::Value::Fixed64(v) => format!("f{}=f64({}B)", f.number, v.len()),
                crate::protobuf::Value::Fixed32(v) => format!("f{}=f32({}B)", f.number, v.len()),
                crate::protobuf::Value::Bytes(b) => format!("f{}=b({}B)", f.number, b.len()),
            })
            .collect::<Vec<_>>()
            .join(" "),
        Err(_) => format!("undecodable({}B)", bytes.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_reports_length_and_hex_prefix() {
        assert_eq!(head(&[0xde, 0xad, 0xbe, 0xef], 4), "4B:deadbeef");
        assert_eq!(head(&[1, 2, 3], 2), "3B:0102");
        assert_eq!(head(&[], 8), "0B:");
    }

    #[test]
    fn shape_describes_fields_without_contents() {
        let bytes = crate::protobuf::message(&[
            crate::protobuf::bytes(1, &[7; 38]),
            crate::protobuf::uint(2, 1),
            crate::protobuf::uint(3, 1),
        ])
        .unwrap();
        assert_eq!(shape(&bytes), "f1=b(38B) f2=v(1) f3=v(1)");
        assert_eq!(shape(&[0xff]), "undecodable(1B)");
    }
}
