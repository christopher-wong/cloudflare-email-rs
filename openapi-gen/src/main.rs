//! cfemail OpenAPI generator.
//!
//! Walks the `#[utoipa::path]`-annotated stubs in `paths` and the
//! `ToSchema`-derived types in `schemas`, builds an OpenAPI 3 document, and
//! writes it to `openapi.json` at the repo root (sibling of this crate's
//! parent directory).
//!
//! Invoke via `make openapi` or `cargo run -p openapi-gen`.

use std::path::PathBuf;

use utoipa::OpenApi;

mod paths;
mod schemas;

use paths as p;
use schemas as s;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "bmail HTTP API",
        version = env!("CARGO_PKG_VERSION"),
        description = "End-to-end encrypted email backed by Cloudflare Workers + Durable Objects. \
                       All `/api/*` routes are served by the Rust worker in `worker/src/router.rs`.",
    ),
    paths(
        // Auth
        p::bootstrap,
        p::register_options,
        p::register_verify,
        p::login_options,
        p::login_verify,
        p::recovery_begin,
        p::recovery_verify,
        p::logout,

        // Me + passkeys
        p::get_me,
        p::patch_me,
        p::list_addresses,
        p::passkeys_list,
        p::passkeys_add_options,
        p::passkeys_add_verify,
        p::passkeys_remove,

        // Mail
        p::list_threads,
        p::get_thread,
        p::patch_message,
        p::delete_message,
        p::send_message,

        // Drafts
        p::drafts_upsert,
        p::drafts_list,
        p::drafts_delete,

        // Labels
        p::labels_create,
        p::labels_list,
        p::labels_update,
        p::labels_delete,
        p::message_labels_toggle,

        // Attachments
        p::attachments_upload,
        p::attachments_download,
        p::attachments_delete,

        // Admin
        p::admin_create_invite,
        p::admin_list_invites,
        p::admin_list_users,
        p::admin_add_address,
        p::admin_remove_address,
        p::admin_status,

        // Misc
        p::public_config,
    ),
    components(schemas(
        s::ErrorResponse,
        s::OkResponse,
        s::BootstrapReq,
        s::BootstrapResp,
        s::RegisterOptionsReq,
        s::RegisterOptions,
        s::RpInfo,
        s::PubKeyUser,
        s::PubKeyCredParam,
        s::AuthenticatorSelection,
        s::Extensions,
        s::PrfInput,
        s::PrfEval,
        s::AttestationResp,
        s::RegisterVerifyReq,
        s::RegisterVerifyResp,
        s::LoginOptions,
        s::LoginVerifyReq,
        s::LoginVerifyResp,
        s::RecoveryBeginReq,
        s::RecoveryBeginResp,
        s::RecoveryVerifyReq,
        s::UserView,
        s::PatchMeReq,
        s::CredentialView,
        s::KeyWrapView,
        s::ExcludeCred,
        s::AddPasskeyOptions,
        s::AddPasskeyVerifyReq,
        s::SendReq,
        s::SendResp,
        s::ThreadSummary,
        s::MessageView,
        s::PatchMessageReq,
        s::LabelView,
        s::CreateLabelReq,
        s::UpdateLabelReq,
        s::ToggleMessageLabelReq,
        s::DraftUpsertReq,
        s::DraftView,
        s::AttachmentUploadResp,
        s::CreateInviteReq,
        s::CreateInviteResp,
        s::InviteView,
        s::AddAddressReq,
        s::AdminStatusResp,
        s::PublicConfig,
    )),
    tags(
        (name = "auth", description = "Bootstrap + WebAuthn ceremonies + session lifecycle."),
        (name = "me", description = "Authenticated user's profile and owned addresses."),
        (name = "passkeys", description = "Per-user passkey credential management."),
        (name = "mail", description = "Threads, messages, and sending."),
        (name = "drafts", description = "Encrypted draft persistence."),
        (name = "labels", description = "User-defined labels and message-label edges."),
        (name = "attachments", description = "R2-backed encrypted attachment storage."),
        (name = "admin", description = "Admin-only invites, user listing, and address ownership."),
        (name = "misc", description = "Public, unauthenticated config."),
    ),
)]
struct ApiDoc;

fn main() {
    // Workspace root is the parent of this crate's directory.
    let out_path: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("openapi-gen has a parent dir")
        .join("openapi.json");

    let doc = ApiDoc::openapi();
    let json = doc.to_pretty_json().expect("serialize openapi doc");
    std::fs::write(&out_path, json).expect("write openapi.json");
    println!("wrote {}", out_path.display());
}
