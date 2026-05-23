use worker::*;

mod b64;
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
