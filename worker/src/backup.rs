//! Generic SQLite-table dump / load helpers used by both DOs to produce
//! and consume backup bundles.
//!
//! A "dump" is a JSON array of rows. BLOB-typed columns come out of the
//! SQL adapter as `Value::Array` (numbers 0–255); we tag them with a
//! `{"__b64": "..."}` marker so the bundle is portable JSON text. The
//! load side detects the marker and decodes back to raw bytes before
//! binding into a prepared INSERT.

use base64::Engine;
use worker::{Result, SqlStorage, SqlStorageValue};

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

/// SELECT every row in the table; each row becomes a JSON object.
pub fn dump_table(sql: &SqlStorage, query: &str) -> Result<Vec<serde_json::Value>> {
    Ok(sql.exec(query, None)?.to_array()?)
}

/// As `dump_table` but base64-tag values for the listed BLOB columns so
/// the JSON output is portable.
pub fn dump_blob_table(
    sql: &SqlStorage,
    query: &str,
    blob_cols: &[&str],
) -> Result<Vec<serde_json::Value>> {
    let raw: Vec<serde_json::Map<String, serde_json::Value>> =
        sql.exec(query, None)?.to_array()?;
    let mut out = Vec::with_capacity(raw.len());
    for mut m in raw {
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
