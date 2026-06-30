//! Minimal Cloudflare REST API client for multi-tenant domain onboarding.
//!
//! **Path A multi-tenancy.** Every customer domain is added as a *full* zone
//! in OUR Cloudflare account, then Email Routing is enabled with a catch-all
//! rule that delivers every inbound message to this same worker's `email()`
//! handler. That single shared worker can be the target for every tenant zone
//! precisely because all the zones live in our one account — Cloudflare's
//! "send to a Worker" action only lists Workers in the zone's own account, so
//! cross-account delivery into our worker is impossible by design.
//!
//! The one step that cannot be automated is the registrar nameserver change:
//! Cloudflare assigns each zone a nameserver pair bound to the account it
//! lives in, so the customer must repoint their registrar at the pair we hand
//! back from [`CfClient::create_zone`]. Everything before and after that is
//! scripted here.
//!
//! ## Auth
//!
//! - `CF_API_TOKEN` (secret): an account-scoped API token with Zone:Edit,
//!   DNS:Edit and Email Routing:Edit. Never returned to clients.
//! - `CF_ACCOUNT_ID` (var): the account the zones are created under.
//! - `CF_EMAIL_WORKER_NAME` (var, optional): the deployed worker script name
//!   the catch-all rule points at. Defaults to `cfemail` (the `name` field in
//!   wrangler.jsonc — kept for deploy compatibility, see CLAUDE.md).

use serde::de::DeserializeOwned;
use serde::Deserialize;
use worker::*;

use crate::error::{ApiError, ApiResult};

const API_BASE: &str = "https://api.cloudflare.com/client/v4";
const DEFAULT_WORKER_NAME: &str = "cfemail";

pub struct CfClient {
    token: String,
    account_id: String,
    worker_name: String,
}

/// The slice of a Cloudflare zone object we care about.
#[derive(Debug, Deserialize)]
pub struct ZoneInfo {
    pub id: String,
    #[allow(dead_code)]
    pub name: String,
    /// `initializing` | `pending` | `active` | `moved` | `deleted`. We treat
    /// `active` as "nameservers verified, ready to configure".
    pub status: String,
    /// The nameserver pair the customer must set at their registrar. Present
    /// once the zone exists; empty for secondary/partial setups (not used).
    #[serde(default)]
    pub name_servers: Vec<String>,
}

#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<ApiErr>,
    result: Option<T>,
}

#[derive(Deserialize)]
struct ApiErr {
    code: i64,
    message: String,
}

impl CfClient {
    /// Build a client from the worker environment. Returns `None`-style error
    /// if the token/account aren't configured so callers can surface a clear
    /// "onboarding not configured" message instead of a generic 500.
    pub fn from_env(env: &Env) -> ApiResult<Self> {
        let token = secret(env, "CF_API_TOKEN").ok_or_else(|| {
            ApiError::Internal("CF_API_TOKEN secret not set — domain onboarding disabled".into())
        })?;
        let account_id = var(env, "CF_ACCOUNT_ID").ok_or_else(|| {
            ApiError::Internal("CF_ACCOUNT_ID var not set — domain onboarding disabled".into())
        })?;
        let worker_name =
            var(env, "CF_EMAIL_WORKER_NAME").unwrap_or_else(|| DEFAULT_WORKER_NAME.to_string());
        Ok(Self {
            token,
            account_id,
            worker_name,
        })
    }

    /// Add `name` as a full zone in our account. Cloudflare kicks off a scan
    /// of the domain's existing public DNS and imports what it finds, so a
    /// live domain keeps resolving its website / other services after the
    /// nameserver switch — we then layer the email records on top in
    /// [`Self::provision_email`]. Returns the zone (including the nameservers
    /// the customer must set at their registrar).
    pub async fn create_zone(&self, name: &str) -> ApiResult<ZoneInfo> {
        let body = serde_json::json!({
            "name": name,
            "account": { "id": self.account_id },
            "type": "full",
        });
        self.call(Method::Post, "/zones", Some(body)).await
    }

    /// Fetch a zone by id — used to poll `status` until it flips to `active`
    /// (i.e. the customer has repointed their nameservers and Cloudflare has
    /// verified them).
    pub async fn get_zone(&self, zone_id: &str) -> ApiResult<ZoneInfo> {
        self.call(Method::Get, &format!("/zones/{zone_id}"), None)
            .await
    }

    /// Run the full email setup against an already-active zone, idempotently:
    /// add the routing DNS records (MX + SPF + DKIM), enable Email Routing,
    /// and point the catch-all rule at our worker. Safe to re-run — each call
    /// is an upsert on Cloudflare's side.
    pub async fn provision_email(&self, zone_id: &str) -> ApiResult<()> {
        // Order matters: add the MX/SPF/DKIM records and enable routing before
        // wiring the catch-all, so the zone is deliverable the moment the rule
        // goes live.
        self.add_routing_dns(zone_id).await?;
        self.enable_email_routing(zone_id).await?;
        self.set_catch_all_to_worker(zone_id).await?;
        self.add_dmarc(zone_id).await?;
        Ok(())
    }

    /// Auto-add the Email Routing DNS records (MX to Cloudflare's inbound MX,
    /// SPF, and DKIM). Cloudflare exposes this as a dedicated endpoint so we
    /// don't have to hand-author the records.
    async fn add_routing_dns(&self, zone_id: &str) -> ApiResult<()> {
        let _: serde_json::Value = self
            .call(
                Method::Post,
                &format!("/zones/{zone_id}/email/routing/dns"),
                Some(serde_json::json!({})),
            )
            .await?;
        Ok(())
    }

    /// Flip Email Routing on for the zone.
    async fn enable_email_routing(&self, zone_id: &str) -> ApiResult<()> {
        let _: serde_json::Value = self
            .call(
                Method::Post,
                &format!("/zones/{zone_id}/email/routing/enable"),
                Some(serde_json::json!({})),
            )
            .await?;
        Ok(())
    }

    /// Point the catch-all rule at our worker so *every* address on the domain
    /// (including misspellings) lands in `email_in::handle`. Per-recipient
    /// ownership is then enforced inside the worker against the addresses
    /// table, so a catch-all here doesn't accept mail for unknown users.
    async fn set_catch_all_to_worker(&self, zone_id: &str) -> ApiResult<()> {
        let body = serde_json::json!({
            "enabled": true,
            "matchers": [ { "type": "all" } ],
            "actions": [ { "type": "worker", "value": [ self.worker_name ] } ],
        });
        let _: serde_json::Value = self
            .call(
                Method::Put,
                &format!("/zones/{zone_id}/email/routing/rules/catch_all"),
                Some(body),
            )
            .await?;
        Ok(())
    }

    /// Add a monitoring DMARC record. `p=none` so we observe without risking
    /// legitimate mail during onboarding; an operator can tighten it later.
    async fn add_dmarc(&self, zone_id: &str) -> ApiResult<()> {
        let body = serde_json::json!({
            "type": "TXT",
            "name": "_dmarc",
            "content": "v=DMARC1; p=none;",
            "ttl": 1,
            "comment": "Added by bmail domain onboarding",
        });
        // Tolerate a pre-existing _dmarc record (e.g. imported by the zone
        // scan) — a duplicate-record error here shouldn't fail onboarding.
        match self
            .call::<serde_json::Value>(
                Method::Post,
                &format!("/zones/{zone_id}/dns_records"),
                Some(body),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(ApiError::Conflict(_)) | Err(ApiError::BadRequest(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Issue a single API call and unwrap Cloudflare's `{success, errors,
    /// result}` envelope into `T` (or a mapped `ApiError`).
    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> ApiResult<T> {
        let url = format!("{API_BASE}{path}");
        let mut init = RequestInit::new();
        init.with_method(method);
        let headers = Headers::new();
        headers
            .set("authorization", &format!("Bearer {}", self.token))
            .map_err(ApiError::from)?;
        headers
            .set("content-type", "application/json")
            .map_err(ApiError::from)?;
        init.with_headers(headers);
        if let Some(b) = body {
            init.with_body(Some(serde_json::to_string(&b)?.into()));
        }
        let req = Request::new_with_init(&url, &init).map_err(ApiError::from)?;
        let mut resp = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| ApiError::Internal(format!("cloudflare api fetch: {e}")))?;

        let status = resp.status_code();
        let env: Envelope<T> = resp
            .json()
            .await
            .map_err(|e| ApiError::Internal(format!("cloudflare api decode ({status}): {e}")))?;
        if env.success {
            env.result
                .ok_or_else(|| ApiError::Internal("cloudflare api: success with no result".into()))
        } else {
            let first = env.errors.first();
            let code = first.map(|e| e.code).unwrap_or(0);
            let msg = first
                .map(|e| e.message.clone())
                .unwrap_or_else(|| "unknown cloudflare error".into());
            // 1061 = "zone already exists". Surface duplicates as Conflict so
            // the onboarding handler can react cleanly.
            Err(match (status, code) {
                (_, 1061) => ApiError::Conflict(format!("cloudflare: {msg} (code {code})")),
                (400..=499, _) => ApiError::BadRequest(format!("cloudflare: {msg} (code {code})")),
                _ => ApiError::Internal(format!("cloudflare: {msg} (code {code})")),
            })
        }
    }
}

/// Read a worker secret (set via `wrangler secret put`). Secrets surface on the
/// env object the same way vars do; reuse the reflection-tolerant reader.
fn secret(env: &Env, key: &str) -> Option<String> {
    if let Ok(s) = env.secret(key) {
        let v = s.to_string();
        if !v.is_empty() {
            return Some(v);
        }
    }
    raw_env_string(env, key)
}

fn var(env: &Env, key: &str) -> Option<String> {
    if let Ok(v) = env.var(key) {
        let s = v.to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    raw_env_string(env, key)
}

/// Reflection fallback identical in spirit to `config::var` — reads the
/// property straight off the env JS object when the typed binding cast fails.
fn raw_env_string(env: &Env, key: &str) -> Option<String> {
    use worker::wasm_bindgen::{JsCast, JsValue};
    let env_obj: &JsValue = env.unchecked_ref();
    let raw = worker::js_sys::Reflect::get(env_obj, &JsValue::from_str(key)).ok()?;
    if raw.is_undefined() || raw.is_null() {
        return None;
    }
    raw.as_string().filter(|s| !s.is_empty())
}

/// Normalize a user-entered domain to its canonical apex form, or return an
/// error describing why it's not a usable email domain.
///
/// Accepts `"  Example.COM "`, `"https://example.com/"`, `"@example.com"` and
/// reduces them to `"example.com"`. Rejects anything without a dot, with a
/// path/port, or with characters outside the DNS label set.
pub fn normalize_domain(input: &str) -> Result<String, String> {
    let mut s = input.trim().to_ascii_lowercase();
    // Strip a scheme if the user pasted a URL.
    for scheme in ["https://", "http://"] {
        if let Some(rest) = s.strip_prefix(scheme) {
            s = rest.to_string();
            break;
        }
    }
    // Strip a leading '@' (people type "@example.com"), then drop any
    // path / query / fragment / port so only the host remains.
    let host: String = s
        .trim_start_matches('@')
        .split(['/', '?', '#', ':'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_string();
    let s = host;

    if s.is_empty() {
        return Err("domain is empty".into());
    }
    if !s.contains('.') {
        return Err("domain must contain a dot (e.g. example.com)".into());
    }
    if s.len() > 253 {
        return Err("domain too long".into());
    }
    for label in s.split('.') {
        if label.is_empty() {
            return Err("domain has an empty label".into());
        }
        if label.len() > 63 {
            return Err("domain label too long".into());
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err("domain label can't start or end with a hyphen".into());
        }
        if !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err("domain has invalid characters".into());
        }
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_lowercases_and_trims() {
        assert_eq!(normalize_domain("  Example.COM  ").unwrap(), "example.com");
    }

    #[test]
    fn normalize_strips_scheme_path_and_at() {
        assert_eq!(
            normalize_domain("https://Example.com/inbox").unwrap(),
            "example.com"
        );
        assert_eq!(normalize_domain("@example.com").unwrap(), "example.com");
        assert_eq!(normalize_domain("example.com:8080").unwrap(), "example.com");
        assert_eq!(normalize_domain("example.com.").unwrap(), "example.com");
    }

    #[test]
    fn normalize_accepts_subdomains() {
        assert_eq!(
            normalize_domain("mail.example.co.uk").unwrap(),
            "mail.example.co.uk"
        );
    }

    #[test]
    fn normalize_rejects_bad_input() {
        assert!(normalize_domain("").is_err());
        assert!(normalize_domain("localhost").is_err()); // no dot
        assert!(normalize_domain("exa mple.com").is_err()); // space
        assert!(normalize_domain("-bad.com").is_err()); // leading hyphen
        assert!(normalize_domain("bad-.com").is_err()); // trailing hyphen
        assert!(normalize_domain("under_score.com").is_err()); // invalid char
    }
}
