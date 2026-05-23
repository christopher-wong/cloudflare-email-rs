use serde::Serialize;
use worker::*;

use crate::config::AppConfig;
use crate::error::ApiResult;

#[derive(Serialize)]
struct PublicConfig<'a> {
    primary_domain: &'a str,
    additional_domains: &'a [String],
    app_host: &'a str,
    app_name: &'a str,
}

pub async fn public_config(cfg: &AppConfig) -> ApiResult<Response> {
    super::json_ok(&PublicConfig {
        primary_domain: &cfg.primary_domain,
        additional_domains: &cfg.additional_domains,
        app_host: &cfg.app_host,
        app_name: &cfg.app_name,
    })
}
