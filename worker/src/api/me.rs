use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{registry_stub, require_auth, stub_json};

pub async fn get(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = registry_stub(env)?;
    let user: crate::registry::UserView = stub_json(
        &stub,
        Method::Get,
        &format!("/me?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await?;
    super::json_ok(&user)
}

pub async fn patch(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: serde_json::Value =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let stub = registry_stub(env)?;
    let payload = serde_json::json!({
        "user_id": s.user_id,
        "display_name": body.get("display_name"),
    });
    super::stub_passthrough(&stub, Method::Patch, "/me/profile", Some(payload)).await
}

pub async fn list_addresses(
    req: HttpRequest,
    env: &Env,
    _cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = registry_stub(env)?;
    let addrs: Vec<String> = stub_json(
        &stub,
        Method::Get,
        &format!("/addresses?user_id={}", urlencoding::encode(&s.user_id)),
        None,
    )
    .await?;
    super::json_ok(&addrs)
}

/// Derived contact list for the authenticated user — the source data
/// for to/cc/bcc autocomplete in Compose. Proxies to MailboxDO which
/// scans the user's messages and dedupes by canonical address.
pub async fn list_contacts(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = super::mailbox_stub(env, &s.user_id)?;
    super::stub_passthrough(&stub, Method::Get, "/contacts", None).await
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
