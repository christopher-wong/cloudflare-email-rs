use serde::{Deserialize, Serialize};
use worker::*;

use crate::config::AppConfig;
use crate::error::{ApiError, ApiResult};

use super::{registry_stub, require_admin_session, require_auth, stub_json, stub_passthrough};

#[derive(Deserialize)]
struct CreateInviteReq {
    handle: Option<String>,
    addresses: Vec<String>,
    #[serde(default)]
    is_admin: bool,
}

#[derive(Serialize)]
struct CreateInviteResp {
    token: String,
    enroll_url: String,
    handle: Option<String>,
    addresses: Vec<String>,
    is_admin: bool,
    expires_at: i64,
}

pub async fn create_invite(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let s = require_admin_session(&req, env).await?;
    let body: CreateInviteReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    for a in &body.addresses {
        if !cfg.owns_address(a) {
            return Err(ApiError::BadRequest(format!(
                "address {} not on a configured domain",
                a
            )));
        }
    }
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    struct R {
        token: String,
        handle: Option<String>,
        addresses: Vec<String>,
        is_admin: bool,
        expires_at: i64,
    }
    let r: R = stub_json(
        &stub,
        Method::Post,
        "/invites",
        Some(serde_json::json!({
            "handle": body.handle,
            "addresses": body.addresses,
            "is_admin": body.is_admin,
            "created_by": s.user_id,
        })),
    )
    .await?;
    super::json_ok(&CreateInviteResp {
        enroll_url: format!("https://{}/enroll?token={}", cfg.app_host, r.token),
        token: r.token,
        handle: r.handle,
        addresses: r.addresses,
        is_admin: r.is_admin,
        expires_at: r.expires_at,
    })
}

pub async fn list_invites(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    stub_passthrough(&registry_stub(env)?, Method::Get, "/invites", None).await
}

pub async fn delete_invite(
    req: HttpRequest,
    env: &Env,
    _cfg: &AppConfig,
) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let token = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("token required".into()))?;
    let path = format!("/invites?token={}", urlencoding::encode(&token));
    stub_passthrough(&registry_stub(env)?, Method::Delete, &path, None).await
}

pub async fn list_users(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    stub_passthrough(&registry_stub(env)?, Method::Get, "/users", None).await
}

// ---- backup / restore ---------------------------------------------------

const BACKUP_PREFIX: &str = "backups/";

/// Build a bundle from every DO and write it to R2. Called by both the
/// admin-triggered POST /api/admin/backup and the cron handler. Returns
/// (key, bytes_written).
pub async fn run_backup(env: &Env) -> ApiResult<(String, usize)> {
    let registry = registry_stub(env)?;
    // Registry first — its dump tells us which users exist for the
    // per-mailbox dumps that follow.
    let registry_dump: serde_json::Value =
        stub_json(&registry, Method::Get, "/export", None).await?;

    #[derive(serde::Deserialize)]
    struct UserId { id: String }
    let users: Vec<UserId> =
        stub_json(&registry, Method::Get, "/users", None).await?;

    let mut mailboxes = serde_json::Map::with_capacity(users.len());
    for u in &users {
        let stub = super::mailbox_stub(env, &u.id)?;
        let dump: serde_json::Value =
            stub_json(&stub, Method::Get, "/export", None).await?;
        mailboxes.insert(u.id.clone(), dump);
    }

    let bundle = serde_json::json!({
        "version":   1,
        "created_at": worker::Date::now().as_millis(),
        "registry":  registry_dump,
        "mailboxes": mailboxes,
    });
    let bytes = serde_json::to_vec(&bundle)
        .map_err(|e| ApiError::Internal(format!("serialize: {e}")))?;
    let size = bytes.len();

    // Timestamp in the R2 key sorts lexicographically. The colons-free
    // form survives shells, filesystems, and curl.
    let key = format!(
        "{}{}.json",
        BACKUP_PREFIX,
        chrono::DateTime::from_timestamp(
            (worker::Date::now().as_millis() / 1000) as i64, 0,
        )
        .unwrap()
        .format("%Y-%m-%dT%H-%M-%SZ"),
    );

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    r2.put(&key, bytes)
        .http_metadata(worker::HttpMetadata {
            content_type: Some("application/json".into()),
            ..Default::default()
        })
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 put: {e}")))?;

    worker::console_log!("backup.written key={key} size={size} users={}", users.len());
    Ok((key, size))
}

pub async fn backup(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let (key, size) = run_backup(env).await?;
    super::json_ok(&serde_json::json!({ "key": key, "size_bytes": size }))
}

/// The cron schedule string we tell the client about. Hard-coded here to
/// mirror wrangler.jsonc's `triggers.crons` because Workers don't expose
/// their own cron config to the runtime. Keep in sync manually; the
/// scheduled handler will fire regardless of what this string says.
const BACKUP_CRON: &str = "17 3 * * *"; // daily at 03:17 UTC

pub async fn list_backups(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut builder = r2.list().limit(100).prefix(BACKUP_PREFIX.to_string());
        if let Some(c) = cursor.clone() {
            builder = builder.cursor(c);
        }
        let page = builder
            .execute()
            .await
            .map_err(|e| ApiError::Internal(format!("R2 list: {e}")))?;
        for obj in page.objects() {
            out.push(serde_json::json!({
                "key": obj.key(),
                "size_bytes": obj.size(),
                "uploaded_at": obj.uploaded().as_millis() as i64,
            }));
        }
        if page.truncated() {
            cursor = page.cursor();
            if cursor.is_none() { break; }
        } else {
            break;
        }
    }
    // Newest first.
    out.sort_by(|a, b| b["key"].as_str().cmp(&a["key"].as_str()));
    super::json_ok(&serde_json::json!({
        "backups": out,
        "schedule_cron": BACKUP_CRON,
    }))
}

pub async fn restore(mut req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;

    #[derive(serde::Deserialize)]
    struct Req { key: String }
    let body: Req = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    if !body.key.starts_with(BACKUP_PREFIX) {
        return Err(ApiError::BadRequest("key must be under backups/".into()));
    }

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2: {e}")))?;
    let obj = r2
        .get(&body.key)
        .execute()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 get: {e}")))?
        .ok_or(ApiError::NotFound)?;
    let bytes = obj
        .body()
        .ok_or_else(|| ApiError::Internal("R2 body".into()))?
        .bytes()
        .await
        .map_err(|e| ApiError::Internal(format!("R2 body bytes: {e}")))?;
    let bundle: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::BadRequest(format!("bundle parse: {e}")))?;

    // Push the registry first so user_ids exist when we restore per-user mailboxes.
    let registry = registry_stub(env)?;
    if let Some(reg_dump) = bundle.get("registry") {
        let _: serde_json::Value =
            stub_json(&registry, Method::Post, "/import", Some(reg_dump.clone())).await?;
    }

    let mut restored_mailboxes = 0u32;
    if let Some(mboxes) = bundle.get("mailboxes").and_then(|v| v.as_object()) {
        for (user_id, dump) in mboxes {
            let stub = super::mailbox_stub(env, user_id)?;
            let _: serde_json::Value =
                stub_json(&stub, Method::Post, "/import", Some(dump.clone())).await?;
            restored_mailboxes += 1;
        }
    }

    worker::console_log!(
        "backup.restored key={} mailboxes={}",
        body.key, restored_mailboxes,
    );
    super::json_ok(&serde_json::json!({
        "ok": true,
        "restored_mailboxes": restored_mailboxes,
    }))
}

#[derive(Deserialize, Serialize)]
struct AddAddrReq { user_id: String, address: String }

pub async fn add_address(
    mut req: HttpRequest,
    env: &Env,
    cfg: &AppConfig,
) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let body: AddAddrReq = serde_json::from_slice(&body_bytes(&mut req).await?)?;
    if !cfg.owns_address(&body.address) {
        return Err(ApiError::BadRequest("address not on configured domain".into()));
    }
    stub_passthrough(
        &registry_stub(env)?,
        Method::Post,
        "/addresses",
        Some(serde_json::to_value(&body).unwrap()),
    )
    .await
}

pub async fn remove_address(req: HttpRequest, env: &Env, _cfg: &AppConfig) -> ApiResult<Response> {
    let _ = require_admin_session(&req, env).await?;
    let addr = super::last_segment(&req)
        .ok_or_else(|| ApiError::BadRequest("address".into()))?;
    let path = format!("/addresses?address={}", urlencoding::encode(&addr));
    stub_passthrough(&registry_stub(env)?, Method::Delete, &path, None).await
}

pub async fn status(req: HttpRequest, env: &Env, cfg: &AppConfig) -> ApiResult<Response> {
    // Reachable without auth — returns whether bootstrap is needed and
    // the public app metadata. Used by the frontend on first load.
    let stub = registry_stub(env)?;
    #[derive(Deserialize)]
    #[allow(dead_code)] struct U { id: String }
    let users: Vec<U> = stub_json(&stub, Method::Get, "/users", None).await?;
    let needs_bootstrap = users.is_empty();
    let is_authed = require_auth(&req, env).await.is_ok();
    super::json_ok(&serde_json::json!({
        "needs_bootstrap": needs_bootstrap,
        "is_authed": is_authed,
        "primary_domain": cfg.primary_domain,
        "additional_domains": cfg.additional_domains,
        "app_host": cfg.app_host,
        "app_name": cfg.app_name,
        "user_count": users.len(),
    }))
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
