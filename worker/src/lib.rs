use worker::*;

mod b64;
mod backup;
mod config;
mod crypto;
mod error;
mod ids;
mod mailbox;
mod registry;
mod router;
mod session;
mod webauthn;

mod api;
mod email_in;

pub use mailbox::MailboxDO;
pub use registry::RegistryDO;

#[event(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[event(fetch)]
async fn fetch(req: HttpRequest, env: Env, ctx: Context) -> Result<Response> {
    router::dispatch(req, env, ctx).await
}

#[event(email)]
async fn email(message: ForwardableEmailMessage, env: Env, ctx: Context) -> Result<()> {
    email_in::handle(message, env, ctx).await
}

/// Cron handler. Fires on the cadence declared in wrangler.jsonc's
/// `triggers.crons`. Today's sole job: snapshot every DO into R2.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) -> Result<()> {
    if let Err(e) = api::admin::run_backup(&env).await {
        console_error!("scheduled backup failed: {e}");
    }
    match api::secret::run_purge(&env).await {
        Ok(n) if n > 0 => console_log!("scheduled secret-link purge: removed {n} row(s)"),
        Ok(_) => {}
        Err(e) => console_error!("scheduled secret-link purge failed: {e}"),
    }
    match api::hosted::run_purge(&env).await {
        Ok(n) if n > 0 => console_log!("scheduled hosted-download purge: removed {n} row(s)"),
        Ok(_) => {}
        Err(e) => console_error!("scheduled hosted-download purge failed: {e}"),
    }
    // Orphan blob sweep — must run AFTER the row-level purges above so
    // a row that purge just deleted has its keys treated as orphans
    // on the same tick (they'll have aged past the grace window if
    // they were old enough to be purged).
    match api::orphan::run_sweep(&env).await {
        Ok(r) => console_log!(
            "scheduled orphan sweep: hosted(listed={} grace={} kept={} deleted={}) \
             secret(listed={} grace={} kept={} deleted={})",
            r.hosted.listed, r.hosted.skipped_grace, r.hosted.kept_referenced, r.hosted.deleted_orphan,
            r.secret.listed, r.secret.skipped_grace, r.secret.kept_referenced, r.secret.deleted_orphan,
        ),
        Err(e) => console_error!("scheduled orphan sweep failed: {e}"),
    }
    Ok(())
}
