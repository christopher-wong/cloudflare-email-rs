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

#[derive(Serialize, Deserialize)]
pub struct UserView {
    pub id: String,
    pub handle: String,
    pub display_name: Option<String>,
    pub is_admin: bool,
    pub addresses: Vec<String>,
    pub pub_key_b64: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct CredentialView {
    pub id_b64: String,
    pub cose_pubkey_b64: String,
    pub sign_count: u32,
}

/// A single wrap of the user's X25519 private key.
#[derive(Serialize, Deserialize)]
pub struct KeyWrapView {
    pub id: String,
    pub kind: String, // 'passkey' | 'recovery'
    pub credential_id_b64: Option<String>,
    pub wrapped_blob_b64: String,
    pub wrap_salt_b64: Option<String>,
    /// JSON-encoded KDF params for recovery wraps; null for passkey wraps.
    pub kdf_params: Option<String>,
    pub label: Option<String>,
    pub created_at: i64,
}

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
];

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}
