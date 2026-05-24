//! WebAuthn registration & login + bootstrap + logout.

use serde::Deserialize;
use worker::*;

use api_types::{
    AuthenticatorSelection, BootstrapReq, BootstrapResp, Extensions, LoginOptions,
    LoginVerifyReq, PrfEval, PrfInput, PubKeyCredParam, PubKeyUser, RecoveryBeginReq,
    RecoveryBeginResp, RecoveryVerifyReq, RegisterOptions, RegisterOptionsReq,
    RegisterVerifyReq, RegisterVerifyResp, RpInfo,
};

use crate::b64;
use crate::config::{rp_id, rp_origin, AppConfig};
use crate::error::{ApiError, ApiResult};
use crate::session;
use crate::webauthn;

use super::{registry_stub, stub_json, stub_passthrough};

// ---- Bootstrap (one-shot, no auth) -------------------------------------

// BootstrapReq / BootstrapResp live in api-types.

pub async fn bootstrap(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let body: BootstrapReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct R { invite_token: String }
    let r: R = stub_json(
        &stub,
        Method::Post,
        "/bootstrap",
        Some(serde_json::json!({
            "handle": body.handle,
            "addresses": body.addresses,
        })),
    )
    .await?;
    let enroll_url = format!("https://{}/enroll?token={}", cfg.app_host, r.invite_token);
    super::json_ok(&BootstrapResp {
        invite_token: r.invite_token,
        enroll_url,
    })
}

// ---- Registration ceremony --------------------------------------------
//
// Every request/response struct lives in `api-types` so the OpenAPI
// spec and this handler agree on shapes by construction.

pub async fn register_options(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let body: RegisterOptionsReq =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let stub = registry_stub(env)?;

    // Validate invite + get target handle/addresses
    #[derive(Deserialize)]
    struct Redeem {
        invite_handle: Option<String>,
        addresses: Vec<String>,
        is_admin: bool,
    }
    let redeem: Redeem = stub_json(
        &stub,
        Method::Post,
        "/invites/redeem",
        Some(serde_json::json!({ "token": body.invite_token })),
    )
    .await?;

    // Create challenge
    #[derive(Deserialize)]
    struct Ch { id: String, challenge_b64: String }
    let ch: Ch = stub_json(
        &stub,
        Method::Post,
        "/challenge",
        Some(serde_json::json!({ "purpose": "register" })),
    )
    .await?;

    // PRF salt: stable per-RP, baked from app host. The same salt must be
    // used at login time so the authenticator returns the same secret.
    let prf_salt = prf_salt_for(cfg);

    let user_id = b64::url_encode(&crate::crypto::random_bytes(16));
    let display_handle = redeem
        .invite_handle
        .clone()
        .unwrap_or_else(|| redeem.addresses.first().cloned().unwrap_or_default());

    super::json_ok(&RegisterOptions {
        rp: RpInfo { id: rp_id(cfg), name: cfg.app_name.clone() },
        user: PubKeyUser {
            id: user_id,
            name: display_handle.clone(),
            display_name: display_handle.clone(),
        },
        challenge: ch.challenge_b64,
        pub_key_cred_params: vec![
            PubKeyCredParam { ty: "public-key".into(), alg: -7 },
            PubKeyCredParam { ty: "public-key".into(), alg: -8 },
            PubKeyCredParam { ty: "public-key".into(), alg: -257 },
        ],
        authenticator_selection: AuthenticatorSelection {
            user_verification: "preferred".into(),
            resident_key: "preferred".into(),
            require_resident_key: false,
        },
        timeout: 60_000,
        attestation: "none".into(),
        extensions: Extensions {
            prf: PrfInput { eval: PrfEval { first: b64::url_encode(&prf_salt) } },
        },
        challenge_id: ch.id,
        prf_salt_b64: b64::url_encode(&prf_salt),
        invite_handle: redeem.invite_handle,
        invite_addresses: redeem.addresses,
        invite_is_admin: redeem.is_admin,
    })
}

// RegisterVerifyReq / AttestationResp live in api-types.

pub async fn register_verify(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let body: RegisterVerifyReq =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let host = host_of(&req);
    let secure = session::is_secure_request(&req);

    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct Cons { challenge_b64: String }
    let cons: Cons = stub_json(
        &stub,
        Method::Post,
        "/challenge/consume",
        Some(serde_json::json!({
            "id": body.challenge_id,
            "purpose": "register",
        })),
    )
    .await?;
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
    let aaguid_b64 = b64::url_encode(&ok.aaguid);
    let transports = body
        .attestation
        .transports
        .map(|t| t.join(","))
        .filter(|s| !s.is_empty());

    let done: RegisterVerifyResp = stub_json(
        &stub,
        Method::Post,
        "/users/register",
        Some(serde_json::json!({
            "invite_token": body.invite_token,
            "handle": body.handle,
            "display_name": body.display_name,
            "credential_id_b64": cred_id_b64,
            "cose_pubkey_b64": b64::url_encode(&ok.cose_pubkey),
            "sign_count": ok.sign_count,
            "aaguid_b64": aaguid_b64,
            "transports": transports,
            "cred_label": body.cred_label,
            "pub_key_b64": body.pub_key_b64,
            "wraps": body.wraps,
        })),
    )
    .await?;

    // Issue session immediately
    let sid = session::new_session_id();
    let _: serde_json::Value = stub_json(
        &stub,
        Method::Post,
        "/sessions",
        Some(serde_json::json!({
            "sid": sid,
            "user_id": done.user_id,
            "ttl_days": cfg.session_ttl_days as i64,
        })),
    )
    .await?;

    let resp = super::json_ok(&serde_json::json!({
        "user_id": done.user_id,
        "is_admin": done.is_admin,
        "addresses": done.addresses,
    }))?;
    Ok(session::with_session_cookie(
        resp,
        &sid,
        cfg.session_ttl_days,
        secure,
    ))
}

// ---- Login ceremony ---------------------------------------------------

pub async fn login_options(
    _req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct Ch { id: String, challenge_b64: String }
    let ch: Ch = stub_json(
        &stub,
        Method::Post,
        "/challenge",
        Some(serde_json::json!({ "purpose": "login" })),
    )
    .await?;
    let prf_salt = prf_salt_for(cfg);
    super::json_ok(&LoginOptions {
        rp_id: rp_id(cfg),
        challenge: ch.challenge_b64,
        challenge_id: ch.id,
        timeout: 60_000,
        user_verification: "preferred".into(),
        extensions: Extensions {
            prf: PrfInput { eval: PrfEval { first: b64::url_encode(&prf_salt) } },
        },
        prf_salt_b64: b64::url_encode(&prf_salt),
    })
}

pub async fn login_verify(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let body: LoginVerifyReq =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let host = host_of(&req);
    let secure = session::is_secure_request(&req);

    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct Cons { challenge_b64: String }
    let cons: Cons = stub_json(
        &stub,
        Method::Post,
        "/challenge/consume",
        Some(serde_json::json!({
            "id": body.challenge_id,
            "purpose": "login",
        })),
    )
    .await?;
    let challenge = b64::url_decode(&cons.challenge_b64)
        .map_err(|_| ApiError::BadRequest("challenge b64".into()))?;

    #[derive(Deserialize)]
    struct LookupResp {
        user: crate::registry::UserView,
        credential: crate::registry::CredentialView,
    }
    let lookup: LookupResp = stub_json(
        &stub,
        Method::Get,
        &format!(
            "/users/by-credential?credential_id_b64={}",
            urlencoding::encode(&body.credential_id_b64)
        ),
        None,
    )
    .await?;
    let cose = b64::url_decode(&lookup.credential.cose_pubkey_b64)
        .map_err(|_| ApiError::BadRequest("stored cose b64".into()))?;

    let origin = rp_origin(cfg, &host, secure);
    let reg_id = rp_id(cfg);

    let ok = webauthn::auth::verify(
        &body.client_data_json_b64,
        &body.authenticator_data_b64,
        &body.signature_b64,
        &webauthn::auth::ExpectedAssertion {
            challenge: &challenge,
            origin: &origin,
            rp_id: &reg_id,
            stored_cose_pubkey: &cose,
            stored_sign_count: lookup.credential.sign_count,
        },
    )
    .map_err(ApiError::BadRequest)?;

    let _: serde_json::Value = stub_json(
        &stub,
        Method::Post,
        "/credentials/update-sign-count",
        Some(serde_json::json!({
            "credential_id_b64": body.credential_id_b64,
            "sign_count": ok.new_sign_count,
        })),
    )
    .await?;

    // Pull the wrap for this credential so the client can unwrap the priv.
    let wrap: crate::registry::KeyWrapView = stub_json(
        &stub,
        Method::Get,
        &format!(
            "/key-wraps/by-credential?credential_id_b64={}",
            urlencoding::encode(&body.credential_id_b64)
        ),
        None,
    )
    .await?;

    let sid = session::new_session_id();
    let _: serde_json::Value = stub_json(
        &stub,
        Method::Post,
        "/sessions",
        Some(serde_json::json!({
            "sid": sid,
            "user_id": lookup.user.id,
            "ttl_days": cfg.session_ttl_days as i64,
        })),
    )
    .await?;

    let resp = super::json_ok(&serde_json::json!({
        "user": lookup.user,
        "wrap": wrap,
    }))?;
    Ok(session::with_session_cookie(
        resp,
        &sid,
        cfg.session_ttl_days,
        secure,
    ))
}

// ---- Recovery login -------------------------------------------------------
//
// Two-step flow to bound brute-force surface:
//
//   1. POST /api/auth/recovery/begin { handle }
//        → { user_id, wrap, sealed_proof_b64 }
//      The server returns the recovery wrap (kdf_params + wrapped_blob) so
//      the client can derive the wrap key + unwrap the X25519 priv. It also
//      returns a `sealed_proof_b64` — a random token sealed to the user's
//      X25519 pubkey. The client decrypts it after unwrapping the priv.
//
//   2. POST /api/auth/recovery/verify { user_id, proof_b64 }
//        → session cookie + user view + wrap
//      Server checks the decrypted proof matches the one it issued (held in
//      the challenges table). Session issued on match.
//
// This means: leaking the wrap blob does NOT itself let an attacker in —
// they also need to crack the Argon2id-protected passphrase to produce a
// valid proof. (Passphrase = 12 BIP39 words = ~128 bits.)

pub async fn recovery_begin(
    mut req: HttpRequest,
    env: &Env,
    _cfg: &AppConfig,
) -> ApiResult<Response> {
    let body: RecoveryBeginReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let stub = registry_stub(env)?;

    // Look up user by handle (we accept either handle or owned address).
    let user: crate::registry::UserView = if body.handle.contains('@') {
        stub_json(
            &stub,
            Method::Get,
            &format!(
                "/users/by-address?address={}",
                urlencoding::encode(&body.handle)
            ),
            None,
        )
        .await?
    } else {
        // No by-handle endpoint yet — scan via /users (small scale, OK for v1).
        let all: Vec<crate::registry::UserView> =
            stub_json(&stub, Method::Get, "/users", None).await?;
        all.into_iter()
            .find(|u| u.handle.eq_ignore_ascii_case(&body.handle))
            .ok_or(ApiError::NotFound)?
    };
    let pub_key = user
        .pub_key_b64
        .as_deref()
        .and_then(|s| b64::url_decode(s).ok())
        .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
        .ok_or_else(|| ApiError::Internal("user missing pubkey".into()))?;

    // Fetch the recovery wrap.
    let wrap: crate::registry::KeyWrapView = stub_json(
        &stub,
        Method::Get,
        &format!("/key-wraps/recovery?user_id={}", urlencoding::encode(&user.id)),
        None,
    )
    .await?;

    // Create a one-time proof: random 32-byte token, sealed to the user's
    // pubkey. Server stores the plaintext token in `challenges`; client
    // returns it to prove they unwrapped the priv.
    #[derive(Deserialize)]
    struct Ch { id: String, challenge_b64: String }
    let ch: Ch = stub_json(
        &stub,
        Method::Post,
        "/challenge",
        Some(serde_json::json!({
            "purpose": "recovery",
            "user_id": user.id,
        })),
    )
    .await?;
    let token = b64::url_decode(&ch.challenge_b64)
        .map_err(|_| ApiError::Internal("challenge b64".into()))?;
    let sealed = crate::crypto::seal_to(&pub_key, &token)?;

    super::json_ok(&RecoveryBeginResp {
        user_id: user.id,
        wrap,
        sealed_proof_b64: b64::url_encode(&sealed),
        challenge_id: ch.id,
    })
}

pub async fn recovery_verify(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let body: RecoveryVerifyReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let secure = session::is_secure_request(&req);
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct Cons {
        challenge_b64: String,
        user_id: Option<String>,
    }
    let cons: Cons = stub_json(
        &stub,
        Method::Post,
        "/challenge/consume",
        Some(serde_json::json!({
            "id": body.challenge_id,
            "purpose": "recovery",
        })),
    )
    .await?;
    let expected = b64::url_decode(&cons.challenge_b64)
        .map_err(|_| ApiError::BadRequest("challenge b64".into()))?;
    let given = b64::url_decode(&body.proof_b64)
        .map_err(|_| ApiError::BadRequest("proof b64".into()))?;
    if !crate::crypto::ct_eq(&expected, &given) {
        return Err(ApiError::Unauthorized);
    }
    let user_id = cons.user_id.ok_or(ApiError::Unauthorized)?;

    let user: crate::registry::UserView = stub_json(
        &stub,
        Method::Get,
        &format!("/me?user_id={}", urlencoding::encode(&user_id)),
        None,
    )
    .await?;

    let sid = session::new_session_id();
    let _: serde_json::Value = stub_json(
        &stub,
        Method::Post,
        "/sessions",
        Some(serde_json::json!({
            "sid": sid,
            "user_id": user_id,
            "ttl_days": cfg.session_ttl_days as i64,
        })),
    )
    .await?;

    let resp = super::json_ok(&user)?;
    Ok(session::with_session_cookie(resp, &sid, cfg.session_ttl_days, secure))
}

// ---- Logout -----------------------------------------------------------

pub async fn logout(req: HttpRequest, env: &Env) -> ApiResult<Response> {
    if let Some(sid) = session::extract_sid(&req) {
        let stub = registry_stub(env)?;
        let _ = stub_passthrough(
            &stub,
            Method::Delete,
            "/sessions",
            Some(serde_json::json!({ "sid": sid })),
        )
        .await;
    }
    let resp = super::json_ok(&serde_json::json!({ "ok": true }))?;
    Ok(session::with_cleared_cookie(resp))
}

// ---- helpers ----------------------------------------------------------

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

/// PRF salt: domain-separated per app instance. 32 bytes; reading the salt
/// gives no meaningful info to an attacker — security comes from the
/// authenticator's per-credential PRF secret.
fn prf_salt_for(cfg: &AppConfig) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"cfemail/prf-salt/v1\0");
    h.update(cfg.app_host.as_bytes());
    h.finalize().to_vec()
}
