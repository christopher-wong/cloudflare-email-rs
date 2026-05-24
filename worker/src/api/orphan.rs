//! Scheduled orphan-blob sweep.
//!
//! The chunked upload pipeline lands ciphertext at
//! `hosted/{user_id}/{uuid}` or `secret/{user_id}/{uuid}` BEFORE the
//! row that references it exists. If the user aborts compose
//! mid-flight (closes tab, kills draft, network error after the
//! final part) the bytes are stranded — no `hosted_downloads` /
//! `secret_links` row to anchor them.
//!
//! Daily sweep: list each R2 prefix, cross-ref against
//! /referenced-keys, delete anything older than the grace window
//! that nobody owns. Runs alongside the daily backup.
//!
//! Tunables:
//!   - `ORPHAN_GRACE_MS` keeps freshly-uploaded bytes around long
//!     enough that an in-flight compose isn't reaped mid-flow.
//!   - `LIST_PAGE_SIZE` controls how aggressively we page R2. Bigger
//!     = fewer round trips; smaller = lighter memory profile per
//!     iteration.

use std::collections::HashSet;

use worker::*;

use crate::error::{ApiError, ApiResult};

use super::{registry_stub, stub_json};

/// Grace period from R2 upload time before a blob is eligible for
/// sweep. 24h matches the "user might've been composing for a while
/// before they hit send" case and prevents reaping uploads that just
/// completed but haven't yet had their `*-create` call land.
const ORPHAN_GRACE_MS: i64 = 24 * 60 * 60 * 1000;
const LIST_PAGE_SIZE: u32 = 1000;

pub async fn run_sweep(env: &Env) -> ApiResult<OrphanSweepResult> {
    let mut result = OrphanSweepResult::default();
    sweep_prefix(env, "hosted/", "/hosted-downloads/referenced-keys", &mut result.hosted).await?;
    sweep_prefix(env, "secret/", "/secret-links/referenced-keys", &mut result.secret).await?;
    Ok(result)
}

#[derive(Default, Debug)]
pub struct OrphanSweepResult {
    pub hosted: PrefixSweepStats,
    pub secret: PrefixSweepStats,
}

#[derive(Default, Debug)]
pub struct PrefixSweepStats {
    pub listed: u32,
    pub skipped_grace: u32,
    pub kept_referenced: u32,
    pub deleted_orphan: u32,
}

async fn sweep_prefix(
    env: &Env,
    r2_prefix: &str,
    referenced_path: &str,
    stats: &mut PrefixSweepStats,
) -> ApiResult<()> {
    let reg = registry_stub(env)?;
    let referenced: Vec<String> =
        stub_json(&reg, Method::Get, referenced_path, None).await?;
    let referenced: HashSet<String> = referenced.into_iter().collect();

    let r2 = env
        .bucket("BLOBS")
        .map_err(|e| ApiError::Internal(format!("R2 binding: {e}")))?;
    let now = Date::now().as_millis() as i64;
    let cutoff = now - ORPHAN_GRACE_MS;
    let mut cursor: Option<String> = None;
    loop {
        let mut builder = r2.list().prefix(r2_prefix.to_string()).limit(LIST_PAGE_SIZE);
        if let Some(c) = cursor.clone() {
            builder = builder.cursor(c);
        }
        let page = builder
            .execute()
            .await
            .map_err(|e| ApiError::Internal(format!("R2 list {r2_prefix}: {e}")))?;
        for obj in page.objects() {
            stats.listed += 1;
            let key = obj.key();
            let uploaded_ms = obj.uploaded().as_millis() as i64;
            if uploaded_ms > cutoff {
                stats.skipped_grace += 1;
                continue;
            }
            if referenced.contains(&key) {
                stats.kept_referenced += 1;
                continue;
            }
            if let Err(e) = r2.delete(&key).await {
                worker::console_log!(
                    "orphan_sweep.r2_delete_failed prefix={} key={} err={}",
                    r2_prefix, key, e
                );
                continue;
            }
            stats.deleted_orphan += 1;
        }
        if page.truncated() {
            cursor = page.cursor();
            if cursor.is_none() { break; }
        } else {
            break;
        }
    }
    Ok(())
}
