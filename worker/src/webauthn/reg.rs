//! Registration ceremony verifier.

#![allow(dead_code)]

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

#[derive(Debug, Deserialize)]
struct AttestationObject {
    fmt: String,
    #[serde(rename = "authData", with = "serde_bytes")]
    auth_data: Vec<u8>,
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

    let att: AttestationObject = ciborium::de::from_reader(&attestation_object_bytes[..])
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
