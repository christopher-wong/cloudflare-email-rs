//! Per-user Mailbox Durable Object. Keyed by user_id so each user gets
//! isolated SQLite storage. Holds metadata, threads, labels, drafts, and
//! attachment metadata; ciphertext bytes for bodies/attachments live in R2.

use serde::{Deserialize, Serialize};
use worker::*;

#[durable_object]
pub struct MailboxDO {
    state: State,
    #[allow(dead_code)]
    env: Env,
}

impl DurableObject for MailboxDO {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        self.ensure_schema()?;
        let url = req.url()?;
        let path = url.path().to_string();
        match (req.method(), path.as_str()) {
            (Method::Post, "/messages") => self.insert_message(req).await,
            (Method::Get, "/threads") => self.list_threads(req).await,
            (Method::Get, "/threads/messages") => self.thread_messages(req).await,
            (Method::Get, "/messages") => self.list_messages(req).await,
            (Method::Get, "/messages/get") => self.get_message(req).await,
            (Method::Patch, "/messages") => self.patch_message(req).await,
            (Method::Delete, "/messages") => self.delete_message(req).await,
            (Method::Post, "/drafts") => self.upsert_draft(req).await,
            (Method::Get, "/drafts") => self.list_drafts().await,
            (Method::Delete, "/drafts") => self.delete_draft(req).await,
            (Method::Post, "/labels") => self.create_label(req).await,
            (Method::Get, "/labels") => self.list_labels().await,
            (Method::Patch, "/labels") => self.update_label(req).await,
            (Method::Delete, "/labels") => self.delete_label(req).await,
            (Method::Post, "/message-labels") => self.toggle_label(req).await,
            (Method::Post, "/attachments") => self.add_attachment(req).await,
            (Method::Get, "/attachments") => self.list_attachments(req).await,
            (Method::Delete, "/attachments") => self.delete_attachment(req).await,
            _ => Response::error("not found", 404),
        }
    }
}

impl MailboxDO {
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

    async fn insert_message(&self, mut req: Request) -> Result<Response> {
        let body: InsertMessageReq = req.json().await?;
        let now = now_ms();
        let thread_id = self.resolve_thread(&body)?;
        let subject_ct = crate::b64::url_decode(&body.subject_ct_b64)
            .map_err(|_| Error::RustError("subject_ct b64".into()))?;
        let body_ct = crate::b64::url_decode(&body.body_ct_b64)
            .map_err(|_| Error::RustError("body_ct b64".into()))?;
        let snippet_ct = match body.snippet_ct_b64.as_deref() {
            Some(s) => Some(
                crate::b64::url_decode(s)
                    .map_err(|_| Error::RustError("snippet b64".into()))?,
            ),
            None => None,
        };
        self.sql().exec(
            "INSERT INTO messages (id, thread_id, message_id, in_reply_to, refs,
                from_addr, from_name, to_addrs, cc_addrs, bcc_addrs,
                sent_at, received_at, direction, read, starred,
                snippet_ct, subject_ct, body_ct, raw_r2_key, size_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
            Some(vec![
                body.id.clone().into(),
                thread_id.clone().into(),
                body.message_id.clone().into(),
                body.in_reply_to.clone().into(),
                body.references.clone().into(),
                body.from_addr.clone().into(),
                body.from_name.clone().into(),
                serde_json::to_string(&body.to_addrs).unwrap_or_default().into(),
                serde_json::to_string(&body.cc_addrs).unwrap_or_default().into(),
                serde_json::to_string(&body.bcc_addrs).unwrap_or_default().into(),
                body.sent_at.into(),
                now.into(),
                body.direction.clone().into(),
                ((body.direction == "out") as i64).into(),
                snippet_ct.into(),
                subject_ct.into(),
                body_ct.into(),
                body.raw_r2_key.clone().into(),
                body.size_bytes.into(),
            ]),
        )?;
        self.touch_thread(&thread_id, body.sent_at, &body.direction, &body)?;
        Response::from_json(&InsertMessageResp { thread_id })
    }

    fn resolve_thread(&self, body: &InsertMessageReq) -> Result<String> {
        if let Some(tid) = &body.thread_id {
            return Ok(tid.clone());
        }
        let sql = self.sql();
        #[derive(Deserialize)]
        struct TidRow { thread_id: String }
        if let Some(irt) = &body.in_reply_to {
            let rows: Vec<TidRow> = sql
                .exec(
                    "SELECT thread_id FROM messages WHERE message_id = ?",
                    Some(vec![irt.clone().into()]),
                )?
                .to_array()?;
            if let Some(r) = rows.into_iter().next() {
                return Ok(r.thread_id);
            }
        }
        if let Some(refs) = &body.references {
            for r in refs.split_whitespace().rev() {
                let r = r.trim_matches(|c| c == '<' || c == '>').to_string();
                let rows: Vec<TidRow> = sql
                    .exec(
                        "SELECT thread_id FROM messages WHERE message_id = ?",
                        Some(vec![r.into()]),
                    )?
                    .to_array()?;
                if let Some(r) = rows.into_iter().next() {
                    return Ok(r.thread_id);
                }
            }
        }
        Ok(crate::ids::thread())
    }

    fn touch_thread(
        &self,
        tid: &str,
        sent_at: i64,
        direction: &str,
        body: &InsertMessageReq,
    ) -> Result<()> {
        let sql = self.sql();
        #[derive(Deserialize)]
        #[allow(dead_code)] struct One { x: i64 }
        let exists: Vec<One> = sql
            .exec(
                "SELECT 1 AS x FROM threads WHERE id = ?",
                Some(vec![tid.into()]),
            )?
            .to_array()?;
        let mut participants: Vec<String> = vec![body.from_addr.clone()];
        participants.extend(body.to_addrs.iter().cloned());
        participants.extend(body.cc_addrs.iter().cloned());
        participants.sort();
        participants.dedup();
        let participants_json = serde_json::to_string(&participants).unwrap_or_default();
        let unread_delta: i64 = if direction == "in" { 1 } else { 0 };
        if exists.is_empty() {
            sql.exec(
                "INSERT INTO threads (id, subject_hint, participants, last_message_at,
                  message_count, unread_count, has_starred, archived)
                 VALUES (?, NULL, ?, ?, 1, ?, 0, 0)",
                Some(vec![
                    tid.into(),
                    participants_json.into(),
                    sent_at.into(),
                    unread_delta.into(),
                ]),
            )?;
        } else {
            sql.exec(
                "UPDATE threads SET
                    last_message_at = MAX(last_message_at, ?),
                    message_count = message_count + 1,
                    unread_count = unread_count + ?,
                    participants = ?
                 WHERE id = ?",
                Some(vec![
                    sent_at.into(),
                    unread_delta.into(),
                    participants_json.into(),
                    tid.into(),
                ]),
            )?;
        }
        Ok(())
    }

    async fn list_threads(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let limit: i64 = url
            .query_pairs()
            .find(|(k, _)| k == "limit")
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(50);
        let before: Option<i64> = url
            .query_pairs()
            .find(|(k, _)| k == "before")
            .and_then(|(_, v)| v.parse().ok());
        let archived: bool = url
            .query_pairs()
            .find(|(k, _)| k == "archived")
            .map(|(_, v)| v == "1")
            .unwrap_or(false);
        // Inbox view: only threads with at least one inbound message. The Sent
        // view fetches messages directly, so this filter is inbox-specific.
        let inbound_only: bool = url
            .query_pairs()
            .find(|(k, _)| k == "inbound_only")
            .map(|(_, v)| v == "1")
            .unwrap_or(false);

        #[derive(Deserialize)]
        struct Row {
            id: String,
            subject_hint: Option<String>,
            participants: Option<String>,
            last_message_at: i64,
            message_count: i64,
            unread_count: i64,
            has_starred: i64,
            archived: i64,
        }
        let inbound_clause = if inbound_only {
            " AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.direction = 'in')"
        } else {
            ""
        };
        let rows: Vec<Row> = if let Some(b) = before {
            let sql_text = format!(
                "SELECT id, subject_hint, participants, last_message_at,
                    message_count, unread_count, has_starred, archived
                 FROM threads
                 WHERE archived = ? AND last_message_at < ?{inbound_clause}
                 ORDER BY last_message_at DESC LIMIT ?"
            );
            self.sql().exec(
                &sql_text,
                Some(vec![(archived as i64).into(), b.into(), limit.into()]),
            )?
        } else {
            let sql_text = format!(
                "SELECT id, subject_hint, participants, last_message_at,
                    message_count, unread_count, has_starred, archived
                 FROM threads
                 WHERE archived = ?{inbound_clause}
                 ORDER BY last_message_at DESC LIMIT ?"
            );
            self.sql().exec(
                &sql_text,
                Some(vec![(archived as i64).into(), limit.into()]),
            )?
        }
        .to_array()?;
        let out: Vec<ThreadRow> = rows
            .into_iter()
            .map(|r| ThreadRow {
                id: r.id,
                subject_hint: r.subject_hint,
                participants: serde_json::from_str(&r.participants.unwrap_or_default())
                    .unwrap_or_default(),
                last_message_at: r.last_message_at,
                message_count: r.message_count,
                unread_count: r.unread_count,
                has_starred: r.has_starred != 0,
                archived: r.archived != 0,
            })
            .collect();
        Response::from_json(&out)
    }

    async fn thread_messages(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let tid = url
            .query_pairs()
            .find(|(k, _)| k == "thread_id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("thread_id required".into()))?;
        self.fetch_messages_where("thread_id = ?", vec![tid.into()])
            .await
    }

    async fn list_messages(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let direction = url
            .query_pairs()
            .find(|(k, _)| k == "direction")
            .map(|(_, v)| v.to_string());
        if let Some(d) = direction {
            self.fetch_messages_where("direction = ?", vec![d.into()])
                .await
        } else {
            self.fetch_messages_where("1=1", vec![]).await
        }
    }

    async fn fetch_messages_where(
        &self,
        where_clause: &str,
        params: Vec<SqlStorageValue>,
    ) -> Result<Response> {
        let sql_text = format!(
            "SELECT id, thread_id, message_id, in_reply_to, from_addr, from_name,
                to_addrs, cc_addrs, bcc_addrs, sent_at, received_at, direction,
                read, starred, snippet_ct, subject_ct, body_ct, size_bytes
             FROM messages WHERE {where_clause} ORDER BY sent_at ASC"
        );
        #[derive(Deserialize)]
        struct Row {
            id: String,
            thread_id: String,
            message_id: Option<String>,
            in_reply_to: Option<String>,
            from_addr: String,
            from_name: Option<String>,
            to_addrs: Option<String>,
            cc_addrs: Option<String>,
            bcc_addrs: Option<String>,
            sent_at: i64,
            received_at: i64,
            direction: String,
            read: i64,
            starred: i64,
            #[serde(with = "serde_bytes", default)]
            snippet_ct: Option<Vec<u8>>,
            #[serde(with = "serde_bytes")]
            subject_ct: Vec<u8>,
            #[serde(with = "serde_bytes")]
            body_ct: Vec<u8>,
            size_bytes: i64,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(&sql_text, if params.is_empty() { None } else { Some(params) })?
            .to_array()?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let labels = self.labels_for(&r.id)?;
            out.push(MessageRow {
                id: r.id,
                thread_id: r.thread_id,
                message_id: r.message_id,
                in_reply_to: r.in_reply_to,
                from_addr: r.from_addr,
                from_name: r.from_name,
                to_addrs: serde_json::from_str(&r.to_addrs.unwrap_or_default())
                    .unwrap_or_default(),
                cc_addrs: serde_json::from_str(&r.cc_addrs.unwrap_or_default())
                    .unwrap_or_default(),
                bcc_addrs: serde_json::from_str(&r.bcc_addrs.unwrap_or_default())
                    .unwrap_or_default(),
                sent_at: r.sent_at,
                received_at: r.received_at,
                direction: r.direction,
                read: r.read != 0,
                starred: r.starred != 0,
                snippet_ct_b64: r.snippet_ct.as_deref().map(crate::b64::url_encode),
                subject_ct_b64: crate::b64::url_encode(&r.subject_ct),
                body_ct_b64: crate::b64::url_encode(&r.body_ct),
                size_bytes: r.size_bytes,
                labels,
            });
        }
        Response::from_json(&out)
    }

    fn labels_for(&self, msg_id: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct LRow { label_id: String }
        let rows: Vec<LRow> = self
            .sql()
            .exec(
                "SELECT label_id FROM message_labels WHERE message_id = ?",
                Some(vec![msg_id.into()]),
            )?
            .to_array()?;
        Ok(rows.into_iter().map(|r| r.label_id).collect())
    }

    async fn get_message(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let id = url
            .query_pairs()
            .find(|(k, _)| k == "id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("id required".into()))?;
        self.fetch_messages_where("id = ?", vec![id.into()]).await
    }

    async fn patch_message(&self, mut req: Request) -> Result<Response> {
        let body: PatchMessageReq = req.json().await?;
        let sql = self.sql();
        if let Some(read) = body.read {
            sql.exec(
                "UPDATE messages SET read = ? WHERE id = ?",
                Some(vec![(read as i64).into(), body.id.clone().into()]),
            )?;
            sql.exec(
                "UPDATE threads SET unread_count = (
                   SELECT COUNT(*) FROM messages WHERE thread_id = threads.id AND read = 0 AND direction = 'in'
                 ) WHERE id = (SELECT thread_id FROM messages WHERE id = ?)",
                Some(vec![body.id.clone().into()]),
            )?;
        }
        if let Some(starred) = body.starred {
            sql.exec(
                "UPDATE messages SET starred = ? WHERE id = ?",
                Some(vec![(starred as i64).into(), body.id.clone().into()]),
            )?;
            sql.exec(
                "UPDATE threads SET has_starred = (
                   SELECT COALESCE(MAX(starred), 0) FROM messages WHERE thread_id = threads.id
                 ) WHERE id = (SELECT thread_id FROM messages WHERE id = ?)",
                Some(vec![body.id.into()]),
            )?;
        }
        Response::ok("{}")
    }

    async fn delete_message(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let id = url
            .query_pairs()
            .find(|(k, _)| k == "id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("id required".into()))?;
        let sql = self.sql();
        #[derive(Deserialize)]
        struct TidRow { thread_id: String }
        let tids: Vec<TidRow> = sql
            .exec(
                "SELECT thread_id FROM messages WHERE id = ?",
                Some(vec![id.clone().into()]),
            )?
            .to_array()?;
        sql.exec(
            "DELETE FROM message_labels WHERE message_id = ?",
            Some(vec![id.clone().into()]),
        )?;
        sql.exec(
            "DELETE FROM messages WHERE id = ?",
            Some(vec![id.clone().into()]),
        )?;
        if let Some(tid) = tids.into_iter().next().map(|r| r.thread_id) {
            #[derive(Deserialize)]
            struct Agg {
                c: i64,
                last_message_at: Option<i64>,
                unread: i64,
                starred: i64,
            }
            let agg: Vec<Agg> = sql
                .exec(
                    "SELECT COUNT(*) AS c, MAX(sent_at) AS last_message_at,
                            COALESCE(SUM(CASE WHEN read = 0 AND direction = 'in' THEN 1 ELSE 0 END), 0) AS unread,
                            COALESCE(MAX(starred), 0) AS starred
                     FROM messages WHERE thread_id = ?",
                    Some(vec![tid.clone().into()]),
                )?
                .to_array()?;
            if let Some(a) = agg.into_iter().next() {
                if a.c == 0 {
                    sql.exec("DELETE FROM threads WHERE id = ?", Some(vec![tid.into()]))?;
                } else {
                    sql.exec(
                        "UPDATE threads SET message_count = ?, last_message_at = ?, unread_count = ?, has_starred = ? WHERE id = ?",
                        Some(vec![
                            a.c.into(),
                            a.last_message_at.unwrap_or(0).into(),
                            a.unread.into(),
                            a.starred.into(),
                            tid.into(),
                        ]),
                    )?;
                }
            }
        }
        Response::ok("{}")
    }

    async fn upsert_draft(&self, mut req: Request) -> Result<Response> {
        let body: UpsertDraftReq = req.json().await?;
        let id = body.id.clone().unwrap_or_else(|| crate::ids::draft());
        let now = now_ms();
        let subject_ct = match &body.subject_ct_b64 {
            Some(s) => Some(
                crate::b64::url_decode(s)
                    .map_err(|_| Error::RustError("subject b64".into()))?,
            ),
            None => None,
        };
        let body_ct = match &body.body_ct_b64 {
            Some(s) => Some(
                crate::b64::url_decode(s)
                    .map_err(|_| Error::RustError("body b64".into()))?,
            ),
            None => None,
        };
        self.sql().exec(
            "INSERT INTO drafts (id, in_reply_to_message_id, to_addrs, cc_addrs, bcc_addrs,
                subject_ct, body_ct, attachments, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                in_reply_to_message_id = excluded.in_reply_to_message_id,
                to_addrs = excluded.to_addrs,
                cc_addrs = excluded.cc_addrs,
                bcc_addrs = excluded.bcc_addrs,
                subject_ct = excluded.subject_ct,
                body_ct = excluded.body_ct,
                attachments = excluded.attachments,
                updated_at = excluded.updated_at",
            Some(vec![
                id.clone().into(),
                body.in_reply_to_message_id.into(),
                serde_json::to_string(&body.to_addrs).unwrap_or_default().into(),
                serde_json::to_string(&body.cc_addrs).unwrap_or_default().into(),
                serde_json::to_string(&body.bcc_addrs).unwrap_or_default().into(),
                subject_ct.into(),
                body_ct.into(),
                serde_json::to_string(&body.attachments).unwrap_or_default().into(),
                now.into(),
            ]),
        )?;
        Response::from_json(&serde_json::json!({ "id": id, "updated_at": now }))
    }

    async fn list_drafts(&self) -> Result<Response> {
        #[derive(Deserialize)]
        struct Row {
            id: String,
            in_reply_to_message_id: Option<String>,
            to_addrs: Option<String>,
            cc_addrs: Option<String>,
            bcc_addrs: Option<String>,
            #[serde(with = "serde_bytes", default)]
            subject_ct: Option<Vec<u8>>,
            #[serde(with = "serde_bytes", default)]
            body_ct: Option<Vec<u8>>,
            attachments: Option<String>,
            updated_at: i64,
        }
        let rows: Vec<Row> = self
            .sql()
            .exec(
                "SELECT id, in_reply_to_message_id, to_addrs, cc_addrs, bcc_addrs,
                    subject_ct, body_ct, attachments, updated_at
                 FROM drafts ORDER BY updated_at DESC",
                None,
            )?
            .to_array()?;
        let out: Vec<DraftRow> = rows
            .into_iter()
            .map(|r| DraftRow {
                id: r.id,
                in_reply_to_message_id: r.in_reply_to_message_id,
                to_addrs: serde_json::from_str(&r.to_addrs.unwrap_or_default()).unwrap_or_default(),
                cc_addrs: serde_json::from_str(&r.cc_addrs.unwrap_or_default()).unwrap_or_default(),
                bcc_addrs: serde_json::from_str(&r.bcc_addrs.unwrap_or_default())
                    .unwrap_or_default(),
                subject_ct_b64: r.subject_ct.as_deref().map(crate::b64::url_encode),
                body_ct_b64: r.body_ct.as_deref().map(crate::b64::url_encode),
                attachments: serde_json::from_str(&r.attachments.unwrap_or_default())
                    .unwrap_or_default(),
                updated_at: r.updated_at,
            })
            .collect();
        Response::from_json(&out)
    }

    async fn delete_draft(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let id = url
            .query_pairs()
            .find(|(k, _)| k == "id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("id required".into()))?;
        self.sql()
            .exec("DELETE FROM drafts WHERE id = ?", Some(vec![id.into()]))?;
        Response::ok("{}")
    }

    async fn create_label(&self, mut req: Request) -> Result<Response> {
        let body: CreateLabelReq = req.json().await?;
        let id = crate::ids::label();
        let now = now_ms();
        let res = self.sql().exec(
            "INSERT INTO labels (id, name, created_at) VALUES (?, ?, ?)",
            Some(vec![id.clone().into(), body.name.clone().into(), now.into()]),
        );
        match res {
            Ok(_) => Response::from_json(&LabelRow {
                id,
                name: body.name,
                created_at: now,
            }),
            Err(e) => Response::error(format!("{e}"), 409),
        }
    }

    async fn list_labels(&self) -> Result<Response> {
        let rows: Vec<LabelRow> = self
            .sql()
            .exec(
                "SELECT id, name, created_at FROM labels ORDER BY name ASC",
                None,
            )?
            .to_array()?;
        Response::from_json(&rows)
    }

    async fn update_label(&self, mut req: Request) -> Result<Response> {
        let body: UpdateLabelReq = req.json().await?;
        self.sql().exec(
            "UPDATE labels SET name = ? WHERE id = ?",
            Some(vec![body.name.into(), body.id.into()]),
        )?;
        Response::ok("{}")
    }

    async fn delete_label(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let id = url
            .query_pairs()
            .find(|(k, _)| k == "id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("id required".into()))?;
        let sql = self.sql();
        sql.exec(
            "DELETE FROM message_labels WHERE label_id = ?",
            Some(vec![id.clone().into()]),
        )?;
        sql.exec("DELETE FROM labels WHERE id = ?", Some(vec![id.into()]))?;
        Response::ok("{}")
    }

    async fn toggle_label(&self, mut req: Request) -> Result<Response> {
        let body: ToggleLabelReq = req.json().await?;
        let sql = self.sql();
        if body.on {
            sql.exec(
                "INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)",
                Some(vec![body.message_id.into(), body.label_id.into()]),
            )?;
        } else {
            sql.exec(
                "DELETE FROM message_labels WHERE message_id = ? AND label_id = ?",
                Some(vec![body.message_id.into(), body.label_id.into()]),
            )?;
        }
        Response::ok("{}")
    }

    async fn add_attachment(&self, mut req: Request) -> Result<Response> {
        let body: AddAttachmentReq = req.json().await?;
        let filename_ct = match &body.filename_ct_b64 {
            Some(s) => Some(
                crate::b64::url_decode(s)
                    .map_err(|_| Error::RustError("filename b64".into()))?,
            ),
            None => None,
        };
        let now = now_ms();
        self.sql().exec(
            "INSERT INTO attachments (id, message_id, draft_id, r2_key, filename_ct, mime, size_bytes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            Some(vec![
                body.id.clone().into(),
                body.message_id.clone().into(),
                body.draft_id.clone().into(),
                body.r2_key.clone().into(),
                filename_ct.into(),
                body.mime.clone().into(),
                body.size_bytes.into(),
                now.into(),
            ]),
        )?;
        Response::from_json(&AttachmentRow {
            id: body.id,
            message_id: body.message_id,
            draft_id: body.draft_id,
            r2_key: body.r2_key,
            filename_ct_b64: body.filename_ct_b64,
            mime: body.mime,
            size_bytes: body.size_bytes,
        })
    }

    async fn list_attachments(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let msg = url
            .query_pairs()
            .find(|(k, _)| k == "message_id")
            .map(|(_, v)| v.to_string());
        let draft = url
            .query_pairs()
            .find(|(k, _)| k == "draft_id")
            .map(|(_, v)| v.to_string());
        #[derive(Deserialize)]
        struct Row {
            id: String,
            message_id: Option<String>,
            draft_id: Option<String>,
            r2_key: String,
            #[serde(with = "serde_bytes", default)]
            filename_ct: Option<Vec<u8>>,
            mime: String,
            size_bytes: i64,
        }
        let rows: Vec<Row> = match (msg, draft) {
            (Some(m), _) => self.sql().exec(
                "SELECT id, message_id, draft_id, r2_key, filename_ct, mime, size_bytes
                 FROM attachments WHERE message_id = ?",
                Some(vec![m.into()]),
            )?,
            (None, Some(d)) => self.sql().exec(
                "SELECT id, message_id, draft_id, r2_key, filename_ct, mime, size_bytes
                 FROM attachments WHERE draft_id = ?",
                Some(vec![d.into()]),
            )?,
            _ => return Response::error("message_id or draft_id required", 400),
        }
        .to_array()?;
        let out: Vec<AttachmentRow> = rows
            .into_iter()
            .map(|r| AttachmentRow {
                id: r.id,
                message_id: r.message_id,
                draft_id: r.draft_id,
                r2_key: r.r2_key,
                filename_ct_b64: r.filename_ct.as_deref().map(crate::b64::url_encode),
                mime: r.mime,
                size_bytes: r.size_bytes,
            })
            .collect();
        Response::from_json(&out)
    }

    async fn delete_attachment(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let id = url
            .query_pairs()
            .find(|(k, _)| k == "id")
            .map(|(_, v)| v.to_string())
            .ok_or_else(|| Error::RustError("id required".into()))?;
        self.sql()
            .exec("DELETE FROM attachments WHERE id = ?", Some(vec![id.into()]))?;
        Response::ok("{}")
    }
}

// ---- shapes ----

#[derive(Deserialize)]
pub struct InsertMessageReq {
    pub id: String,
    pub thread_id: Option<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub from_addr: String,
    pub from_name: Option<String>,
    pub to_addrs: Vec<String>,
    pub cc_addrs: Vec<String>,
    pub bcc_addrs: Vec<String>,
    pub sent_at: i64,
    pub direction: String,
    pub snippet_ct_b64: Option<String>,
    pub subject_ct_b64: String,
    pub body_ct_b64: String,
    pub raw_r2_key: Option<String>,
    pub size_bytes: i64,
}

#[derive(Serialize)]
struct InsertMessageResp { thread_id: String }

#[derive(Serialize)]
struct ThreadRow {
    id: String,
    subject_hint: Option<String>,
    participants: Vec<String>,
    last_message_at: i64,
    message_count: i64,
    unread_count: i64,
    has_starred: bool,
    archived: bool,
}

#[derive(Serialize)]
struct MessageRow {
    id: String,
    thread_id: String,
    message_id: Option<String>,
    in_reply_to: Option<String>,
    from_addr: String,
    from_name: Option<String>,
    to_addrs: Vec<String>,
    cc_addrs: Vec<String>,
    bcc_addrs: Vec<String>,
    sent_at: i64,
    received_at: i64,
    direction: String,
    read: bool,
    starred: bool,
    snippet_ct_b64: Option<String>,
    subject_ct_b64: String,
    body_ct_b64: String,
    size_bytes: i64,
    labels: Vec<String>,
}

#[derive(Deserialize)]
struct PatchMessageReq { id: String, read: Option<bool>, starred: Option<bool> }

#[derive(Deserialize)]
struct UpsertDraftReq {
    id: Option<String>,
    in_reply_to_message_id: Option<String>,
    to_addrs: Vec<String>,
    cc_addrs: Vec<String>,
    bcc_addrs: Vec<String>,
    subject_ct_b64: Option<String>,
    body_ct_b64: Option<String>,
    attachments: Vec<String>,
}
#[derive(Serialize)]
struct DraftRow {
    id: String,
    in_reply_to_message_id: Option<String>,
    to_addrs: Vec<String>,
    cc_addrs: Vec<String>,
    bcc_addrs: Vec<String>,
    subject_ct_b64: Option<String>,
    body_ct_b64: Option<String>,
    attachments: Vec<String>,
    updated_at: i64,
}

#[derive(Deserialize)]
struct CreateLabelReq { name: String }
#[derive(Serialize, Deserialize)]
struct LabelRow { id: String, name: String, created_at: i64 }
#[derive(Deserialize)]
struct UpdateLabelReq { id: String, name: String }
#[derive(Deserialize)]
struct ToggleLabelReq { message_id: String, label_id: String, on: bool }

#[derive(Deserialize)]
struct AddAttachmentReq {
    id: String,
    message_id: Option<String>,
    draft_id: Option<String>,
    r2_key: String,
    filename_ct_b64: Option<String>,
    mime: String,
    size_bytes: i64,
}
#[derive(Serialize)]
struct AttachmentRow {
    id: String,
    message_id: Option<String>,
    draft_id: Option<String>,
    r2_key: String,
    filename_ct_b64: Option<String>,
    mime: String,
    size_bytes: i64,
}

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)",
    "CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        subject_hint TEXT,
        participants TEXT,
        last_message_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        has_starred INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE INDEX IF NOT EXISTS threads_last ON threads(last_message_at DESC)",
    "CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        in_reply_to TEXT,
        refs TEXT,
        from_addr TEXT NOT NULL,
        from_name TEXT,
        to_addrs TEXT NOT NULL,
        cc_addrs TEXT,
        bcc_addrs TEXT,
        sent_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        direction TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        snippet_ct BLOB,
        subject_ct BLOB NOT NULL,
        body_ct BLOB NOT NULL,
        raw_r2_key TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, sent_at)",
    "CREATE INDEX IF NOT EXISTS messages_msgid ON messages(message_id)",
    "CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS message_labels (
        message_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY (message_id, label_id)
    )",
    "CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        in_reply_to_message_id TEXT,
        to_addrs TEXT,
        cc_addrs TEXT,
        bcc_addrs TEXT,
        subject_ct BLOB,
        body_ct BLOB,
        attachments TEXT,
        updated_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        draft_id TEXT,
        r2_key TEXT NOT NULL,
        filename_ct BLOB,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS att_msg ON attachments(message_id)",
];

fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}
