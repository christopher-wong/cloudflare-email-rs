//! Cookie-based session tokens. The cookie value is an opaque random ID
//! looked up server-side in the RegistryDO `sessions` table; we don't bake
//! claims into the cookie so revocation is just a DELETE.

use serde::{Deserialize, Serialize};
use worker::{HttpRequest, Response};

use crate::error::{ApiError, ApiResult};

pub const COOKIE_NAME: &str = "cfe_sid";

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub user_id: String,
    pub is_admin: bool,
}

pub fn new_session_id() -> String {
    crate::ids::session()
}

pub fn cookie_header(sid: &str, ttl_days: u32, secure: bool) -> String {
    let max_age = ttl_days as u64 * 86_400;
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}={sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure_attr}",
        name = COOKIE_NAME,
        sid = sid,
        max_age = max_age,
        secure_attr = secure_attr,
    )
}

pub fn clear_cookie_header() -> String {
    format!("{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", COOKIE_NAME)
}

pub fn extract_sid(req: &HttpRequest) -> Option<String> {
    let cookie = req.headers().get("cookie")?.to_str().ok()?;
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix(&format!("{}=", COOKIE_NAME)) {
            return Some(rest.to_string());
        }
    }
    None
}

pub fn require_sid(req: &HttpRequest) -> ApiResult<String> {
    extract_sid(req).ok_or(ApiError::Unauthorized)
}

pub fn with_session_cookie(mut res: Response, sid: &str, ttl_days: u32, secure: bool) -> Response {
    let _ = res
        .headers_mut()
        .append("set-cookie", &cookie_header(sid, ttl_days, secure));
    res
}

pub fn with_cleared_cookie(mut res: Response) -> Response {
    let _ = res.headers_mut().append("set-cookie", &clear_cookie_header());
    res
}

pub fn is_secure_request(req: &HttpRequest) -> bool {
    req.headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("https"))
        .unwrap_or(true) // Workers default to HTTPS in production
}
