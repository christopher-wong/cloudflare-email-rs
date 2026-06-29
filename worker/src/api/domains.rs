//! Admin domain-onboarding endpoints (multi-tenant "bring your own domain").
//!
//! Flow (Path A — the zone lives in OUR Cloudflare account):
//!
//! 1. `POST /api/admin/domains` `{ domain }`
//!      → create a full zone in our account via the Cloudflare API, persist a
//!        `pending_ns` row, and return the two nameservers the customer must
//!        set at their registrar.
//! 2. Customer repoints their registrar nameservers (the one unavoidable
//!    manual step — see `cf_api`).
//! 3. `POST /api/admin/domains/{domain}/verify`
//!      → poll the zone; once Cloudflare reports it `active`, enable Email
//!        Routing, add the MX/SPF/DKIM/DMARC records, and point the catch-all
//!        rule at this worker. Flip the row to `active`. Idempotent — safe to
//!        call repeatedly while waiting for nameservers to propagate.
//! 4. `GET /api/admin/domains` → list with live status for the UI to poll.
//! 5. `DELETE /api/admin/domains/{domain}` → soft-remove from the registry
//!    (the Cloudflare zone is left intact — deleting it is a separate, more
//!    destructive action we don't take implicitly).
//!
//! Every endpoint is admin-gated. Domain ownership for inbound mail is decided
//! by the `domains` registry table (see `config::domain_is_owned`), so a
//! domain only starts accepting mail once it reaches `active`.

use serde::Deserialize;
use worker::*;

use crate::cf_api::{normalize_domain, CfClient};
use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{json_ok, registry_stub, require_admin_session, stub_json};

/// `POST /api/admin/domains` with `{ domain }`. Creates the zone and stores a
/// `pending_ns` row.
pub async fn create(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let s = require_admin_session(&req, env).await?;
    #[derive(Deserialize)]
    struct Req {
        domain: String,
    }
    let body: Req = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    let domain = normalize_domain(&body.domain).map_err(ApiError::BadRequest)?;

    let cf = CfClient::from_env(env)?;
    // Create the zone (Cloudflare scans + imports existing DNS automatically).
    let zone = cf.create_zone(&domain).await?;

    // Persist the pending row with the zone id + nameservers to show the user.
    let reg = registry_stub(env)?;
    let view: serde_json::Value = stub_json(
        &reg,
        Method::Post,
        "/domains",
        Some(serde_json::json!({
            "domain": domain,
            "cf_zone_id": zone.id,
            "status": "pending_ns",
            "nameservers": zone.name_servers,
            "added_by": s.user_id,
        })),
    )
    .await?;

    worker::console_log!(
        "domains.created domain={} zone_id={} by={}",
        domain,
        zone.id,
        s.user_id
    );
    json_ok(&view)
}

/// `GET /api/admin/domains` → the onboarded domains with stored status.
pub async fn list(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    super::stub_passthrough(&registry_stub(env)?, Method::Get, "/domains", None).await
}

/// `POST /api/admin/domains/{domain}/verify` → check the zone is active and,
/// if so, run the email provisioning and flip the row to `active`.
///
/// Returns the (possibly still `pending_ns`) domain row plus a `zone_status`
/// field so the UI can tell the difference between "nameservers not yet
/// propagated" and "fully live".
pub async fn verify(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    // Path is /api/admin/domains/{domain}/verify — pull the {domain} segment.
    let domain = domain_from_verify_path(req.uri().path())
        .ok_or_else(|| ApiError::BadRequest("domain required".into()))?;

    let reg = registry_stub(env)?;
    let current: DomainRow = stub_json(
        &reg,
        Method::Get,
        &format!("/domains/by-name?domain={}", urlencoding::encode(&domain)),
        None,
    )
    .await?;

    let zone_id = current
        .cf_zone_id
        .clone()
        .ok_or_else(|| ApiError::Internal("domain has no zone id".into()))?;

    let cf = CfClient::from_env(env)?;
    let zone = cf.get_zone(&zone_id).await?;

    if zone.status != "active" {
        // Nameservers not verified yet — report status, leave the row pending.
        return json_ok(&serde_json::json!({
            "domain": current.domain,
            "status": current.status,
            "zone_status": zone.status,
            "nameservers": current.nameservers,
            "ready": false,
        }));
    }

    // Zone is active: provision email (idempotent) and mark active.
    cf.provision_email(&zone_id).await?;
    let updated: serde_json::Value = stub_json(
        &reg,
        Method::Patch,
        "/domains",
        Some(serde_json::json!({ "domain": domain, "status": "active" })),
    )
    .await?;

    worker::console_log!("domains.activated domain={} zone_id={}", domain, zone_id);
    let nameservers = updated
        .get("nameservers")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    json_ok(&serde_json::json!({
        "domain": domain,
        "status": "active",
        "zone_status": zone.status,
        "nameservers": nameservers,
        "ready": true,
    }))
}

/// `DELETE /api/admin/domains/{domain}` → remove from the registry. Leaves the
/// Cloudflare zone intact.
pub async fn remove(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let domain = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("domain required".into()))?;
    let path = format!("/domains?domain={}", urlencoding::encode(&domain));
    super::stub_passthrough(&registry_stub(env)?, Method::Delete, &path, None).await
}

/// Minimal projection of a domain row for the verify handler.
#[derive(Deserialize)]
struct DomainRow {
    domain: String,
    cf_zone_id: Option<String>,
    status: String,
    #[serde(default)]
    nameservers: Vec<String>,
}

/// Extract `{domain}` from `/api/admin/domains/{domain}/verify`.
fn domain_from_verify_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/api/admin/domains/")?;
    let domain = rest.strip_suffix("/verify")?;
    if domain.is_empty() || domain.contains('/') {
        return None;
    }
    urlencoding::decode(domain).ok().map(|s| s.into_owned())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_path_extracts_domain() {
        assert_eq!(
            domain_from_verify_path("/api/admin/domains/example.com/verify").as_deref(),
            Some("example.com")
        );
    }

    #[test]
    fn verify_path_rejects_malformed() {
        assert!(domain_from_verify_path("/api/admin/domains//verify").is_none());
        assert!(domain_from_verify_path("/api/admin/domains/example.com").is_none());
        assert!(domain_from_verify_path("/api/admin/domains/a/b/verify").is_none());
    }
}
