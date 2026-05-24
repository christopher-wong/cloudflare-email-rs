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
    path = "/api/me/contacts",
    tag = "me",
    description = "Derived contact list — every person the user has emailed or received from, deduped by canonical address, sorted by most recent interaction. Backs the to/cc/bcc autocomplete in Compose.",
    responses(
        (status = 200, body = Vec<ContactView>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn list_contacts() {}

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
//
// Upload moved to /api/uploads/* (unified pipeline). The endpoints
// here are read/cleanup paths only.

#[utoipa::path(
    get,
    path = "/api/messages/{message_id}/attachments",
    tag = "attachments",
    description = "List attachment metadata for a message. Filenames are ciphertext (sealed-to-self); the client decrypts.",
    params(
        ("message_id" = String, Path),
    ),
    responses(
        (status = 200, body = Vec<AttachmentView>),
        (status = 401, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn attachments_list_for_message() {}

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

// ---- Unified upload pipeline --------------------------------------------

#[utoipa::path(
    post,
    path = "/api/uploads/init",
    tag = "uploads",
    description = "Begin an R2 multipart upload. Returns the (r2_key, upload_id) handle the client uses for /parts and /complete. The `kind` picks the R2 prefix (attach / hosted / secret) and post-complete bookkeeping.",
    request_body = UploadInitReq,
    responses(
        (status = 200, body = UploadInitResp),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn uploads_init() {}

#[utoipa::path(
    post,
    path = "/api/uploads/parts",
    tag = "uploads",
    description = "Upload one part of a multipart upload. Body is raw bytes (≤ 6 MiB). Required headers: x-r2-key, x-upload-id, x-part-number (1-indexed).",
    params(
        ("x-r2-key" = String, Header, description = "From /init"),
        ("x-upload-id" = String, Header, description = "From /init"),
        ("x-part-number" = u16, Header, description = "1-indexed; ≥ 1"),
    ),
    request_body(
        content = String,
        content_type = "application/octet-stream",
        description = "Raw part bytes."
    ),
    responses(
        (status = 200, body = UploadPartResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn uploads_parts() {}

#[utoipa::path(
    post,
    path = "/api/uploads/complete",
    tag = "uploads",
    description = "Finalize a multipart upload. For kind=attach, also registers an attachment row in MailboxDO and returns `attachment_id`.",
    request_body = UploadCompleteReq,
    responses(
        (status = 200, body = UploadCompleteResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn uploads_complete() {}

#[utoipa::path(
    post,
    path = "/api/uploads/abort",
    tag = "uploads",
    description = "Abort an in-flight multipart upload. Best-effort cleanup; R2 also expires abandoned multiparts eventually.",
    request_body = UploadAbortReq,
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn uploads_abort() {}

// ---- Secret links --------------------------------------------------------
//
// Password-protected E2E share links. Sender uploads ciphertext via
// /api/uploads (kind=secret), then mints the row here. The recipient
// hits the public viewer endpoints with the URL they were sent
// out-of-band.

#[utoipa::path(
    post,
    path = "/api/secret/create",
    tag = "secret",
    description = "Mint a secret link from previously-uploaded ciphertext + the password-derived check value.",
    request_body = SecretCreateReq,
    responses(
        (status = 200, body = SecretCreateResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn secret_create() {}

#[utoipa::path(
    get,
    path = "/api/secret/mine",
    tag = "secret",
    description = "Sender dashboard: list every secret link the current user has minted.",
    responses(
        (status = 200, body = Vec<SecretSenderRow>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn secret_mine() {}

#[utoipa::path(
    post,
    path = "/api/secret/{token}/revoke",
    tag = "secret",
    description = "Revoke a secret link and delete its R2 attachment blobs.",
    params(
        ("token" = String, Path),
    ),
    responses(
        (status = 200, body = SecretRevokeResp),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn secret_revoke() {}

#[utoipa::path(
    get,
    path = "/api/s/{token}",
    tag = "secret",
    description = "Public viewer metadata (no password required). Returns hint, sender display, KDF params, salt, policy + state. The viewer derives Argon2id locally before calling /open.",
    params(
        ("token" = String, Path),
    ),
    responses(
        (status = 200, body = SecretLinkPublicView),
        (status = 404, body = ErrorResponse),
        (status = 410, description = "self-destructed", body = ErrorResponse),
    ),
)]
pub fn secret_view() {}

#[utoipa::path(
    post,
    path = "/api/s/{token}/open",
    tag = "secret",
    description = "Public unlock. Server compares password_check_b64 against the stored check value. Bumps fail_count on miss; self-destructs the row at the 10th miss.",
    params(
        ("token" = String, Path),
    ),
    request_body = SecretLinkOpenReq,
    responses(
        (status = 200, body = SecretLinkOpenResp),
        (status = 401, description = "bad password", body = ErrorResponse),
        (status = 410, description = "expired / revoked / self-destructed", body = ErrorResponse),
    ),
)]
pub fn secret_open() {}

#[utoipa::path(
    post,
    path = "/api/s/{token}/attachment",
    tag = "secret",
    description = "Public per-chunk ciphertext fetch. Re-verifies the password check; does NOT advance policy state. Optional offset+length for ranged reads (one chunk per call).",
    params(
        ("token" = String, Path),
    ),
    request_body = SecretAttachmentReq,
    responses(
        (status = 200, description = "Raw ciphertext for the requested range.", body = String, content_type = "application/octet-stream"),
        (status = 401, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
        (status = 410, body = ErrorResponse),
    ),
)]
pub fn secret_attachment() {}

// ---- Hosted downloads ---------------------------------------------------
//
// E2E hosted links — Firefox Send / Wormhole.app model. CEK lives in
// the URL fragment, never reaches the server. Created entirely
// client-side after the ciphertext is uploaded via /api/uploads
// (kind=hosted).

#[utoipa::path(
    post,
    path = "/api/hosted/create",
    tag = "hosted",
    description = "Mint a hosted-download row. Server never sees the CEK; the client embeds it in the URL fragment when emailing the link.",
    request_body = HostedCreateReq,
    responses(
        (status = 200, body = HostedCreateResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn hosted_create() {}

#[utoipa::path(
    get,
    path = "/api/hosted/mine",
    tag = "hosted",
    description = "Sender dashboard: list hosted links + per-row `sender_cek_wrap_b64` so the sender can re-decrypt locally.",
    responses(
        (status = 200, body = Vec<HostedSenderRow>),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn hosted_mine() {}

#[utoipa::path(
    post,
    path = "/api/hosted/{token}/revoke",
    tag = "hosted",
    description = "Revoke a hosted-download link and delete its R2 blobs.",
    params(
        ("token" = String, Path),
    ),
    responses(
        (status = 200, body = HostedRevokeResp),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn hosted_revoke() {}

#[utoipa::path(
    get,
    path = "/api/d/{token}",
    tag = "hosted",
    description = "Public landing-page metadata. Sender identity (cleartext), file list (cleartext filenames + mimes), expiry. The CEK to decrypt the bytes lives in the URL fragment.",
    params(
        ("token" = String, Path),
    ),
    responses(
        (status = 200, body = HostedPublicView),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn hosted_view() {}

#[utoipa::path(
    get,
    path = "/api/d/{token}/file",
    tag = "hosted",
    description = "Stream one file's ciphertext. Supports HTTP Range for resumable browser downloads. Server returns `Content-Type: application/octet-stream` because it doesn't know the real mime.",
    params(
        ("token" = String, Path),
        ("r2_key" = String, Query, description = "Must be a key listed on this row's `files`."),
        ("Range" = Option<String>, Header, description = "Optional `bytes=START-END`."),
    ),
    responses(
        (status = 200, description = "Full ciphertext.", body = String, content_type = "application/octet-stream"),
        (status = 206, description = "Partial content (Range).", body = String, content_type = "application/octet-stream"),
        (status = 404, body = ErrorResponse),
        (status = 409, description = "expired or revoked", body = ErrorResponse),
    ),
)]
pub fn hosted_download() {}

// ---- Realtime ------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/realtime",
    tag = "mail",
    description = "WebSocket upgrade. Handed off to the MailboxDO which broadcasts message.new / draft.upsert / draft.delete events.",
    responses(
        (status = 101, description = "Upgrade to WebSocket."),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
    ),
)]
pub fn realtime() {}

// ---- Thread cascade delete ----------------------------------------------

#[utoipa::path(
    delete,
    path = "/api/threads/{thread_id}",
    tag = "mail",
    description = "Cascade-delete every message + attachment + R2 blob in a thread. Returns the count of R2 objects swept.",
    params(
        ("thread_id" = String, Path),
    ),
    responses(
        (status = 200, body = DeleteThreadResp),
        (status = 401, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn delete_thread() {}

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
    delete,
    path = "/api/admin/invites/{token}",
    tag = "admin",
    description = "Revoke an unredeemed invite. Refuses if the invite has already been redeemed (those are audit trail).",
    params(
        ("token" = String, Path),
    ),
    responses(
        (status = 200, body = OkResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
        (status = 409, description = "invite already redeemed", body = ErrorResponse),
    ),
)]
pub fn admin_delete_invite() {}

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

#[utoipa::path(
    post,
    path = "/api/admin/backup",
    tag = "admin",
    description = "Dump every DO (registry + every mailbox) to a JSON bundle at `backups/<iso>.json` in R2. Same code path the scheduled daily backup uses.",
    responses(
        (status = 200, body = BackupCreateResp),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_backup() {}

#[utoipa::path(
    get,
    path = "/api/admin/backups",
    tag = "admin",
    description = "List backup bundles in R2 + the cron schedule the scheduled handler runs on.",
    responses(
        (status = 200, body = BackupListResp),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
    ),
)]
pub fn admin_list_backups() {}

#[utoipa::path(
    post,
    path = "/api/admin/restore",
    tag = "admin",
    description = "Replay a backup bundle. Registry rows go first (so user_ids exist when MailboxDO rows reference them). Each table uses INSERT OR REPLACE so re-running is idempotent.",
    request_body = RestoreReq,
    responses(
        (status = 200, body = RestoreResp),
        (status = 400, body = ErrorResponse),
        (status = 401, body = ErrorResponse),
        (status = 403, body = ErrorResponse),
        (status = 404, body = ErrorResponse),
    ),
)]
pub fn admin_restore() {}

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
