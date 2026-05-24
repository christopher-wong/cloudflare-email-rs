//! Singleton Registry Durable Object: user directory, credentials, address
//! ownership, sessions, invites, and short-lived WebAuthn challenges.
//!
//! All workers route to the same instance via the stable name `"registry"`.

use serde::{Deserialize, Serialize};
use worker::*;

const CHALLENGE_TTL_SECS: i64 = 300;
const INVITE_TTL_DAYS: i64 = 7;

#[durable_object]
pub struct RegistryDO {
    state: State,
    #[allow(dead_code)]
    env: Env,
}

impl DurableObject for RegistryDO {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        self.ensure_schema()?;
        let url = req.url()?;
        let path = url.path().to_string();
        match (req.method(), path.as_str()) {
            (Method::Post, "/bootstrap") => self.bootstrap(req).await,
            (Method::Post, "/invites") => self.create_invite(req).await,
            (Method::Get, "/invites") => self.list_invites().await,
            (Method::Delete, "/invites") => self.delete_invite(req).await,
            (Method::Post, "/invites/redeem") => self.redeem_invite(req).await,
            (Method::Post, "/challenge") => self.create_challenge(req).await,
            (Method::Post, "/challenge/consume") => self.consume_challenge(req).await,
            (Method::Post, "/users/register") => self.complete_registration(req).await,
            (Method::Get, "/users/by-credential") => self.user_by_credential(req).await,
            (Method::Get, "/users/by-address") => self.user_by_address(req).await,
            (Method::Get, "/users") => self.list_users().await,
            (Method::Get, "/me") => self.get_me(req).await,
            (Method::Patch, "/me/profile") => self.update_profile(req).await,
            (Method::Post, "/credentials/update-sign-count") => {
                self.update_sign_count(req).await
            }
            (Method::Post, "/sessions") => self.create_session(req).await,
            (Method::Delete, "/sessions") => self.delete_session(req).await,
            (Method::Get, "/sessions/lookup") => self.lookup_session(req).await,
            (Method::Post, "/addresses") => self.add_address(req).await,
            (Method::Delete, "/addresses") => self.remove_address(req).await,
            (Method::Get, "/addresses") => self.list_addresses(req).await,
            (Method::Post, "/key-wraps") => self.add_key_wrap(req).await,
            (Method::Get, "/key-wraps/by-credential") => self.wrap_by_credential(req).await,
            (Method::Get, "/key-wraps/recovery") => self.recovery_wrap(req).await,
            (Method::Delete, "/key-wraps/by-credential") => self.delete_wrap_by_credential(req).await,
            (Method::Post, "/users/add-passkey") => self.add_passkey(req).await,
            (Method::Get, "/credentials/by-user") => self.credentials_by_user(req).await,
            (Method::Delete, "/credentials") => self.delete_credential(req).await,
            (Method::Get, "/export") => self.export(req).await,
            (Method::Post, "/import") => self.import(req).await,
            (Method::Post, "/secret-links") => self.create_secret_link(req).await,
            (Method::Get, "/secret-links/by-token") => self.secret_link_by_token(req).await,
            (Method::Get, "/secret-links/by-user") => self.secret_links_by_user(req).await,
            (Method::Post, "/secret-links/open") => self.open_secret_link(req).await,
            (Method::Post, "/secret-links/verify") => self.verify_secret_link(req).await,
            (Method::Post, "/secret-links/revoke") => self.revoke_secret_link(req).await,
            (Method::Post, "/secret-links/purge") => self.purge_secret_links(req).await,
            (Method::Get, "/secret-links/referenced-keys") => self.secret_links_referenced_keys().await,
            (Method::Post, "/hosted-downloads") => self.create_hosted_download(req).await,
            (Method::Get, "/hosted-downloads/by-token") => self.hosted_download_by_token(req).await,
            (Method::Get, "/hosted-downloads/by-user") => self.hosted_downloads_by_user(req).await,
            (Method::Post, "/hosted-downloads/bump") => self.bump_hosted_download(req).await,
            (Method::Post, "/hosted-downloads/revoke") => self.revoke_hosted_download(req).await,
            (Method::Post, "/hosted-downloads/purge") => self.purge_hosted_downloads(req).await,
            (Method::Get, "/hosted-downloads/referenced-keys") => self.hosted_downloads_referenced_keys().await,
            _ => Response::error("not found", 404),
        }
    }
}

impl RegistryDO {
    fn sql(&self) -> SqlStorage {
        self.state.storage().sql()
    }

    fn ensure_schema(&self) -> Result<()> {
        let sql = self.sql();
        for stmt in SCHEMA {
            sql.exec(stmt, None)?;
        }
        // Best-effort migrations. ALTER TABLE ADD COLUMN errors with
        // "duplicate column" on subsequent runs — swallow it so the
        // migration is idempotent. Any *first*-run failure (real
        // problem) will surface on the next SELECT against the new
        // column.
        for stmt in MIGRATIONS {
            let _ = sql.exec(stmt, None);
        }
        Ok(())
    }

    // --- helpers for typed row reads ---

    async fn bootstrap(&self, mut req: Request) -> Result<Response> {
        let body: BootstrapReq = req.json().await?;
        let sql = self.sql();

        #[derive(Deserialize)]
        struct CountRow { n: i64 }
        let count: Vec<CountRow> = sql
            .exec("SELECT COUNT(*) AS n FROM users", None)?
            .to_array()?;
        if count.first().map(|c| c.n).unwrap_or(0) > 0 {
            return Response::error("already bootstrapped", 409);
        }

        let token = crate::ids::invite();
        let now = now_ms();
        let expires = now + INVITE_TTL_DAYS * 86_400_000;
        sql.exec(
            "INSERT INTO invites (token, handle, addresses, is_admin, created_by, created_at, expires_at)
             VALUES (?, ?, ?, 1, NULL, ?, ?)",
            Some(vec![
                token.clone().into(),
                body.handle.into(),
                serde_json::to_string(&body.addresses).unwrap_or_default().into(),
                now.into(),
                expires.into(),
            ]),
        )?;
        Response::from_json(&BootstrapResp { invite_token: token })
    }

    async fn create_invite(&self, mut req: Request) -> Result<Response> {
        let body: CreateInviteReq = req.json().await?;
        let token = crate::ids::invite();
        let now = now_ms();
        let expires = now + INVITE_TTL_DAYS * 86_400_000;
        let addrs_json = serde_json::to_string(&body.addresses).unwrap_or_default();
        self.sql().exec(
            "INSERT INTO invites (token, handle, addresses, is_admin, created_by, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                token.clone().into(),
                body.handle.clone().into(),
                addrs_json.into(),
                (body.is_admin as i64).into(),
                body.created_by.clone().into(),
                now.into(),
                expires.into(),
            ]),
        )?;
        Response::from_json(&InviteResp {
            token,
            handle: body.handle,
            addresses: body.addresses,
            is_admin: body.is_admin,
            expires_at: expires,
        })
    }

    async fn delete_invite(&self, req: Request) -> Result<Response> {
        // Accept the token from the query string. Only deletes *unredeemed*
        // invites — once an invite has been redeemed it's part of an audit
        // trail (the `redeemed_user_id` link), so revoke-then-leave is the
        // honest model. If the row doesn't exist or is already redeemed, we
        // 404 so the caller knows the call had no effect.
        let url = req.url()?;
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("token required".into()))?;

        #[derive(Deserialize)]
        struct Row { redeemed_user_id: Option<String> }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT redeemed_user_id FROM invites WHERE token = ?",
                Some(vec![token.clone().into()]),
            )?
            .to_array()?;
        let row = match rows.into_iter().next() {
            Some(r) => r,
            None => return Response::error("invite not found", 404),
        };
        if row.redeemed_user_id.is_some() {
            return Response::error("invite already redeemed", 409);
        }
        self.sql().exec(
            "DELETE FROM invites WHERE token = ?",
            Some(vec![token.into()]),
        )?;
        Response::ok("{}")
    }

    async fn list_invites(&self) -> Result<Response> {
        #[derive(Deserialize)]
        struct Row {
            token: String,
            handle: Option<String>,
            addresses: String,
            is_admin: i64,
            expires_at: i64,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT token, handle, addresses, is_admin, expires_at FROM invites
                 WHERE redeemed_user_id IS NULL ORDER BY created_at DESC",
                None,
            )?
            .to_array()?;
        let out: Vec<InviteResp> = rows
            .into_iter()
            .map(|r| InviteResp {
                token: r.token,
                handle: r.handle,
                addresses: serde_json::from_str(&r.addresses).unwrap_or_default(),
                is_admin: r.is_admin != 0,
                expires_at: r.expires_at,
            })
            .collect();
        Response::from_json(&out)
    }

    async fn redeem_invite(&self, mut req: Request) -> Result<Response> {
        let body: RedeemInviteReq = req.json().await?;
        #[derive(Deserialize)]
        struct Row {
            handle: Option<String>,
            addresses: String,
            is_admin: i64,
            expires_at: i64,
            redeemed_user_id: Option<String>,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT handle, addresses, is_admin, expires_at, redeemed_user_id
                 FROM invites WHERE token = ?",
                Some(vec![body.token.into()]),
            )?
            .to_array()?;
        let row = match rows.into_iter().next() {
            Some(r) => r,
            None => return Response::error("invite not found", 404),
        };
        if row.redeemed_user_id.is_some() {
            return Response::error("invite already redeemed", 409);
        }
        if row.expires_at < now_ms() {
            return Response::error("invite expired", 410);
        }
        Response::from_json(&RedeemInviteResp {
            invite_handle: row.handle,
            addresses: serde_json::from_str(&row.addresses).unwrap_or_default(),
            is_admin: row.is_admin != 0,
        })
    }

    async fn create_challenge(&self, mut req: Request) -> Result<Response> {
        let body: CreateChallengeReq = req.json().await?;
        let id = crate::ids::challenge();
        let value = crate::crypto::random_bytes(32);
        let now = now_ms();
        let expires = now + CHALLENGE_TTL_SECS * 1000;
        self.sql().exec(
            "INSERT INTO challenges (id, value, purpose, user_id, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            Some(vec![
                id.clone().into(),
                value.clone().into(),
                body.purpose.into(),
                body.user_id.into(),
                now.into(),
                expires.into(),
            ]),
        )?;
        Response::from_json(&ChallengeResp {
            id,
            challenge_b64: crate::b64::url_encode(&value),
        })
    }

    async fn consume_challenge(&self, mut req: Request) -> Result<Response> {
        let body: ConsumeChallengeReq = req.json().await?;
        #[derive(Deserialize)]
        struct Row {
            #[serde(with = "serde_bytes")]
            value: Vec<u8>,
            purpose: String,
            user_id: Option<String>,
            expires_at: i64,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT value, purpose, user_id, expires_at FROM challenges WHERE id = ?",
                Some(vec![body.id.clone().into()]),
            )?
            .to_array()?;
        let row = match rows.into_iter().next() {
            Some(r) => r,
            None => return Response::error("challenge not found", 404),
        };
        self.sql().exec(
            "DELETE FROM challenges WHERE id = ?",
            Some(vec![body.id.into()]),
        )?;
        if row.expires_at < now_ms() {
            return Response::error("challenge expired", 410);
        }
        if row.purpose != body.purpose {
            return Response::error("challenge purpose mismatch", 400);
        }
        Response::from_json(&ConsumeChallengeResp {
            challenge_b64: crate::b64::url_encode(&row.value),
            user_id: row.user_id,
        })
    }

    async fn complete_registration(&self, mut req: Request) -> Result<Response> {
        let body: CompleteRegistrationReq = req.json().await?;
        let sql = self.sql();

        #[derive(Deserialize)]
        struct InviteRow {
            handle: Option<String>,
            addresses: String,
            is_admin: i64,
            expires_at: i64,
            redeemed_user_id: Option<String>,
        }
        let inv: Vec<InviteRow> = sql
            .exec(
                "SELECT handle, addresses, is_admin, expires_at, redeemed_user_id
                 FROM invites WHERE token = ?",
                Some(vec![body.invite_token.clone().into()]),
            )?
            .to_array()?;
        let inv = match inv.into_iter().next() {
            Some(r) => r,
            None => return Response::error("invite not found", 404),
        };
        if inv.redeemed_user_id.is_some() {
            return Response::error("invite already redeemed", 409);
        }
        if inv.expires_at < now_ms() {
            return Response::error("invite expired", 410);
        }
        let addresses: Vec<String> = serde_json::from_str(&inv.addresses).unwrap_or_default();
        let handle = body
            .handle
            .clone()
            .or(inv.handle)
            .unwrap_or_else(|| addresses.first().cloned().unwrap_or_else(crate::ids::random_token));

        #[derive(Deserialize)]
        #[allow(dead_code)] struct One { x: i64 }
        let exists: Vec<One> = sql
            .exec(
                "SELECT 1 AS x FROM users WHERE handle = ?",
                Some(vec![handle.clone().into()]),
            )?
            .to_array()?;
        if !exists.is_empty() {
            return Response::error("handle taken", 409);
        }

        // Validate wraps: exactly one passkey wrap + exactly one recovery
        // wrap, both present. Recovery is non-negotiable.
        let has_passkey = body.wraps.iter().filter(|w| w.kind == "passkey").count();
        let has_recovery = body.wraps.iter().filter(|w| w.kind == "recovery").count();
        if has_passkey != 1 || has_recovery != 1 {
            return Response::error(
                "registration requires exactly one passkey wrap and one recovery wrap",
                400,
            );
        }

        let user_id = crate::ids::user();
        let now = now_ms();
        let pub_key = crate::b64::url_decode(&body.pub_key_b64)
            .map_err(|_| Error::RustError("pub_key b64".into()))?;
        let credential_id = crate::b64::url_decode(&body.credential_id_b64)
            .map_err(|_| Error::RustError("credId b64".into()))?;
        let cose_pubkey = crate::b64::url_decode(&body.cose_pubkey_b64)
            .map_err(|_| Error::RustError("cose b64".into()))?;
        let aaguid: Option<Vec<u8>> = body
            .aaguid_b64
            .as_deref()
            .and_then(|s| crate::b64::url_decode(s).ok());

        sql.exec(
            "INSERT INTO users (id, handle, display_name, is_admin, pub_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            Some(vec![
                user_id.clone().into(),
                handle.clone().into(),
                body.display_name.clone().into(),
                inv.is_admin.into(),
                pub_key.into(),
                now.into(),
            ]),
        )?;

        sql.exec(
            "INSERT INTO credentials (id, user_id, cose_pubkey, sign_count, aaguid, transports, created_at, label)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                credential_id.clone().into(),
                user_id.clone().into(),
                cose_pubkey.into(),
                (body.sign_count as i64).into(),
                aaguid.into(),
                body.transports.into(),
                now.into(),
                body.cred_label.into(),
            ]),
        )?;

        for w in &body.wraps {
            let blob = crate::b64::url_decode(&w.wrapped_blob_b64)
                .map_err(|_| Error::RustError("wrap blob b64".into()))?;
            let salt = match w.wrap_salt_b64.as_deref() {
                Some(s) => Some(
                    crate::b64::url_decode(s)
                        .map_err(|_| Error::RustError("wrap salt b64".into()))?,
                ),
                None => None,
            };
            let cred_for_wrap: Option<Vec<u8>> = if w.kind == "passkey" {
                Some(credential_id.clone())
            } else {
                None
            };
            sql.exec(
                "INSERT INTO key_wraps (id, user_id, kind, credential_id, wrapped_blob, wrap_salt, kdf_params, label, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                Some(vec![
                    crate::ids::wrap().into(),
                    user_id.clone().into(),
                    w.kind.clone().into(),
                    cred_for_wrap.into(),
                    blob.into(),
                    salt.into(),
                    w.kdf_params.clone().into(),
                    w.label.clone().into(),
                    now.into(),
                ]),
            )?;
        }

        for addr in &addresses {
            let canon = crate::config::canonical_address(addr);
            sql.exec(
                "INSERT OR IGNORE INTO addresses (address, user_id, created_at) VALUES (?, ?, ?)",
                Some(vec![canon.into(), user_id.clone().into(), now.into()]),
            )?;
        }

        sql.exec(
            "UPDATE invites SET redeemed_user_id = ? WHERE token = ?",
            Some(vec![user_id.clone().into(), body.invite_token.into()]),
        )?;

        Response::from_json(&CompleteRegistrationResp {
            user_id,
            is_admin: inv.is_admin != 0,
            addresses,
        })
    }

    async fn user_by_credential(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let cred_b64 = url
            .query_pairs()
            .find(|(k, _)| k == "credential_id_b64")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("credential_id_b64 required".into()))?;
        let cred = crate::b64::url_decode(&cred_b64)
            .map_err(|_| Error::RustError("credential_id_b64 decode".into()))?;
        #[derive(Deserialize)]
        struct Row {
            user_id: String,
            #[serde(with = "serde_bytes")]
            cose_pubkey: Vec<u8>,
            sign_count: i64,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT user_id, cose_pubkey, sign_count FROM credentials WHERE id = ?",
                Some(vec![cred.into()]),
            )?
            .to_array()?;
        match rows.into_iter().next() {
            None => Response::error("not found", 404),
            Some(r) => {
                let user = self.load_user(&r.user_id)?;
                Response::from_json(&serde_json::json!({
                    "user": user,
                    "credential": CredentialView {
                        id_b64: cred_b64,
                        cose_pubkey_b64: crate::b64::url_encode(&r.cose_pubkey),
                        sign_count: r.sign_count as u32,
                    }
                }))
            }
        }
    }

    async fn user_by_address(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let addr = url
            .query_pairs()
            .find(|(k, _)| k == "address")
            .map(|(_, v)| crate::config::canonical_address(v.as_ref()))
            .ok_or_else(|| Error::RustError("address required".into()))?;
        #[derive(Deserialize)]
        struct Row { user_id: String }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT user_id FROM addresses WHERE address = ?",
                Some(vec![addr.into()]),
            )?
            .to_array()?;
        match rows.into_iter().next() {
            None => Response::error("not found", 404),
            Some(r) => {
                let user = self.load_user(&r.user_id)?;
                Response::from_json(&user)
            }
        }
    }

    async fn list_users(&self) -> Result<Response> {
        #[derive(Deserialize)]
        struct IdRow { id: String }
        let ids: Vec<IdRow> = self
            .sql()
            .exec("SELECT id FROM users ORDER BY created_at ASC", None)?
            .to_array()?;
        let mut out = Vec::with_capacity(ids.len());
        for IdRow { id } in ids {
            out.push(self.load_user(&id)?);
        }
        Response::from_json(&out)
    }

    async fn get_me(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let uid = url
            .query_pairs()
            .find(|(k, _)| k == "user_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("user_id required".into()))?;
        Response::from_json(&self.load_user(&uid)?)
    }

    async fn update_profile(&self, mut req: Request) -> Result<Response> {
        let body: UpdateProfileReq = req.json().await?;
        self.sql().exec(
            "UPDATE users SET display_name = ? WHERE id = ?",
            Some(vec![body.display_name.into(), body.user_id.into()]),
        )?;
        Response::ok("{}")
    }

    async fn update_sign_count(&self, mut req: Request) -> Result<Response> {
        let body: UpdateSignCountReq = req.json().await?;
        let cred = crate::b64::url_decode(&body.credential_id_b64)
            .map_err(|_| Error::RustError("credId b64".into()))?;
        self.sql().exec(
            "UPDATE credentials SET sign_count = ? WHERE id = ?",
            Some(vec![(body.sign_count as i64).into(), cred.into()]),
        )?;
        Response::ok("{}")
    }

    async fn create_session(&self, mut req: Request) -> Result<Response> {
        let body: CreateSessionReq = req.json().await?;
        let now = now_ms();
        let expires = now + body.ttl_days * 86_400_000;
        self.sql().exec(
            "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            Some(vec![
                body.sid.into(),
                body.user_id.into(),
                now.into(),
                expires.into(),
            ]),
        )?;
        Response::ok("{}")
    }

    async fn delete_session(&self, mut req: Request) -> Result<Response> {
        let body: DeleteSessionReq = req.json().await?;
        self.sql()
            .exec("DELETE FROM sessions WHERE id = ?", Some(vec![body.sid.into()]))?;
        Response::ok("{}")
    }

    async fn lookup_session(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let sid = url
            .query_pairs()
            .find(|(k, _)| k == "sid")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("sid required".into()))?;
        #[derive(Deserialize)]
        struct Row { user_id: String, expires_at: i64 }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT user_id, expires_at FROM sessions WHERE id = ?",
                Some(vec![sid.clone().into()]),
            )?
            .to_array()?;
        let row = match rows.into_iter().next() {
            None => return Response::error("not found", 404),
            Some(r) => r,
        };
        if row.expires_at < now_ms() {
            self.sql()
                .exec("DELETE FROM sessions WHERE id = ?", Some(vec![sid.into()]))?;
            return Response::error("expired", 410);
        }
        #[derive(Deserialize)]
        struct UserRow {
            handle: String,
            display_name: Option<String>,
            is_admin: i64,
        }
        let urows: Vec<UserRow> = self
            .sql()
            .exec(
                "SELECT handle, display_name, is_admin FROM users WHERE id = ?",
                Some(vec![row.user_id.clone().into()]),
            )?
            .to_array()?;
        let u = urows
            .into_iter()
            .next()
            .ok_or_else(|| Error::RustError("user gone".into()))?;
        Response::from_json(&SessionLookupResp {
            user_id: row.user_id,
            is_admin: u.is_admin != 0,
            handle: u.handle,
            display_name: u.display_name,
        })
    }

    async fn add_address(&self, mut req: Request) -> Result<Response> {
        let body: AddAddressReq = req.json().await?;
        let addr = crate::config::canonical_address(&body.address);
        let now = now_ms();
        let res = self.sql().exec(
            "INSERT INTO addresses (address, user_id, created_at) VALUES (?, ?, ?)",
            Some(vec![addr.into(), body.user_id.into(), now.into()]),
        );
        match res {
            Ok(_) => Response::ok("{}"),
            Err(e) => Response::error(format!("{e}"), 409),
        }
    }

    async fn remove_address(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let addr = url
            .query_pairs()
            .find(|(k, _)| k == "address")
            .map(|(_, v)| crate::config::canonical_address(v.as_ref()))
            .ok_or_else(|| Error::RustError("address required".into()))?;
        self.sql()
            .exec("DELETE FROM addresses WHERE address = ?", Some(vec![addr.into()]))?;
        Response::ok("{}")
    }

    async fn list_addresses(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let uid = url
            .query_pairs()
            .find(|(k, _)| k == "user_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("user_id required".into()))?;
        #[derive(Deserialize)]
        struct Row { address: String }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT address FROM addresses WHERE user_id = ? ORDER BY created_at ASC",
                Some(vec![uid.into()]),
            )?
            .to_array()?;
        let out: Vec<String> = rows.into_iter().map(|r| r.address).collect();
        Response::from_json(&out)
    }

    fn load_user(&self, id: &str) -> Result<UserView> {
        let sql = self.sql();
        #[derive(Deserialize)]
        struct Row {
            handle: String,
            display_name: Option<String>,
            is_admin: i64,
            #[serde(with = "serde_bytes", default)]
            pub_key: Option<Vec<u8>>,
        }
        let rows: Vec<Row> = sql
            .exec(
                "SELECT handle, display_name, is_admin, pub_key FROM users WHERE id = ?",
                Some(vec![id.into()]),
            )?
            .to_array()?;
        let row = rows
            .into_iter()
            .next()
            .ok_or_else(|| Error::RustError("user not found".into()))?;
        #[derive(Deserialize)]
        struct AddrRow { address: String }
        let addrs: Vec<AddrRow> = sql
            .exec(
                "SELECT address FROM addresses WHERE user_id = ? ORDER BY created_at ASC",
                Some(vec![id.into()]),
            )?
            .to_array()?;
        Ok(UserView {
            id: id.to_string(),
            handle: row.handle,
            display_name: row.display_name,
            is_admin: row.is_admin != 0,
            addresses: addrs.into_iter().map(|a| a.address).collect(),
            pub_key_b64: row.pub_key.as_deref().map(crate::b64::url_encode),
        })
    }

    // ---- key_wraps ----

    async fn add_key_wrap(&self, mut req: Request) -> Result<Response> {
        let body: AddKeyWrapReq = req.json().await?;
        if body.kind != "passkey" && body.kind != "recovery" {
            return Response::error("kind must be passkey|recovery", 400);
        }
        if body.kind == "passkey" && body.credential_id_b64.is_none() {
            return Response::error("passkey wrap requires credential_id", 400);
        }
        let wrap_blob = crate::b64::url_decode(&body.wrapped_blob_b64)
            .map_err(|_| Error::RustError("wrapped_blob b64".into()))?;
        let wrap_salt = match body.wrap_salt_b64.as_deref() {
            Some(s) => Some(
                crate::b64::url_decode(s).map_err(|_| Error::RustError("wrap_salt b64".into()))?,
            ),
            None => None,
        };
        let credential_id = match body.credential_id_b64.as_deref() {
            Some(s) => Some(
                crate::b64::url_decode(s).map_err(|_| Error::RustError("credential_id b64".into()))?,
            ),
            None => None,
        };
        let id = crate::ids::wrap();
        let now = now_ms();
        let res = self.sql().exec(
            "INSERT INTO key_wraps (id, user_id, kind, credential_id, wrapped_blob, wrap_salt, kdf_params, label, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                id.clone().into(),
                body.user_id.into(),
                body.kind.into(),
                credential_id.into(),
                wrap_blob.into(),
                wrap_salt.into(),
                body.kdf_params.into(),
                body.label.into(),
                now.into(),
            ]),
        );
        match res {
            Ok(_) => Response::from_json(&serde_json::json!({ "id": id })),
            Err(e) => Response::error(format!("{e}"), 409),
        }
    }

    async fn wrap_by_credential(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let cred_b64 = url
            .query_pairs()
            .find(|(k, _)| k == "credential_id_b64")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("credential_id_b64 required".into()))?;
        let cred = crate::b64::url_decode(&cred_b64)
            .map_err(|_| Error::RustError("credential_id_b64 decode".into()))?;
        self.fetch_wrap_where(
            "credential_id = ? AND kind = 'passkey'",
            vec![cred.into()],
        )
    }

    async fn recovery_wrap(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let uid = url
            .query_pairs()
            .find(|(k, _)| k == "user_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("user_id required".into()))?;
        self.fetch_wrap_where("user_id = ? AND kind = 'recovery'", vec![uid.into()])
    }

    fn fetch_wrap_where(
        &self,
        where_clause: &str,
        params: Vec<SqlStorageValue>,
    ) -> Result<Response> {
        let sql_text = format!(
            "SELECT id, kind, credential_id, wrapped_blob, wrap_salt, kdf_params, label, created_at
             FROM key_wraps WHERE {where_clause} LIMIT 1"
        );
        #[derive(Deserialize)]
        struct Row {
            id: String,
            kind: String,
            #[serde(with = "serde_bytes", default)]
            credential_id: Option<Vec<u8>>,
            #[serde(with = "serde_bytes")]
            wrapped_blob: Vec<u8>,
            #[serde(with = "serde_bytes", default)]
            wrap_salt: Option<Vec<u8>>,
            kdf_params: Option<String>,
            label: Option<String>,
            created_at: i64,
        }
        let rows: Vec<Row> = self.sql().exec(&sql_text, Some(params))?.to_array()?;
        match rows.into_iter().next() {
            None => Response::error("not found", 404),
            Some(r) => Response::from_json(&KeyWrapView {
                id: r.id,
                kind: r.kind,
                credential_id_b64: r.credential_id.as_deref().map(crate::b64::url_encode),
                wrapped_blob_b64: crate::b64::url_encode(&r.wrapped_blob),
                wrap_salt_b64: r.wrap_salt.as_deref().map(crate::b64::url_encode),
                kdf_params: r.kdf_params,
                label: r.label,
                created_at: r.created_at,
            }),
        }
    }

    async fn delete_wrap_by_credential(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let cred_b64 = url
            .query_pairs()
            .find(|(k, _)| k == "credential_id_b64")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("credential_id_b64 required".into()))?;
        let cred = crate::b64::url_decode(&cred_b64)
            .map_err(|_| Error::RustError("credential_id_b64 decode".into()))?;
        self.sql().exec(
            "DELETE FROM key_wraps WHERE credential_id = ? AND kind = 'passkey'",
            Some(vec![cred.into()]),
        )?;
        Response::ok("{}")
    }

    async fn credentials_by_user(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let uid = url
            .query_pairs()
            .find(|(k, _)| k == "user_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("user_id required".into()))?;
        #[derive(Deserialize)]
        struct Row {
            #[serde(with = "serde_bytes")]
            id: Vec<u8>,
            label: Option<String>,
            created_at: i64,
            #[serde(with = "serde_bytes", default)]
            aaguid: Option<Vec<u8>>,
            transports: Option<String>,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT id, label, created_at, aaguid, transports
                 FROM credentials WHERE user_id = ? ORDER BY created_at ASC",
                Some(vec![uid.into()]),
            )?
            .to_array()?;
        let out: Vec<_> = rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "credential_id_b64": crate::b64::url_encode(&r.id),
                    "label": r.label,
                    "created_at": r.created_at,
                    "aaguid_b64": r.aaguid.as_deref().map(crate::b64::url_encode),
                    "transports": r.transports,
                })
            })
            .collect();
        Response::from_json(&out)
    }

    async fn delete_credential(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let cred_b64 = url
            .query_pairs()
            .find(|(k, _)| k == "credential_id_b64")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("credential_id_b64 required".into()))?;
        let cred = crate::b64::url_decode(&cred_b64)
            .map_err(|_| Error::RustError("credential_id_b64 decode".into()))?;
        // Refuse to delete the last passkey — recovery phrase exists but the
        // UX of "your only passkey is gone" is bad. Caller should add
        // another first.
        #[derive(Deserialize)]
        #[allow(dead_code)] struct C { c: i64, user_id: Option<String> }
        let info: Vec<C> = self
            .sql()
            .exec(
                "SELECT (SELECT COUNT(*) FROM credentials c2 WHERE c2.user_id = c1.user_id) AS c,
                        c1.user_id FROM credentials c1 WHERE c1.id = ?",
                Some(vec![cred.clone().into()]),
            )?
            .to_array()?;
        let i = info.into_iter().next().ok_or_else(|| Error::RustError("not found".into()))?;
        if i.c <= 1 {
            return Response::error("can't delete the last passkey — add another first", 409);
        }
        let sql = self.sql();
        sql.exec(
            "DELETE FROM key_wraps WHERE credential_id = ? AND kind = 'passkey'",
            Some(vec![cred.clone().into()]),
        )?;
        sql.exec(
            "DELETE FROM credentials WHERE id = ?",
            Some(vec![cred.into()]),
        )?;
        Response::ok("{}")
    }

    async fn add_passkey(&self, mut req: Request) -> Result<Response> {
        // Used when an already-authenticated user adds another passkey. The
        // client supplies the new credential and a wrap of its existing
        // X25519 private key under the new passkey's PRF-derived key.
        let body: AddPasskeyReq = req.json().await?;
        let credential_id = crate::b64::url_decode(&body.credential_id_b64)
            .map_err(|_| Error::RustError("credId b64".into()))?;
        let cose_pubkey = crate::b64::url_decode(&body.cose_pubkey_b64)
            .map_err(|_| Error::RustError("cose b64".into()))?;
        let wrapped = crate::b64::url_decode(&body.wrapped_blob_b64)
            .map_err(|_| Error::RustError("wrapped b64".into()))?;
        let wrap_salt = crate::b64::url_decode(&body.wrap_salt_b64)
            .map_err(|_| Error::RustError("wrap_salt b64".into()))?;
        let aaguid = body
            .aaguid_b64
            .as_deref()
            .and_then(|s| crate::b64::url_decode(s).ok());
        let now = now_ms();

        let sql = self.sql();
        sql.exec(
            "INSERT INTO credentials (id, user_id, cose_pubkey, sign_count, aaguid, transports, created_at, label)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                credential_id.clone().into(),
                body.user_id.clone().into(),
                cose_pubkey.into(),
                (body.sign_count as i64).into(),
                aaguid.into(),
                body.transports.into(),
                now.into(),
                body.cred_label.into(),
            ]),
        )?;
        sql.exec(
            "INSERT INTO key_wraps (id, user_id, kind, credential_id, wrapped_blob, wrap_salt, kdf_params, label, created_at)
             VALUES (?, ?, 'passkey', ?, ?, ?, NULL, ?, ?)",
            Some(vec![
                crate::ids::wrap().into(),
                body.user_id.into(),
                credential_id.into(),
                wrapped.into(),
                wrap_salt.into(),
                body.wrap_label.into(),
                now.into(),
            ]),
        )?;
        Response::ok("{}")
    }

    // ---- secret links -----------------------------------------------------

    async fn create_secret_link(&self, mut req: Request) -> Result<Response> {
        let body: CreateSecretLinkReq = req.json().await?;
        let token = crate::ids::secret_link();
        let now = now_ms();
        // Hard upper bound on every link (even "never"): 1y after creation.
        // Keeps abandoned data from accumulating indefinitely.
        let expires_at = now + 365 * 86_400_000;

        let password_check = crate::b64::url_decode(&body.password_check_b64)
            .map_err(|_| Error::RustError("password_check b64".into()))?;
        let password_wrap = crate::b64::url_decode(&body.password_wrap_b64)
            .map_err(|_| Error::RustError("password_wrap b64".into()))?;
        let argon_salt = crate::b64::url_decode(&body.argon_salt_b64)
            .map_err(|_| Error::RustError("argon_salt b64".into()))?;
        let subject_ct = crate::b64::url_decode(&body.subject_ct_b64)
            .map_err(|_| Error::RustError("subject_ct b64".into()))?;
        let body_ct = crate::b64::url_decode(&body.body_ct_b64)
            .map_err(|_| Error::RustError("body_ct b64".into()))?;
        let attachments_json = serde_json::to_string(&body.attachments)
            .unwrap_or_else(|_| "[]".to_string());

        self.sql().exec(
            "INSERT INTO secret_links (
                token, sender_user_id, sender_addr, sender_name, recipient_addr,
                password_check, password_wrap, argon_salt, kdf_params,
                subject_ct, body_ct, hint, attachments, policy,
                created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                token.clone().into(),
                body.sender_user_id.into(),
                body.sender_addr.into(),
                body.sender_name.into(),
                body.recipient_addr.into(),
                password_check.into(),
                password_wrap.into(),
                argon_salt.into(),
                body.kdf_params.into(),
                subject_ct.into(),
                body_ct.into(),
                body.hint.into(),
                attachments_json.into(),
                body.policy.into(),
                now.into(),
                expires_at.into(),
            ]),
        )?;
        Response::from_json(&serde_json::json!({
            "token": token,
            "expires_at": expires_at,
        }))
    }

    /// Public metadata for a viewer — does NOT include the wrap or
    /// ciphertext. Anyone with the token can hit this; we leak only the
    /// sender display name, recipient address (so the viewer page can show
    /// who it was sent to), the hint, and salt/kdf-params so the client
    /// can pre-derive the Argon2id key for the password prompt.
    async fn secret_link_by_token(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("token required".into()))?;
        let row = self.load_secret_link(&token)?;
        let now = now_ms();
        let expired = row.expires_at < now;
        Response::from_json(&serde_json::json!({
            "token": row.token,
            "sender_addr": row.sender_addr,
            "sender_name": row.sender_name,
            "recipient_addr": row.recipient_addr,
            "hint": row.hint,
            "argon_salt_b64": crate::b64::url_encode(&row.argon_salt),
            "kdf_params": row.kdf_params,
            "policy": row.policy,
            "created_at": row.created_at,
            "expires_at": row.expires_at,
            "first_opened_at": row.first_opened_at,
            "opens_count": row.opens_count,
            "revoked": row.revoked != 0,
            "expired": expired,
            "self_destructed": row.self_destructed != 0,
        }))
    }

    /// Two-step password verification. Client derives Argon2id locally,
    /// HKDFs out a `check` value, and sends it here. We compare against the
    /// stored check (constant-time). On match: return the wrap + ciphertext,
    /// bump opens_count, set first_opened_at, and apply the policy (shorten
    /// expires_at or revoke for one-time use).
    async fn open_secret_link(&self, mut req: Request) -> Result<Response> {
        let body: OpenSecretLinkReq = req.json().await?;
        let row = self.load_secret_link(&body.token)?;
        let now = now_ms();
        if row.self_destructed != 0 {
            return self.self_destruct_response(&row);
        }
        if row.revoked != 0 {
            return Response::error("revoked", 410);
        }
        if row.expires_at < now {
            return Response::error("expired", 410);
        }
        let given_check = crate::b64::url_decode(&body.password_check_b64)
            .map_err(|_| Error::RustError("password_check b64".into()))?;
        if !crate::crypto::ct_eq(&given_check, &row.password_check) {
            return self.handle_bad_password(&row, &body.token);
        }

        // Success — figure out the new policy-driven expires_at *before*
        // writing. Note: for `one_time`, policy_expiry returns
        // `now + ONE_TIME_GRACE_MS`, giving the viewer a short window to
        // pull attachment streams that follow this body fetch. The
        // grace window IS the consumption mechanism — once it passes,
        // verify/open both fail.
        let first_opened = row.first_opened_at.unwrap_or(now);
        let new_expires_at = if row.first_opened_at.is_some() {
            row.expires_at
        } else {
            policy_expiry(&row.policy, first_opened, row.expires_at)
        };

        self.sql().exec(
            "UPDATE secret_links SET
                opens_count = opens_count + 1,
                first_opened_at = COALESCE(first_opened_at, ?),
                expires_at = ?
             WHERE token = ?",
            Some(vec![
                now.into(),
                new_expires_at.into(),
                body.token.into(),
            ]),
        )?;

        Response::from_json(&serde_json::json!({
            "password_wrap_b64": crate::b64::url_encode(&row.password_wrap),
            "subject_ct_b64": crate::b64::url_encode(&row.subject_ct),
            "body_ct_b64": crate::b64::url_encode(&row.body_ct),
            "attachments": serde_json::from_str::<serde_json::Value>(&row.attachments).unwrap_or(serde_json::json!([])),
            "sender_addr": row.sender_addr,
            "sender_name": row.sender_name,
            "recipient_addr": row.recipient_addr,
            "first_opened_at": Some(first_opened),
            "opens_count": row.opens_count + 1,
            "expires_at": new_expires_at,
            "policy": row.policy,
        }))
    }

    /// Read-only password verification — used by the per-attachment
    /// streaming endpoint. Bumps `fail_count` (and self-destructs after
    /// 10) on a bad password the same way /open does, but does NOT
    /// advance `opens_count` or set `first_opened_at`. Refuses to
    /// verify a link that hasn't been opened yet: callers must hit
    /// /open first.
    async fn verify_secret_link(&self, mut req: Request) -> Result<Response> {
        let body: OpenSecretLinkReq = req.json().await?;
        let row = self.load_secret_link(&body.token)?;
        let now = now_ms();
        if row.self_destructed != 0 {
            return self.self_destruct_response(&row);
        }
        if row.revoked != 0 {
            return Response::error("revoked", 410);
        }
        if row.expires_at < now {
            return Response::error("expired", 410);
        }
        if row.first_opened_at.is_none() {
            return Response::error("not yet opened", 409);
        }
        let given_check = crate::b64::url_decode(&body.password_check_b64)
            .map_err(|_| Error::RustError("password_check b64".into()))?;
        if !crate::crypto::ct_eq(&given_check, &row.password_check) {
            return self.handle_bad_password(&row, &body.token);
        }
        Response::from_json(&serde_json::json!({
            "attachments": serde_json::from_str::<serde_json::Value>(&row.attachments)
                .unwrap_or(serde_json::json!([])),
        }))
    }

    /// Single shared implementation of "bad password" for /open and
    /// /verify. On the 10th failure the row gets self-destructed:
    /// ciphertext columns zeroed, attachments JSON cleared, and the
    /// matching R2 keys returned in the 401 body so the worker layer
    /// can delete them in lockstep. After self-destruct the response
    /// status is 410 (Gone) to disambiguate from a normal "wrong
    /// password" 401.
    fn handle_bad_password(&self, row: &SecretLinkRow, token: &str) -> Result<Response> {
        let new_fail = row.fail_count + 1;
        if new_fail >= 10 {
            // Self-destruct. Zero the ciphertext + attachments JSON so a
            // leaked DB row reveals nothing. We don't drop the row —
            // we want the sender to keep seeing it (with "self
            // destructed" status) in /api/secret/mine.
            let r2_keys = attachment_r2_keys(&row.attachments);
            self.sql().exec(
                "UPDATE secret_links SET
                    fail_count = ?,
                    self_destructed = 1,
                    subject_ct = X'',
                    body_ct = X'',
                    attachments = '[]'
                 WHERE token = ?",
                Some(vec![new_fail.into(), token.into()]),
            )?;
            let body = serde_json::json!({
                "error": "self_destructed",
                "self_destructed": true,
                "fail_count": new_fail,
                "r2_keys": r2_keys,
            });
            return Ok(Response::from_json(&body)?.with_status(410));
        }
        self.sql().exec(
            "UPDATE secret_links SET fail_count = ? WHERE token = ?",
            Some(vec![new_fail.into(), token.into()]),
        )?;
        let body = serde_json::json!({
            "error": "bad password",
            "fail_count": new_fail,
            "attempts_remaining": 10 - new_fail,
        });
        Ok(Response::from_json(&body)?.with_status(401))
    }

    /// Response shape for any post-destruct probe (open/verify/by-token).
    /// Always 410 Gone. Includes the (now empty) r2_keys list for symmetry
    /// with the destruct moment.
    fn self_destruct_response(&self, _row: &SecretLinkRow) -> Result<Response> {
        let body = serde_json::json!({
            "error": "self_destructed",
            "self_destructed": true,
        });
        Ok(Response::from_json(&body)?.with_status(410))
    }

    async fn revoke_secret_link(&self, mut req: Request) -> Result<Response> {
        let body: RevokeSecretLinkReq = req.json().await?;
        let row = self.load_secret_link(&body.token)?;
        if row.sender_user_id != body.sender_user_id {
            return Response::error("forbidden", 403);
        }
        self.sql().exec(
            "UPDATE secret_links SET revoked = 1 WHERE token = ?",
            Some(vec![body.token.into()]),
        )?;
        // Return r2_keys so the caller can delete the corresponding blobs.
        Response::from_json(&serde_json::json!({
            "r2_keys": attachment_r2_keys(&row.attachments),
        }))
    }

    async fn secret_links_by_user(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let uid = url
            .query_pairs()
            .find(|(k, _)| k == "user_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("user_id required".into()))?;
        #[derive(Deserialize)]
        struct Row {
            token: String,
            recipient_addr: Option<String>,
            sender_addr: String,
            hint: Option<String>,
            policy: String,
            created_at: i64,
            expires_at: i64,
            first_opened_at: Option<i64>,
            opens_count: i64,
            fail_count: i64,
            revoked: i64,
            #[serde(default)]
            self_destructed: i64,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT token, recipient_addr, sender_addr, hint, policy,
                        created_at, expires_at, first_opened_at,
                        opens_count, fail_count, revoked, self_destructed
                 FROM secret_links WHERE sender_user_id = ?
                 ORDER BY created_at DESC",
                Some(vec![uid.into()]),
            )?
            .to_array()?;
        let out: Vec<_> = rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "token": r.token,
                    "recipient_addr": r.recipient_addr,
                    "sender_addr": r.sender_addr,
                    "hint": r.hint,
                    "policy": r.policy,
                    "created_at": r.created_at,
                    "expires_at": r.expires_at,
                    "first_opened_at": r.first_opened_at,
                    "opens_count": r.opens_count,
                    "fail_count": r.fail_count,
                    "revoked": r.revoked != 0,
                    "self_destructed": r.self_destructed != 0,
                })
            })
            .collect();
        Response::from_json(&out)
    }

    /// Returns rows whose `expires_at < now` OR `revoked = 1` and have
    /// at least one attachment we need to clean from R2. The worker then
    /// deletes the R2 blobs and DELETEs the rows in a follow-up call.
    async fn purge_secret_links(&self, _req: Request) -> Result<Response> {
        let now = now_ms();
        #[derive(Deserialize)]
        struct Row { token: String, attachments: String }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT token, attachments FROM secret_links
                 WHERE expires_at < ? OR revoked = 1
                 LIMIT 500",
                Some(vec![now.into()]),
            )?
            .to_array()?;
        let mut tokens = Vec::with_capacity(rows.len());
        let mut keys: Vec<String> = Vec::new();
        for r in rows {
            tokens.push(r.token.clone());
            keys.extend(attachment_r2_keys(&r.attachments));
        }
        // Delete the rows now (we already collected the r2_keys).
        if !tokens.is_empty() {
            let placeholders = std::iter::repeat("?")
                .take(tokens.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql_text = format!(
                "DELETE FROM secret_links WHERE token IN ({placeholders})"
            );
            let params: Vec<SqlStorageValue> =
                tokens.iter().map(|t| t.clone().into()).collect();
            self.sql().exec(&sql_text, Some(params))?;
        }
        Response::from_json(&serde_json::json!({
            "purged_rows": tokens.len(),
            "r2_keys": keys,
        }))
    }

    /// Returns every R2 key referenced by any current secret_links
    /// row. The orphan sweep uses it to figure out which `secret/...`
    /// R2 objects are stranded (uploaded but never wired into a
    /// `secret_links` row — typically because the user aborted compose
    /// mid-flight).
    async fn secret_links_referenced_keys(&self) -> Result<Response> {
        #[derive(Deserialize)]
        struct Row { attachments: String }
        let rows: Vec<Row> = self
            .sql()
            .exec("SELECT attachments FROM secret_links", None)?
            .to_array()?;
        let mut keys = Vec::new();
        for r in rows {
            keys.extend(attachment_r2_keys(&r.attachments));
        }
        Response::from_json(&keys)
    }

    fn load_secret_link(&self, token: &str) -> Result<SecretLinkRow> {
        let rows: Vec<SecretLinkRow> = self
            .sql()
            .exec(
                "SELECT token, sender_user_id, sender_addr, sender_name, recipient_addr,
                        password_check, password_wrap, argon_salt, kdf_params,
                        subject_ct, body_ct, hint, attachments, policy,
                        created_at, expires_at, first_opened_at,
                        opens_count, fail_count, revoked, self_destructed
                 FROM secret_links WHERE token = ?",
                Some(vec![token.into()]),
            )?
            .to_array()?;
        rows.into_iter()
            .next()
            .ok_or_else(|| Error::RustError("secret link not found".into()))
    }

    // ---- hosted downloads -------------------------------------------------

    async fn create_hosted_download(&self, mut req: Request) -> Result<Response> {
        let body: CreateHostedReq = req.json().await?;
        let token = crate::ids::hosted_link();
        let now = now_ms();
        let expires_at = now + body.ttl_days.max(1) * 86_400_000;
        let recipients_json =
            serde_json::to_string(&body.recipient_addrs).unwrap_or_else(|_| "[]".into());
        let files_json = serde_json::to_string(&body.files).unwrap_or_else(|_| "[]".into());
        let sender_cek_wrap: Option<Vec<u8>> = match body.sender_cek_wrap_b64.as_deref() {
            Some(s) => Some(
                crate::b64::url_decode(s)
                    .map_err(|_| Error::RustError("sender_cek_wrap_b64".into()))?,
            ),
            None => None,
        };

        self.sql().exec(
            "INSERT INTO hosted_downloads (
                token, sender_user_id, sender_addr, sender_name,
                recipient_addrs, subject, files, total_bytes,
                created_at, expires_at, sender_cek_wrap
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                token.clone().into(),
                body.sender_user_id.into(),
                body.sender_addr.into(),
                body.sender_name.into(),
                recipients_json.into(),
                body.subject.into(),
                files_json.into(),
                body.total_bytes.into(),
                now.into(),
                expires_at.into(),
                sender_cek_wrap.into(),
            ]),
        )?;
        Response::from_json(&serde_json::json!({
            "token": token,
            "expires_at": expires_at,
        }))
    }

    async fn hosted_download_by_token(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("token required".into()))?;
        let row = self.load_hosted_download(&token)?;
        let now = now_ms();
        let expired = row.expires_at < now;
        Response::from_json(&serde_json::json!({
            "token": row.token,
            "sender_addr": row.sender_addr,
            "sender_name": row.sender_name,
            "recipient_addrs": serde_json::from_str::<serde_json::Value>(&row.recipient_addrs)
                .unwrap_or(serde_json::json!([])),
            "subject": row.subject,
            "files": serde_json::from_str::<serde_json::Value>(&row.files)
                .unwrap_or(serde_json::json!([])),
            "total_bytes": row.total_bytes,
            "created_at": row.created_at,
            "expires_at": row.expires_at,
            "download_count": row.download_count,
            "revoked": row.revoked != 0,
            "expired": expired,
        }))
    }

    async fn hosted_downloads_by_user(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let uid = url
            .query_pairs()
            .find(|(k, _)| k == "user_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("user_id required".into()))?;
        #[derive(Deserialize)]
        struct Row {
            token: String,
            recipient_addrs: String,
            subject: Option<String>,
            files: String,
            total_bytes: i64,
            created_at: i64,
            expires_at: i64,
            download_count: i64,
            revoked: i64,
            #[serde(with = "serde_bytes", default)]
            sender_cek_wrap: Option<Vec<u8>>,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT token, recipient_addrs, subject, files, total_bytes,
                        created_at, expires_at, download_count, revoked,
                        sender_cek_wrap
                 FROM hosted_downloads WHERE sender_user_id = ?
                 ORDER BY created_at DESC",
                Some(vec![uid.into()]),
            )?
            .to_array()?;
        let out: Vec<_> = rows
            .into_iter()
            .map(|r| {
                serde_json::json!({
                    "token": r.token,
                    "recipient_addrs": serde_json::from_str::<serde_json::Value>(&r.recipient_addrs)
                        .unwrap_or(serde_json::json!([])),
                    "subject": r.subject,
                    "files": serde_json::from_str::<serde_json::Value>(&r.files)
                        .unwrap_or(serde_json::json!([])),
                    "total_bytes": r.total_bytes,
                    "created_at": r.created_at,
                    "expires_at": r.expires_at,
                    "download_count": r.download_count,
                    "revoked": r.revoked != 0,
                    // Only returned on this auth'd by-user endpoint —
                    // /by-token (public viewer) doesn't expose it.
                    "sender_cek_wrap_b64": r.sender_cek_wrap.as_deref().map(crate::b64::url_encode),
                })
            })
            .collect();
        Response::from_json(&out)
    }

    async fn bump_hosted_download(&self, mut req: Request) -> Result<Response> {
        #[derive(Deserialize)]
        struct Req { token: String }
        let body: Req = req.json().await?;
        self.sql().exec(
            "UPDATE hosted_downloads SET download_count = download_count + 1
             WHERE token = ?",
            Some(vec![body.token.into()]),
        )?;
        Response::ok("{}")
    }

    async fn revoke_hosted_download(&self, mut req: Request) -> Result<Response> {
        #[derive(Deserialize)]
        struct Req { token: String, sender_user_id: String }
        let body: Req = req.json().await?;
        let row = self.load_hosted_download(&body.token)?;
        if row.sender_user_id != body.sender_user_id {
            return Response::error("forbidden", 403);
        }
        self.sql().exec(
            "UPDATE hosted_downloads SET revoked = 1 WHERE token = ?",
            Some(vec![body.token.into()]),
        )?;
        Response::from_json(&serde_json::json!({
            "r2_keys": hosted_file_r2_keys(&row.files),
        }))
    }

    /// Sweep expired/revoked rows. Returns r2_keys to delete + tokens
    /// that were dropped, in the same shape as `purge_secret_links`.
    async fn purge_hosted_downloads(&self, _req: Request) -> Result<Response> {
        let now = now_ms();
        #[derive(Deserialize)]
        struct Row { token: String, files: String }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT token, files FROM hosted_downloads
                 WHERE expires_at < ? OR revoked = 1
                 LIMIT 500",
                Some(vec![now.into()]),
            )?
            .to_array()?;
        let mut tokens = Vec::with_capacity(rows.len());
        let mut keys: Vec<String> = Vec::new();
        for r in rows {
            tokens.push(r.token.clone());
            keys.extend(hosted_file_r2_keys(&r.files));
        }
        if !tokens.is_empty() {
            let placeholders = std::iter::repeat("?")
                .take(tokens.len())
                .collect::<Vec<_>>()
                .join(", ");
            let sql_text = format!(
                "DELETE FROM hosted_downloads WHERE token IN ({placeholders})"
            );
            let params: Vec<SqlStorageValue> =
                tokens.iter().map(|t| t.clone().into()).collect();
            self.sql().exec(&sql_text, Some(params))?;
        }
        Response::from_json(&serde_json::json!({
            "purged_rows": tokens.len(),
            "r2_keys": keys,
        }))
    }

    /// Companion to `secret_links_referenced_keys` for hosted
    /// downloads. Same purpose, different prefix in R2.
    async fn hosted_downloads_referenced_keys(&self) -> Result<Response> {
        #[derive(Deserialize)]
        struct Row { files: String }
        let rows: Vec<Row> = self
            .sql()
            .exec("SELECT files FROM hosted_downloads", None)?
            .to_array()?;
        let mut keys = Vec::new();
        for r in rows {
            keys.extend(hosted_file_r2_keys(&r.files));
        }
        Response::from_json(&keys)
    }

    fn load_hosted_download(&self, token: &str) -> Result<HostedDownloadRow> {
        let rows: Vec<HostedDownloadRow> = self
            .sql()
            .exec(
                "SELECT token, sender_user_id, sender_addr, sender_name,
                        recipient_addrs, subject, files, total_bytes,
                        created_at, expires_at, download_count, revoked
                 FROM hosted_downloads WHERE token = ?",
                Some(vec![token.into()]),
            )?
            .to_array()?;
        rows.into_iter()
            .next()
            .ok_or_else(|| Error::RustError("hosted download not found".into()))
    }

    // ---- backup / restore -------------------------------------------------
    //
    // Export every row in every table as JSON. The worker side gzips and
    // writes the result to R2. We use serde_json::Value rather than the
    // typed Row structs above so a schema migration doesn't silently lose
    // a column on backup — the dump is a faithful copy of whatever's in
    // the SQLite tables today.

    async fn export(&self, _req: Request) -> Result<Response> {
        use crate::backup::{dump_blob_table, dump_table};
        let sql = self.sql();
        // Each step is a separate let-binding with a context-prefixed
        // error map so the next backup failure tells us which table
        // exploded instead of bubbling up an opaque serde message.
        macro_rules! step {
            ($name:literal, $e:expr) => {
                $e.map_err(|err| {
                    Error::RustError(format!("registry export[{}]: {err}", $name))
                })?
            };
        }
        let users        = step!("users",       dump_blob_table(&sql, "SELECT id, handle, display_name, is_admin, pub_key, created_at FROM users", &["pub_key"]));
        let credentials  = step!("credentials", dump_blob_table(&sql, "SELECT id, user_id, cose_pubkey, sign_count, aaguid, transports, created_at, label FROM credentials", &["id", "cose_pubkey", "aaguid"]));
        let addresses    = step!("addresses",   dump_table(&sql, "SELECT * FROM addresses"));
        let invites      = step!("invites",     dump_table(&sql, "SELECT * FROM invites"));
        let sessions     = step!("sessions",    dump_table(&sql, "SELECT * FROM sessions"));
        let key_wraps    = step!("key_wraps",   dump_blob_table(&sql, "SELECT id, user_id, kind, credential_id, wrapped_blob, wrap_salt, kdf_params, label, created_at FROM key_wraps", &["credential_id", "wrapped_blob", "wrap_salt"]));
        let challenges   = step!("challenges",  dump_blob_table(&sql, "SELECT id, value, purpose, user_id, created_at, expires_at FROM challenges", &["value"]));
        let secret_links = step!("secret_links", dump_blob_table(&sql,
            "SELECT token, sender_user_id, sender_addr, sender_name, recipient_addr,
                    password_check, password_wrap, argon_salt, kdf_params,
                    subject_ct, body_ct, hint, attachments, policy,
                    created_at, expires_at, first_opened_at,
                    opens_count, fail_count, revoked, self_destructed
             FROM secret_links",
            &["password_check", "password_wrap", "argon_salt", "subject_ct", "body_ct"]));
        let hosted_downloads = step!("hosted_downloads", dump_blob_table(&sql,
            "SELECT token, sender_user_id, sender_addr, sender_name,
                    recipient_addrs, subject, files, total_bytes,
                    created_at, expires_at, download_count, revoked,
                    sender_cek_wrap
             FROM hosted_downloads",
            &["sender_cek_wrap"]));
        let dump = serde_json::json!({
            "users":            users,
            "credentials":      credentials,
            "addresses":        addresses,
            "invites":          invites,
            "sessions":         sessions,
            "key_wraps":        key_wraps,
            "challenges":       challenges,
            "secret_links":     secret_links,
            "hosted_downloads": hosted_downloads,
        });
        Response::from_json(&dump)
    }

    /// Reinsert rows from an export bundle. Uses INSERT OR REPLACE so a
    /// partial restore is idempotent (re-running the same backup is a no-op).
    /// Tables are populated in dependency order; foreign-key-style references
    /// (e.g. message_labels → labels, etc.) live in the MailboxDO, so the
    /// Registry import has no cross-row ordering concerns within itself.
    async fn import(&self, mut req: Request) -> Result<Response> {
        use crate::backup::load_table;
        let body: serde_json::Value = req.json().await?;
        let sql = self.sql();
        load_table(&sql, &body, "users",
            &["id", "handle", "display_name", "is_admin", "pub_key", "created_at"],
            &["pub_key"])?;
        load_table(&sql, &body, "credentials",
            &["id", "user_id", "cose_pubkey", "sign_count", "aaguid", "transports", "created_at", "label"],
            &["id", "cose_pubkey", "aaguid"])?;
        load_table(&sql, &body, "addresses",
            &["address", "user_id", "created_at"], &[])?;
        load_table(&sql, &body, "invites",
            &["token", "handle", "addresses", "is_admin", "created_by", "created_at", "expires_at", "redeemed_user_id"], &[])?;
        load_table(&sql, &body, "sessions",
            &["id", "user_id", "created_at", "expires_at"], &[])?;
        load_table(&sql, &body, "key_wraps",
            &["id", "user_id", "kind", "credential_id", "wrapped_blob", "wrap_salt", "kdf_params", "label", "created_at"],
            &["credential_id", "wrapped_blob", "wrap_salt"])?;
        load_table(&sql, &body, "challenges",
            &["id", "value", "purpose", "user_id", "created_at", "expires_at"],
            &["value"])?;
        load_table(&sql, &body, "secret_links",
            &["token", "sender_user_id", "sender_addr", "sender_name", "recipient_addr",
              "password_check", "password_wrap", "argon_salt", "kdf_params",
              "subject_ct", "body_ct", "hint", "attachments", "policy",
              "created_at", "expires_at", "first_opened_at",
              "opens_count", "fail_count", "revoked", "self_destructed"],
            &["password_check", "password_wrap", "argon_salt", "subject_ct", "body_ct"])?;
        load_table(&sql, &body, "hosted_downloads",
            &["token", "sender_user_id", "sender_addr", "sender_name",
              "recipient_addrs", "subject", "files", "total_bytes",
              "created_at", "expires_at", "download_count", "revoked",
              "sender_cek_wrap"],
            &["sender_cek_wrap"])?;
        Response::ok("{}")
    }
}

// ---- request / response shapes ----

#[derive(Deserialize)]
struct BootstrapReq { handle: String, addresses: Vec<String> }
#[derive(Serialize)]
struct BootstrapResp { invite_token: String }

#[derive(Deserialize)]
struct CreateInviteReq {
    handle: Option<String>,
    addresses: Vec<String>,
    is_admin: bool,
    created_by: Option<String>,
}
#[derive(Serialize)]
struct InviteResp {
    token: String,
    handle: Option<String>,
    addresses: Vec<String>,
    is_admin: bool,
    expires_at: i64,
}

#[derive(Deserialize)]
struct RedeemInviteReq { token: String }
#[derive(Serialize)]
struct RedeemInviteResp {
    invite_handle: Option<String>,
    addresses: Vec<String>,
    is_admin: bool,
}

#[derive(Deserialize)]
struct CreateChallengeReq { purpose: String, user_id: Option<String> }
#[derive(Serialize)]
struct ChallengeResp { id: String, challenge_b64: String }

#[derive(Deserialize)]
struct ConsumeChallengeReq { id: String, purpose: String }
#[derive(Serialize)]
struct ConsumeChallengeResp { challenge_b64: String, user_id: Option<String> }

#[derive(Deserialize)]
struct CompleteRegistrationReq {
    invite_token: String,
    handle: Option<String>,
    display_name: Option<String>,
    credential_id_b64: String,
    cose_pubkey_b64: String,
    sign_count: u32,
    aaguid_b64: Option<String>,
    transports: Option<String>,
    cred_label: Option<String>,
    pub_key_b64: String,
    /// Initial wraps of the user's X25519 private key. Must include
    /// exactly one `kind: "passkey"` (matching `credential_id_b64`) and
    /// exactly one `kind: "recovery"`. Recovery is mandatory.
    wraps: Vec<KeyWrapInput>,
}

#[derive(Deserialize)]
struct KeyWrapInput {
    kind: String,
    /// Required when `kind == "passkey"`. We don't actually consume this
    /// during `complete_registration` because the passkey wrap is bound to
    /// the credential being registered in the same call — but we still
    /// accept the field so the wire format matches `add_key_wrap` (where it
    /// IS required), keeping the client-side payload shape consistent.
    #[allow(dead_code)]
    credential_id_b64: Option<String>,
    wrapped_blob_b64: String,
    wrap_salt_b64: Option<String>,
    /// JSON describing the KDF for recovery wraps.
    kdf_params: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
struct AddKeyWrapReq {
    user_id: String,
    kind: String,
    credential_id_b64: Option<String>,
    wrapped_blob_b64: String,
    wrap_salt_b64: Option<String>,
    kdf_params: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
struct AddPasskeyReq {
    user_id: String,
    credential_id_b64: String,
    cose_pubkey_b64: String,
    sign_count: u32,
    aaguid_b64: Option<String>,
    transports: Option<String>,
    cred_label: Option<String>,
    wrapped_blob_b64: String,
    wrap_salt_b64: String,
    wrap_label: Option<String>,
}
#[derive(Serialize)]
struct CompleteRegistrationResp {
    user_id: String,
    is_admin: bool,
    addresses: Vec<String>,
}

// UserView / CredentialView / KeyWrapView are the canonical wire
// shapes — defined in `api-types` so the OpenAPI generator and the
// worker share one definition. Re-exported here so existing
// `crate::registry::UserView` import paths keep compiling.
pub use api_types::{CredentialView, KeyWrapView, UserView};

#[derive(Deserialize)]
struct CreateSessionReq { sid: String, user_id: String, ttl_days: i64 }
#[derive(Deserialize)]
struct DeleteSessionReq { sid: String }
#[derive(Serialize)]
struct SessionLookupResp {
    user_id: String,
    is_admin: bool,
    handle: String,
    display_name: Option<String>,
}
#[derive(Deserialize)]
struct AddAddressReq { user_id: String, address: String }
#[derive(Deserialize)]
struct UpdateProfileReq { user_id: String, display_name: Option<String> }
#[derive(Deserialize)]
struct UpdateSignCountReq { credential_id_b64: String, sign_count: u32 }

#[derive(Deserialize)]
struct CreateSecretLinkReq {
    sender_user_id: String,
    sender_addr: String,
    sender_name: Option<String>,
    recipient_addr: Option<String>,
    password_check_b64: String,
    password_wrap_b64: String,
    argon_salt_b64: String,
    /// JSON of the Argon2id params used to derive the wrap key, so the
    /// viewer can reproduce the derivation without knowing app defaults.
    kdf_params: String,
    subject_ct_b64: String,
    body_ct_b64: String,
    hint: Option<String>,
    /// Each: { r2_key, mime, size, filename_ct_b64 }
    attachments: Vec<serde_json::Value>,
    /// 'one_time' | '1h' | '24h' | '14d' | 'never'
    policy: String,
}

#[derive(Deserialize)]
struct OpenSecretLinkReq {
    token: String,
    password_check_b64: String,
}

#[derive(Deserialize)]
struct RevokeSecretLinkReq {
    token: String,
    sender_user_id: String,
}

#[derive(Deserialize)]
struct SecretLinkRow {
    token: String,
    sender_user_id: String,
    sender_addr: String,
    sender_name: Option<String>,
    recipient_addr: Option<String>,
    #[serde(with = "serde_bytes")]
    password_check: Vec<u8>,
    #[serde(with = "serde_bytes")]
    password_wrap: Vec<u8>,
    #[serde(with = "serde_bytes")]
    argon_salt: Vec<u8>,
    kdf_params: String,
    #[serde(with = "serde_bytes")]
    subject_ct: Vec<u8>,
    #[serde(with = "serde_bytes")]
    body_ct: Vec<u8>,
    hint: Option<String>,
    attachments: String,
    policy: String,
    created_at: i64,
    expires_at: i64,
    first_opened_at: Option<i64>,
    opens_count: i64,
    fail_count: i64,
    revoked: i64,
    #[serde(default)]
    self_destructed: i64,
}

/// Grace window after a `one_time` link is first opened, during which the
/// viewer can still pull attachment streams. Without this, a one-time
/// link with attachments would be unusable: the body fetch consumes the
/// link, then per-attachment downloads would see a revoked row.
const ONE_TIME_GRACE_MS: i64 = 5 * 60 * 1000;

fn policy_expiry(policy: &str, opened_at: i64, current_expires: i64) -> i64 {
    // Cap the new expiry at the row's existing upper bound (created_at + 1y)
    // so a "14d after open" link still gets purged eventually.
    let candidate = match policy {
        "one_time" => opened_at + ONE_TIME_GRACE_MS,
        "1h"       => opened_at +  3_600_000,
        "24h"      => opened_at + 86_400_000,
        "14d"      => opened_at + 14 * 86_400_000,
        "never"    => current_expires,
        _          => current_expires,
    };
    candidate.min(current_expires)
}

/// Extract every R2 key referenced by the attachments JSON column. Used at
/// revoke / purge time to clean up the blob storage in lockstep with the row.
fn attachment_r2_keys(attachments_json: &str) -> Vec<String> {
    let v: serde_json::Value =
        serde_json::from_str(attachments_json).unwrap_or(serde_json::json!([]));
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("r2_key").and_then(|k| k.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Mirror of `attachment_r2_keys` for hosted_downloads' `files` column.
fn hosted_file_r2_keys(files_json: &str) -> Vec<String> {
    let v: serde_json::Value =
        serde_json::from_str(files_json).unwrap_or(serde_json::json!([]));
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|f| f.get("r2_key").and_then(|k| k.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Deserialize)]
struct CreateHostedReq {
    sender_user_id: String,
    sender_addr: String,
    sender_name: Option<String>,
    recipient_addrs: Vec<String>,
    subject: Option<String>,
    /// Each: { filename, mime, size, r2_key, ... }
    files: Vec<serde_json::Value>,
    total_bytes: i64,
    ttl_days: i64,
    /// Optional sender-only CEK wrap. The sender's client seals the
    /// link's CEK to its own X25519 pubkey and passes the result here;
    /// the row stores it so the sender can re-decrypt from the
    /// dashboard later. Public viewer endpoints never see it.
    #[serde(default)]
    sender_cek_wrap_b64: Option<String>,
}

#[derive(Deserialize)]
struct HostedDownloadRow {
    token: String,
    sender_user_id: String,
    sender_addr: String,
    sender_name: Option<String>,
    recipient_addrs: String,
    subject: Option<String>,
    files: String,
    total_bytes: i64,
    created_at: i64,
    expires_at: i64,
    download_count: i64,
    revoked: i64,
}

// ---- schema ----

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",

    // The user table no longer carries wrap material — that lives in
    // `key_wraps`, one row per wrap (passkey or recovery). `pub_key` stays
    // here because it's cleartext (the server needs it to encrypt-on-receive).
    "CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE,
        display_name TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        pub_key BLOB,
        created_at INTEGER NOT NULL
    )",

    // One row per wrap of the user's X25519 private key.
    //   kind = 'passkey'  → wrap derived from WebAuthn PRF output.
    //                       `credential_id` links to credentials.id, and
    //                       `wrap_salt` is the PRF salt used.
    //   kind = 'recovery' → wrap derived from Argon2id(passphrase, salt).
    //                       `kdf_params` is JSON describing the KDF.
    //
    // Recovery is mandatory (created at enrollment). Passkey wraps are
    // one-per-passkey; users may have additional passkeys past the first.
    "CREATE TABLE IF NOT EXISTS key_wraps (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('passkey', 'recovery')),
        credential_id BLOB,
        wrapped_blob BLOB NOT NULL,
        wrap_salt BLOB,
        kdf_params TEXT,
        label TEXT,
        created_at INTEGER NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS key_wraps_user ON key_wraps(user_id)",
    "CREATE INDEX IF NOT EXISTS key_wraps_cred ON key_wraps(credential_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS key_wraps_recovery_unique
        ON key_wraps(user_id) WHERE kind = 'recovery'",

    "CREATE TABLE IF NOT EXISTS credentials (
        id BLOB PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cose_pubkey BLOB NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        aaguid BLOB,
        transports TEXT,
        created_at INTEGER NOT NULL,
        label TEXT
    )",
    "CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id)",

    "CREATE TABLE IF NOT EXISTS addresses (
        address TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS addresses_user ON addresses(user_id)",

    "CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    )",

    "CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        handle TEXT,
        addresses TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_user_id TEXT
    )",

    "CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        purpose TEXT NOT NULL,
        user_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    )",

    // Password-protected secret links — the "outside-user" portal modeled
    // after ProtonMail's encrypted-for-outside-users flow.
    //
    // The recipient gets a URL ending in /s/<token> + an out-of-band password
    // (sender shared by SMS / Signal / etc). The viewer derives an Argon2id
    // key from the password, sends a check value, and on match the server
    // returns the wrapped CEK + ciphertext for client-side decrypt.
    //
    // Server never sees: password, CEK, plaintext. All it sees: the check
    // value (a one-way derivative of the password), the AES-GCM-wrapped CEK,
    // and XChaCha20-Poly1305 ciphertext keyed by the CEK.
    //
    // `expires_at` is set at creation to created_at + 1 year as an upper
    // bound; on first successful open it may be lowered per `policy`
    // ('one_time', '1h', '24h', '14d', 'never'). The scheduled purge job
    // sweeps rows past expires_at.
    "CREATE TABLE IF NOT EXISTS secret_links (
        token TEXT PRIMARY KEY,
        sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_addr TEXT NOT NULL,
        sender_name TEXT,
        -- Nullable: secret links created from the standalone /share UI
        -- have no email recipient — the sender just wants a URL they can
        -- hand to whoever (Signal, in person, paste into another app).
        recipient_addr TEXT,
        password_check BLOB NOT NULL,
        password_wrap BLOB NOT NULL,
        argon_salt BLOB NOT NULL,
        kdf_params TEXT NOT NULL,
        -- subject_ct and body_ct go to zero-length BLOB on self-destruct.
        -- attachments JSON likewise goes to an empty array + R2 blobs deleted.
        subject_ct BLOB NOT NULL,
        body_ct BLOB NOT NULL,
        hint TEXT,
        attachments TEXT NOT NULL,
        policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        first_opened_at INTEGER,
        opens_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        -- A self_destructed=1 row has had its ciphertext + attachment
        -- blobs purged after 10 failed unlock attempts. Distinct from
        -- `revoked` (manual sender action) and from `expires_at` past
        -- (timed-out one-time / lifetime cap) so the Secrets dashboard
        -- can show why a link died.
        self_destructed INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE INDEX IF NOT EXISTS secret_links_user ON secret_links(sender_user_id)",
    "CREATE INDEX IF NOT EXISTS secret_links_expires ON secret_links(expires_at)",

    // Hosted downloads — Firefox Send / Wormhole.app model. The
    // bytes on R2 are ciphertext; the decryption key lives in the
    // URL fragment of the share link (everything after `#`), which
    // browsers never transmit. The server can route requests by
    // `token` (the part before `#`) but cannot decrypt the contents.
    //
    // Distinct from secret_links because there's no user-chosen
    // password: the fragment key is a 256-bit random value generated
    // client-side. Anyone with the full URL can decrypt; anyone with
    // only the token (e.g. seen in worker logs) cannot.
    //
    // What the server stores per-row:
    //   - subject (cleartext) — used to render the email body that
    //     wraps the link. Optional, may be empty for /share-style
    //     standalone uses.
    //   - files JSON: each entry has r2_key + ciphertext metadata
    //     (chunk sizes, encrypted filename, encrypted mime). The
    //     plaintext filename and mime never reach the server.
    //
    // On revoke or expiry the worker deletes the matching R2 blobs.
    "CREATE TABLE IF NOT EXISTS hosted_downloads (
        token TEXT PRIMARY KEY,
        sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender_addr TEXT NOT NULL,
        sender_name TEXT,
        recipient_addrs TEXT NOT NULL,
        subject TEXT,
        files TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        download_count INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        -- CEK sealed to sender's X25519 pubkey. Lets the sender
        -- re-decrypt their own hosted downloads from the dashboard
        -- without having kept the URL fragment around. Never
        -- exposed on the public /api/d/:token endpoint — only
        -- returned to the authenticated sender via /api/hosted/mine.
        sender_cek_wrap BLOB
    )",
    "CREATE INDEX IF NOT EXISTS hosted_downloads_user ON hosted_downloads(sender_user_id)",
    "CREATE INDEX IF NOT EXISTS hosted_downloads_expires ON hosted_downloads(expires_at)",
];

const MIGRATIONS: &[&str] = &[
    // Added when we shipped self-destruct-after-10-failures. Existing
    // tables predate the column; the ALTER errors (and is ignored) on
    // already-migrated DOs.
    "ALTER TABLE secret_links ADD COLUMN self_destructed INTEGER NOT NULL DEFAULT 0",
    // Added when hosted downloads became E2E and the sender needed a
    // way to re-decrypt from the dashboard.
    "ALTER TABLE hosted_downloads ADD COLUMN sender_cek_wrap BLOB",
];

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}
