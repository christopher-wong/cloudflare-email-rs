//! APNs device-token registration endpoints.
//!
//! The client posts its APNs token (+ environment) after the OS grants push
//! permission; we store it per-user in the MailboxDO. The actual push send on
//! inbound mail lives in `crate::push` (called from the email handler).

use worker::*;

use crate::config::AppConfig;
use crate::error::ApiResult;

use super::{mailbox_stub, require_auth, stub_passthrough};

pub async fn register(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/push/register", Some(body)).await
}

pub async fn unregister(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/push/unregister", Some(body)).await
}

async fn body_bytes(req: &mut HttpRequest) -> ApiResult<Vec<u8>> {
    use http_body_util::BodyExt;
    let body = std::mem::replace(req.body_mut(), worker::Body::empty());
    let collected = body
        .collect()
        .await
        .map_err(|e| crate::error::ApiError::BadRequest(format!("body: {e}")))?;
    Ok(collected.to_bytes().to_vec())
}
