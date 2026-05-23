//! Passkey management for an authenticated user.
//!
//! Add another passkey: the user must already hold the unwrapped X25519
//! private key in browser memory (because they're signed in). They run a
//! WebAuthn registration ceremony on the new device, derive a new wrap
//! key from that authenticator's PRF output, AES-GCM-wrap the same priv
//! key with it, and post the credential + new wrap here.
//!
//! Remove a passkey: deletes the credential row + its corresponding
//! key_wraps row. The DO refuses to remove the last passkey on a user —
//! recovery still works but UX of "no passkeys at all" is bad; require
//! adding one first if the user wants to swap.

use serde::{Deserialize, Serialize};
use worker::*;

use crate::b64;
use crate::config::{rp_id, rp_origin, AppConfig};
use crate::error::{ApiError, ApiResult};
use crate::session;
use crate::webauthn;

use super::{registry_stub, require_auth, stub_json, stub_passthrough};

pub async fn list(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = registry_stub(env)?;
    stub_passthrough(
        &stub,
        Method::Get,
        &format!("/credentials/by-user?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await
}

// ---- Add passkey ceremony ------------------------------------------------

#[derive(Serialize)]
struct AddPasskeyOptions {
    rp: Rp,
    user: User,
    challenge: String,
    pub_key_cred_params: Vec<PubKeyCredParam>,
    authenticator_selection: AuthSel,
    timeout: u32,
    attestation: String,
    extensions: PrfExt,
    challenge_id: String,
    prf_salt_b64: String,
    exclude_credentials: Vec<ExcludeCred>,
}
#[derive(Serialize)]
struct Rp { id: String, name: String }
#[derive(Serialize)]
struct User { id: String, name: String, display_name: String }
#[derive(Serialize)]
struct PubKeyCredParam { #[serde(rename = "type")] ty: String, alg: i32 }
#[derive(Serialize)]
struct AuthSel {
    user_verification: String,
    resident_key: String,
    require_resident_key: bool,
}
#[derive(Serialize)]
struct PrfExt { prf: PrfInput }
#[derive(Serialize)]
struct PrfInput { eval: PrfEval }
#[derive(Serialize)]
struct PrfEval { first: String }
#[derive(Serialize)]
struct ExcludeCred { #[serde(rename = "type")] ty: String, id: String }

pub async fn add_options(req: HttpRequest, env: &Env, cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = registry_stub(env)?;

    // Get existing credentials so the authenticator excludes already-bound ones.
    #[derive(Deserialize)]
    struct CredRow { credential_id_b64: String }
    let creds: Vec<CredRow> = stub_json(
        &stub,
        Method::Get,
        &format!("/credentials/by-user?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await?;

    #[derive(Deserialize)]
    struct Ch { id: String, challenge_b64: String }
    let ch: Ch = stub_json(
        &stub,
        Method::Post,
        "/challenge",
        Some(serde_json::json!({
            "purpose": "add-passkey",
            "user_id": s.user_id,
        })),
    )
    .await?;

    let prf_salt = prf_salt_for(cfg);
    let new_user_id = b64::url_encode(&crate::crypto::random_bytes(16));

    super::json_ok(&AddPasskeyOptions {
        rp: Rp { id: rp_id(cfg), name: cfg.app_name.clone() },
        user: User {
            id: new_user_id,
            name: s.handle.clone(),
            display_name: s.handle.clone(),
        },
        challenge: ch.challenge_b64,
        pub_key_cred_params: vec![
            PubKeyCredParam { ty: "public-key".into(), alg: -7 },
            PubKeyCredParam { ty: "public-key".into(), alg: -8 },
            PubKeyCredParam { ty: "public-key".into(), alg: -257 },
        ],
        authenticator_selection: AuthSel {
            user_verification: "preferred".into(),
            resident_key: "preferred".into(),
            require_resident_key: false,
        },
        timeout: 60_000,
        attestation: "none".into(),
        extensions: PrfExt { prf: PrfInput { eval: PrfEval { first: b64::url_encode(&prf_salt) } } },
        challenge_id: ch.id,
        prf_salt_b64: b64::url_encode(&prf_salt),
        exclude_credentials: creds
            .into_iter()
            .map(|c| ExcludeCred { ty: "public-key".into(), id: c.credential_id_b64 })
            .collect(),
    })
}

#[derive(Deserialize)]
struct AddVerifyReq {
    challenge_id: String,
    cred_label: Option<String>,
    attestation: AttResp,
    /// AES-GCM-wrapped X25519 private key under the new PRF-derived key.
    wrapped_blob_b64: String,
    wrap_salt_b64: String,
}

#[derive(Deserialize)]
struct AttResp {
    credential_id_b64: String,
    client_data_json_b64: String,
    attestation_object_b64: String,
    transports: Option<Vec<String>>,
}

pub async fn add_verify(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: AddVerifyReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let host = host_of(&req);
    let secure = session::is_secure_request(&req);

    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct Cons { challenge_b64: String, user_id: Option<String> }
    let cons: Cons = stub_json(
        &stub,
        Method::Post,
        "/challenge/consume",
        Some(serde_json::json!({
            "id": body.challenge_id,
            "purpose": "add-passkey",
        })),
    )
    .await?;
    if cons.user_id.as_deref() != Some(s.user_id.as_str()) {
        return Err(ApiError::Forbidden);
    }
    let challenge = b64::url_decode(&cons.challenge_b64)
        .map_err(|_| ApiError::BadRequest("challenge b64".into()))?;
    let origin = rp_origin(cfg, &host, secure);
    let reg_id = rp_id(cfg);

    let ok = webauthn::reg::verify(
        &body.attestation.client_data_json_b64,
        &body.attestation.attestation_object_b64,
        &webauthn::reg::ExpectedRegistration {
            challenge: &challenge,
            origin: &origin,
            rp_id: &reg_id,
        },
    )
    .map_err(ApiError::BadRequest)?;

    let cred_id_b64 = b64::url_encode(&ok.credential_id);
    if cred_id_b64 != body.attestation.credential_id_b64 {
        return Err(ApiError::BadRequest("credential_id mismatch".into()));
    }
    let transports = body
        .attestation
        .transports
        .map(|t| t.join(","))
        .filter(|s| !s.is_empty());

    let _: serde_json::Value = stub_json(
        &stub,
        Method::Post,
        "/users/add-passkey",
        Some(serde_json::json!({
            "user_id": s.user_id,
            "credential_id_b64": cred_id_b64,
            "cose_pubkey_b64": b64::url_encode(&ok.cose_pubkey),
            "sign_count": ok.sign_count,
            "aaguid_b64": b64::url_encode(&ok.aaguid),
            "transports": transports,
            "cred_label": body.cred_label.clone(),
            "wrapped_blob_b64": body.wrapped_blob_b64,
            "wrap_salt_b64": body.wrap_salt_b64,
            "wrap_label": body.cred_label,
        })),
    )
    .await?;
    super::json_ok(&serde_json::json!({ "ok": true }))
}

pub async fn remove(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_auth(&req, env).await?;
    let cred_b64 = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("credential_id".into()))?;
    let stub = registry_stub(env)?;
    stub_passthrough(
        &stub,
        Method::Delete,
        &format!("/credentials?credential_id_b64={}", urlencoding::encode(&cred_b64)),
        None,
    )
    .await
}

// helpers (copied to avoid super::auth private leaks)

fn host_of(req: &HttpRequest) -> String {
    req.headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

async fn body_bytes(req: &mut HttpRequest) -> ApiResult<Vec<u8>> {
    use http_body_util::BodyExt;
    let body = std::mem::replace(req.body_mut(), worker::Body::empty());
    let collected = body
        .collect()
        .await
        .map_err(|e| ApiError::BadRequest(format!("body: {e}")))?;
    Ok(collected.to_bytes().to_vec())
}

fn prf_salt_for(cfg: &AppConfig) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"cfemail/prf-salt/v1\0");
    h.update(cfg.app_host.as_bytes());
    h.finalize().to_vec()
}
