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
        p::list_contacts,
        p::get_image_settings,
        p::set_image_settings,
        p::add_image_domain,
        p::remove_image_domain,
        p::passkeys_list,
        p::passkeys_add_options,
        p::passkeys_add_verify,
        p::passkeys_remove,

        // Mail
        p::list_threads,
        p::get_thread,
        p::delete_thread,
        p::patch_message,
        p::delete_message,
        p::send_message,
        p::realtime,
        p::proxy_image,

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

        // Attachments (read/cleanup only — upload moved to /api/uploads/*)
        p::attachments_list_for_message,
        p::attachments_download,
        p::attachments_delete,

        // Unified upload pipeline (all kinds: attach / hosted / secret)
        p::uploads_init,
        p::uploads_parts,
        p::uploads_complete,
        p::uploads_abort,

        // Secret links (password-protected E2E)
        p::secret_create,
        p::secret_mine,
        p::secret_revoke,
        p::secret_view,
        p::secret_open,
        p::secret_attachment,

        // Hosted downloads (E2E, fragment-key)
        p::hosted_create,
        p::hosted_mine,
        p::hosted_revoke,
        p::hosted_view,
        p::hosted_download,

        // Admin
        p::admin_create_invite,
        p::admin_list_invites,
        p::admin_delete_invite,
        p::admin_list_users,
        p::admin_add_address,
        p::admin_remove_address,
        p::admin_status,
        p::admin_backup,
        p::admin_list_backups,
        p::admin_restore,

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
        s::AttachmentView,
        s::SendAttachmentRef,

        // Unified upload pipeline
        s::UploadKind,
        s::UploadInitReq,
        s::UploadInitResp,
        s::UploadPartResp,
        s::UploadedPartRef,
        s::UploadCompleteReq,
        s::UploadCompleteResp,
        s::UploadAbortReq,

        // Secret links
        s::SecretAttachmentRef,
        s::SecretCreateReq,
        s::SecretCreateResp,
        s::SecretSenderRow,
        s::SecretRevokeResp,
        s::SecretLinkPublicView,
        s::SecretLinkOpenReq,
        s::SecretLinkOpenResp,
        s::SecretAttachmentReq,

        // Hosted downloads
        s::HostedFile,
        s::HostedCreateReq,
        s::HostedCreateResp,
        s::HostedSenderRow,
        s::HostedPublicView,
        s::HostedRevokeResp,

        // Misc / mail / admin extras
        s::DeleteThreadResp,
        s::BackupCreateResp,
        s::BackupListItem,
        s::BackupListResp,
        s::RestoreReq,
        s::RestoreResp,

        s::CreateInviteReq,
        s::CreateInviteResp,
        s::InviteView,
        s::AddAddressReq,
        s::AdminStatusResp,
        s::PublicConfig,
        s::ContactView,
        s::ImageSettings,
        s::SetImageDefaultReq,
        s::AddImageDomainReq,
    )),
    tags(
        (name = "auth", description = "Bootstrap + WebAuthn ceremonies + session lifecycle."),
        (name = "me", description = "Authenticated user's profile and owned addresses."),
        (name = "passkeys", description = "Per-user passkey credential management."),
        (name = "mail", description = "Threads, messages, send + realtime."),
        (name = "drafts", description = "Encrypted draft persistence."),
        (name = "labels", description = "User-defined labels and message-label edges."),
        (name = "attachments", description = "R2-backed encrypted attachment storage. Upload moved to `uploads`."),
        (name = "uploads", description = "Unified chunked R2 multipart upload pipeline. One API for attach / hosted / secret kinds."),
        (name = "secret", description = "Password-protected E2E secret links (ProtonMail-style)."),
        (name = "hosted", description = "End-to-end encrypted hosted downloads (Firefox Send / Wormhole.app model — key in URL fragment)."),
        (name = "admin", description = "Admin-only invites, user listing, address ownership, backup / restore."),
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
