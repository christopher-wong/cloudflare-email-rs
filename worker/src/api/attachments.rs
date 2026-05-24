//! Attachment storage on R2. The client encrypts the bytes before upload —
//! the worker stores the opaque ciphertext blob and a metadata row in the
//! user's MailboxDO. Cleartext mime + size + R2 key are kept for routing
//! and for outbound MIME assembly when the user later sends.
//!
//! Path scheme: `attach/{user_id}/{uuid}` so we can list/clean per user.

use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{mailbox_stub, require_auth};

/// List attachments for a single message. The frontend hits this once
/// per thread render and decrypts filenames client-side.
pub async fn list_for_message(
    req: HttpRequest,
    env: &Env,
    _cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    // Path is /api/messages/:id/attachments — split the second-to-last
    // segment out instead of using last_segment.
    let path = req.uri().path().to_string();
    let msg_id = path
        .strip_prefix("/api/messages/")
        .and_then(|rest| rest.strip_suffix("/attachments"))
        .ok_or_else(|| ApiError::BadRequest("message id".into()))?
        .to_string();
    let stub = mailbox_stub(env, &s.user_id)?;
    let path = format!("/attachments?message_id={}", urlencoding::encode(&msg_id));
    super::stub_passthrough(&stub, Method::Get, &path, None).await
}

pub async fn download(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("attachment id".into()))?;
    let key = format!("attach/{}/{}", s.user_id, id);
    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let obj = r2
        .get(&key)
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 get: {e}")))?
        .ok_or(ApiError::NotFound)?;
    let bytes = obj
        .body()
        .ok_or_else(|| ApiError::Internal("R2 body".into()))?
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 body: {e}")))?;
    let mime = obj
        .http_metadata()
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let mut resp = Response::from_bytes(bytes).map_err(ApiError::from)?;
    let _ = resp.headers_mut().set("content-type", &mime);
    Ok(resp)
}

pub async fn delete(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("attachment id".into()))?;
    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let key = format!("attach/{}/{}", s.user_id, id);
    r2.delete(&key)
        .await
        .map_err(|e| ApiError::Internal(format!("R2 delete: {e}")))?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let path = format!("/attachments?id={}", urlencoding::encode(&id));
    super::stub_passthrough(&stub, Method::Delete, &path, None).await
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
