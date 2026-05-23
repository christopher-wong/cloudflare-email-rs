use serde::{Deserialize, Serialize};
use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{registry_stub, require_admin_session, require_auth, stub_json, stub_passthrough};

#[derive(Deserialize)]
struct CreateInviteReq {
    handle: Option<String>,
    addresses: Vec<String>,
    #[serde(default)]
    is_admin: bool,
}

#[derive(Serialize)]
struct CreateInviteResp {
    token: String,
    enroll_url: String,
    handle: Option<String>,
    addresses: Vec<String>,
    is_admin: bool,
    expires_at: i64,
}

pub async fn create_invite(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_admin_session(&req, env).await?;
    let body: CreateInviteReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    for a in &body.addresses {
        if !cfg.owns_address(a) {
            return Err(ApiError::BadRequest(format!(
                "address {} not on a configured domain",
                a
            )));
        }
    }
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct R {
        token: String,
        handle: Option<String>,
        addresses: Vec<String>,
        is_admin: bool,
        expires_at: i64,
    }
    let r: R = stub_json(
        &stub,
        Method::Post,
        "/invites",
        Some(serde_json::json!({
            "handle": body.handle,
            "addresses": body.addresses,
            "is_admin": body.is_admin,
            "created_by": s.user_id,
        })),
    )
    .await?;
    super::json_ok(&CreateInviteResp {
        enroll_url: format!("https://{}/enroll?token={}", cfg.app_host, r.token),
        token: r.token,
        handle: r.handle,
        addresses: r.addresses,
        is_admin: r.is_admin,
        expires_at: r.expires_at,
    })
}

pub async fn list_invites(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    stub_passthrough(&registry_stub(env)?, Method::Get, "/invites", None).await
}

pub async fn list_users(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    stub_passthrough(&registry_stub(env)?, Method::Get, "/users", None).await
}

#[derive(Deserialize, Serialize)]
struct AddAddrReq { user_id: String, address: String }

pub async fn add_address(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let body: AddAddrReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    if !cfg.owns_address(&body.address) {
        return Err(ApiError::BadRequest("address not on configured domain".into()));
    }
    stub_passthrough(
        &registry_stub(env)?,
        Method::Post,
        "/addresses",
        Some(serde_json::to_value(&body).unwrap()),
    )
    .await
}

pub async fn remove_address(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let addr = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("address".into()))?;
    let path = format!("/addresses?address={}", urlencoding::encode(&addr));
    stub_passthrough(&registry_stub(env)?, Method::Delete, &path, None).await
}

pub async fn status(req: HttpRequest, env: &Env, cfg: &AppConfig) -> ApiResult<Response> {
    // Reachable without auth — returns whether bootstrap is needed and
    // the public app metadata. Used by the frontend on first load.
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    #[allow(dead_code)] struct U { id: String }
    let users: Vec<U> = stub_json(&stub, Method::Get, "/users", None).await?;
    let needs_bootstrap = users.is_empty();
    let is_authed = require_auth(&req, env).await.is_ok();
    super::json_ok(&serde_json::json!({
        "needs_bootstrap": needs_bootstrap,
        "is_authed": is_authed,
        "primary_domain": cfg.primary_domain,
        "additional_domains": cfg.additional_domains,
        "app_host": cfg.app_host,
        "app_name": cfg.app_name,
        "user_count": users.len(),
    }))
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
