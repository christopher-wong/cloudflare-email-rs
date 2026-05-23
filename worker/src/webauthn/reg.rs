//! Registration ceremony verifier.

#![allow(dead_code)]

use ciborium::value::Value;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::b64;

use super::cose::CosePub;
use super::{flag_at, flag_up, parse_auth_data};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientData {
    #[serde(rename = "type")]
    ty: String,
    challenge: String,
    origin: String,
}

struct AttestationObject {
    fmt: String,
    auth_data: Vec<u8>,
}

/// Parse the CBOR attestation-object map by walking `Value::Map` directly.
/// We previously used a serde-derived struct with `#[serde(with =
/// "serde_bytes")]`, but ciborium 0.2's struct deserializer mishandles the
/// byte-string `authData` when skipping the ignored `attStmt` field, surfacing
/// as `invalid type: byte array, expected a sequence`. Walking the map by hand
/// — same approach as `cose::parse` — sidesteps the issue and lets us be
/// explicit about which CBOR types we accept.
fn parse_attestation_object(bytes: &[u8]) -> Result<AttestationObject, String> {
    let v: Value = ciborium::de::from_reader(bytes).map_err(|e| format!("cbor: {e}"))?;
    let map = match v {
        Value::Map(m) => m,
        _ => return Err("attestationObject not a map".into()),
    };
    let mut fmt: Option<String> = None;
    let mut auth_data: Option<Vec<u8>> = None;
    for (k, val) in map {
        let key = match k {
            Value::Text(s) => s,
            _ => continue,
        };
        match key.as_str() {
            "fmt" => {
                if let Value::Text(s) = val {
                    fmt = Some(s);
                }
            }
            "authData" => {
                if let Value::Bytes(b) = val {
                    auth_data = Some(b);
                }
            }
            // `attStmt` and any extensions are intentionally ignored.
            _ => {}
        }
    }
    Ok(AttestationObject {
        fmt: fmt.ok_or("missing fmt")?,
        auth_data: auth_data.ok_or("missing authData")?,
    })
}

#[derive(Debug)]
pub struct RegistrationOk {
    pub credential_id: Vec<u8>,
    pub cose_pubkey: Vec<u8>,
    pub sign_count: u32,
    pub aaguid: [u8; 16],
}

pub struct ExpectedRegistration<'a> {
    pub challenge: &'a [u8],
    pub origin: &'a str,
    pub rp_id: &'a str,
}

pub fn verify(
    client_data_json_b64: &str,
    attestation_object_b64: &str,
    expected: &ExpectedRegistration,
) -> Result<RegistrationOk, String> {
    let client_data_json =
        b64::url_decode(client_data_json_b64).map_err(|e| format!("clientDataJSON b64: {e}"))?;
    let attestation_object_bytes =
        b64::url_decode(attestation_object_b64).map_err(|e| format!("attObj b64: {e}"))?;

    let cd: ClientData = serde_json::from_slice(&client_data_json)
        .map_err(|e| format!("clientDataJSON parse: {e}"))?;
    if cd.ty != "webauthn.create" {
        return Err(format!("wrong type: {}", cd.ty));
    }
    let challenge =
        b64::url_decode(&cd.challenge).map_err(|e| format!("challenge b64: {e}"))?;
    if !crate::crypto::ct_eq(&challenge, expected.challenge) {
        return Err("challenge mismatch".into());
    }
    if !cd.origin.eq_ignore_ascii_case(expected.origin) {
        return Err(format!("origin mismatch: {} vs {}", cd.origin, expected.origin));
    }

    let att = parse_attestation_object(&attestation_object_bytes)
        .map_err(|e| format!("attestationObject cbor: {e}"))?;
    if att.fmt != "none" {
        // v1: only accept "none". Real-world platform authenticators and
        // discoverable creds default to "none" with most RPs. Self/full
        // attestation can be added later.
        return Err(format!("unsupported attestation fmt: {}", att.fmt));
    }

    let ad = parse_auth_data(&att.auth_data).map_err(|e| format!("authData: {e}"))?;

    let mut h = Sha256::new();
    h.update(expected.rp_id.as_bytes());
    let want = h.finalize();
    if !crate::crypto::ct_eq(&ad.rp_id_hash, &want) {
        return Err("rpIdHash mismatch".into());
    }
    if !flag_up(ad.flags) {
        return Err("UP flag not set".into());
    }
    if !flag_at(ad.flags) {
        return Err("AT flag not set (no attested credential data)".into());
    }

    let attested = ad.attested.ok_or("missing attestedCredentialData")?;
    // Validate that the COSE pubkey is one we understand. We re-encode
    // nothing — we store the original COSE bytes for later signature
    // verification, but we want to fail early on unsupported algs.
    let _: CosePub = super::cose::parse(&attested.cose_public_key)
        .map_err(|e| format!("COSE pubkey: {e}"))?;

    Ok(RegistrationOk {
        credential_id: attested.credential_id,
        cose_pubkey: attested.cose_public_key,
        sign_count: ad.sign_count,
        aaguid: attested.aaguid,
    })
}
