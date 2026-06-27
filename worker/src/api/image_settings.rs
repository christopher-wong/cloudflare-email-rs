//! Per-user remote-image settings.
//!
//! Remote images in inbound HTML email are blocked by default (opening an
//! email shouldn't fire a tracking pixel). This endpoint persists the user's
//! choices so they survive across devices:
//!
//!   * `load_by_default` — load remote images for every sender (still through
//!     the `/api/img` proxy, so the sender never sees the recipient's IP).
//!   * `domains` — an allowlist of sender domains the user has opted in via
//!     "Always load from this sender".
//!
//! Storage lives in the user's MailboxDO (see `mailbox.rs`). Every endpoint
//! returns the full, fresh settings object so the client can update in place.

use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{mailbox_stub, require_auth, stub_passthrough};

/// `GET /api/me/image-settings` → `{ load_by_default, domains }`.
pub async fn get(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    stub_passthrough(&stub, Method::Get, "/image-settings", None).await
}

/// `PUT /api/me/image-settings` with `{ load_by_default: bool }`.
pub async fn set_default(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/image-settings/default", Some(body)).await
}

/// `POST /api/me/image-settings/domains` with `{ domain: String }`.
pub async fn add_domain(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/image-settings/domains", Some(body)).await
}

/// `DELETE /api/me/image-settings/domains/{domain}`.
pub async fn remove_domain(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let domain = super::last_segment(&req).ok_or_else(|| ApiError::BadRequest("domain".into()))?;
    let path = format!("/image-settings/domains?domain={}", urlencoding::encode(&domain));
    stub_passthrough(&stub, Method::Delete, &path, None).await
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
