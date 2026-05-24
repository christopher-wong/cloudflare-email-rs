use worker::*;

use api_types::PublicConfig;

use crate::config::AppConfig;
use crate::error::ApiResult;

pub async fn public_config(cfg: &AppConfig) -> ApiResult<Response> {
    // Build the owned struct each call. The endpoint is hit infrequently
    // (on first SPA load) so the clones are not a concern.
    super::json_ok(&PublicConfig {
        primary_domain: cfg.primary_domain.clone(),
        additional_domains: cfg.additional_domains.clone(),
        app_host: cfg.app_host.clone(),
        app_name: cfg.app_name.clone(),
    })
}
