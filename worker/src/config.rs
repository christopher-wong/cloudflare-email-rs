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
    env.var(key).ok().map(|v| v.to_string())
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
