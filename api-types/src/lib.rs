//! Single source of truth for every HTTP request / response shape on
//! the cfemail API.
//!
//! Consumed by both:
//!
//!  * `worker/` (wasm32) — the handlers in `worker/src/api/*.rs`
//!    `use api_types::*` for their request/response structs.
//!  * `openapi-gen/` (native) — generates `openapi.json` by walking
//!    these structs' `utoipa::ToSchema` impls.
//!
//! Editing one struct here updates both sides in lockstep — the worker
//! handler will fail to compile if it tries to read a field that no
//! longer exists, and the spec regenerates with the new shape on the
//! next `make openapi`.
//!
//! **Dependency rule:** this crate must compile on BOTH `wasm32-unknown-unknown`
//! AND native targets. Stick to `serde`, `serde_json`, and `utoipa`. No
//! `worker::*`, no `getrandom/js`, no `std::time::SystemTime`. If you
//! need a worker-only helper, keep it inside `worker/src/api/`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ---- Error envelope -------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ErrorResponse {
    /// Human-readable error message. Status code carries the category
    /// (400/401/403/404/409/500).
    pub error: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct OkResponse {
    pub ok: bool,
}

// ---- Bootstrap & auth -----------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct BootstrapReq {
    pub handle: String,
    pub addresses: Vec<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct BootstrapResp {
    pub invite_token: String,
    pub enroll_url: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RegisterOptionsReq {
    pub invite_token: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RpInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PubKeyUser {
    pub id: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PubKeyCredParam {
    #[serde(rename = "type")]
    pub ty: String,
    pub alg: i32,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AuthenticatorSelection {
    pub user_verification: String,
    pub resident_key: String,
    pub require_resident_key: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PrfEval {
    pub first: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PrfInput {
    pub eval: PrfEval,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct Extensions {
    pub prf: PrfInput,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RegisterOptions {
    pub rp: RpInfo,
    pub user: PubKeyUser,
    pub challenge: String,
    pub pub_key_cred_params: Vec<PubKeyCredParam>,
    pub authenticator_selection: AuthenticatorSelection,
    pub timeout: u32,
    pub attestation: String,
    pub extensions: Extensions,
    pub challenge_id: String,
    pub prf_salt_b64: String,
    pub invite_handle: Option<String>,
    pub invite_addresses: Vec<String>,
    pub invite_is_admin: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AttestationResp {
    pub credential_id_b64: String,
    pub client_data_json_b64: String,
    pub attestation_object_b64: String,
    pub transports: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RegisterVerifyReq {
    pub invite_token: String,
    pub challenge_id: String,
    pub handle: Option<String>,
    pub display_name: Option<String>,
    pub cred_label: Option<String>,
    pub attestation: AttestationResp,
    /// X25519 public key bytes (32B), base64url.
    pub pub_key_b64: String,
    /// Two wraps required: one passkey, one recovery. Pass-through to the DO.
    #[schema(value_type = Vec<Object>)]
    pub wraps: Vec<serde_json::Value>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RegisterVerifyResp {
    pub user_id: String,
    pub is_admin: bool,
    pub addresses: Vec<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct LoginOptions {
    pub rp_id: String,
    pub challenge: String,
    pub challenge_id: String,
    pub timeout: u32,
    pub user_verification: String,
    pub extensions: Extensions,
    pub prf_salt_b64: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct LoginVerifyReq {
    pub challenge_id: String,
    pub credential_id_b64: String,
    pub client_data_json_b64: String,
    pub authenticator_data_b64: String,
    pub signature_b64: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct LoginVerifyResp {
    pub user: UserView,
    pub wrap: KeyWrapView,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RecoveryBeginReq {
    pub handle: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RecoveryBeginResp {
    pub user_id: String,
    pub wrap: KeyWrapView,
    /// Random token sealed to the user's X25519 pubkey.
    pub sealed_proof_b64: String,
    pub challenge_id: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RecoveryVerifyReq {
    pub challenge_id: String,
    pub proof_b64: String,
}

// ---- Users / me -----------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UserView {
    pub id: String,
    pub handle: String,
    pub display_name: Option<String>,
    pub is_admin: bool,
    pub addresses: Vec<String>,
    pub pub_key_b64: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PatchMeReq {
    pub display_name: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct CredentialView {
    pub id_b64: String,
    pub cose_pubkey_b64: String,
    pub sign_count: u32,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct KeyWrapView {
    pub id: String,
    /// One of `"passkey"` or `"recovery"`.
    pub kind: String,
    pub credential_id_b64: Option<String>,
    pub wrapped_blob_b64: String,
    pub wrap_salt_b64: Option<String>,
    /// JSON-encoded KDF params for recovery wraps; null for passkey wraps.
    pub kdf_params: Option<String>,
    pub label: Option<String>,
    pub created_at: i64,
}

// ---- Passkeys (add ceremony) ---------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ExcludeCred {
    #[serde(rename = "type")]
    pub ty: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AddPasskeyOptions {
    pub rp: RpInfo,
    pub user: PubKeyUser,
    pub challenge: String,
    pub pub_key_cred_params: Vec<PubKeyCredParam>,
    pub authenticator_selection: AuthenticatorSelection,
    pub timeout: u32,
    pub attestation: String,
    pub extensions: Extensions,
    pub challenge_id: String,
    pub prf_salt_b64: String,
    pub exclude_credentials: Vec<ExcludeCred>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AddPasskeyVerifyReq {
    pub challenge_id: String,
    pub cred_label: Option<String>,
    pub attestation: AttestationResp,
    pub wrapped_blob_b64: String,
    pub wrap_salt_b64: String,
}

// ---- Mail -----------------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SendAttachmentRef {
    /// R2 key produced by the unified upload pipeline (`kind=attach`).
    pub r2_key: String,
    /// Plain filename for the outbound MIME Content-Disposition. Never
    /// stored server-side in cleartext — see `filename_ct_b64`.
    pub filename: String,
    /// Sealed-to-self filename stored on the sender's MailboxDO row.
    pub filename_ct_b64: Option<String>,
    pub mime: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SendReq {
    pub from: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub text: String,
    pub html: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    /// Inline-MIME attachments. The hosted-link path is now driven
    /// entirely client-side (see /api/hosted/create) — large files
    /// become links spliced into `text`/`html` BEFORE this call.
    #[serde(default)]
    pub attachments: Vec<SendAttachmentRef>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SendResp {
    pub message_id: String,
    pub thread_id: String,
}

/// Thread summary returned by `GET /api/threads`. The actual shape is owned
/// by the mailbox DO; this is a best-effort mirror so the spec has
/// *something* to point at. Update as the DO surface stabilizes.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ThreadSummary {
    pub id: String,
    pub last_message_at: i64,
    pub message_count: i64,
    /// Encrypted subject ciphertext (base64url).
    pub subject_ct_b64: Option<String>,
    /// Encrypted snippet ciphertext (base64url).
    pub snippet_ct_b64: Option<String>,
    pub participants: Vec<String>,
    pub label_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct MessageView {
    pub id: String,
    pub thread_id: String,
    pub message_id: String,
    pub direction: String,
    pub from_addr: String,
    pub from_name: Option<String>,
    pub to_addrs: Vec<String>,
    pub cc_addrs: Vec<String>,
    pub sent_at: i64,
    pub subject_ct_b64: Option<String>,
    pub body_ct_b64: Option<String>,
    /// Optional sealed HTML body. Inbound messages with a text/html
    /// MIME part populate this; outbound messages composed with rich
    /// formatting do too. When present the viewer prefers it (rendered
    /// in a sandboxed iframe) and falls back to body_ct otherwise.
    #[serde(default)]
    pub body_html_ct_b64: Option<String>,
    pub snippet_ct_b64: Option<String>,
    pub size_bytes: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PatchMessageReq {
    pub starred: Option<bool>,
    pub read: Option<bool>,
    pub archived: Option<bool>,
    pub thread_id: Option<String>,
}

// ---- Labels / drafts (opaque pass-through to the mailbox DO) -------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct LabelView {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct CreateLabelReq {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UpdateLabelReq {
    pub name: Option<String>,
    pub color: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ToggleMessageLabelReq {
    pub message_id: String,
    pub label_id: String,
    pub set: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct DraftUpsertReq {
    pub id: Option<String>,
    pub to_addrs: Option<Vec<String>>,
    pub cc_addrs: Option<Vec<String>>,
    pub bcc_addrs: Option<Vec<String>>,
    pub subject_ct_b64: Option<String>,
    pub body_ct_b64: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct DraftView {
    pub id: String,
    pub updated_at: i64,
    pub subject_ct_b64: Option<String>,
    pub body_ct_b64: Option<String>,
    pub to_addrs: Vec<String>,
    pub cc_addrs: Vec<String>,
    pub bcc_addrs: Vec<String>,
}

// ---- Attachments ---------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AttachmentView {
    pub id: String,
    pub message_id: Option<String>,
    pub draft_id: Option<String>,
    pub r2_key: String,
    pub filename_ct_b64: Option<String>,
    pub mime: String,
    pub size_bytes: i64,
    pub created_at: i64,
}

// ---- Unified upload pipeline --------------------------------------------
//
// One pipeline for all file uploads — regular email attachments,
// secret-link ciphertext, hosted-download ciphertext. The `kind`
// parameter picks the R2 prefix and post-complete bookkeeping.

#[derive(Serialize, Deserialize, ToSchema, Copy, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UploadKind {
    /// `attach/{user_id}/{uuid}` — inline-MIME email attachment.
    /// Registers a row in MailboxDO at /complete.
    Attach,
    /// `hosted/{user_id}/{uuid}` — E2E ciphertext referenced by a
    /// later /api/hosted/create call.
    Hosted,
    /// `secret/{user_id}/{uuid}` — E2E ciphertext referenced by a
    /// later /api/secret/create call.
    Secret,
}

impl UploadKind {
    /// The leading path segment for the R2 key. The worker uses this
    /// when minting a key at /init and when verifying ownership of a
    /// supplied r2_key at /parts and /complete.
    pub fn r2_prefix(&self) -> &'static str {
        match self {
            UploadKind::Attach => "attach",
            UploadKind::Hosted => "hosted",
            UploadKind::Secret => "secret",
        }
    }

    /// Inverse of `r2_prefix` — used at /complete time when the request
    /// only carries `r2_key` and we need to infer which kind of
    /// post-complete bookkeeping to run.
    pub fn from_key(r2_key: &str) -> Option<Self> {
        match r2_key.split('/').next()? {
            "attach" => Some(Self::Attach),
            "hosted" => Some(Self::Hosted),
            "secret" => Some(Self::Secret),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadInitReq {
    pub kind: UploadKind,
    /// Optional MIME hint stored as R2 http_metadata. Encrypted-kind
    /// uploads almost always use `application/octet-stream` here
    /// because the bytes are ciphertext.
    pub mime: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadInitResp {
    pub r2_key: String,
    pub upload_id: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadPartResp {
    pub part_number: u16,
    pub etag: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadedPartRef {
    pub part_number: u16,
    pub etag: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadCompleteReq {
    pub r2_key: String,
    pub upload_id: String,
    pub parts: Vec<UploadedPartRef>,
    /// Sum of part lengths (ciphertext bytes uploaded).
    pub size: i64,
    /// `attach` only — sealed filename to store on MailboxDO.
    pub filename_ct_b64: Option<String>,
    /// `attach` only — real mime for outbound MIME assembly.
    pub mime: Option<String>,
    /// `attach` only — bind the new attachment row to a draft so
    /// draft-cleanup paths can find it.
    pub draft_id: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadCompleteResp {
    pub r2_key: String,
    pub size: i64,
    /// `attach` kind only — id of the row registered in MailboxDO.
    pub attachment_id: Option<String>,
    pub mime: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UploadAbortReq {
    pub r2_key: String,
    pub upload_id: String,
}

// ---- Secret links --------------------------------------------------------
//
// Password-protected E2E links. Server stores ciphertext + a one-way
// derivative of the password (`password_check`) it can compare against
// on unlock attempts. Argon2id derives the wrap key from the password
// (with `kdf_params` letting future clients re-derive).

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretAttachmentRef {
    pub r2_key: String,
    pub mime: String,
    /// Total ciphertext bytes on R2.
    pub size: i64,
    /// Single chunk of XChaCha20-Poly1305 framed ciphertext of the
    /// filename, under the secret-link CEK.
    pub filename_ct_b64: String,
    /// Total plaintext bytes.
    #[serde(default)]
    pub plaintext_size: i64,
    /// Uniform plaintext bytes per chunk (last may be smaller). 0
    /// means "treat as non-chunked single blob" — pre-chunked legacy.
    #[serde(default)]
    pub chunk_size: i64,
    #[serde(default)]
    pub chunk_count: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretCreateReq {
    /// Email recipient (compose flow). Absent for /share standalone links.
    pub recipient: Option<String>,
    pub hint: Option<String>,
    /// One of `"one_time" | "1h" | "24h" | "14d" | "never"`.
    pub policy: String,
    pub argon_salt_b64: String,
    pub kdf_params: String,
    pub password_check_b64: String,
    pub password_wrap_b64: String,
    pub subject_ct_b64: String,
    pub body_ct_b64: String,
    #[serde(default)]
    pub attachments: Vec<SecretAttachmentRef>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretCreateResp {
    pub token: String,
    pub url: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretSenderRow {
    pub token: String,
    pub recipient_addr: Option<String>,
    pub sender_addr: String,
    pub hint: Option<String>,
    pub policy: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub first_opened_at: Option<i64>,
    pub opens_count: i64,
    pub fail_count: i64,
    pub revoked: bool,
    pub self_destructed: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretRevokeResp {
    pub deleted_blobs: u32,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretLinkPublicView {
    pub token: String,
    pub sender_addr: String,
    pub sender_name: Option<String>,
    pub recipient_addr: Option<String>,
    pub hint: Option<String>,
    pub argon_salt_b64: String,
    pub kdf_params: String,
    pub policy: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub first_opened_at: Option<i64>,
    pub opens_count: i64,
    pub revoked: bool,
    pub expired: bool,
    pub self_destructed: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretLinkOpenReq {
    pub password_check_b64: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretLinkOpenResp {
    pub password_wrap_b64: String,
    pub subject_ct_b64: String,
    pub body_ct_b64: String,
    #[schema(value_type = Vec<Object>)]
    pub attachments: Vec<serde_json::Value>,
    pub sender_addr: String,
    pub sender_name: Option<String>,
    pub recipient_addr: Option<String>,
    pub first_opened_at: Option<i64>,
    pub opens_count: i64,
    pub expires_at: i64,
    pub policy: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SecretAttachmentReq {
    pub password_check_b64: String,
    pub r2_key: String,
    /// Optional byte range. When both fields are provided the worker
    /// issues an R2 ranged GET; otherwise serves the whole object.
    pub offset: Option<u64>,
    pub length: Option<u64>,
}

// ---- Hosted downloads ---------------------------------------------------
//
// End-to-end encrypted with a CEK that travels only in the URL fragment
// (`#k=<base64url>`). Server is blind to contents; filenames + mimes
// stored cleartext for UX (sender dashboard + recipient preview).

#[derive(Serialize, Deserialize, ToSchema)]
pub struct HostedFile {
    pub r2_key: String,
    pub size: i64,
    pub plaintext_size: i64,
    pub chunk_size: i64,
    pub chunk_count: i64,
    pub filename: String,
    pub mime: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct HostedCreateReq {
    /// Display-only recipients (for the anti-phishing landing).
    #[serde(default)]
    pub recipient_addrs: Vec<String>,
    pub subject: Option<String>,
    pub files: Vec<HostedFile>,
    /// TTL override; server clamps to [1, 30] days.
    pub ttl_days: Option<i64>,
    /// CEK sealed to sender's own X25519 pubkey. Lets the sender
    /// re-decrypt from the /hosted dashboard later. Public viewer
    /// endpoints never expose this.
    pub sender_cek_wrap_b64: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct HostedCreateResp {
    pub token: String,
    /// URL prefix WITHOUT the `#k=<key>` fragment — caller appends
    /// the fragment client-side so the CEK never reaches the server.
    pub url_prefix: String,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct HostedSenderRow {
    pub token: String,
    pub recipient_addrs: Vec<String>,
    pub sender_addr: String,
    pub subject: Option<String>,
    pub files: Vec<HostedFile>,
    pub total_bytes: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub download_count: i64,
    pub revoked: bool,
    /// Sender-only — base64url of `seal_to(sender_pub, cek)`. Only
    /// returned on /api/hosted/mine, never on the public view.
    pub sender_cek_wrap_b64: Option<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct HostedPublicView {
    pub token: String,
    pub sender_addr: String,
    pub sender_name: Option<String>,
    pub recipient_addrs: Vec<String>,
    pub subject: Option<String>,
    pub files: Vec<HostedFile>,
    pub total_bytes: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub download_count: i64,
    pub revoked: bool,
    pub expired: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct HostedRevokeResp {
    pub deleted_blobs: u32,
}

// ---- Threads (delete cascade) -------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct DeleteThreadResp {
    pub deleted_blobs: u64,
}

// ---- Admin backup / restore ---------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct BackupCreateResp {
    pub key: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct BackupListItem {
    pub key: String,
    pub size_bytes: u64,
    pub uploaded_at: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct BackupListResp {
    pub backups: Vec<BackupListItem>,
    pub schedule_cron: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RestoreReq {
    pub key: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RestoreResp {
    pub ok: bool,
    pub restored_mailboxes: u32,
}

// ---- Admin ---------------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct CreateInviteReq {
    pub handle: Option<String>,
    pub addresses: Vec<String>,
    #[serde(default)]
    pub is_admin: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct CreateInviteResp {
    pub token: String,
    pub enroll_url: String,
    pub handle: Option<String>,
    pub addresses: Vec<String>,
    pub is_admin: bool,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct InviteView {
    pub token: String,
    pub handle: Option<String>,
    pub addresses: Vec<String>,
    pub is_admin: bool,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub redeemed_at: Option<i64>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AddAddressReq {
    pub user_id: String,
    pub address: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AdminStatusResp {
    pub needs_bootstrap: bool,
    pub is_authed: bool,
    pub primary_domain: String,
    pub additional_domains: Vec<String>,
    pub app_host: String,
    pub app_name: String,
    pub user_count: u64,
}

// ---- Contacts -----------------------------------------------------------

/// One row in the authenticated user's derived contact list.
///
/// Derived (not stored): we scan the user's MailboxDO messages on each
/// `/api/contacts` call and dedupe by canonical email address. There is
/// no separate contacts table — the source of truth is the message log.
/// The client caches the result in IndexedDB with a short TTL and
/// invalidates on send.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ContactView {
    /// Canonical email address (plus-suffix stripped, lowercased).
    pub addr: String,
    /// Most recent display name we've seen for this address, if any.
    /// Comes from `from_name` on inbound messages; outbound recipients
    /// have no name source (we only get raw addresses there) so it's
    /// `None` until they reply.
    pub name: Option<String>,
    /// `sent_at` of the most recent message touching this contact.
    pub last_seen_at: i64,
    /// Total number of messages (inbound + outbound) involving this
    /// contact. Used by the typeahead to break ties when scoring
    /// suggestions.
    pub message_count: i64,
}

// ---- Public config -------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PublicConfig {
    pub primary_domain: String,
    pub additional_domains: Vec<String>,
    pub app_host: String,
    pub app_name: String,
}
