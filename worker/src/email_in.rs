//! Inbound email handler.
//!
//! 1. Parse the raw MIME with `mail-parser`.
//! 2. For each canonical recipient that we own, look up the user via
//!    RegistryDO and fetch their X25519 public key.
//! 3. Seal the subject + text body + html + each attachment to that user's
//!    pubkey (NaCl-style sealed box — server never holds a private key).
//! 4. Store ciphertext attachments in R2; write a row to the user's
//!    MailboxDO with cleartext routing metadata + ciphertext blobs.
//!
//! Same email addressed to multiple owned recipients fan-outs to each user's
//! mailbox independently. Plus-addressing canonicalizes before lookup.

use mail_parser::{MessageParser, MimeHeaders};
use serde::Deserialize;
use worker::*;

use crate::api;
use crate::b64;
use crate::config::{canonical_address, AppConfig};
use crate::error::{ApiError, ApiResult};

pub async fn handle(message: ForwardableEmailMessage, env: Env, ctx: Context) -> Result<()> {
    let cfg = match AppConfig::load(&env) {
        Ok(c) => c,
        Err(e) => {
            console_error!("config load: {}", e);
            return Ok(());
        }
    };
    if let Err(e) = handle_impl(message, env, ctx, cfg).await {
        console_error!("email_in: {}", e);
    }
    Ok(())
}

async fn handle_impl(
    message: ForwardableEmailMessage,
    env: Env,
    _ctx: Context,
    cfg: AppConfig,
) -> ApiResult<()> {
    let raw = message
        .raw_bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("raw_bytes: {e}")))?;
    let parsed = MessageParser::default()
        .parse(&raw[..])
        .ok_or_else(|| ApiError::BadRequest("MIME parse failed".into()))?;

    let envelope_to = message.to();
    let envelope_from = message.from();

    // Determine the set of *owned* recipients. Header To/Cc are unreliable —
    // we use the envelope RCPT TO from `message.to`. (Cloudflare Email
    // Routing calls the handler once per envelope-recipient, so this should
    // typically be a single address; the loop is defensive.)
    let raw_to = envelope_to.to_string();
    let raw_from = envelope_from.to_string();
    let header_subject = parsed.subject().unwrap_or("").to_string();
    let header_message_id = parsed.message_id().unwrap_or("").to_string();
    let raw_size = raw.len();
    console_log!(
        "email_in.received from={} to={} subject={:?} message_id={} size={}",
        raw_from,
        raw_to,
        header_subject,
        header_message_id,
        raw_size,
    );
    let recipients: Vec<String> = vec![raw_to.clone()]
        .into_iter()
        .map(|a| canonical_address(&a))
        .filter(|a| cfg.owns_address(a))
        .collect();
    if recipients.is_empty() {
        // Not for us — let it drop. (We could `message.forward()` to a
        // configured catch-all, but for now drop is the safe default.)
        console_log!(
            "email_in.dropped reason=not-owned from={} to={} message_id={}",
            raw_from,
            raw_to,
            header_message_id,
        );
        return Ok(());
    }

    let subject = parsed.subject().unwrap_or("").to_string();
    let text_body = parsed.body_text(0).map(|s| s.to_string()).unwrap_or_default();
    let html_body = parsed.body_html(0).map(|s| s.to_string());
    let snippet: String = text_body.chars().take(140).collect();
    let message_id = parsed
        .message_id()
        .map(|s| strip_angle(s))
        .unwrap_or_else(|| format!("{}@{}", crate::ids::message(), cfg.primary_domain));
    let in_reply_to = parsed
        .in_reply_to()
        .as_text()
        .map(strip_angle)
        .filter(|s| !s.is_empty());
    let references = parsed
        .references()
        .as_text_list()
        .map(|v| {
            v.iter()
                .map(|r| strip_angle(r))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        });
    let header_from_addr = parsed
        .from()
        .and_then(|f| f.first())
        .and_then(|a| a.address())
        .map(|s| s.to_string())
        .unwrap_or_else(|| raw_from.clone());
    let from_name = parsed
        .from()
        .and_then(|f| f.first())
        .and_then(|a| a.name())
        .map(|s| s.to_string());
    let header_to: Vec<String> = parsed
        .to()
        .as_ref()
        .map(|list| {
            list.iter()
                .filter_map(|a| a.address())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let header_cc: Vec<String> = parsed
        .cc()
        .as_ref()
        .map(|list| {
            list.iter()
                .filter_map(|a| a.address())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    let sent_at = parsed
        .date()
        .map(|d| d.to_timestamp() * 1000)
        .unwrap_or(Date::now().as_millis() as i64);

    // Collect attachments once; we encrypt + upload per-recipient (small fan-out).
    let mut attachments: Vec<Att> = Vec::new();
    for att in parsed.attachments() {
        let name = att
            .attachment_name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "attachment".to_string());
        let mime = att.content_type().map(|c| {
            let mut s = c.ctype().to_string();
            if let Some(st) = c.subtype() {
                s.push('/');
                s.push_str(st);
            }
            s
        }).unwrap_or_else(|| "application/octet-stream".to_string());
        attachments.push(Att {
            filename: name,
            mime,
            bytes: att.contents().to_vec(),
        });
    }

    let registry = api::registry_stub(&env).map_err(|e| ApiError::Internal(e.to_string()))?;
    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;

    for rcpt in recipients {
        // Resolve user + pubkey.
        #[derive(Deserialize)]
        struct U {
            id: String,
            pub_key_b64: Option<String>,
        }
        let u: U = match api::stub_json(
            &registry,
            Method::Get,
            &format!(
                "/users/by-address?address={}",
                urlencoding::encode(&rcpt)
            ),
            None,
        )
        .await
        {
            Ok(v) => v,
            Err(_) => {
                console_log!(
                    "email_in.dropped reason=no-user-for-address from={} to={} rcpt={} message_id={}",
                    raw_from,
                    raw_to,
                    rcpt,
                    header_message_id,
                );
                continue;
            }
        };
        let pk = match u
            .pub_key_b64
            .as_deref()
            .and_then(|s| b64::url_decode(s).ok())
            .and_then(|v| <[u8; 32]>::try_from(v.as_slice()).ok())
        {
            Some(p) => p,
            None => {
                console_log!(
                    "email_in.dropped reason=user-missing-pubkey from={} to={} rcpt={} user_id={} message_id={}",
                    raw_from,
                    raw_to,
                    rcpt,
                    u.id,
                    header_message_id,
                );
                continue;
            }
        };

        let subject_ct = crate::crypto::seal_to(&pk, subject.as_bytes())?;
        let body_ct = crate::crypto::seal_to(
            &pk,
            html_body
                .as_deref()
                .unwrap_or(text_body.as_str())
                .as_bytes(),
        )?;
        let snippet_ct = crate::crypto::seal_to(&pk, snippet.as_bytes())?;

        // Store raw MIME ciphertext too — useful for showing original source
        // and (eventually) forwarding/exports without re-parsing.
        let raw_key = format!("raw/{}/{}", u.id, crate::ids::ksuid());
        let raw_ct = crate::crypto::seal_to(&pk, raw.as_slice())?;
        // `worker::Data` doesn't impl `From<&[u8]>` — pass an owned Vec.
        r2.put(&raw_key, raw_ct)
            .execute()
            .await
            .map_err(|e| ApiError::Internal(format!("R2 put raw: {e}")))?;

        let mailbox = api::mailbox_stub(&env, &u.id)
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        let msg_id = crate::ids::message();
        let _: serde_json::Value = api::stub_json(
            &mailbox,
            Method::Post,
            "/messages",
            Some(serde_json::json!({
                "id": msg_id,
                "thread_id": null,
                "message_id": message_id,
                "in_reply_to": in_reply_to,
                "references": references,
                "from_addr": header_from_addr,
                "from_name": from_name,
                "to_addrs": header_to,
                "cc_addrs": header_cc,
                "bcc_addrs": Vec::<String>::new(),
                "sent_at": sent_at,
                "direction": "in",
                "snippet_ct_b64": b64::url_encode(&snippet_ct),
                "subject_ct_b64": b64::url_encode(&subject_ct),
                "body_ct_b64": b64::url_encode(&body_ct),
                "raw_r2_key": raw_key,
                "size_bytes": raw.len() as i64,
            })),
        )
        .await?;

        // Encrypt + upload each attachment, register meta.
        for att in &attachments {
            let key = format!("attach/{}/{}", u.id, crate::ids::ksuid());
            let ct = crate::crypto::seal_to(&pk, &att.bytes)?;
            r2.put(&key, ct)
                .execute()
                .await
                .map_err(|e| ApiError::Internal(format!("R2 put att: {e}")))?;
            let filename_ct = crate::crypto::seal_to(&pk, att.filename.as_bytes())?;
            let _: serde_json::Value = api::stub_json(
                &mailbox,
                Method::Post,
                "/attachments",
                Some(serde_json::json!({
                    "id": crate::ids::attachment(),
                    "message_id": msg_id,
                    "draft_id": null,
                    "r2_key": key,
                    "filename_ct_b64": b64::url_encode(&filename_ct),
                    "mime": att.mime,
                    "size_bytes": att.bytes.len() as i64,
                })),
            )
            .await?;
        }

        console_log!(
            "email_in.stored from={} to={} rcpt={} user_id={} msg_id={} attachments={} message_id={}",
            raw_from,
            raw_to,
            rcpt,
            u.id,
            msg_id,
            attachments.len(),
            header_message_id,
        );
    }

    Ok(())
}

struct Att {
    filename: String,
    mime: String,
    bytes: Vec<u8>,
}

/// Normalize an RFC822 Message-Id by stripping the surrounding `<>` and any
/// surrounding whitespace. Reply-threading needs both sides to compare equal,
/// and senders are inconsistent about whether they include the brackets.
fn strip_angle(s: impl AsRef<str>) -> String {
    s.as_ref()
        .trim()
        .trim_matches(|c| c == '<' || c == '>')
        .to_string()
}
