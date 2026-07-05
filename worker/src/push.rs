//! APNs push notifications for inbound mail.
//!
//! Server-blind by design: the subject and body are E2E ciphertext the server
//! cannot read, so a push alert carries only the **cleartext sender** (the
//! same From address we already use for routing) plus the thread/message ids
//! for tap-through. No decrypted content ever leaves the worker.
//!
//! Auth uses APNs token-based (JWT / ES256) provider auth. Config comes from
//! env (see `ApnsConfig::from_env`); if any piece is missing, push is a silent
//! no-op so inbound mail delivery is never blocked on push being set up.
//!
//! Device tokens live per-user in the MailboxDO (`push_tokens` table). Dead
//! tokens (APNs 410 Unregistered / 400 BadDeviceToken) are pruned on send.

use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey;
use serde::Deserialize;
use worker::*;

pub struct ApnsConfig {
    key_pem: String,
    key_id: String,
    team_id: String,
    topic: String,
}

impl ApnsConfig {
    /// Read APNs config from env. `APNS_KEY` is a secret (the `.p8` PEM);
    /// the rest are plain vars. Uses `config::var`'s reflection fallback so it
    /// also works inside the `#[event(email)]` handler, where the typed
    /// `env.var()` cast fails on the pinned workers-rs rev. Returns `None`
    /// (push disabled) unless every field is present.
    pub fn from_env(env: &Env) -> Option<Self> {
        Some(Self {
            key_pem: crate::config::var(env, "APNS_KEY")?,
            key_id: crate::config::var(env, "APNS_KEY_ID")?,
            team_id: crate::config::var(env, "APNS_TEAM_ID")?,
            topic: crate::config::var(env, "APNS_TOPIC")?,
        })
    }
}

#[derive(Deserialize)]
struct TokenRow {
    token: String,
    environment: String,
}

/// Send a "new mail" push to every registered device for `user_id`.
/// Best-effort: all failures are logged, never propagated.
pub async fn notify_new_mail(
    env: &Env,
    user_id: &str,
    sender: &str,
    thread_id: &str,
    msg_id: &str,
) {
    let Some(cfg) = ApnsConfig::from_env(env) else {
        return; // push not configured — silent no-op
    };
    let tokens = match fetch_tokens(env, user_id).await {
        Some(t) if !t.is_empty() => t,
        _ => return,
    };
    let jwt = match get_or_mint_jwt(env, &cfg).await {
        Ok(j) => j,
        Err(e) => {
            console_log!("push.jwt_failed err={e}");
            return;
        }
    };

    // Subject stays encrypted; the body is a fixed string. Sender is cleartext.
    let payload = serde_json::json!({
        "aps": {
            "alert": { "title": sender, "body": "New encrypted message" },
            "sound": "default",
        },
        "thread_id": thread_id,
        "msg_id": msg_id,
    })
    .to_string();

    for t in tokens {
        match send_one(&cfg, &jwt, &t.token, &t.environment, &payload).await {
            Ok(410) | Ok(400) => {
                // Token is no longer valid on this device — stop trying.
                unregister_token(env, user_id, &t.token).await;
            }
            Ok(status) if !(200..300).contains(&status) => {
                console_log!("push.apns_status status={status}");
            }
            Ok(_) => {}
            Err(e) => console_log!("push.send_failed err={e}"),
        }
    }
}

fn apns_host(environment: &str) -> &'static str {
    if environment.eq_ignore_ascii_case("production") {
        "api.push.apple.com"
    } else {
        "api.sandbox.push.apple.com"
    }
}

async fn send_one(
    cfg: &ApnsConfig,
    jwt: &str,
    token: &str,
    environment: &str,
    body: &str,
) -> Result<u16> {
    let url = format!("https://{}/3/device/{}", apns_host(environment), token);
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    let headers = Headers::new();
    headers.set("authorization", &format!("bearer {jwt}"))?;
    headers.set("apns-topic", &cfg.topic)?;
    headers.set("apns-push-type", "alert")?;
    headers.set("apns-priority", "10")?;
    headers.set("content-type", "application/json")?;
    init.with_headers(headers);
    init.with_body(Some(body.to_string().into()));
    let req = Request::new_with_init(&url, &init)?;
    let resp = Fetch::Request(req).send().await?;
    Ok(resp.status_code())
}

// ---- Provider JWT (ES256) -------------------------------------------------

/// APNs allows reusing a provider token for up to 1h and throttles clients
/// that mint new tokens too frequently. Cache it in KV with a sub-hour TTL.
async fn get_or_mint_jwt(env: &Env, cfg: &ApnsConfig) -> Result<String> {
    let kv = env.kv("CONFIG")?;
    if let Ok(Some(cached)) = kv.get("apns_jwt").text().await {
        return Ok(cached);
    }
    let iat = (Date::now().as_millis() / 1000) as u64;
    let jwt = mint_jwt(cfg, iat)?;
    // 45-minute TTL: comfortably inside APNs' 60-min ceiling.
    match kv.put("apns_jwt", &jwt) {
        Ok(builder) => {
            let _ = builder.expiration_ttl(2700).execute().await;
        }
        Err(e) => console_log!("push.jwt_cache_failed err={e}"),
    }
    Ok(jwt)
}

fn mint_jwt(cfg: &ApnsConfig, iat: u64) -> Result<String> {
    let header = format!(r#"{{"alg":"ES256","kid":"{}"}}"#, cfg.key_id);
    let claims = format!(r#"{{"iss":"{}","iat":{}}}"#, cfg.team_id, iat);
    let signing_input = format!(
        "{}.{}",
        crate::b64::url_encode(header.as_bytes()),
        crate::b64::url_encode(claims.as_bytes())
    );
    let der = pem_to_der(&cfg.key_pem)
        .ok_or_else(|| Error::RustError("apns key: bad PEM".into()))?;
    let sk = SigningKey::from_pkcs8_der(&der)
        .map_err(|e| Error::RustError(format!("apns key: {e}")))?;
    let sig: Signature = sk.sign(signing_input.as_bytes());
    let sig_b64 = crate::b64::url_encode(sig.to_bytes().as_slice());
    Ok(format!("{signing_input}.{sig_b64}"))
}

/// Strip PEM armor + whitespace and base64-decode the PKCS#8 DER body.
fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .flat_map(|l| l.chars())
        .filter(|c| !c.is_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

// ---- MailboxDO token store round-trips ------------------------------------

async fn fetch_tokens(env: &Env, user_id: &str) -> Option<Vec<TokenRow>> {
    let stub = crate::api::mailbox_stub(env, user_id).ok()?;
    crate::api::stub_json::<Vec<TokenRow>>(&stub, Method::Get, "/push/tokens", None)
        .await
        .ok()
}

async fn unregister_token(env: &Env, user_id: &str, token: &str) {
    let Ok(stub) = crate::api::mailbox_stub(env, user_id) else {
        return;
    };
    let _ = crate::api::stub_json::<serde_json::Value>(
        &stub,
        Method::Post,
        "/push/unregister",
        Some(serde_json::json!({ "token": token })),
    )
    .await;
}
