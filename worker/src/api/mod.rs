//! HTTP API surface. Each submodule owns a slice of the routes; the dispatch
//! itself lives in `router.rs`.

pub mod admin;
pub mod attachments;
pub mod auth;
pub mod drafts;
pub mod labels;
pub mod mail;
pub mod hosted;
pub mod img;
pub mod me;
pub mod misc;
pub mod orphan;
pub mod passkeys;
pub mod secret;
pub mod uploads;

use serde::{Deserialize, Serialize};
use worker::*;

use crate::error::{ApiError, ApiResult};
use crate::session;

/// Authenticated session resolved from the request cookie.
pub struct AuthedSession {
    pub user_id: String,
    pub is_admin: bool,
    #[allow(dead_code)]
    pub handle: String,
}

#[derive(Deserialize)]
struct SessionLookupResp {
    user_id: String,
    is_admin: bool,
    handle: String,
    #[allow(dead_code)]
    display_name: Option<String>,
}

pub async fn require_auth(req: &HttpRequest, env: &Env) -> ApiResult<AuthedSession> {
    let sid = session::require_sid(req)?;
    let reg = registry_stub(env)?;
    let lookup_req = Request::new_with_init(
        &format!("https://reg/sessions/lookup?sid={}", urlencoding::encode(&sid)),
        &RequestInit::default(),
    )
    .map_err(crate::error::ApiError::from)?;
    let mut resp = reg
        .fetch_with_request(lookup_req)
        .await
        .map_err(crate::error::ApiError::from)?;
    if resp.status_code() != 200 {
        return Err(ApiError::Unauthorized);
    }
    let r: SessionLookupResp = resp.json().await.map_err(crate::error::ApiError::from)?;
    Ok(AuthedSession {
        user_id: r.user_id,
        is_admin: r.is_admin,
        handle: r.handle,
    })
}

pub async fn require_admin_session(req: &HttpRequest, env: &Env) -> ApiResult<AuthedSession> {
    let s = require_auth(req, env).await?;
    if !s.is_admin {
        return Err(ApiError::Forbidden);
    }
    Ok(s)
}

pub fn registry_stub(env: &Env) -> ApiResult<worker::Stub> {
    let ns = env.durable_object("REGISTRY").map_err(ApiError::from)?;
    let id = ns.id_from_name("registry").map_err(ApiError::from)?;
    id.get_stub().map_err(ApiError::from)
}

pub fn mailbox_stub(env: &Env, user_id: &str) -> ApiResult<worker::Stub> {
    let ns = env.durable_object("MAILBOX").map_err(ApiError::from)?;
    let id = ns.id_from_name(user_id).map_err(ApiError::from)?;
    id.get_stub().map_err(ApiError::from)
}

/// Helper: fetch a Stub with a JSON body. Returns the deserialized response.
pub async fn stub_json<R: serde::de::DeserializeOwned>(
    stub: &worker::Stub,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> ApiResult<R> {
    let url = format!("https://do{}", path);
    let mut init = RequestInit::new();
    init.with_method(method);
    if let Some(b) = body {
        init.with_body(Some(serde_json::to_string(&b)?.into()));
        let headers = Headers::new();
        headers
            .set("content-type", "application/json")
            .map_err(ApiError::from)?;
        init.with_headers(headers);
    }
    let req = Request::new_with_init(&url, &init).map_err(ApiError::from)?;
    let mut resp = stub.fetch_with_request(req).await.map_err(ApiError::from)?;
    if resp.status_code() >= 400 {
        let msg = resp.text().await.unwrap_or_default();
        return Err(match resp.status_code() {
            401 => ApiError::Unauthorized,
            403 => ApiError::Forbidden,
            404 => ApiError::NotFound,
            409 | 410 => ApiError::Conflict(msg),
            400 => ApiError::BadRequest(msg),
            _ => ApiError::Internal(msg),
        });
    }
    resp.json().await.map_err(ApiError::from)
}

/// As `stub_json` but returning the raw `worker::Response` for pass-through.
pub async fn stub_passthrough(
    stub: &worker::Stub,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> ApiResult<Response> {
    let url = format!("https://do{}", path);
    let mut init = RequestInit::new();
    init.with_method(method);
    if let Some(b) = body {
        init.with_body(Some(serde_json::to_string(&b)?.into()));
        let headers = Headers::new();
        headers
            .set("content-type", "application/json")
            .map_err(ApiError::from)?;
        init.with_headers(headers);
    }
    let req = Request::new_with_init(&url, &init).map_err(ApiError::from)?;
    stub.fetch_with_request(req).await.map_err(ApiError::from)
}

pub fn json_ok<T: Serialize>(v: &T) -> ApiResult<Response> {
    Response::from_json(v).map_err(ApiError::from)
}

/// Build a URL path from a request, returning the last path segment (used
/// for routes like `/api/messages/:id`).
pub fn last_segment(req: &HttpRequest) -> Option<String> {
    req.uri().path().rsplit('/').next().map(|s| s.to_string())
}

/// Drain the incoming HTTP request body into bytes.
///
/// On the `http` feature, `req.body()` is a `worker::Body` that implements
/// `http_body::Body`. We use `BodyExt::collect()` to buffer it, then flatten
/// the resulting `Bytes` into a `Vec<u8>`. Currently unused — each api module
/// has its own `body_bytes(&mut req)` helper that keeps `req` borrowable for
/// header reads.
#[allow(dead_code)]
pub async fn read_body(req: HttpRequest) -> ApiResult<Vec<u8>> {
    use http_body_util::BodyExt;
    let (_parts, body) = req.into_parts();
    let collected = body
        .collect()
        .await
        .map_err(|e| ApiError::BadRequest(format!("body read: {e}")))?;
    Ok(collected.to_bytes().to_vec())
}
