//! Tiny COSE_Key parser built on top of `ciborium`.

#![allow(dead_code)]

use ciborium::value::{Integer, Value};

use super::CoseAlg;

#[derive(Debug, Clone)]
pub enum CosePub {
    Es256 { x: [u8; 32], y: [u8; 32] },
    EdDsa { x: [u8; 32] },
    Rs256 { n: Vec<u8>, e: Vec<u8> },
}

impl CosePub {
    pub fn alg(&self) -> CoseAlg {
        match self {
            CosePub::Es256 { .. } => CoseAlg::Es256,
            CosePub::EdDsa { .. } => CoseAlg::EdDsa,
            CosePub::Rs256 { .. } => CoseAlg::Rs256,
        }
    }
}

fn int(v: &Integer) -> Option<i128> {
    i128::try_from(*v).ok()
}

pub fn parse(bytes: &[u8]) -> Result<CosePub, String> {
    let v: Value = ciborium::de::from_reader(bytes).map_err(|e| format!("cbor: {e}"))?;
    let map = match v {
        Value::Map(m) => m,
        _ => return Err("COSE_Key not a map".into()),
    };

    let mut kty: Option<i128> = None;
    let mut alg: Option<i128> = None;
    let mut crv: Option<i128> = None;
    let mut x: Option<Vec<u8>> = None;
    let mut y: Option<Vec<u8>> = None;
    let mut n: Option<Vec<u8>> = None;
    let mut e_exp: Option<Vec<u8>> = None;

    for (k, val) in map {
        let key = match &k {
            Value::Integer(i) => match int(i) {
                Some(n) => n,
                None => continue,
            },
            _ => continue,
        };
        match (key, val) {
            (1, Value::Integer(i)) => kty = int(&i),
            (3, Value::Integer(i)) => alg = int(&i),
            (-1, Value::Integer(i)) if kty == Some(2) || kty == Some(1) => crv = int(&i),
            (-1, Value::Bytes(b)) if kty == Some(3) => n = Some(b),
            (-2, Value::Bytes(b)) if kty == Some(2) || kty == Some(1) => x = Some(b),
            (-2, Value::Bytes(b)) if kty == Some(3) => e_exp = Some(b),
            (-3, Value::Bytes(b)) => y = Some(b),
            _ => {}
        }
    }

    match (kty, alg) {
        (Some(2), Some(-7)) => {
            if crv != Some(1) {
                return Err("ES256 requires crv=P-256".into());
            }
            let xb = x.ok_or("missing x")?;
            let yb = y.ok_or("missing y")?;
            if xb.len() != 32 || yb.len() != 32 {
                return Err("EC coords wrong length".into());
            }
            let mut xa = [0u8; 32];
            let mut ya = [0u8; 32];
            xa.copy_from_slice(&xb);
            ya.copy_from_slice(&yb);
            Ok(CosePub::Es256 { x: xa, y: ya })
        }
        (Some(1), Some(-8)) => {
            if crv != Some(6) {
                return Err("EdDSA requires crv=Ed25519".into());
            }
            let xb = x.ok_or("missing x")?;
            if xb.len() != 32 {
                return Err("Ed25519 pubkey wrong length".into());
            }
            let mut xa = [0u8; 32];
            xa.copy_from_slice(&xb);
            Ok(CosePub::EdDsa { x: xa })
        }
        (Some(3), Some(-257)) => {
            let nb = n.ok_or("missing n")?;
            let eb = e_exp.ok_or("missing e")?;
            Ok(CosePub::Rs256 { n: nb, e: eb })
        }
        _ => Err(format!("unsupported COSE alg ({:?},{:?})", kty, alg)),
    }
}

/// Byte length of one top-level CBOR item starting at the beginning of `buf`.
pub fn cbor_item_len(buf: &[u8]) -> Result<(usize, ()), String> {
    let mut cur = std::io::Cursor::new(buf);
    let _: Value =
        ciborium::de::from_reader(&mut cur).map_err(|e| format!("cbor read: {e}"))?;
    Ok((cur.position() as usize, ()))
}
