//! Minimal WebAuthn server-side ceremony verifier. Supports:
//! * "none" attestation (the only path we accept; sufficient for platform
//!   authenticators + most security keys when discoverable creds are used)
//! * ES256 (P-256 / SHA-256), EdDSA (Ed25519), RS256 (RSA-PKCS1v15 / SHA-256)
//!   public keys decoded from COSE_Key.
//! * PRF extension is *passively* supported — we never need to verify PRF
//!   output server-side; the client uses it locally to derive the wrap key.
//!
//! Spec reference: WebAuthn Level 3.

// Several types here (CoseAlg, ParsedAuthData::raw, flag_uv) are intentionally
// public so we can extend verification later (e.g. include the full authData
// blob in some audit trail) without re-plumbing the module. Suppress the
// dead-code warning at the module level.
#![allow(dead_code)]

pub mod cose;
pub mod reg;
pub mod auth;

use serde::{Deserialize, Serialize};

/// Public key types we accept.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CoseAlg {
    Es256,
    EdDsa,
    Rs256,
}

#[derive(Debug, Clone)]
pub struct ParsedAuthData {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub sign_count: u32,
    /// Only present on registration responses.
    pub attested: Option<AttestedCred>,
    /// Raw bytes — needed for signature verification.
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct AttestedCred {
    #[allow(dead_code)]
    pub aaguid: [u8; 16],
    pub credential_id: Vec<u8>,
    pub cose_public_key: Vec<u8>,
}

pub fn flag_up(flags: u8) -> bool {
    (flags & 0x01) != 0
}
pub fn flag_uv(flags: u8) -> bool {
    (flags & 0x04) != 0
}
pub fn flag_at(flags: u8) -> bool {
    (flags & 0x40) != 0
}

pub fn parse_auth_data(buf: &[u8]) -> Result<ParsedAuthData, String> {
    if buf.len() < 37 {
        return Err("authData too short".into());
    }
    let mut rp_id_hash = [0u8; 32];
    rp_id_hash.copy_from_slice(&buf[..32]);
    let flags = buf[32];
    let sign_count = u32::from_be_bytes([buf[33], buf[34], buf[35], buf[36]]);

    let mut attested = None;
    let mut pos = 37;
    if flag_at(flags) {
        if buf.len() < pos + 18 {
            return Err("attestedCredData truncated".into());
        }
        let mut aaguid = [0u8; 16];
        aaguid.copy_from_slice(&buf[pos..pos + 16]);
        pos += 16;
        let cred_id_len = u16::from_be_bytes([buf[pos], buf[pos + 1]]) as usize;
        pos += 2;
        if buf.len() < pos + cred_id_len {
            return Err("credentialId truncated".into());
        }
        let credential_id = buf[pos..pos + cred_id_len].to_vec();
        pos += cred_id_len;

        // The remaining bytes are CBOR for the COSE pubkey, possibly followed
        // by CBOR extensions. We greedy-parse one CBOR item.
        let (cose_len, _) =
            cose::cbor_item_len(&buf[pos..]).map_err(|e| format!("COSE: {e}"))?;
        let cose_public_key = buf[pos..pos + cose_len].to_vec();
        attested = Some(AttestedCred {
            aaguid,
            credential_id,
            cose_public_key,
        });
    }

    Ok(ParsedAuthData {
        rp_id_hash,
        flags,
        sign_count,
        attested,
        raw: buf.to_vec(),
    })
}
