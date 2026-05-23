use worker::Env;

use crate::error::{ApiError, ApiResult};

/// Runtime app configuration sourced from `vars` + KV overrides.
pub struct AppConfig {
    /// Email domain (e.g. `middleseat.vc`).
    pub primary_domain: String,
    /// Extra owned email domains.
    pub additional_domains: Vec<String>,
    /// Hostname the web app is served from (e.g. `mail.middleseat.vc`).
    /// Used as the WebAuthn RP ID + expected origin.
    pub app_host: String,
    pub app_name: String,
    pub session_ttl_days: u32,
}

impl AppConfig {
    pub fn load(env: &Env) -> ApiResult<Self> {
        let primary_domain = var(env, "PRIMARY_DOMAIN").unwrap_or_else(|| "localhost".to_string());
        let additional_domains = var(env, "ADDITIONAL_DOMAINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let app_host = var(env, "APP_HOST").unwrap_or_else(|| primary_domain.clone());
        let app_name = var(env, "APP_NAME").unwrap_or_else(|| "cfemail".to_string());
        let session_ttl_days = var(env, "SESSION_TTL_DAYS")
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

        Ok(Self {
            primary_domain,
            additional_domains,
            app_host,
            app_name,
            session_ttl_days,
        })
    }

    /// All domains this instance considers its own.
    pub fn all_domains(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.additional_domains.iter().map(|s| s.as_str()).collect();
        v.insert(0, &self.primary_domain);
        v
    }

    pub fn owns_address(&self, addr: &str) -> bool {
        addr.rsplit_once('@')
            .map(|(_, d)| {
                self.all_domains()
                    .iter()
                    .any(|owned| owned.eq_ignore_ascii_case(d))
            })
            .unwrap_or(false)
    }
}

fn var(env: &Env, key: &str) -> Option<String> {
    // 1. Standard workers-rs API path. Works in #[event(fetch)] context.
    if let Ok(v) = env.var(key) {
        let s = v.to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    // 2. Fallback: read the value directly from the env JS object. In the
    //    #[event(email)] handler (workers-rs rev 3d0903a), `env.var(...)`
    //    rejects plain `vars` declared in wrangler.jsonc because the typed
    //    binding cast fails — even though the property IS present on the
    //    env object. This reflection path bypasses that check.
    use worker::wasm_bindgen::{JsCast, JsValue};
    let env_obj: &JsValue = env.unchecked_ref();
    let raw = worker::js_sys::Reflect::get(env_obj, &JsValue::from_str(key)).ok()?;
    if raw.is_undefined() || raw.is_null() {
        return None;
    }
    raw.as_string().filter(|s| !s.is_empty())
}

pub fn rp_id(cfg: &AppConfig) -> String {
    // WebAuthn RP ID — tight-scoped to the app host. A passkey created here
    // is not usable on any other host. Spec requires the RP ID be a
    // registrable-suffix of the origin; using the host itself satisfies that.
    cfg.app_host.clone()
}

pub fn rp_origin(cfg: &AppConfig, req_host: &str, secure: bool) -> String {
    // Prefer the configured APP_HOST so dev (localhost) and prod can be
    // distinguished cleanly. Fall back to the request's host header.
    let host = if !cfg.app_host.is_empty() {
        cfg.app_host.as_str()
    } else {
        req_host
    };
    let scheme = if secure { "https" } else { "http" };
    format!("{scheme}://{host}")
}

/// Strip `+suffix` from the local part of an email address so plus-addressed
/// aliases route to the canonical mailbox. Returns the canonical form,
/// lowercased.
///
/// `christopher+newsletter@MiddleSeat.VC` → `christopher@middleseat.vc`
pub fn canonical_address(addr: &str) -> String {
    let lower = addr.trim().to_lowercase();
    let (local, domain) = match lower.rsplit_once('@') {
        Some(pair) => pair,
        None => return lower,
    };
    let canonical_local = match local.split_once('+') {
        Some((root, _)) => root,
        None => local,
    };
    format!("{canonical_local}@{domain}")
}

#[allow(dead_code)]
pub fn require_admin(_env: &Env) -> ApiResult<()> {
    // Admin status is determined per-user via the RegistryDO (`is_admin` column).
    // This helper is reserved for future env-gated bootstrapping.
    Ok(())
}

#[allow(dead_code)]
pub fn err_internal(msg: impl Into<String>) -> ApiError {
    ApiError::Internal(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(primary: &str, additional: &[&str]) -> AppConfig {
        AppConfig {
            primary_domain: primary.to_string(),
            additional_domains: additional.iter().map(|s| s.to_string()).collect(),
            app_host: primary.to_string(),
            app_name: "cfemail".to_string(),
            session_ttl_days: 30,
        }
    }

    #[test]
    fn canonical_lowercases_and_strips_plus_aliases() {
        assert_eq!(
            canonical_address("Christopher+Newsletter@MiddleSeat.VC"),
            "christopher@middleseat.vc",
        );
    }

    #[test]
    fn canonical_handles_no_plus_alias() {
        assert_eq!(
            canonical_address("hello@example.com"),
            "hello@example.com",
        );
    }

    #[test]
    fn canonical_trims_whitespace() {
        assert_eq!(canonical_address("  user@host  "), "user@host");
    }

    #[test]
    fn canonical_returns_input_for_unparseable_addresses() {
        // No @ — return lowercase trimmed but don't synthesize one.
        assert_eq!(canonical_address("not-an-email"), "not-an-email");
    }

    #[test]
    fn owns_primary_domain() {
        let c = cfg("middleseat.vc", &[]);
        assert!(c.owns_address("christopher@middleseat.vc"));
        assert!(c.owns_address("anyone@middleseat.vc"));
    }

    #[test]
    fn owns_additional_domains() {
        let c = cfg("middleseat.vc", &["alt.example", "other.test"]);
        assert!(c.owns_address("foo@alt.example"));
        assert!(c.owns_address("foo@other.test"));
        assert!(c.owns_address("foo@middleseat.vc"));
    }

    #[test]
    fn rejects_foreign_domains() {
        let c = cfg("middleseat.vc", &["alt.example"]);
        assert!(!c.owns_address("attacker@evil.com"));
        // Subdomain isn't enough — exact match only.
        assert!(!c.owns_address("foo@sub.middleseat.vc"));
        // Trailing chars on the domain — not equal.
        assert!(!c.owns_address("foo@middleseat.vc.evil.com"));
    }

    #[test]
    fn domain_match_is_case_insensitive() {
        let c = cfg("MiddleSeat.VC", &[]);
        assert!(c.owns_address("user@middleseat.vc"));
        assert!(c.owns_address("user@MIDDLESEAT.VC"));
    }

    #[test]
    fn all_domains_returns_primary_first() {
        let c = cfg("middleseat.vc", &["alt.example", "other.test"]);
        let v = c.all_domains();
        assert_eq!(v, vec!["middleseat.vc", "alt.example", "other.test"]);
    }
}
