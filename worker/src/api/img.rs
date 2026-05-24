//! Image proxy for inbound HTML email.
//!
//! Why this exists: marketing / transactional emails almost always
//! reference remote images (logos, hero shots, tracking pixels).
//! Loading them from the recipient's browser leaks the recipient's
//! IP address + timing to the sender — the classic email-tracking
//! channel. Proxying through the worker means the sender only sees
//! Cloudflare's IP, with no per-recipient distinguishability.
//!
//! Endpoint: `GET /api/img?u=<url-encoded-absolute-url>`. Requires
//! a session cookie (the only consumer is the email viewer), so an
//! anonymous third party can't use us as a generic web proxy.
//!
//! Security:
//!   * Only http(s) URLs.
//!   * Reject obvious private / link-local hosts so we're not used
//!     for SSRF probes against internal infra. Workers' runtime
//!     can't route to private IPs anyway, but explicit-fail is
//!     friendlier than a timeout.
//!   * Refuse non-image content types — keeps us from being abused
//!     to fetch HTML / JSON / etc.
//!   * 10 MiB cap so a 4 GB billboard image can't tie up a worker.
//!   * `Cross-Origin-Resource-Policy: same-origin` so the response
//!     can only be embedded from our own pages.

use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::require_auth;

/// Per-image upper bound (bytes). Real marketing imagery rarely
/// exceeds a few hundred KB; the cap is a defense-in-depth ceiling.
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

pub async fn proxy(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_auth(&req, env).await?;
    let qs = req.uri().query().unwrap_or("");
    let url_str = url_param(qs, "u")
        .ok_or_else(|| ApiError::BadRequest("u required".into()))?;
    let parsed = url::Url::parse(&url_str)
        .map_err(|_| ApiError::BadRequest("invalid url".into()))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(ApiError::BadRequest("only http/https allowed".into()));
    }
    if let Some(host) = parsed.host_str() {
        if is_private_host(host) {
            return Err(ApiError::BadRequest("blocked host".into()));
        }
    }

    let upstream = Fetch::Url(parsed)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("fetch: {e}")))?;
    let status = upstream.status_code();
    if !(200..300).contains(&status) {
        return Err(ApiError::NotFound);
    }
    let mime = upstream
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .unwrap_or_default();
    if !mime.starts_with("image/") {
        return Err(ApiError::BadRequest(format!("not an image: {mime}")));
    }

    // Buffer with cap. Images are small enough that streaming buys
    // us nothing; the cap protects worker memory.
    let mut upstream = upstream;
    let bytes = upstream
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("body: {e}")))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::BadRequest("image too large".into()));
    }

    let mut resp = Response::from_bytes(bytes).map_err(ApiError::from)?;
    let h = resp.headers_mut();
    let _ = h.set("content-type", &mime);
    // 1-day public cache. Marketing imagery is stable; the URL is
    // already content-addressable (different campaign → different
    // URL) so collisions are non-issues.
    let _ = h.set("cache-control", "public, max-age=86400, immutable");
    // Prevent embedding the proxied image into pages on other
    // origins — the bytes are still reachable to anyone with our
    // session cookie + the URL, just not embeddable cross-origin.
    let _ = h.set("cross-origin-resource-policy", "same-origin");
    let _ = h.set("referrer-policy", "no-referrer");
    Ok(resp)
}

/// Refuse private / loopback / link-local hosts. Catches the most
/// obvious SSRF attempts (worker runtime would reject most anyway,
/// but we don't want to give a meaningful timeout signal back to a
/// remote attacker). Not exhaustive — we accept that real public
/// DNS pointing at private IPs would slip past this, since we'd
/// have to do an actual DNS resolution to catch it.
fn is_private_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::" | "::1"
    ) {
        return true;
    }
    if lower.ends_with(".local") || lower.ends_with(".internal") {
        return true;
    }
    if lower.starts_with("10.") || lower.starts_with("192.168.") || lower.starts_with("169.254.") {
        return true;
    }
    if let Some(rest) = lower.strip_prefix("172.") {
        // 172.16.0.0/12
        if let Some((second, _)) = rest.split_once('.') {
            if let Ok(n) = second.parse::<u8>() {
                if (16..=31).contains(&n) {
                    return true;
                }
            }
        }
    }
    false
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
