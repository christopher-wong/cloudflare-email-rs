//! Threads, messages, send.

use serde::{Deserialize, Serialize};
use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{mailbox_stub, require_auth, stub_json, stub_passthrough};

pub async fn list_threads(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let qs = req.uri().query().unwrap_or("");
    let path = if qs.is_empty() {
        "/threads".to_string()
    } else {
        format!("/threads?{qs}")
    };
    stub_passthrough(&stub, Method::Get, &path, None).await
}

pub async fn get_thread(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let tid = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("thread id".into()))?;
    let path = format!(
        "/threads/messages?thread_id={}",
        urlencoding::encode(&tid)
    );
    stub_passthrough(&stub, Method::Get, &path, None).await
}

/// Cascade-delete a thread: every message + attachment row in the DO, plus
/// the R2 blobs they reference (raw .eml ciphertext + attachment ciphertext).
pub async fn delete_thread(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let tid = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("thread id".into()))?;
    let path = format!("/threads?id={}", urlencoding::encode(&tid));

    #[derive(Deserialize)]
    struct DoResp { r2_keys: Vec<String> }
    let resp: DoResp = stub_json(&stub, Method::Delete, &path, None).await?;

    if !resp.r2_keys.is_empty() {
        let r2 = env
            .bucket("BLOBS")
            .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
        for key in &resp.r2_keys {
            if let Err(e) = r2.delete(key).await {
                // Best-effort: the DO row is already gone, so log and
                // continue. A dangling blob is preferable to surfacing a
                // partial-success error to the caller.
                worker::console_log!("delete_thread.r2_orphan key={} err={}", key, e);
            }
        }
    }

    super::json_ok(&serde_json::json!({ "deleted_blobs": resp.r2_keys.len() }))
}

/// Upgrade the request to a WebSocket and hand off to the user's
/// MailboxDO, which holds the connection (hibernatably) and broadcasts
/// new-message events when `email_in` and `send` insert messages.
pub async fn realtime(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let upgrade = req
        .headers()
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if upgrade != "websocket" {
        return Err(ApiError::BadRequest("expected websocket upgrade".into()));
    }
    let stub = mailbox_stub(env, &s.user_id)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    let headers = Headers::new();
    headers.set("Upgrade", "websocket").map_err(ApiError::from)?;
    init.with_headers(headers);
    let sub_req =
        Request::new_with_init("https://do/realtime", &init).map_err(ApiError::from)?;
    stub.fetch_with_request(sub_req).await.map_err(ApiError::from)
}

pub async fn patch_message(
    mut req: HttpRequest,
    env: &Env,
    _cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("message id".into()))?;
    let mut body: serde_json::Value =
        serde_json::from_slice(&body_bytes(&mut req).await?)?;
    body["id"] = serde_json::Value::String(id);
    stub_passthrough(&stub, Method::Patch, "/messages", Some(body)).await
}

pub async fn delete_message(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let stub = mailbox_stub(env, &s.user_id)?;
    let id = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("message id".into()))?;
    let path = format!("/messages?id={}", urlencoding::encode(&id));
    stub_passthrough(&stub, Method::Delete, &path, None).await
}

// ---- Send -------------------------------------------------------------
//
// Outbound = plaintext over SMTP (the recipient can't decrypt our E2E).
// We send via the `EMAIL` binding, then store an encrypted copy in the
// sender's mailbox by sealing the plaintext to the sender's own pubkey.

#[derive(Deserialize)]
struct SendReq {
    /// Sender address. Must be owned by the current user.
    from: String,
    /// Optional display name for the From header.
    from_name: Option<String>,
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    #[serde(default)]
    bcc: Vec<String>,
    subject: String,
    text: String,
    html: Option<String>,
    in_reply_to: Option<String>,
    references: Option<String>,
    /// Optional R2 keys for attachments (already uploaded via /api/attachments).
    #[serde(default)]
    attachment_r2_keys: Vec<String>,
}

#[derive(Serialize)]
struct SendResp {
    message_id: String,
    thread_id: String,
}

pub async fn send(mut req: HttpRequest, env: &Env, cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_auth(&req, env).await?;
    let body: SendReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;

    // Validate the sender owns the From address.
    let from_canon = crate::config::canonical_address(&body.from);
    if !cfg.owns_address(&from_canon) {
        return Err(ApiError::BadRequest(format!(
            "from address {} not on a configured domain",
            body.from
        )));
    }
    let reg = super::registry_stub(env)?;
    #[derive(Deserialize)]
    struct Owner { id: String, pub_key_b64: Option<String> }
    let owner: Owner = stub_json(
        &reg,
        Method::Get,
        &format!(
            "/users/by-address?address={}",
            urlencoding::encode(&from_canon)
        ),
        None,
    )
    .await?;
    if owner.id != s.user_id {
        return Err(ApiError::Forbidden);
    }
    let pub_key = owner
        .pub_key_b64
        .as_deref()
        .and_then(|s| crate::b64::url_decode(s).ok())
        .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
        .ok_or_else(|| ApiError::Internal("user has no pubkey".into()))?;

    // Build the outbound MIME and send via the binding.
    let message_id = format!("{}@{}", crate::ids::message(), domain_of(&body.from));
    let now_ms = Date::now().as_millis() as i64;
    let (sent_message_id, attachments_meta) =
        outbound::send(env, cfg, &body, &message_id, now_ms).await?;

    // Seal a copy for sender storage. Subject + body + each attachment.
    let subject_ct = crate::crypto::seal_to(&pub_key, body.subject.as_bytes())?;
    let body_ct = crate::crypto::seal_to(&pub_key, body.text.as_bytes())?;
    let snippet = make_snippet(&body.text);
    let snippet_ct = crate::crypto::seal_to(&pub_key, snippet.as_bytes())?;

    let mailbox = mailbox_stub(env, &s.user_id)?;
    let msg_id = crate::ids::message();
    let insert = serde_json::json!({
        "id": msg_id,
        "thread_id": null,
        "message_id": sent_message_id,
        "in_reply_to": body.in_reply_to,
        "references": body.references,
        "from_addr": from_canon,
        "from_name": body.from_name,
        "to_addrs": body.to,
        "cc_addrs": body.cc,
        "bcc_addrs": body.bcc,
        "sent_at": now_ms,
        "direction": "out",
        "snippet_ct_b64": crate::b64::url_encode(&snippet_ct),
        "subject_ct_b64": crate::b64::url_encode(&subject_ct),
        "body_ct_b64": crate::b64::url_encode(&body_ct),
        "raw_r2_key": null,
        "size_bytes": (body.subject.len() + body.text.len()) as i64,
    });
    #[derive(Deserialize)]
    struct Inserted { thread_id: String }
    let ins: Inserted =
        stub_json(&mailbox, Method::Post, "/messages", Some(insert)).await?;

    // Register attachment metadata on the message.
    for att in attachments_meta {
        let _: serde_json::Value = stub_json(
            &mailbox,
            Method::Post,
            "/attachments",
            Some(serde_json::json!({
                "id": crate::ids::attachment(),
                "message_id": msg_id,
                "draft_id": null,
                "r2_key": att.r2_key,
                "filename_ct_b64": null,
                "mime": att.mime,
                "size_bytes": att.size,
            })),
        )
        .await?;
    }

    // Realtime push to any open tabs. Best-effort — the message is sent
    // and stored regardless.
    let _ = stub_json::<serde_json::Value>(
        &mailbox,
        Method::Post,
        "/notify",
        Some(serde_json::json!({
            "type": "message.new",
            "direction": "out",
            "msg_id": msg_id,
            "thread_id": ins.thread_id,
        })),
    )
    .await;

    super::json_ok(&SendResp {
        message_id: sent_message_id,
        thread_id: ins.thread_id,
    })
}

fn make_snippet(text: &str) -> String {
    text.chars().take(140).collect()
}

fn domain_of(addr: &str) -> &str {
    addr.rsplit_once('@').map(|(_, d)| d).unwrap_or("local")
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

mod outbound {
    use super::*;

    pub(super) struct AttMeta {
        pub r2_key: String,
        pub mime: String,
        pub size: i64,
    }

    pub(super) async fn send(
        env: &Env,
        _cfg: &AppConfig,
        req: &SendReq,
        message_id: &str,
        now_ms: i64,
    ) -> ApiResult<(String, Vec<AttMeta>)> {
        use mail_builder::MessageBuilder;

        // Fetch attachment bytes from R2 so we can attach to outbound MIME.
        let r2 = env
            .bucket("BLOBS")
            .map_err(|e| ApiError::Internal(format!("R2 binding: {e}")))?;
        let mut atts: Vec<(String, String, Vec<u8>, i64)> = Vec::new();
        for key in &req.attachment_r2_keys {
            let obj = r2
                .get(key)
                .execute()
                .await
                .map_err(|e| ApiError::Internal(format!("R2 get: {e}")))?
                .ok_or_else(|| ApiError::NotFound)?;
            let mime = obj
                .http_metadata()
                .content_type
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let bytes = obj
                .body()
                .ok_or_else(|| ApiError::Internal("R2 body".into()))?
                .bytes()
                .await
                .map_err(|e| ApiError::Internal(format!("R2 body bytes: {e}")))?;
            let size = bytes.len() as i64;
            let name = key.rsplit('/').next().unwrap_or("attachment").to_string();
            atts.push((name, mime.clone(), bytes, size));
        }

        // Compose MIME.
        let mut builder = MessageBuilder::new()
            .from((req.from_name.as_deref().unwrap_or(""), req.from.as_str()))
            .to(req
                .to
                .iter()
                .map(|a| ("", a.as_str()))
                .collect::<Vec<_>>())
            .subject(req.subject.as_str())
            .date(now_ms / 1000)
            .message_id(message_id)
            .text_body(req.text.as_str());
        if !req.cc.is_empty() {
            builder = builder.cc(req.cc.iter().map(|a| ("", a.as_str())).collect::<Vec<_>>());
        }
        if !req.bcc.is_empty() {
            builder = builder.bcc(req.bcc.iter().map(|a| ("", a.as_str())).collect::<Vec<_>>());
        }
        if let Some(html) = &req.html {
            builder = builder.html_body(html.as_str());
        }
        if let Some(irt) = &req.in_reply_to {
            builder = builder.in_reply_to(irt.as_str());
        }
        if let Some(refs) = &req.references {
            builder = builder.references(refs.as_str());
        }
        for (name, mime, bytes, _) in &atts {
            builder = builder.attachment(mime.as_str(), name.as_str(), bytes.as_slice());
        }
        let raw = builder
            .write_to_string()
            .map_err(|e| ApiError::Internal(format!("mime build: {e}")))?;

        // Send via binding. We send to To+Cc+Bcc; bcc recipients are not in
        // headers, the binding just delivers to them.
        let sender = env
            .send_email("EMAIL")
            .map_err(|e| ApiError::Internal(format!("EMAIL binding: {e}")))?;
        let mut all_rcpts: Vec<&str> = req.to.iter().map(|s| s.as_str()).collect();
        all_rcpts.extend(req.cc.iter().map(|s| s.as_str()));
        all_rcpts.extend(req.bcc.iter().map(|s| s.as_str()));
        for rcpt in all_rcpts {
            // EmailMessage / sender errors are `js_sys::Error` which doesn't
            // implement Display — funnel through worker::Error which does.
            let msg = EmailMessage::new(&req.from, rcpt, &raw)
                .map_err(|e| ApiError::Internal(format!("EmailMessage: {}", worker::Error::from(e))))?;
            sender
                .send(&msg)
                .await
                .map_err(|e| ApiError::Internal(format!("send: {}", worker::Error::from(e))))?;
        }

        let meta = atts
            .into_iter()
            .zip(req.attachment_r2_keys.iter())
            .map(|((_, mime, _, size), key)| AttMeta {
                r2_key: key.clone(),
                mime,
                size,
            })
            .collect();
        Ok((message_id.to_string(), meta))
    }
}
