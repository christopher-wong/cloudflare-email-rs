//! HTTP dispatch.

use worker::*;

use crate::api;
use crate::config::AppConfig;
use crate::error;

pub async fn dispatch(req: HttpRequest, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.uri().path().to_string();
    let method = req.method().as_str().to_string();

    // Apple App Site Association — required for cross-platform passkey
    // operations to work in a companion native iOS app (WebCredentials
    // federation). Apple's prober fetches this exact path and refuses
    // passkey operations for the RP if the response isn't a plain JSON
    // document at the right Content-Type. No redirects, no auth, no
    // SPA fallback — handle it before the asset shim.
    if path == "/.well-known/apple-app-site-association" && method == "GET" {
        return aasa_response();
    }

    if !path.starts_with("/api/") {
        return serve_assets(env, req).await;
    }

    let cfg = match AppConfig::load(&env) {
        Ok(c) => c,
        Err(e) => return error::to_response(e),
    };

    let result: std::result::Result<Response, error::ApiError> = match (
        method.as_str(),
        path.as_str(),
    ) {
        ("POST", "/api/bootstrap") => api::auth::bootstrap(req, &env, &cfg).await,

        ("POST", "/api/auth/register/options") => api::auth::register_options(req, &env, &cfg).await,
        ("POST", "/api/auth/register/verify") => api::auth::register_verify(req, &env, &cfg).await,
        ("POST", "/api/auth/login/options") => api::auth::login_options(req, &env, &cfg).await,
        ("POST", "/api/auth/login/verify") => api::auth::login_verify(req, &env, &cfg).await,
        ("POST", "/api/auth/recovery/begin") => api::auth::recovery_begin(req, &env, &cfg).await,
        ("POST", "/api/auth/recovery/verify") => api::auth::recovery_verify(req, &env, &cfg).await,
        ("POST", "/api/auth/logout") => api::auth::logout(req, &env).await,

        ("GET", "/api/me/passkeys") => api::passkeys::list(req, &env, &cfg).await,
        ("POST", "/api/me/passkeys/add/options") => api::passkeys::add_options(req, &env, &cfg).await,
        ("POST", "/api/me/passkeys/add/verify") => api::passkeys::add_verify(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/me/passkeys/") => api::passkeys::remove(req, &env, &cfg).await,

        ("GET", "/api/me") => api::me::get(req, &env, &cfg).await,
        ("PATCH", "/api/me") => api::me::patch(req, &env, &cfg).await,
        ("GET", "/api/me/addresses") => api::me::list_addresses(req, &env, &cfg).await,

        ("GET", "/api/threads") => api::mail::list_threads(req, &env, &cfg).await,
        ("GET", p) if p.starts_with("/api/threads/") => api::mail::get_thread(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/threads/") => api::mail::delete_thread(req, &env, &cfg).await,
        ("GET", "/api/realtime") => api::mail::realtime(req, &env, &cfg).await,
        ("PATCH", p) if p.starts_with("/api/messages/") => api::mail::patch_message(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/messages/") => api::mail::delete_message(req, &env, &cfg).await,
        ("POST", "/api/messages/send") => api::mail::send(req, &env, &cfg).await,

        ("POST", "/api/drafts") => api::drafts::upsert(req, &env, &cfg).await,
        ("GET", "/api/drafts") => api::drafts::list(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/drafts/") => api::drafts::delete(req, &env, &cfg).await,

        ("POST", "/api/labels") => api::labels::create(req, &env, &cfg).await,
        ("GET", "/api/labels") => api::labels::list(req, &env, &cfg).await,
        ("PATCH", p) if p.starts_with("/api/labels/") => api::labels::update(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/labels/") => api::labels::delete(req, &env, &cfg).await,
        ("POST", "/api/message-labels") => api::labels::toggle(req, &env, &cfg).await,

        ("POST", "/api/attachments") => api::attachments::upload(req, &env, &cfg).await,
        ("GET", p) if p.starts_with("/api/messages/") && p.ends_with("/attachments") => {
            api::attachments::list_for_message(req, &env, &cfg).await
        }
        ("GET", p) if p.starts_with("/api/attachments/") => api::attachments::download(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/attachments/") => api::attachments::delete(req, &env, &cfg).await,

        ("POST", "/api/admin/invites") => api::admin::create_invite(req, &env, &cfg).await,
        ("GET", "/api/admin/invites") => api::admin::list_invites(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/admin/invites/") => api::admin::delete_invite(req, &env, &cfg).await,
        ("GET", "/api/admin/users") => api::admin::list_users(req, &env, &cfg).await,
        ("POST", "/api/admin/addresses") => api::admin::add_address(req, &env, &cfg).await,
        ("DELETE", p) if p.starts_with("/api/admin/addresses/") => api::admin::remove_address(req, &env, &cfg).await,
        ("GET", "/api/admin/status") => api::admin::status(req, &env, &cfg).await,

        ("GET", "/api/config") => api::misc::public_config(&cfg).await,

        _ => Err(error::ApiError::NotFound),
    };

    match result {
        Ok(r) => Ok(r),
        Err(e) => error::to_response(e),
    }
}

fn aasa_response() -> Result<Response> {
    // The associated-domains body. Hardcoded here rather than read from
    // a var because (a) the App ID rarely changes, (b) Apple cares about
    // exact bytes, and (c) it keeps a misconfigured wrangler.jsonc from
    // silently breaking passkey federation. Edit if your Apple Team ID
    // / bundle ID changes.
    const BODY: &str = r#"{"webcredentials":{"apps":["L6678C3HLZ.middleseat.bmail"]}}"#;
    let mut resp = Response::ok(BODY)?;
    resp.headers_mut()
        .set("Content-Type", "application/json")?;
    Ok(resp)
}

async fn serve_assets(env: Env, req: HttpRequest) -> Result<Response> {
    // The Assets binding handles SPA fallback (configured in wrangler.jsonc).
    // Under the `http` feature it returns `http::Response<worker::Body>`,
    // which we convert to `worker::Response` via the provided TryFrom impl
    // so the dispatch return type stays consistent.
    let assets = env.assets("ASSETS")?;
    let http_resp = assets.fetch_request(req).await?;
    Response::try_from(http_resp)
}
