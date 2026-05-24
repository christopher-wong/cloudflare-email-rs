//! Hosted-download path. End-to-end encrypted; server is blind to
//! contents and filenames.
//!
//! Threat model: Firefox Send / Wormhole.app. The decryption CEK is
//! generated client-side, embedded in the URL fragment after `#`, and
//! never transmitted to the server. R2 only sees ciphertext. The
//! `hosted_downloads` row only sees encrypted metadata (filename and
//! mime are sealed under the CEK).
//!
//! Anyone with the full URL `https://.../d/<token>#k=<cek>` can
//! decrypt; anyone with only the token (worker logs, traffic dumps)
//! cannot.
//!
//! Auth model:
//!   - Sender creation: standard cookie auth (`require_auth`).
//!   - Recipient access: token in URL is enough; the URL fragment is
//!     the decryption auth. Server gates on revoke/expire only.
//!
//! Lifecycle: 14-day TTL by default, sweepable via the scheduled purge
//! alongside secret_links. Sender can revoke at any time.

use serde::Deserialize;
use worker::*;

use api_types::{HostedCreateReq as CreateReq, HostedCreateResp as CreateResp};

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{registry_stub, require_auth, stub_json};

/// Default TTL for hosted downloads. Mirrored client-side as the "link
/// expires in N days" copy on the email body.
pub const HOSTED_TTL_DAYS: i64 = 14;

// HostedFile / CreateReq / CreateResp all live in api-types; imported above.

// ---- create (auth'd, by sender) --------------------------------------------

pub async fn create(mut req: HttpRequest, env: &Env, cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: CreateReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    if body.files.is_empty() {
        return Err(ApiError::BadRequest("at least one file required".into()));
    }
    let ttl_days = body.ttl_days.unwrap_or(HOSTED_TTL_DAYS).clamp(1, 30);

    // Validate every r2_key belongs to this user. Client uploads under
    // the unified pipeline land at `hosted/{user_id}/{uuid}`; refuse
    // anything else so a compromised client can't link to another
    // user's blobs.
    let prefix = format!("hosted/{}/", s.user_id);
    for f in &body.files {
        if !f.r2_key.starts_with(&prefix) {
            return Err(ApiError::BadRequest("file r2_key prefix mismatch".into()));
        }
    }

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
    let total_bytes: i64 = body.files.iter().map(|f| f.size).sum();

    #[derive(Deserialize)]
    struct DoResp { token: String, expires_at: i64 }
    let resp: DoResp = stub_json(
        &reg,
        Method::Post,
        "/hosted-downloads",
        Some(serde_json::json!({
            "sender_user_id": s.user_id,
            "sender_addr": sender_addr,
            "sender_name": sender_name,
            "recipient_addrs": body.recipient_addrs,
            "subject": body.subject,
            "files": body.files,
            "total_bytes": total_bytes,
            "ttl_days": ttl_days,
            "sender_cek_wrap_b64": body.sender_cek_wrap_b64,
        })),
    )
    .await?;

    let url_prefix = format!("https://{}/d/{}", cfg.app_host, resp.token);
    super::json_ok(&CreateResp {
        token: resp.token,
        url_prefix,
        expires_at: resp.expires_at,
    })
}

// ---- auth'd: list / revoke (sender) -----------------------------------------

pub async fn list_mine(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let reg = registry_stub(env)?;
    super::stub_passthrough(
        &reg,
        Method::Get,
        &format!("/hosted-downloads/by-user?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await
}

pub async fn revoke(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let path = req.uri().path().to_string();
    let token = path
        .strip_prefix("/api/hosted/")
        .and_then(|rest| rest.split('/').next())
        .ok_or_else(|| ApiError::BadRequest("token".into()))?
        .to_string();
    let reg = registry_stub(env)?;
    #[derive(Deserialize)]
    struct DoResp { r2_keys: Vec<String> }
    let resp: DoResp = stub_json(
        &reg,
        Method::Post,
        "/hosted-downloads/revoke",
        Some(serde_json::json!({
            "token": token,
            "sender_user_id": s.user_id,
        })),
    )
    .await?;
    delete_r2_keys(env, &resp.r2_keys).await;
    super::json_ok(&serde_json::json!({ "deleted_blobs": resp.r2_keys.len() }))
}

// ---- public: landing page metadata + download -------------------------------

pub async fn view(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let token = token_from_view_path(&req)?;
    let reg = registry_stub(env)?;
    super::stub_passthrough(
        &reg,
        Method::Get,
        &format!("/hosted-downloads/by-token?token={}", urlencoding::encode(&token)),
        None,
    )
    .await
}

/// Stream the ciphertext of one file from R2 to the recipient.
///
/// Server has no key, no filename, no mime — only the r2_key (which it
/// validates is referenced by this row) and HTTP Range support for
/// resumable downloads. The browser-side viewer reads the URL
/// fragment to get the CEK, fetches chunks via this endpoint, and
/// decrypts in JS before assembling a downloadable Blob.
pub async fn download(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let token = token_from_view_path(&req)?;
    let qs = req.uri().query().unwrap_or("").to_string();
    let r2_key = url_param(&qs, "r2_key")
        .ok_or_else(|| ApiError::BadRequest("r2_key required".into()))?;

    let reg = registry_stub(env)?;
    let meta: serde_json::Value = stub_json(
        &reg,
        Method::Get,
        &format!("/hosted-downloads/by-token?token={}", urlencoding::encode(&token)),
        None,
    )
    .await?;
    if meta.get("revoked").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(ApiError::Conflict("revoked".into()));
    }
    if meta.get("expired").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err(ApiError::Conflict("expired".into()));
    }
    let files = meta
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or(ApiError::NotFound)?;
    // r2_key must be listed on this row — refuse to be a generic
    // proxy for arbitrary R2 objects.
    let entry = files
        .iter()
        .find(|f| f.get("r2_key").and_then(|v| v.as_str()) == Some(r2_key.as_str()))
        .ok_or(ApiError::NotFound)?;
    let declared_total = entry.get("size").and_then(|v| v.as_i64());

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2 binding: {e}")))?;
    let mut get = r2.get(&r2_key);
    let mut range_header: Option<String> = None;
    let mut range_status: Option<u16> = None;
    if let Some(h) = req.headers().get("range").and_then(|v| v.to_str().ok()) {
        if let Some((offset, length, total_hint)) = parse_byte_range(h, declared_total) {
            get = get.range(worker::Range::OffsetWithLength { offset, length });
            range_header = Some(format!(
                "bytes {}-{}/{}",
                offset,
                offset + length - 1,
                total_hint,
            ));
            range_status = Some(206);
        }
    }
    let obj = get
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 get: {e}")))?
        .ok_or(ApiError::NotFound)?;
    let object_size = obj.size();
    let body = obj
        .body()
        .ok_or_else(|| ApiError::Internal("R2 body".into()))?
        .response_body()
        .map_err(|e| ApiError::Internal(format!("R2 body stream: {e}")))?;

    // Best-effort download counter bump.
    let _ = stub_json::<serde_json::Value>(
        &reg,
        Method::Post,
        "/hosted-downloads/bump",
        Some(serde_json::json!({ "token": token })),
    )
    .await;

    let mut resp = Response::from_body(body).map_err(ApiError::from)?;
    if let Some(status) = range_status {
        resp = resp.with_status(status);
    }
    let h = resp.headers_mut();
    // Always octet-stream — bytes are ciphertext, and we don't know
    // (or want to know) the real mime. The viewer creates a Blob
    // with the decrypted mime locally after decrypt.
    let _ = h.set("content-type", "application/octet-stream");
    let _ = h.set("accept-ranges", "bytes");
    let _ = h.set("content-length", &object_size.to_string());
    if let Some(cr) = range_header {
        let _ = h.set("content-range", &cr);
    }
    Ok(resp)
}

// ---- scheduled purge --------------------------------------------------------

pub async fn run_purge(env: &Env) -> ApiResult<u32> {
    let reg = registry_stub(env)?;
    let mut total = 0u32;
    loop {
        #[derive(Deserialize)]
        struct PurgeResp { purged_rows: u32, r2_keys: Vec<String> }
        let resp: PurgeResp = stub_json(
            &reg,
            Method::Post,
            "/hosted-downloads/purge",
            Some(serde_json::json!({})),
        )
        .await?;
        if resp.purged_rows == 0 {
            break;
        }
        delete_r2_keys(env, &resp.r2_keys).await;
        total += resp.purged_rows;
        if resp.purged_rows < 500 {
            break;
        }
    }
    Ok(total)
}

// ---- helpers ----------------------------------------------------------------

async fn delete_r2_keys(env: &Env, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let r2 = match env.bucket("BLOBS") {
        Ok(b) => b,
        Err(e) => {
            worker::console_log!("hosted.r2_binding err={e}");
            return;
        }
    };
    for k in keys {
        if let Err(e) = r2.delete(k).await {
            worker::console_log!("hosted.r2_orphan key={} err={}", k, e);
        }
    }
}

fn token_from_view_path(req: &HttpRequest) -> ApiResult<String> {
    let path = req.uri().path().to_string();
    let rest = path
        .strip_prefix("/api/d/")
        .ok_or_else(|| ApiError::BadRequest("path".into()))?;
    let token = rest
        .split('/')
        .next()
        .ok_or_else(|| ApiError::BadRequest("token".into()))?;
    Ok(token.to_string())
}

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

fn parse_byte_range(header: &str, declared_total: Option<i64>) -> Option<(u64, u64, i64)> {
    let s = header.trim().strip_prefix("bytes=")?;
    let mut parts = s.split('-');
    let start: u64 = parts.next()?.parse().ok()?;
    let end_str = parts.next()?;
    let total = declared_total.unwrap_or(i64::MAX) as u64;
    let end: u64 = if end_str.is_empty() {
        total.saturating_sub(1)
    } else {
        end_str.parse().ok()?
    };
    if end < start {
        return None;
    }
    let length = end - start + 1;
    Some((start, length, declared_total.unwrap_or(length as i64)))
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
