//! Stub functions carrying `#[utoipa::path]` annotations for every route
//! served by `worker/src/router.rs`. The bodies are intentionally empty —
//! utoipa only reads the attribute to build the spec.
//!
//! When you add or rename a route in `router.rs`, mirror it here and add
//! the stub to the `paths(...)` list in `main.rs`.

#![allow(dead_code, unused_variables)]

use crate::schemas::*;

// ---- Bootstrap & auth ----------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/bootstrap",
    tag = "auth",
    description = "One-shot tenant bootstrap. Refuses if any users already exist.",
    request_body = BootstrapReq,
    responses(
        (status = 200, body = BootstrapResp),
        (status = 409, description = "already bootstrapped", body = ErrorResponse),
    ),
)]
pub fn bootstrap() {}

#[utoipa::path(
    post,
    path = "/api/auth/register/options",
    tag = "auth",
    description = "Start a WebAuthn registration ceremony against an invite token.",
    request_body = RegisterOptionsReq,
    responses(
        (status = 200, body = RegisterOptions),
        (status = 400, body = ErrorResponse),
    ),
)]
pub fn register_options() {}

#[utoipa::path(
    post,
    path = "/api/auth/register/verify",
    tag = "auth",
    description = "Verify the attestation, create the user, and issue a session cookie.",
    request_body = RegisterVerifyReq,
    responses(
        (status = 200, body = RegisterVerifyResp),
        (status = 400, body = ErrorResponse),
    ),
)]
pub fn register_verify() {}

#[utoipa::path(
    post,
    path = "/api/auth/login/options",
    tag = "auth",
    description = "Allocate a server-side WebAuthn challenge for sign-in.",
    responses(
        (status = 200, body = LoginOptions),
    ),
)]
pub fn login_options() {}

#[utoipa::path(
    post,
    path = "/api/auth/login/verify",
    tag = "auth",
    description = "Verify the assertion, update sign count, and issue a session cookie.",
    request_body = LoginVerifyReq,
    responses(
        (status = 200, body = LoginVerifyResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn login_verify() {}

#[utoipa::path(
    post,
    path = "/api/auth/recovery/begin",
    tag = "auth",
    description = "Step 1 of passphrase recovery: returns the recovery wrap and a sealed proof token.",
    request_body = RecoveryBeginReq,
    responses(
        (status = 200, body = RecoveryBeginResp),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn recovery_begin() {}

#[utoipa::path(
    post,
    path = "/api/auth/recovery/verify",
    tag = "auth",
    description = "Step 2: client returns the decrypted proof token, server issues a session.",
    request_body = RecoveryVerifyReq,
    responses(
        (status = 200, body = UserView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn recovery_verify() {}

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "auth",
    description = "Invalidate the current session cookie.",
    responses(
        (status = 200, body = OkResponse),
    ),
)]
pub fn logout() {}

// ---- Me + passkeys -------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/me",
    tag = "me",
    description = "Return the authenticated user's profile.",
    responses(
        (status = 200, body = UserView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn get_me() {}

#[utoipa::path(
    patch,
    path = "/api/me",
    tag = "me",
    description = "Update mutable profile fields (currently just display_name).",
    request_body = PatchMeReq,
    responses(
        (status = 200, body = UserView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn patch_me() {}

#[utoipa::path(
    get,
    path = "/api/me/addresses",
    tag = "me",
    description = "List all email addresses owned by the authenticated user.",
    responses(
        (status = 200, body = Vec<String>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn list_addresses() {}

#[utoipa::path(
    get,
    path = "/api/me/passkeys",
    tag = "passkeys",
    description = "List passkey credentials registered to the current user.",
    responses(
        (status = 200, body = Vec<CredentialView>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn passkeys_list() {}

#[utoipa::path(
    post,
    path = "/api/me/passkeys/add/options",
    tag = "passkeys",
    description = "Start an add-passkey ceremony. Returns PRF-extension options and excludes existing creds.",
    responses(
        (status = 200, body = AddPasskeyOptions),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn passkeys_add_options() {}

#[utoipa::path(
    post,
    path = "/api/me/passkeys/add/verify",
    tag = "passkeys",
    description = "Verify the new attestation and store the wrap of the user's existing X25519 priv.",
    request_body = AddPasskeyVerifyReq,
    responses(
        (status = 200, body = OkResponse),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn passkeys_add_verify() {}

#[utoipa::path(
    delete,
    path = "/api/me/passkeys/{credential_id_b64}",
    tag = "passkeys",
    description = "Remove a passkey credential + its wrap. Last passkey on a user is refused.",
    params(
        ("credential_id_b64" = String, Path, description = "base64url-encoded WebAuthn credential id"),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
        (status = 409, body = ErrorResponse),
    ),
)]
pub fn passkeys_remove() {}

// ---- Mail ----------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/threads",
    tag = "mail",
    description = "List threads in the authenticated user's mailbox. Forwards query string to the mailbox DO.",
    responses(
        (status = 200, body = Vec<ThreadSummary>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn list_threads() {}

#[utoipa::path(
    get,
    path = "/api/threads/{thread_id}",
    tag = "mail",
    description = "Return all messages in a thread.",
    params(
        ("thread_id" = String, Path),
    ),
    responses(
        (status = 200, body = Vec<MessageView>),
        (status = 401, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn get_thread() {}

#[utoipa::path(
    patch,
    path = "/api/messages/{message_id}",
    tag = "mail",
    description = "Update message flags (starred/read/archived) or move it to another thread.",
    params(
        ("message_id" = String, Path),
    ),
    request_body = PatchMessageReq,
    responses(
        (status = 200, body = MessageView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn patch_message() {}

#[utoipa::path(
    delete,
    path = "/api/messages/{message_id}",
    tag = "mail",
    params(
        ("message_id" = String, Path),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn delete_message() {}

#[utoipa::path(
    post,
    path = "/api/messages/send",
    tag = "mail",
    description = "Send an outbound message via the EMAIL binding and seal a copy for the sender's mailbox.",
    request_body = SendReq,
    responses(
        (status = 200, body = SendResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn send_message() {}

// ---- Drafts --------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/drafts",
    tag = "drafts",
    description = "Create or upsert a draft. ID is supplied by the client for idempotent autosaves.",
    request_body = DraftUpsertReq,
    responses(
        (status = 200, body = DraftView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn drafts_upsert() {}

#[utoipa::path(
    get,
    path = "/api/drafts",
    tag = "drafts",
    responses(
        (status = 200, body = Vec<DraftView>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn drafts_list() {}

#[utoipa::path(
    delete,
    path = "/api/drafts/{draft_id}",
    tag = "drafts",
    params(
        ("draft_id" = String, Path),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn drafts_delete() {}

// ---- Labels --------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/labels",
    tag = "labels",
    request_body = CreateLabelReq,
    responses(
        (status = 200, body = LabelView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn labels_create() {}

#[utoipa::path(
    get,
    path = "/api/labels",
    tag = "labels",
    responses(
        (status = 200, body = Vec<LabelView>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn labels_list() {}

#[utoipa::path(
    patch,
    path = "/api/labels/{label_id}",
    tag = "labels",
    params(
        ("label_id" = String, Path),
    ),
    request_body = UpdateLabelReq,
    responses(
        (status = 200, body = LabelView),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn labels_update() {}

#[utoipa::path(
    delete,
    path = "/api/labels/{label_id}",
    tag = "labels",
    params(
        ("label_id" = String, Path),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn labels_delete() {}

#[utoipa::path(
    post,
    path = "/api/message-labels",
    tag = "labels",
    description = "Toggle a label on a message.",
    request_body = ToggleMessageLabelReq,
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn message_labels_toggle() {}

// ---- Attachments ---------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/attachments",
    tag = "attachments",
    description = "Upload an encrypted attachment blob. Query params: mime, filename_ct_b64, draft_id. Body is raw bytes.",
    params(
        ("mime" = Option<String>, Query),
        ("filename_ct_b64" = Option<String>, Query),
        ("draft_id" = Option<String>, Query),
    ),
    request_body(
        content = String,
        content_type = "application/octet-stream",
        description = "Raw encrypted attachment bytes."
    ),
    responses(
        (status = 200, body = AttachmentUploadResp),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn attachments_upload() {}

#[utoipa::path(
    get,
    path = "/api/attachments/{attachment_id}",
    tag = "attachments",
    description = "Stream back the encrypted attachment bytes.",
    params(
        ("attachment_id" = String, Path),
    ),
    responses(
        (status = 200, description = "Raw bytes; content-type from R2 metadata.", body = String, content_type = "application/octet-stream"),
        (status = 401, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn attachments_download() {}

#[utoipa::path(
    delete,
    path = "/api/attachments/{attachment_id}",
    tag = "attachments",
    params(
        ("attachment_id" = String, Path),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn attachments_delete() {}

// ---- Admin ---------------------------------------------------------------

#[utoipa::path(
    post,
    path = "/api/admin/invites",
    tag = "admin",
    description = "Issue a new invite. Admin-only.",
    request_body = CreateInviteReq,
    responses(
        (status = 200, body = CreateInviteResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_create_invite() {}

#[utoipa::path(
    get,
    path = "/api/admin/invites",
    tag = "admin",
    responses(
        (status = 200, body = Vec<InviteView>),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_list_invites() {}

#[utoipa::path(
    get,
    path = "/api/admin/users",
    tag = "admin",
    responses(
        (status = 200, body = Vec<UserView>),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_list_users() {}

#[utoipa::path(
    post,
    path = "/api/admin/addresses",
    tag = "admin",
    description = "Attach an additional owned address to a user.",
    request_body = AddAddressReq,
    responses(
        (status = 200, body = OkResponse),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_add_address() {}

#[utoipa::path(
    delete,
    path = "/api/admin/addresses/{address}",
    tag = "admin",
    params(
        ("address" = String, Path),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_remove_address() {}

#[utoipa::path(
    get,
    path = "/api/admin/status",
    tag = "admin",
    description = "Unauthenticated bootstrap-status probe used on first load.",
    responses(
        (status = 200, body = AdminStatusResp),
    ),
)]
pub fn admin_status() {}

// ---- Misc ----------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/config",
    tag = "misc",
    description = "Public, unauthenticated app config.",
    responses(
        (status = 200, body = PublicConfig),
    ),
)]
pub fn public_config() {}
