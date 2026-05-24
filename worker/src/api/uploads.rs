//! The one true upload pipeline.
//!
//! All three file flows — regular email attachments, hosted downloads,
//! secret-link ciphertext — funnel through this module. The differences
//! are encoded in `kind` at init time:
//!
//!  * `attach`  → stored at `attach/{user_id}/{uuid}`. On /complete the
//!                worker also registers a row in the user's MailboxDO so
//!                drafts and outbound MIME can find it.
//!  * `hosted`  → stored at `hosted/{user_id}/{uuid}`. No DO row — the
//!                hosted_downloads row in RegistryDO references it.
//!  * `secret`  → stored at `secret/{user_id}/{uuid}`. No DO row — the
//!                secret_links row in RegistryDO references it. Bytes
//!                are expected to be ciphertext (client encrypts per
//!                chunk before upload).
//!
//! Wire shape mirrors a stripped-down R2 multipart API:
//!
//!   POST /api/uploads/init      → { r2_key, upload_id }
//!   POST /api/uploads/parts     → { part_number, etag }  (raw bytes body)
//!   POST /api/uploads/complete  → { r2_key, size, attachment_id? }
//!   POST /api/uploads/abort     → { ok }
//!
//! Single-shot upload becomes "multipart with one part." R2 allows that
//! provided you have at least one part (which can be smaller than the
//! 5 MiB minimum if it's the last/only part).

use worker::*;

use api_types::{
    UploadAbortReq, UploadCompleteReq, UploadInitReq, UploadKind,
};

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{mailbox_stub, require_auth, AuthedSession};

/// Recommended per-chunk plaintext size for the client. Pick this so the
/// ciphertext lands at or just above R2's 5-MiB minimum for non-final
/// parts. Mirrors `secret_link.ts::SECRET_CHUNK_PLAINTEXT_BYTES`.
#[allow(dead_code)]
pub const UPLOAD_RECOMMENDED_CHUNK_BYTES: usize = 5 * 1024 * 1024;
/// Per-part upload size ceiling. Protects worker memory from a hostile
/// client posting a giant single part.
pub const UPLOAD_MAX_PART_BYTES: usize = 6 * 1024 * 1024;

// ---- init -------------------------------------------------------------------

pub async fn init(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: UploadInitReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2 binding: {e}")))?;
    let id = crate::ids::attachment();
    let key = format!("{}/{}/{}", body.kind.r2_prefix(), s.user_id, id);
    let upload = r2
        .create_multipart_upload(&key)
        .http_metadata(HttpMetadata {
            content_type: body
                .mime
                .or_else(|| Some("application/octet-stream".into())),
            ..Default::default()
        })
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 create_multipart_upload: {e}")))?;
    let upload_id = upload.upload_id().await;
    super::json_ok(&serde_json::json!({
        "r2_key": key,
        "upload_id": upload_id,
    }))
}

// ---- part -------------------------------------------------------------------

pub async fn part(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let r2_key = header_str(&req, "x-r2-key")?;
    let upload_id = header_str(&req, "x-upload-id")?;
    let part_number: u16 = header_str(&req, "x-part-number")?
        .parse()
        .map_err(|_| ApiError::BadRequest("x-part-number must be u16".into()))?;
    if part_number == 0 {
        return Err(ApiError::BadRequest("x-part-number must be ≥ 1".into()));
    }
    require_owns(&s, &r2_key)?;

    // Pre-flight: bail before draining the body if the declared length
    // already blows the per-part ceiling.
    if let Some(declared) = req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
    {
        if declared > UPLOAD_MAX_PART_BYTES {
            return Err(ApiError::BadRequest(format!(
                "part too large: {} MiB max",
                UPLOAD_MAX_PART_BYTES / (1024 * 1024)
            )));
        }
    }

    let bytes = {
        use http_body_util::BodyExt;
        let raw = std::mem::replace(req.body_mut(), worker::Body::empty());
        let collected = raw
            .collect()
            .await
            .map_err(|e| ApiError::BadRequest(format!("body: {e}")))?;
        collected.to_bytes().to_vec()
    };
    if bytes.len() > UPLOAD_MAX_PART_BYTES {
        return Err(ApiError::BadRequest("part exceeds max size".into()));
    }

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let upload = r2
        .resume_multipart_upload(&r2_key, &upload_id)
        .map_err(|e| ApiError::Internal(format!("resume_multipart_upload: {e}")))?;
    let uploaded = upload
        .upload_part(part_number, bytes)
        .await
        .map_err(|e| ApiError::Internal(format!("upload_part: {e}")))?;
    super::json_ok(&serde_json::json!({
        "part_number": uploaded.part_number(),
        "etag": uploaded.etag(),
    }))
}

// ---- complete ---------------------------------------------------------------

pub async fn complete(
    mut req: HttpRequest,
    env: &Env,
    _cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: UploadCompleteReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    require_owns(&s, &body.r2_key)?;
    if body.parts.is_empty() {
        return Err(ApiError::BadRequest("no parts to complete".into()));
    }

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let upload = r2
        .resume_multipart_upload(&body.r2_key, &body.upload_id)
        .map_err(|e| ApiError::Internal(format!("resume_multipart_upload: {e}")))?;
    let parts: Vec<worker::UploadedPart> = body
        .parts
        .iter()
        .map(|p| worker::UploadedPart::new(p.part_number, p.etag.clone()))
        .collect();
    upload
        .complete(parts)
        .await
        .map_err(|e| ApiError::Internal(format!("complete: {e}")))?;

    // Kind-specific post-complete bookkeeping. The only branch that
    // needs anything is `attach`: register the file in the user's
    // MailboxDO so drafts and outbound MIME can discover it.
    let kind = UploadKind::from_key(&body.r2_key)
        .ok_or_else(|| ApiError::BadRequest("unknown r2_key prefix".into()))?;
    let mut out = serde_json::json!({
        "r2_key": body.r2_key,
        "size": body.size,
    });
    if matches!(kind, UploadKind::Attach) {
        let attachment_id = crate::ids::attachment();
        let mailbox = mailbox_stub(env, &s.user_id)?;
        let _: serde_json::Value = super::stub_json(
            &mailbox,
            Method::Post,
            "/attachments",
            Some(serde_json::json!({
                "id": attachment_id,
                "message_id": null,
                "draft_id": body.draft_id,
                "r2_key": body.r2_key,
                "filename_ct_b64": body.filename_ct_b64,
                "mime": body.mime.clone().unwrap_or_else(|| "application/octet-stream".into()),
                "size_bytes": body.size,
            })),
        )
        .await?;
        if let Some(obj) = out.as_object_mut() {
            obj.insert("attachment_id".into(), attachment_id.into());
            obj.insert(
                "mime".into(),
                body.mime
                    .unwrap_or_else(|| "application/octet-stream".into())
                    .into(),
            );
        }
    }
    super::json_ok(&out)
}

// ---- abort ------------------------------------------------------------------

pub async fn abort(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: UploadAbortReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    require_owns(&s, &body.r2_key)?;
    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let upload = r2
        .resume_multipart_upload(&body.r2_key, &body.upload_id)
        .map_err(|e| ApiError::Internal(format!("resume_multipart_upload: {e}")))?;
    upload
        .abort()
        .await
        .map_err(|e| ApiError::Internal(format!("abort: {e}")))?;
    super::json_ok(&serde_json::json!({ "ok": true }))
}

// ---- helpers ----------------------------------------------------------------

fn header_str(req: &HttpRequest, name: &str) -> ApiResult<String> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| ApiError::BadRequest(format!("missing header: {name}")))
}

/// The R2 key must belong to the authenticated user — the second path
/// segment carries `user_id`. This prevents a compromised client from
/// uploading parts into another user's in-flight multipart upload.
fn require_owns(s: &AuthedSession, r2_key: &str) -> ApiResult<()> {
    let mut parts = r2_key.split('/');
    let _prefix = parts
        .next()
        .ok_or_else(|| ApiError::BadRequest("malformed r2_key".into()))?;
    let user = parts
        .next()
        .ok_or_else(|| ApiError::BadRequest("malformed r2_key".into()))?;
    if user != s.user_id {
        return Err(ApiError::Forbidden);
    }
    Ok(())
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
