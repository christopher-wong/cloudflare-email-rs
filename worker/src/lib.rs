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
    Ok(())
}
