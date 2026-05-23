//! Assertion (login) ceremony verifier.

#![allow(dead_code)]

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::b64;

use super::cose::{parse as parse_cose, CosePub};
use super::{flag_up, parse_auth_data};

#[derive(Debug, Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    ty: String,
    challenge: String,
    origin: String,
}

pub struct ExpectedAssertion<'a> {
    pub challenge: &'a [u8],
    pub origin: &'a str,
    pub rp_id: &'a str,
    pub stored_cose_pubkey: &'a [u8],
    pub stored_sign_count: u32,
}

pub struct AssertionOk {
    pub new_sign_count: u32,
}

pub fn verify(
    client_data_json_b64: &str,
    authenticator_data_b64: &str,
    signature_b64: &str,
    expected: &ExpectedAssertion,
) -> Result<AssertionOk, String> {
    let cdj = b64::url_decode(client_data_json_b64).map_err(|e| format!("cdj b64: {e}"))?;
    let auth_data =
        b64::url_decode(authenticator_data_b64).map_err(|e| format!("authData b64: {e}"))?;
    let sig = b64::url_decode(signature_b64).map_err(|e| format!("sig b64: {e}"))?;

    let cd: ClientData =
        serde_json::from_slice(&cdj).map_err(|e| format!("cdj parse: {e}"))?;
    if cd.ty != "webauthn.get" {
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

    let ad = parse_auth_data(&auth_data).map_err(|e| format!("authData: {e}"))?;
    let mut h = Sha256::new();
    h.update(expected.rp_id.as_bytes());
    let want = h.finalize();
    if !crate::crypto::ct_eq(&ad.rp_id_hash, &want) {
        return Err("rpIdHash mismatch".into());
    }
    if !flag_up(ad.flags) {
        return Err("UP flag not set".into());
    }
    if ad.sign_count != 0 && ad.sign_count <= expected.stored_sign_count {
        return Err("signCount regressed".into());
    }

    // sig_base = authData ‖ SHA256(clientDataJSON)
    let mut cdj_hash = Sha256::new();
    cdj_hash.update(&cdj);
    let cdj_digest = cdj_hash.finalize();
    let mut sig_base = Vec::with_capacity(auth_data.len() + 32);
    sig_base.extend_from_slice(&auth_data);
    sig_base.extend_from_slice(&cdj_digest);

    let pubkey = parse_cose(expected.stored_cose_pubkey)
        .map_err(|e| format!("stored pubkey: {e}"))?;
    verify_signature(&pubkey, &sig_base, &sig)?;

    Ok(AssertionOk {
        new_sign_count: ad.sign_count,
    })
}

fn verify_signature(pk: &CosePub, msg: &[u8], sig: &[u8]) -> Result<(), String> {
    match pk {
        CosePub::Es256 { x, y } => {
            use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
            use p256::EncodedPoint;
            let pt = EncodedPoint::from_affine_coordinates(x.into(), y.into(), false);
            let vk = VerifyingKey::from_encoded_point(&pt)
                .map_err(|e| format!("ES256 vk: {e}"))?;
            let s = Signature::from_der(sig).map_err(|e| format!("ES256 sig DER: {e}"))?;
            vk.verify(msg, &s).map_err(|e| format!("ES256 verify: {e}"))
        }
        CosePub::EdDsa { x } => {
            use ed25519_dalek::{Signature, Verifier, VerifyingKey};
            let vk = VerifyingKey::from_bytes(x).map_err(|e| format!("Ed25519 vk: {e}"))?;
            let s = Signature::from_slice(sig).map_err(|e| format!("Ed25519 sig: {e}"))?;
            vk.verify(msg, &s).map_err(|e| format!("Ed25519 verify: {e}"))
        }
        CosePub::Rs256 { n, e } => {
            use rsa::pkcs1v15::{Signature, VerifyingKey};
            use rsa::signature::Verifier;
            use rsa::{BigUint, RsaPublicKey};
            let nn = BigUint::from_bytes_be(n);
            let ee = BigUint::from_bytes_be(e);
            let pk = RsaPublicKey::new(nn, ee).map_err(|e| format!("RS256 key: {e}"))?;
            let vk = VerifyingKey::<sha2::Sha256>::new(pk);
            let s = Signature::try_from(sig).map_err(|e| format!("RS256 sig: {e}"))?;
            vk.verify(msg, &s).map_err(|e| format!("RS256 verify: {e}"))
        }
    }
}
