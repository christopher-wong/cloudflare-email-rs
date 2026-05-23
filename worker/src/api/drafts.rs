use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{mailbox_stub, require_auth, stub_passthrough};

pub async fn upsert(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/drafts", Some(body)).await
}

pub async fn list(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    stub_passthrough(&stub, Method::Get, "/drafts", None).await
}

pub async fn delete(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("draft id".into()))?;
    let path = format!("/drafts?id={}", urlencoding::encode(&id));
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
