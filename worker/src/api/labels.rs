use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{mailbox_stub, require_auth, stub_passthrough};

pub async fn create(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/labels", Some(body)).await
}

pub async fn list(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    stub_passthrough(&stub, Method::Get, "/labels", None).await
}

pub async fn update(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("label id".into()))?;
    let mut body: serde_json::Value =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    body["id"] = serde_json::Value::String(id);
    stub_passthrough(&stub, Method::Patch, "/labels", Some(body)).await
}

pub async fn delete(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("label id".into()))?;
    let path = format!("/labels?id={}", urlencoding::encode(&id));
    stub_passthrough(&stub, Method::Delete, &path, None).await
}

pub async fn toggle(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let body: serde_json::Value =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    stub_passthrough(&stub, Method::Post, "/message-labels", Some(body)).await
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
