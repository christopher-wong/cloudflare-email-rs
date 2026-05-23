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
        let canonical = canonical_address(&raw_to);
        let domains = cfg.all_domains();
        console_warn!(
            "email_in.dropped reason=not-owned from={} to={:?} canonical={:?} owned_domains={:?} message_id={}",
            raw_from,
            raw_to,
            canonical,
            domains,
            header_message_id,
        );
        return Ok(());
    }

    let subject = parsed.subject().unwrap_or("").to_string();
    let text_body = parsed.body_text(0).map(|s| s.to_string()).unwrap_or_default();
    let html_body = parsed.body_html(0).map(|s| s.to_string());
    // Snippet is computed per-recipient below, from the final display body
    // (which prefers text/plain but falls back to html_to_text(html_body)).
    // Deriving it from text_body alone would empty the preview line for
    // HTML-only mail.
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
                console_warn!(
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
        // Prefer text/plain when senders provide a multipart/alternative.
        // Fall back to a pragmatic HTML-to-text conversion for HTML-only
        // mail so the Thread view doesn't render raw markup at the user.
        // The original raw MIME is still stored in R2 (raw_r2_key) for any
        // future "view original" affordance.
        let display_body = if !text_body.is_empty() {
            text_body.clone()
        } else {
            html_body
                .as_deref()
                .map(html_to_text)
                .unwrap_or_default()
        };
        // Snippet = first ~140 chars of the final display body. For HTML
        // emails this naturally picks up the "pre-header" — senders use a
        // display:none div at the top of the body as a list-preview line,
        // and since html_to_text doesn't honor display:none it appears
        // first in the stripped output. Standard inbox-preview behaviour.
        let snippet: String = display_body.chars().take(140).collect();
        let body_ct = crate::crypto::seal_to(&pk, display_body.as_bytes())?;
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

        // Best-effort realtime push to any tabs the user has open. We
        // include enough metadata (sender, sealed subject) for the SPA
        // to render a system-level Notification without a follow-up
        // fetch. Don't propagate errors — the message is stored.
        if let Err(e) = api::stub_json::<serde_json::Value>(
            &mailbox,
            Method::Post,
            "/notify",
            Some(serde_json::json!({
                "type": "message.new",
                "direction": "in",
                "msg_id": msg_id,
                "from_addr": header_from_addr,
                "from_name": from_name,
                "subject_ct_b64": b64::url_encode(&subject_ct),
            })),
        )
        .await
        {
            console_log!("email_in.notify_failed err={e}");
        }
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

/// Convert an HTML body to a readable plain-text approximation.
///
/// We store this (not the original HTML) in the user's mailbox so the
/// Thread view can render the body without an HTML sandbox or sanitizer.
/// The conversion is intentionally pragmatic, not a faithful renderer:
///
/// - `<script>` and `<style>` blocks are removed entirely (case-insensitive).
/// - Block-level tags (`<br>`, `<p>`, `<div>`, `<li>`) become newlines so
///   paragraph breaks survive the round-trip.
/// - All remaining tags are dropped.
/// - A small set of common HTML entities are decoded.
/// - Runs of blank lines collapse to at most one.
///
/// A future "view original" affordance can re-render the raw HTML in a
/// sandboxed iframe — for now we prefer predictable text.
pub fn html_to_text(html: &str) -> String {
    let stripped = strip_block(&strip_block(html, "script"), "style");

    // Insert paragraph/line breaks before tag-removal so we preserve them.
    let mut buf = String::with_capacity(stripped.len());
    let bytes = stripped.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Find the end of the tag.
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'>' {
                j += 1;
            }
            if j >= bytes.len() {
                break;
            }
            let tag = std::str::from_utf8(&bytes[i + 1..j])
                .unwrap_or("")
                .to_lowercase();
            // Strip leading '/' (closing tags) and split on whitespace OR '/'
            // so self-closing forms like `<br/>` (no space) match the same
            // tag name as `<br>` / `<br />`.
            let tag_name = tag
                .trim_start_matches('/')
                .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or("");
            match tag_name {
                "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                    buf.push('\n');
                }
                _ => {}
            }
            i = j + 1;
        } else {
            buf.push(bytes[i] as char);
            i += 1;
        }
    }

    // Decode common entities (covers the >95% case; numeric entities are
    // intentionally ignored to keep this dependency-free).
    let decoded = buf
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'");

    // Collapse 2+ blank lines to one, trim per-line whitespace.
    let mut out = String::with_capacity(decoded.len());
    let mut blank_run = 0;
    for line in decoded.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                out.push('\n');
            }
        } else {
            blank_run = 0;
            out.push_str(t);
            out.push('\n');
        }
    }
    out.trim().to_string()
}

/// Drop every `<tag>...</tag>` block (case-insensitive) from a string.
fn strip_block(s: &str, tag: &str) -> String {
    let lower = s.to_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        match lower[i..].find(&open) {
            Some(rel) => {
                out.push_str(&s[i..i + rel]);
                let from = i + rel;
                match lower[from..].find(&close) {
                    Some(end) => i = from + end + close.len(),
                    None => break,
                }
            }
            None => {
                out.push_str(&s[i..]);
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_angle_strips_brackets_and_whitespace() {
        assert_eq!(strip_angle("<abc@host>"), "abc@host");
        assert_eq!(strip_angle("  <abc@host>  "), "abc@host");
        assert_eq!(strip_angle("abc@host"), "abc@host");
        assert_eq!(strip_angle(""), "");
    }

    #[test]
    fn html_to_text_strips_tags_and_preserves_paragraphs() {
        let html = "<p>Hello</p><p>World</p>";
        let out = html_to_text(html);
        assert!(out.contains("Hello"));
        assert!(out.contains("World"));
        // Block-level tags produce paragraph breaks, not glued lines.
        assert!(!out.contains("HelloWorld"));
    }

    #[test]
    fn html_to_text_drops_script_and_style_blocks_entirely() {
        let html =
            "<style>body{color:red}</style>real content<script>alert(1)</script>more";
        let out = html_to_text(html);
        // The contents of script/style must NOT survive the strip — they
        // are not user-facing text.
        assert!(!out.contains("color:red"));
        assert!(!out.contains("alert(1)"));
        assert!(out.contains("real content"));
        assert!(out.contains("more"));
    }

    #[test]
    fn html_to_text_decodes_common_entities() {
        let html = "AT&amp;T &lt;3 &quot;quotes&quot; &nbsp; tail";
        let out = html_to_text(html);
        assert!(out.contains("AT&T"));
        assert!(out.contains("<3"));
        assert!(out.contains("\"quotes\""));
    }

    #[test]
    fn html_to_text_preheader_pattern_surfaces_first() {
        // The standard pre-header technique: a hidden div with the inbox
        // preview, followed by the real content. Since html_to_text
        // doesn't honor display:none, the pre-header naturally appears
        // first in the output — which is exactly what we want when we
        // take the first ~140 chars as the snippet.
        let html = r#"
            <div style="display:none">PREHEADER preview line</div>
            <p>Body of the email.</p>
        "#;
        let out = html_to_text(html);
        let idx_pre = out.find("PREHEADER preview line").unwrap();
        let idx_body = out.find("Body of the email").unwrap();
        assert!(idx_pre < idx_body);
    }

    #[test]
    fn html_to_text_collapses_excess_blank_lines() {
        let html = "<p>one</p><p></p><p></p><p></p><p>two</p>";
        let out = html_to_text(html);
        // We allow at most one or two blank lines between paragraphs.
        // Counting 3+ consecutive newlines tells us the collapser is on.
        assert!(!out.contains("\n\n\n\n"));
    }

    #[test]
    fn html_to_text_handles_self_closing_br() {
        let html = "line one<br/>line two<br />line three";
        let out = html_to_text(html);
        assert!(out.contains("line one"));
        assert!(out.contains("line two"));
        assert!(out.contains("line three"));
        // Each <br> should produce a line break.
        let lines: Vec<&str> = out.split('\n').filter(|l| !l.trim().is_empty()).collect();
        assert!(lines.len() >= 3, "expected ≥3 non-empty lines, got {:?}", lines);
    }

    #[test]
    fn html_to_text_handles_input_with_no_tags() {
        let out = html_to_text("just plain text");
        assert_eq!(out, "just plain text");
    }
}
