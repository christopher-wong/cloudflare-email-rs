//! Password-protected "secret link" delivery — ProtonMail-style.
//!
//! Two surfaces:
//!
//!  * Authenticated (sender): upload attachment ciphertext to R2, create a
//!    secret link row with metadata + ciphertext, list own links, revoke.
//!
//!  * Unauthenticated (recipient): fetch link metadata by token, exchange a
//!    password-derived `check` value for the AES-GCM-wrapped CEK +
//!    XChaCha20-Poly1305 ciphertext for subject and body.
//!
//! All the actual encryption happens client-side. The server never holds
//! plaintext, the CEK, or the password — only a one-way derivative of the
//! password (`password_check`) it can compare against on viewer attempts to
//! gate access and enforce rate-limiting / policy expiry.

use serde::Deserialize;
use worker::*;

use api_types::{SecretCreateReq as CreateReq, SecretCreateResp as CreateResp};

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{registry_stub, require_auth, stub_json};

/// Per-link total ciphertext cap (subject + body + every attachment). Tuned
/// to balance "useful for files most people send" against "fits sensibly
/// behind a single Workers fetch handler." Each attachment also runs
/// through `bytes()` on download, which buffers — see
/// `SECRET_MAX_PER_ATTACHMENT_BYTES`.
pub const SECRET_MAX_LINK_BYTES: usize = 256 * 1024 * 1024;
/// Per-attachment soft cap exposed to the client purely for UX
/// pre-flight; the unified chunked upload pipeline can ingest larger,
/// but warning the user past this size keeps the per-file scroll
/// realistic. Kept in sync with `web/src/lib/secret-link.ts`.
#[allow(dead_code)]
pub const SECRET_MAX_PER_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

// CreateReq, CreateResp, SecretAttachment all defined in api-types;
// imported above as type aliases that preserve the local names.

// ---- create -----------------------------------------------------------------

pub async fn create(mut req: HttpRequest, env: &Env, cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: CreateReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    if !matches!(body.policy.as_str(), "one_time" | "1h" | "24h" | "14d" | "never") {
        return Err(ApiError::BadRequest(format!("invalid policy: {}", body.policy)));
    }
    // Total size cap: ciphertext for subject + body + every attachment.
    // We approximate the ciphertext sizes from the base64 wire form
    // (each 4 b64 chars ≈ 3 bytes) rather than decoding, since we don't
    // need the bytes themselves here. Attachment sizes are already in
    // bytes via the upload step. Reject before hitting the DO so a giant
    // payload never reaches storage.
    let approx_b64_bytes = |s: &str| (s.len() / 4) * 3;
    let mut total: usize = approx_b64_bytes(&body.subject_ct_b64)
        + approx_b64_bytes(&body.body_ct_b64);
    for a in &body.attachments {
        total = total.saturating_add(a.size as usize);
    }
    if total > SECRET_MAX_LINK_BYTES {
        return Err(ApiError::BadRequest(format!(
            "secret link too large: {} MiB max total, got {} MiB",
            SECRET_MAX_LINK_BYTES / (1024 * 1024),
            total / (1024 * 1024),
        )));
    }
    // Pull the sender's default address + display name from the registry.
    // We store these denormalized on the row so the viewer page can show
    // "from Christopher <christopher@middleseat.vc>" without an extra
    // round trip and without leaking the sender's full identity record.
    let reg = registry_stub(env)?;
    let me: crate::registry::UserView = stub_json(
        &reg,
        Method::Get,
        &format!("/me?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await?;
    let sender_addr = me.addresses.first().cloned().unwrap_or_default();
    let sender_name = me.display_name.clone();

    // Verify every uploaded attachment r2_key actually belongs to this
    // user. The upload endpoint puts blobs under `secret/{user_id}/...` —
    // refuse anything else so a compromised client can't link to another
    // user's blobs.
    let prefix = format!("secret/{}/", s.user_id);
    for a in &body.attachments {
        if !a.r2_key.starts_with(&prefix) {
            return Err(ApiError::BadRequest("attachment r2_key prefix mismatch".into()));
        }
    }

    #[derive(Deserialize)]
    struct DoResp { token: String, expires_at: i64 }
    let resp: DoResp = stub_json(
        &reg,
        Method::Post,
        "/secret-links",
        Some(serde_json::json!({
            "sender_user_id": s.user_id,
            "sender_addr": sender_addr,
            "sender_name": sender_name,
            "recipient_addr": body.recipient.as_deref().map(crate::config::canonical_address),
            "password_check_b64": body.password_check_b64,
            "password_wrap_b64": body.password_wrap_b64,
            "argon_salt_b64": body.argon_salt_b64,
            "kdf_params": body.kdf_params,
            "subject_ct_b64": body.subject_ct_b64,
            "body_ct_b64": body.body_ct_b64,
            "hint": body.hint,
            "attachments": body.attachments,
            "policy": body.policy,
        })),
    )
    .await?;

    let url = format!("https://{}/s/{}", cfg.app_host, resp.token);
    super::json_ok(&CreateResp {
        token: resp.token,
        url,
        expires_at: resp.expires_at,
    })
}

/// Upper bound on per-range download for secret attachments. Streaming
/// responses don't actually allocate this in the worker (the runtime
/// tees R2 → response), but we still cap so an adversarial viewer can't
/// request giant ranges and tie up a connection. Mirrors what the
/// unified upload pipeline accepts per part.
pub const SECRET_MULTIPART_MAX_PART_BYTES: usize = 6 * 1024 * 1024;


// ---- list / revoke (auth'd, by sender) --------------------------------------

pub async fn list_mine(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let reg = registry_stub(env)?;
    super::stub_passthrough(
        &reg,
        Method::Get,
        &format!("/secret-links/by-user?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await
}

pub async fn revoke(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let token = token_from_path(&req)?;
    let reg = registry_stub(env)?;

    #[derive(Deserialize)]
    struct DoResp { r2_keys: Vec<String> }
    let resp: DoResp = stub_json(
        &reg,
        Method::Post,
        "/secret-links/revoke",
        Some(serde_json::json!({
            "token": token,
            "sender_user_id": s.user_id,
        })),
    )
    .await?;

    delete_r2_keys(env, &resp.r2_keys).await;
    super::json_ok(&serde_json::json!({ "deleted_blobs": resp.r2_keys.len() }))
}

// ---- public viewer endpoints (unauthenticated) ------------------------------
//
// The path `/api/s/:token` and `/api/s/:token/open` are deliberately on the
// public surface — a recipient with the URL and the password is everything
// that should be required.

pub async fn view(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let token = token_from_view_path(&req)?;
    let reg = registry_stub(env)?;
    super::stub_passthrough(
        &reg,
        Method::Get,
        &format!("/secret-links/by-token?token={}", urlencoding::encode(&token)),
        None,
    )
    .await
}

/// Verifies the password and returns the link metadata + subject/body
/// ciphertext + the attachment manifest (with r2_keys). Attachment bytes
/// are NOT inlined — base64 inflation × 256 MiB is more than the worker
/// can hold in memory. The viewer follows up with one
/// `POST /api/s/:token/attachment` per file to stream the ciphertext.
///
/// `one_time` consumption: applied via `policy_expiry()` as a short
/// post-open grace window rather than an immediate revoke, so follow-up
/// attachment streams from this same /open succeed.
///
/// Self-destruct: when the DO returns 410 `self_destructed` (the 10th
/// failed unlock crossed the line), we delete the R2 attachment blobs
/// it tells us about before returning the 410 to the viewer.
pub async fn open(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let token = token_from_view_path(&req)?;
    #[derive(Deserialize)]
    struct OpenReq { password_check_b64: String }
    let body: OpenReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;

    let reg = registry_stub(env)?;
    forward_with_self_destruct_cleanup(
        env,
        &reg,
        Method::Post,
        "/secret-links/open",
        Some(serde_json::json!({
            "token": token,
            "password_check_b64": body.password_check_b64,
        })),
    )
    .await
}

/// Streams a single attachment's ciphertext from R2. Auth is the same
/// password-check value the viewer derived for /open; we re-verify it
/// against the row via `/secret-links/verify` (which DOESN'T touch the
/// open counter or policy state), then return the R2 object body
/// buffered as a single response.
///
/// Range support: `offset` + `length` in the request body limits the
/// fetch to a single chunk of the encrypted blob — used by the
/// streaming viewer to pull one framed chunk at a time and keep peak
/// memory low. Omit both to fetch the whole object (only safe for
/// ≤ ~95 MiB files; the chunked-aware viewer never does this).
pub async fn attachment(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let token = token_from_view_path(&req)?;
    #[derive(Deserialize)]
    struct AttReq {
        password_check_b64: String,
        r2_key: String,
        /// Optional byte range. When provided we issue a ranged R2 GET
        /// instead of fetching the full object.
        #[serde(default)]
        offset: Option<u64>,
        #[serde(default)]
        length: Option<u64>,
    }
    let body: AttReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    // Defense in depth: never let a single range read exceed one chunk's
    // worth of bytes — bounded worker memory.
    if let Some(len) = body.length {
        if len as usize > SECRET_MULTIPART_MAX_PART_BYTES {
            return Err(ApiError::BadRequest("length exceeds chunk limit".into()));
        }
    }

    let reg = registry_stub(env)?;
    // Same self-destruct handling as /open: if the verify call returns
    // 410 with `self_destructed: true`, sweep the R2 attachments before
    // propagating the failure to the viewer.
    let mut raw = forward_with_self_destruct_cleanup(
        env,
        &reg,
        Method::Post,
        "/secret-links/verify",
        Some(serde_json::json!({
            "token": token.clone(),
            "password_check_b64": body.password_check_b64,
        })),
    )
    .await?;
    if raw.status_code() != 200 {
        // Convert non-200 into the equivalent ApiError so the caller's
        // error-handling code matches the previous behavior.
        let status = raw.status_code();
        let text = raw.text().await.unwrap_or_default();
        return Err(match status {
            401 => ApiError::Unauthorized,
            410 => ApiError::Conflict(text),
            _ => ApiError::Internal(text),
        });
    }
    let verified: serde_json::Value = raw.json().await.map_err(ApiError::from)?;

    // r2_key must match one declared on the row — refuse to be a generic
    // proxy that streams arbitrary R2 objects.
    let atts = verified
        .get("attachments")
        .and_then(|v| v.as_array())
        .ok_or(ApiError::NotFound)?;
    let matched_mime = atts.iter().find_map(|a| {
        let k = a.get("r2_key").and_then(|v| v.as_str())?;
        if k == body.r2_key {
            Some(
                a.get("mime")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_string(),
            )
        } else {
            None
        }
    });
    let mime = match matched_mime {
        Some(m) => m,
        None => return Err(ApiError::NotFound),
    };

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let mut get = r2.get(&body.r2_key);
    if let (Some(offset), Some(length)) = (body.offset, body.length) {
        get = get.range(worker::Range::OffsetWithLength { offset, length });
    }
    let obj = get
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 get: {e}")))?
        .ok_or(ApiError::NotFound)?;
    // Stream the R2 object body directly to the recipient. Even though
    // we cap individual range requests at SECRET_MULTIPART_MAX_PART_BYTES,
    // streaming means the worker doesn't have to materialise the chunk
    // in JS memory — the runtime tees R2 → response without copying.
    let body_stream = obj
        .body()
        .ok_or_else(|| ApiError::Internal("R2 body".into()))?
        .response_body()
        .map_err(|e| ApiError::Internal(format!("R2 body stream: {e}")))?;
    let mut resp = Response::from_body(body_stream).map_err(ApiError::from)?;
    // Body is ciphertext; the viewer decrypts in-memory and presents
    // it under the real mime locally.
    let _ = resp.headers_mut().set("content-type", &mime);
    Ok(resp)
}

// ---- scheduled purge --------------------------------------------------------

/// Sweep expired/revoked secret links from the RegistryDO and delete the
/// matching R2 blobs. Called from the scheduled handler alongside the
/// nightly backup.
pub async fn run_purge(env: &Env) -> ApiResult<u32> {
    let reg = registry_stub(env)?;
    let mut total = 0u32;
    // Loop because the DO caps each purge at 500 rows.
    loop {
        #[derive(Deserialize)]
        struct PurgeResp { purged_rows: u32, r2_keys: Vec<String> }
        let resp: PurgeResp =
            stub_json(&reg, Method::Post, "/secret-links/purge", Some(serde_json::json!({})))
                .await?;
        if resp.purged_rows == 0 {
            break;
        }
        delete_r2_keys(env, &resp.r2_keys).await;
        total += resp.purged_rows;
        if resp.purged_rows < 500 { break; }
    }
    Ok(total)
}

// ---- helpers ----------------------------------------------------------------

/// Forward a request to the registry DO, then peek at the response: if it
/// describes a fresh self-destruct (status 410 + body has `r2_keys`),
/// delete those R2 attachment blobs synchronously before returning the
/// 410 to the original caller. Returns a Response with the original body
/// intact for the viewer to render the failure case.
async fn forward_with_self_destruct_cleanup(
    env: &Env,
    stub: &worker::Stub,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> ApiResult<Response> {
    let mut resp = super::stub_passthrough(stub, method, path, body).await?;
    if resp.status_code() != 410 {
        return Ok(resp);
    }
    // Drain + re-emit. We don't want to consume the body and then send a
    // body-less 410, so we read the bytes, parse them for r2_keys,
    // dispatch deletes, and rebuild the response.
    let bytes = resp.bytes().await.map_err(ApiError::from)?;
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        let is_destruct = json
            .get("self_destructed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_destruct {
            if let Some(arr) = json.get("r2_keys").and_then(|v| v.as_array()) {
                let keys: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                delete_r2_keys(env, &keys).await;
            }
        }
    }
    let mut out = Response::from_bytes(bytes).map_err(ApiError::from)?;
    out = out.with_status(410);
    let _ = out.headers_mut().set("content-type", "application/json");
    Ok(out)
}

async fn delete_r2_keys(env: &Env, keys: &[String]) {
    if keys.is_empty() { return; }
    let r2 = match env.bucket("BLOBS") {
        Ok(b) => b,
        Err(e) => {
            worker::console_log!("secret_links.r2_binding err={e}");
            return;
        }
    };
    for k in keys {
        if let Err(e) = r2.delete(k).await {
            worker::console_log!("secret_links.r2_orphan key={} err={}", k, e);
        }
    }
}

fn token_from_path(req: &HttpRequest) -> ApiResult<String> {
    // /api/secret/:token/revoke
    let path = req.uri().path().to_string();
    let rest = path
        .strip_prefix("/api/secret/")
        .ok_or_else(|| ApiError::BadRequest("path".into()))?;
    let token = rest
        .split('/')
        .next()
        .ok_or_else(|| ApiError::BadRequest("token".into()))?;
    Ok(token.to_string())
}

fn token_from_view_path(req: &HttpRequest) -> ApiResult<String> {
    // /api/s/:token  OR  /api/s/:token/open
    let path = req.uri().path().to_string();
    let rest = path
        .strip_prefix("/api/s/")
        .ok_or_else(|| ApiError::BadRequest("path".into()))?;
    let token = rest
        .split('/')
        .next()
        .ok_or_else(|| ApiError::BadRequest("token".into()))?;
    Ok(token.to_string())
}

#[allow(dead_code)]
fn url_param(qs: &str, name: &str) -> Option<String> {
    for pair in qs.split('&') {
        let mut it = pair.splitn(2, '=');
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            if k == name {
                return urlencoding::decode(v).ok().map(|s| s.into_owned());
            }
        }
    }
    None
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
