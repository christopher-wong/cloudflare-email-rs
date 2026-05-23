//! Generic SQLite-table dump / load helpers used by both DOs to produce
//! and consume backup bundles.
//!
//! A "dump" is a JSON array of rows. BLOB-typed columns are tagged as
//! `{"__b64": "..."}` so the bundle is portable JSON text; the load side
//! detects the marker and decodes back to raw bytes before binding into
//! a prepared INSERT.
//!
//! ## Why the wrapper type
//!
//! `serde_json::Value`'s deserialize visitor in serde_json 1.0.150 does
//! NOT implement `visit_bytes`. workers-rs's SQL adapter, however, can
//! and does deliver BLOB columns to deserializers via `visit_bytes` —
//! at least for some byte payloads (empirically: depends on length /
//! content / underlying JS representation). When that happens against
//! a bare `Value`, the row dies with the opaque "invalid type: byte
//! array, expected any valid JSON value" error.
//!
//! `BlobAwareValue` is a thin wrapper whose visitor implements
//! `visit_bytes` / `visit_byte_buf` (producing a `Value::Array` of u8
//! numbers, which `normalize_blob` then base64-tags), and delegates
//! everything else to the standard JSON-value shape. We use it as the
//! deserialization target for every SQL row, so a future schema gaining
//! a BLOB column won't silently break the backup endpoint again.

use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use std::fmt;
use worker::{Result, SqlStorage, SqlStorageValue};

/// Wrapper around `serde_json::Value` whose Deserialize impl handles
/// `visit_bytes` and `visit_byte_buf`. See the module docs for why.
struct BlobAwareValue(serde_json::Value);

impl<'de> serde::Deserialize<'de> for BlobAwareValue {
    fn deserialize<D>(d: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = BlobAwareValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                write!(f, "any JSON value, or a byte array")
            }
            // ---- bytes (the whole point of this wrapper) ----
            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> std::result::Result<Self::Value, E> {
                let arr = v
                    .iter()
                    .map(|&b| serde_json::Value::Number(serde_json::Number::from(b)))
                    .collect();
                Ok(BlobAwareValue(serde_json::Value::Array(arr)))
            }
            fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> std::result::Result<Self::Value, E> {
                self.visit_bytes(&v)
            }
            // ---- all the standard JSON-shaped inputs ----
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::Bool(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::Number(serde_json::Number::from(v))))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::Number(serde_json::Number::from(v))))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                let n = serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null);
                Ok(BlobAwareValue(n))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::String(v.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::String(v)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::Null))
            }
            fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(BlobAwareValue(serde_json::Value::Null))
            }
            fn visit_some<D>(self, d: D) -> std::result::Result<Self::Value, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                BlobAwareValue::deserialize(d)
            }
            fn visit_seq<A>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut arr = Vec::new();
                while let Some(elem) = seq.next_element::<BlobAwareValue>()? {
                    arr.push(elem.0);
                }
                Ok(BlobAwareValue(serde_json::Value::Array(arr)))
            }
            fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut obj = serde_json::Map::new();
                while let Some((k, v)) = map.next_entry::<String, BlobAwareValue>()? {
                    obj.insert(k, v.0);
                }
                Ok(BlobAwareValue(serde_json::Value::Object(obj)))
            }
        }
        d.deserialize_any(V)
    }
}

/// Tag a Vec<u8>-shaped JSON value as `{"__b64": "..."}` so it survives
/// the round-trip through pure JSON. Anything not array-shaped passes
/// through unchanged.
pub fn normalize_blob(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Array(arr) => {
            let bytes: Vec<u8> = arr
                .into_iter()
                .filter_map(|n| n.as_u64().map(|x| x as u8))
                .collect();
            serde_json::json!({
                "__b64": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
            })
        }
        other => other,
    }
}

pub fn decode_blob(v: &serde_json::Value) -> Option<Vec<u8>> {
    let b64 = v.get("__b64")?.as_str()?;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(b64)
        .ok()
}

/// Run `query` and turn each row into a JSON object. Safe for tables
/// with or without BLOB columns — bytes arrive via `BlobAwareValue`'s
/// `visit_bytes` and end up as JSON arrays of u8 numbers, which the
/// caller can `normalize_blob` afterwards if it wants the bundle to
/// stay portable text.
fn dump_rows(sql: &SqlStorage, query: &str) -> Result<Vec<serde_json::Map<String, serde_json::Value>>> {
    let raw: Vec<HashMap<String, BlobAwareValue>> = sql.exec(query, None)?.to_array()?;
    Ok(raw
        .into_iter()
        .map(|m| m.into_iter().map(|(k, BlobAwareValue(v))| (k, v)).collect())
        .collect())
}

/// SELECT every row; each row becomes a JSON object. Works for any
/// table — BLOB columns come out as JSON arrays of u8 numbers (use
/// `dump_blob_table` instead if you want them base64-tagged for a
/// portable backup bundle).
pub fn dump_table(sql: &SqlStorage, query: &str) -> Result<Vec<serde_json::Value>> {
    Ok(dump_rows(sql, query)?
        .into_iter()
        .map(serde_json::Value::Object)
        .collect())
}

/// As `dump_table` but base64-tag values for the listed BLOB columns so
/// the JSON output is portable text.
pub fn dump_blob_table(
    sql: &SqlStorage,
    query: &str,
    blob_cols: &[&str],
) -> Result<Vec<serde_json::Value>> {
    let rows = dump_rows(sql, query)?;
    let mut out = Vec::with_capacity(rows.len());
    for mut m in rows {
        for &col in blob_cols {
            if let Some(v) = m.get(col).cloned() {
                m.insert(col.to_string(), normalize_blob(v));
            }
        }
        out.push(serde_json::Value::Object(m));
    }
    Ok(out)
}

/// INSERT OR REPLACE each row from `bundle[table]` into the table. Missing
/// table key is a no-op (older backups won't have newer tables).
pub fn load_table(
    sql: &SqlStorage,
    bundle: &serde_json::Value,
    table: &str,
    cols: &[&str],
    blob_cols: &[&str],
) -> Result<()> {
    let rows = match bundle.get(table).and_then(|v| v.as_array()) {
        Some(r) => r,
        None => return Ok(()),
    };
    if rows.is_empty() {
        return Ok(());
    }
    let placeholders = std::iter::repeat("?")
        .take(cols.len())
        .collect::<Vec<_>>()
        .join(", ");
    let col_list = cols.join(", ");
    let sql_text = format!(
        "INSERT OR REPLACE INTO {table} ({col_list}) VALUES ({placeholders})"
    );
    for row in rows {
        let mut params: Vec<SqlStorageValue> = Vec::with_capacity(cols.len());
        for &c in cols {
            let v = row.get(c).cloned().unwrap_or(serde_json::Value::Null);
            if blob_cols.contains(&c) {
                if let Some(bytes) = decode_blob(&v) {
                    params.push(bytes.into());
                    continue;
                }
            }
            params.push(json_to_sql(v));
        }
        sql.exec(&sql_text, Some(params))?;
    }
    Ok(())
}

pub fn json_to_sql(v: serde_json::Value) -> SqlStorageValue {
    match v {
        serde_json::Value::Null => SqlStorageValue::Null,
        serde_json::Value::Bool(b) => (b as i64).into(),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.into()
            } else if let Some(f) = n.as_f64() {
                f.into()
            } else {
                0i64.into()
            }
        }
        serde_json::Value::String(s) => s.into(),
        other => other.to_string().into(),
    }
}
