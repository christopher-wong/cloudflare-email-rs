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
        ("GET", "/api/me/contacts") => api::me::list_contacts(req, &env, &cfg).await,

        // Per-user remote-image settings: the global "load by default"
        // flag plus the allowlist of sender domains the user trusts.
        ("GET", "/api/me/image-settings") => api::image_settings::get(req, &env, &cfg).await,
        ("PUT", "/api/me/image-settings") => api::image_settings::set_default(req, &env, &cfg).await,
        ("POST", "/api/me/image-settings/domains") => {
            api::image_settings::add_domain(req, &env, &cfg).await
        }
        ("DELETE", p) if p.starts_with("/api/me/image-settings/domains/") => {
            api::image_settings::remove_domain(req, &env, &cfg).await
        }

        // Image proxy for inbound HTML email. Auth'd; rewrites a
        // remote image URL through Cloudflare so the recipient's IP
        // never reaches the original sender (defeats tracking pixels).
        ("GET", "/api/img") => api::img::proxy(req, &env, &cfg).await,

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

        // Unified upload pipeline — kind ∈ { attach, hosted, secret }
        // picks the R2 prefix and post-complete bookkeeping. All file
        // uploads (regular email, hosted links, secret-link ciphertext)
        // go through here.
        ("POST", "/api/uploads/init") => api::uploads::init(req, &env, &cfg).await,
        ("POST", "/api/uploads/parts") => api::uploads::part(req, &env, &cfg).await,
        ("POST", "/api/uploads/complete") => api::uploads::complete(req, &env, &cfg).await,
        ("POST", "/api/uploads/abort") => api::uploads::abort(req, &env, &cfg).await,

        // Attachment read paths (download / list / delete) stay — only
        // the upload was unified into /api/uploads/*.
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
        ("POST", "/api/admin/backup") => api::admin::backup(req, &env, &cfg).await,
        ("GET", "/api/admin/backups") => api::admin::list_backups(req, &env, &cfg).await,
        ("POST", "/api/admin/restore") => api::admin::restore(req, &env, &cfg).await,

        ("GET", "/api/config") => api::misc::public_config(&cfg).await,

        // Secret-link (password-protected outside-recipient) flow.
        // Authenticated, sender-side:
        ("POST", "/api/secret/create") => api::secret::create(req, &env, &cfg).await,
        ("GET", "/api/secret/mine") => api::secret::list_mine(req, &env, &cfg).await,
        ("POST", p) if p.starts_with("/api/secret/") && p.ends_with("/revoke") => {
            api::secret::revoke(req, &env, &cfg).await
        }
        // Unauthenticated, recipient-side:
        ("GET", p) if p.starts_with("/api/s/")
            && !p.contains("/open")
            && !p.contains("/attachment") =>
        {
            api::secret::view(req, &env, &cfg).await
        }
        ("POST", p) if p.starts_with("/api/s/") && p.ends_with("/open") => {
            api::secret::open(req, &env, &cfg).await
        }
        ("POST", p) if p.starts_with("/api/s/") && p.ends_with("/attachment") => {
            api::secret::attachment(req, &env, &cfg).await
        }

        // Hosted downloads — Firefox Send / Wormhole.app model.
        // Client-driven: the sender's browser generates a CEK, uploads
        // ciphertext via /api/uploads (kind=hosted), then POSTs the
        // encrypted metadata here. The CEK never reaches the server;
        // it lives in the URL fragment of the share link.
        ("POST", "/api/hosted/create") => api::hosted::create(req, &env, &cfg).await,
        ("GET", "/api/hosted/mine") => api::hosted::list_mine(req, &env, &cfg).await,
        ("POST", p) if p.starts_with("/api/hosted/") && p.ends_with("/revoke") => {
            api::hosted::revoke(req, &env, &cfg).await
        }
        ("GET", p) if p.starts_with("/api/d/") && !p.contains("/file") => {
            api::hosted::view(req, &env, &cfg).await
        }
        ("GET", p) if p.starts_with("/api/d/") && p.ends_with("/file") => {
            api::hosted::download(req, &env, &cfg).await
        }

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
