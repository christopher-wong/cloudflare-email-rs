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

pub async fn upload(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let qs = req.uri().query().unwrap_or("").to_string();
    let mime = url_param(&qs, "mime").unwrap_or_else(|| "application/octet-stream".into());
    let filename_ct_b64 = url_param(&qs, "filename_ct_b64");
    let draft_id = url_param(&qs, "draft_id");

    let body = {
        use http_body_util::BodyExt;
        let raw = std::mem::replace(req.body_mut(), worker::Body::empty());
        let collected = raw
            .collect()
            .await
            .map_err(|e| ApiError::BadRequest(format!("body: {e}")))?;
        collected.to_bytes().to_vec()
    };
    let size = body.len() as i64;

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2 binding: {e}")))?;
    let id = crate::ids::attachment();
    let key = format!("attach/{}/{}", s.user_id, id);
    r2.put(&key, body)
        .http_metadata(HttpMetadata {
            content_type: Some(mime.clone()),
            ..Default::default()
        })
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 put: {e}")))?;

    // Register in mailbox (unattached to a message until send).
    let stub = mailbox_stub(env, &s.user_id)?;
    let _: serde_json::Value = super::stub_json(
        &stub,
        Method::Post,
        "/attachments",
        Some(serde_json::json!({
            "id": id,
            "message_id": null,
            "draft_id": draft_id,
            "r2_key": key,
            "filename_ct_b64": filename_ct_b64,
            "mime": mime,
            "size_bytes": size,
        })),
    )
    .await?;

    super::json_ok(&serde_json::json!({
        "id": id,
        "r2_key": key,
        "size_bytes": size,
        "mime": mime,
    }))
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
