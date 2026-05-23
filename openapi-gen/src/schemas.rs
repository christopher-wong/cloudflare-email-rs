//! Request/response shapes for the cfemail HTTP API.
//!
//! These mirror the inline structs in `worker/src/api/*.rs`. They are
//! re-defined here because the worker crate is wasm-only (uses `worker::*`
//! and `getrandom/js`) and won't compile on the host target where this
//! generator runs. Keep them in sync with the handlers when you change a
//! payload shape.

#![allow(dead_code)]

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
    /// Optional R2 keys for attachments (already uploaded via /api/attachments).
    #[serde(default)]
    pub attachment_r2_keys: Vec<String>,
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
pub struct AttachmentUploadResp {
    pub id: String,
    pub r2_key: String,
    pub size_bytes: i64,
    pub mime: String,
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

// ---- Public config -------------------------------------------------------

#[derive(Serialize, Deserialize, ToSchema)]
pub struct PublicConfig {
    pub primary_domain: String,
    pub additional_domains: Vec<String>,
    pub app_host: String,
    pub app_name: String,
}
