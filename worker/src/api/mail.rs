//! Threads, messages, send.

use serde::Deserialize;
use worker::*;

use api_types::{SendReq, SendResp};

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

// SendReq / AttachmentRef / SendResp are defined once in api-types and
// imported above. Same JSON shape; one less place to drift.

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

    // Hosted-attachment conversion used to happen here (server reading
    // attach/ bytes, copying to hosted/, splicing a link into the
    // body). That was incompatible with E2E hosted: the server can no
    // longer touch the bytes. The client now handles the hosted
    // upload + link-building entirely before calling /api/messages/send,
    // so by the time we get here the body already contains the
    // /d/<token>#k=<key> URL(s) and `attachments` is just the inline
    // MIME files.

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
                "filename_ct_b64": att.filename_ct_b64,
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
    //! Hand-rolled MIME builder.
    //!
    //! We don't use `mail-builder` because its `make_boundary` calls
    //! `SystemTime::now()`, which panics on wasm32-unknown-unknown (the
    //! Workers target has no clock std impl). Our footprint is small
    //! enough that a ~100-line builder beats forking the dep.

    use super::*;
    use rand_core::{OsRng, RngCore};

    pub(super) struct AttMeta {
        pub r2_key: String,
        pub mime: String,
        pub size: i64,
        pub filename_ct_b64: Option<String>,
    }

    pub(super) async fn send(
        env: &Env,
        _cfg: &AppConfig,
        req: &SendReq,
        message_id: &str,
        now_ms: i64,
    ) -> ApiResult<(String, Vec<AttMeta>)> {
        // Fetch attachment bytes from R2 so we can attach to outbound MIME.
        let r2 = env
            .bucket("BLOBS")
            .map_err(|e| ApiError::Internal(format!("R2 binding: {e}")))?;
        let mut atts: Vec<(String, String, Vec<u8>, i64, Option<String>)> = Vec::new();
        for att in &req.attachments {
            let obj = r2
                .get(&att.r2_key)
                .execute()
                .await
                .map_err(|e| ApiError::Internal(format!("R2 get: {e}")))?
                .ok_or_else(|| ApiError::NotFound)?;
            let bytes = obj
                .body()
                .ok_or_else(|| ApiError::Internal("R2 body".into()))?
                .bytes()
                .await
                .map_err(|e| ApiError::Internal(format!("R2 body bytes: {e}")))?;
            let size = bytes.len() as i64;
            atts.push((
                att.filename.clone(),
                att.mime.clone(),
                bytes,
                size,
                att.filename_ct_b64.clone(),
            ));
        }

        let raw = build_mime(req, message_id, now_ms, &atts);

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

        let meta: Vec<AttMeta> = atts
            .into_iter()
            .zip(req.attachments.iter())
            .map(|((_, mime, _, size, filename_ct_b64), att)| AttMeta {
                r2_key: att.r2_key.clone(),
                mime,
                size,
                filename_ct_b64,
            })
            .collect();
        Ok((message_id.to_string(), meta))
    }

    /// One MIME part: headers (no leading boundary, no trailing CRLF) and a
    /// body that's already encoded — base64 for leaves, raw multipart text
    /// for containers.
    struct Part {
        headers: String,
        body: String,
    }

    fn build_mime(
        req: &SendReq,
        message_id: &str,
        now_ms: i64,
        atts: &[(String, String, Vec<u8>, i64, Option<String>)],
    ) -> String {
        let body_part = match (req.html.as_deref(), atts.is_empty()) {
            (None, true) => text_part(&req.text),
            (Some(html), true) => alternative_part(&req.text, html),
            (None, false) => mixed_part(text_part(&req.text), atts),
            (Some(html), false) => mixed_part(alternative_part(&req.text, html), atts),
        };

        let mut out = String::new();
        out.push_str(&format!("Date: {}\r\n", rfc2822_date(now_ms)));
        out.push_str(&format!(
            "From: {}\r\n",
            fmt_address(req.from_name.as_deref(), &req.from)
        ));
        out.push_str(&format!("To: {}\r\n", join_addresses(&req.to)));
        if !req.cc.is_empty() {
            out.push_str(&format!("Cc: {}\r\n", join_addresses(&req.cc)));
        }
        out.push_str(&format!("Subject: {}\r\n", encode_header_value(&req.subject)));
        out.push_str(&format!("Message-ID: <{}>\r\n", message_id));
        if let Some(irt) = &req.in_reply_to {
            out.push_str(&format!("In-Reply-To: {}\r\n", irt));
        }
        if let Some(refs) = &req.references {
            out.push_str(&format!("References: {}\r\n", refs));
        }
        out.push_str("MIME-Version: 1.0\r\n");
        out.push_str(&body_part.headers);
        out.push_str("\r\n");
        out.push_str(&body_part.body);
        out
    }

    fn text_part(text: &str) -> Part {
        Part {
            headers: "Content-Type: text/plain; charset=utf-8\r\n\
                      Content-Transfer-Encoding: base64\r\n"
                .into(),
            body: base64_wrap(text.as_bytes()),
        }
    }

    fn html_part(html: &str) -> Part {
        Part {
            headers: "Content-Type: text/html; charset=utf-8\r\n\
                      Content-Transfer-Encoding: base64\r\n"
                .into(),
            body: base64_wrap(html.as_bytes()),
        }
    }

    fn attachment_part(mime: &str, filename: &str, bytes: &[u8]) -> Part {
        let safe = sanitize_filename(filename);
        Part {
            headers: format!(
                "Content-Type: {mime}; name=\"{safe}\"\r\n\
                 Content-Disposition: attachment; filename=\"{safe}\"\r\n\
                 Content-Transfer-Encoding: base64\r\n",
            ),
            body: base64_wrap(bytes),
        }
    }

    fn alternative_part(text: &str, html: &str) -> Part {
        wrap_multipart(
            "multipart/alternative",
            &[text_part(text), html_part(html)],
        )
    }

    fn mixed_part(
        first: Part,
        atts: &[(String, String, Vec<u8>, i64, Option<String>)],
    ) -> Part {
        let mut parts = Vec::with_capacity(1 + atts.len());
        parts.push(first);
        for (name, mime, bytes, _, _) in atts {
            parts.push(attachment_part(mime, name, bytes));
        }
        wrap_multipart("multipart/mixed", &parts)
    }

    fn wrap_multipart(content_type: &str, parts: &[Part]) -> Part {
        let boundary = make_boundary();
        let mut body = String::new();
        for p in parts {
            body.push_str(&format!("--{}\r\n", boundary));
            body.push_str(&p.headers);
            body.push_str("\r\n");
            body.push_str(&p.body);
            body.push_str("\r\n");
        }
        body.push_str(&format!("--{}--\r\n", boundary));
        Part {
            headers: format!(
                "Content-Type: {content_type}; boundary=\"{boundary}\"\r\n",
            ),
            body,
        }
    }

    fn make_boundary() -> String {
        let mut buf = [0u8; 18];
        OsRng.fill_bytes(&mut buf);
        format!("=_bmail_{}", crate::b64::url_encode(&buf))
    }

    /// Wrap base64 at 76 cols with CRLF, per RFC 2045.
    fn base64_wrap(bytes: &[u8]) -> String {
        let raw = crate::b64::std_encode(bytes);
        let mut out = String::with_capacity(raw.len() + raw.len() / 76 * 2);
        for (i, c) in raw.chars().enumerate() {
            if i > 0 && i % 76 == 0 {
                out.push_str("\r\n");
            }
            out.push(c);
        }
        out
    }

    fn rfc2822_date(now_ms: i64) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp(now_ms / 1000, 0)
            .unwrap_or_else(|| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap()
            })
            .to_rfc2822()
    }

    fn fmt_address(name: Option<&str>, addr: &str) -> String {
        match name {
            Some(n) if !n.is_empty() => {
                format!("{} <{}>", encode_header_value(n), addr)
            }
            _ => addr.to_string(),
        }
    }

    fn join_addresses(addrs: &[String]) -> String {
        addrs.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
    }

    /// RFC 2047 encoded-word for header values that need it (non-ASCII or
    /// control bytes). ASCII-only values pass through unchanged.
    fn encode_header_value(s: &str) -> String {
        if s.bytes().all(|b| b >= 0x20 && b < 0x7f) {
            return s.to_string();
        }
        format!("=?UTF-8?B?{}?=", crate::b64::std_encode(s.as_bytes()))
    }

    /// Filenames go inside quoted MIME parameters. Strip the few bytes that
    /// would break the quote or the header (CR, LF, quote, backslash).
    fn sanitize_filename(name: &str) -> String {
        name.chars()
            .filter(|c| !matches!(c, '\r' | '\n' | '"' | '\\'))
            .collect()
    }
}
