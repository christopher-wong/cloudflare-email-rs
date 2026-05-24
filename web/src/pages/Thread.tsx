/**
 * Thread view: loads all messages in a thread, decrypts subject/body
 * client-side using the in-memory X25519 private key, renders each message
 * collapsed-by-default with the most recent expanded.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';
import HtmlMessageFrame from '@/components/HtmlMessageFrame';

import { marked } from 'marked';

import * as api from '@/lib/api';
import { b64uDecode, openSealedBox, openSealedString } from '@/lib/crypto';
import * as realtime from '@/lib/realtime';
import { sessionPriv, unlock } from '@/lib/webauthn';
import { absoluteDate, relativeDate } from '@/lib/time';

interface AttachmentRow {
  id: string;
  message_id: string | null;
  draft_id: string | null;
  r2_key: string;
  filename_ct_b64: string | null;
  mime: string;
  size_bytes: number;
  created_at: number;
}

interface DecodedAttachment {
  row: AttachmentRow;
  filename: string;
}

interface Decoded {
  row: api.MessageRow;
  subject: string;
  body: string;
  /** Decrypted HTML body when one was stored. Null for legacy
   *  text-only messages — the renderer falls back to `body`. */
  bodyHtml: string | null;
  attachments: DecodedAttachment[];
}

export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<api.MessageRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Per-message "show images" — defaults to false (images blocked).
  // The button on the message swaps the iframe over to the proxied
  // image URLs so the user gets the real layout without leaking IP.
  const [imagesShown, setImagesShown] = useState<Record<string, boolean>>({});
  // attachments keyed by message_id
  const [attsByMsg, setAttsByMsg] = useState<Record<string, AttachmentRow[]>>({});
  // Tracks whether we've already auto-expanded the latest message on the
  // *first* load of this thread. Realtime events (message.read fires from
  // our own mark-as-read PATCH inside load()) re-trigger load(), and we
  // don't want each refresh to clobber whatever the user is currently
  // reading. Reset when the thread id changes.
  const initialExpansionApplied = useRef(false);

  // Reset the "auto-expand latest" gate whenever the thread changes.
  useEffect(() => {
    initialExpansionApplied.current = false;
  }, [id]);

  // Pull the user's labels once per mount. Cheap; small data set; the
  // user can change them in Labels.tsx and we'll refresh via the realtime
  // signal that fires whenever a label is created/deleted (TODO: emit
  // those events too — for now we just stale-tolerate until next mount).
  const [labels, setLabels] = useState<api.Label[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.get<api.Label[]>('/api/labels').then(
      (l) => { if (!cancelled) setLabels(l); },
      () => { /* tolerable: labels are optional polish */ },
    );
    return () => { cancelled = true; };
  }, []);

  const toggleLabel = async (msgId: string, labelId: string, on: boolean) => {
    // Optimistic patch — flip the local labels list immediately, let the
    // realtime echo (message.label) reconcile if something diverges.
    setMsgs((cur) =>
      cur
        ? cur.map((m) => {
            if (m.id !== msgId) return m;
            const has = m.labels.includes(labelId);
            return {
              ...m,
              labels: on
                ? (has ? m.labels : [...m.labels, labelId])
                : m.labels.filter((id) => id !== labelId),
            };
          })
        : cur,
    );
    try {
      await api.post('/api/message-labels', { message_id: msgId, label_id: labelId, on });
    } catch (e: any) {
      setErr(e?.message || 'label toggle failed');
    }
  };

  // A live ref to the latest msgs list. We can't put `msgs` in the
  // useEffect dep array — load() sets msgs, msgs re-fires the effect,
  // load() runs again, ad infinitum. So the realtime handler reads
  // through this ref instead and the effect deps only include `id`.
  const msgsRef = useRef<api.MessageRow[] | null>(null);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get<api.MessageRow[]>(`/api/threads/${id}`);
        if (cancelled) return;
        setMsgs(data);
        if (data.length > 0 && !initialExpansionApplied.current) {
          setExpandedId(data[data.length - 1].id);
          initialExpansionApplied.current = true;
        }
        // Mark all inbound as read.
        await Promise.allSettled(
          data
            .filter((m) => m.direction === 'in' && !m.read)
            .map((m) => api.patch(`/api/messages/${m.id}`, { read: true })),
        );
        // Fetch attachments per message; messages without attachments
        // simply return an empty list cheaply. Run in parallel.
        const attsEntries = await Promise.all(
          data.map(async (m) => {
            try {
              const list = await api.get<AttachmentRow[]>(
                `/api/messages/${encodeURIComponent(m.id)}/attachments`,
              );
              return [m.id, list] as const;
            } catch {
              return [m.id, [] as AttachmentRow[]] as const;
            }
          }),
        );
        if (cancelled) return;
        const map: Record<string, AttachmentRow[]> = {};
        for (const [k, v] of attsEntries) map[k] = v;
        setAttsByMsg(map);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'load failed');
      }
    };
    void load();
    const unsub = realtime.subscribe((ev) => {
      switch (ev.type) {
        case 'message.new': {
          const tid = (ev as { thread_id?: string }).thread_id;
          if (!tid || tid === id) void load();
          break;
        }
        case 'thread.delete':
          if (ev.thread_id === id) nav('/', { replace: true });
          break;
        case 'message.delete':
          if (!ev.thread_id || ev.thread_id === id) void load();
          break;
        case 'message.read':
        case 'message.star':
        case 'message.label':
          if (msgsRef.current?.some((m) => m.id === ev.msg_id)) void load();
          break;
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [id, nav]);

  const priv = sessionPriv();
  const decoded = useMemo<Decoded[] | null>(() => {
    if (!msgs) return null;
    if (!priv) return [];
    return msgs.map((row) => {
      let subject = '';
      let body = '';
      let bodyHtml: string | null = null;
      try {
        subject = openSealedString(b64uDecode(row.subject_ct_b64), priv);
      } catch { subject = '[decrypt failed]'; }
      try {
        body = openSealedString(b64uDecode(row.body_ct_b64), priv);
      } catch { body = '[decrypt failed]'; }
      // Inbound HTML emails ship the real html alongside the text
      // fallback — when present we render it in a sandboxed iframe
      // (real layout, no scripts). body stays the text representation
      // for snippets and the markdown fallback path.
      if (row.body_html_ct_b64) {
        try {
          bodyHtml = openSealedString(b64uDecode(row.body_html_ct_b64), priv);
        } catch { /* keep text fallback */ }
      }
      const rawAtts = attsByMsg[row.id] ?? [];
      const attachments: DecodedAttachment[] = rawAtts.map((a) => {
        let filename = a.r2_key.split('/').pop() ?? 'attachment';
        if (a.filename_ct_b64) {
          try {
            filename = openSealedString(b64uDecode(a.filename_ct_b64), priv);
          } catch { /* keep fallback */ }
        }
        return { row: a, filename };
      });
      return { row, subject, body, bodyHtml, attachments };
    });
  }, [msgs, attsByMsg]);

  /**
   * Fetch the sealed attachment bytes, decrypt with the in-memory priv
   * key, then trigger a browser download. We can't stream-decrypt because
   * sealed-box is all-or-nothing, but typical attachments are small
   * enough (a few MB) that buffering is fine.
   */
  const downloadAttachment = async (att: DecodedAttachment) => {
    if (!priv) return;
    try {
      const resp = await api.rawFetch('GET', `/api/attachments/${encodeURIComponent(att.row.id)}`, '');
      if (!resp.ok) throw new Error(`download failed (${resp.status})`);
      const ct = new Uint8Array(await resp.arrayBuffer());
      // Inbound attachments arrive sealed. Outbound (sender's stored
      // copy) is plaintext for v1, so try seal-open first and fall
      // back to the raw bytes if it isn't a sealed-box envelope.
      let bytes: Uint8Array;
      try {
        bytes = openSealedBox(ct, priv);
      } catch {
        bytes = ct;
      }
      const blob = new Blob([bytes as BlobPart], { type: att.row.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setErr(e?.message || 'download failed');
    }
  };

  if (err) return <EmptyState title={err} />;
  if (!msgs || !decoded) return <Loader />;
  if (msgs.length === 0) return <EmptyState title="thread not found" />;
  if (!priv) {
    return (
      <EmptyState
        title="vault locked"
        hint={
          <>
            decrypt this thread by unlocking with your passkey. your
            private key is held only in memory; unlocking re-derives it
            from your authenticator without a full sign-in.
          </>
        }
        action={
          <button
            type="button"
            className="btn btn-primary label"
            onClick={async () => {
              try {
                await unlock();
                // Force a re-render by re-fetching messages.
                setMsgs(null);
                const data = await api.get<api.MessageRow[]>(`/api/threads/${id}`);
                setMsgs(data);
              } catch (e: any) {
                setErr(e?.message || 'unlock failed');
              }
            }}
          >
            unlock with passkey ▸
          </button>
        }
      />
    );
  }

  const subject = decoded[0]?.subject || '';
  const last = msgs[msgs.length - 1];

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          <Link
            to="/compose"
            state={{
              replyToMessageId: last.id,
              replyToThreadId: last.thread_id,
              messageId: last.message_id,
              references: last.in_reply_to,
              to: [last.from_addr],
              subject: subject.startsWith('Re: ') ? subject : `Re: ${subject}`,
            }}
            className="btn btn-primary label"
          >
            reply ▸
          </Link>
        }
      >
        <button className="btn-ghost btn label" onClick={() => nav('/')}>
          ◂ back
        </button>
      </Toolbar>

      <div className="hair-b px-4 py-3">
        <div className="label">subject</div>
        <div className="mt-1 truncate text-lg font-bold">{subject || '(no subject)'}</div>
      </div>

      <ul className="flex-1 overflow-y-auto">
        {decoded.map((d) => {
          const open = expandedId === d.row.id;
          return (
            <li key={d.row.id} className="hair-b">
              <button
                className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-2 text-left hover:bg-faint"
                onClick={() => setExpandedId(open ? null : d.row.id)}
              >
                <div className="truncate">
                  <span className="font-bold">{d.row.from_name ?? d.row.from_addr}</span>
                  <span className="text-mute ml-2 text-xs">{d.row.from_addr}</span>
                </div>
                <div className="text-xs">
                  {d.row.direction === 'out' && <span className="chip mr-2">SENT</span>}
                  {relativeDate(d.row.sent_at)}
                </div>
              </button>
              {open && (
                <div className="hair-t px-4 py-3">
                  <div className="text-mute mb-2 text-xs">
                    to {d.row.to_addrs.join(', ')}
                    {d.row.cc_addrs.length > 0 && `  ·  cc ${d.row.cc_addrs.join(', ')}`}
                    {'  ·  '}
                    {absoluteDate(d.row.sent_at)}
                  </div>
                  {/*
                    Render policy:
                    - Real HTML body present (typical for marketing /
                      transactional mail from any modern sender)
                      → sandboxed iframe with the sender's HTML
                      preserved. No scripts run, link clicks open in
                      new tabs, the iframe self-sizes.
                    - No HTML body: outbound bodies are the user's own
                      WYSIWYG HTML and render in-page; inbound text-
                      only goes through marked.parse for autolinking
                      and paragraph breaks.
                  */}
                  {d.bodyHtml ? (
                    <>
                      <HtmlMessageFrame
                        html={d.bodyHtml}
                        loadImages={imagesShown[d.row.id] ?? false}
                      />
                      {!imagesShown[d.row.id] && (
                        <button
                          type="button"
                          className="btn label mt-2 text-xs"
                          onClick={() =>
                            setImagesShown((p) => ({ ...p, [d.row.id]: true }))
                          }
                          title="Load remote images via our proxy. The sender will not see your IP."
                        >
                          show images
                        </button>
                      )}
                    </>
                  ) : (
                    <div
                      className="prose-sm font-sans text-sm leading-snug"
                      dangerouslySetInnerHTML={{
                        __html:
                          d.row.direction === 'out'
                            ? d.body
                            : (marked.parse(d.body, {
                                async: false,
                                gfm: true,
                                breaks: true,
                              }) as string),
                      }}
                    />
                  )}
                  {d.attachments.length > 0 && (
                    <div className="hair-t mt-3 flex flex-wrap items-center gap-2 pt-3">
                      {d.attachments.map((a) => (
                        <button
                          key={a.row.id}
                          type="button"
                          onClick={() => void downloadAttachment(a)}
                          className="hair-all flex items-center gap-2 px-2 py-1 text-xs hover:bg-faint"
                          title={`${a.row.mime} · ${formatBytes(a.row.size_bytes)}`}
                        >
                          <span>📎</span>
                          <span className="truncate max-w-[16rem]">{a.filename}</span>
                          <span className="text-mute">{formatBytes(a.row.size_bytes)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="hair-t mt-3 flex flex-wrap items-center gap-2 pt-3">
                    <span className="label text-mute">labels</span>
                    {d.row.labels.map((lid) => {
                      const l = labels.find((x) => x.id === lid);
                      return (
                        <button
                          key={lid}
                          type="button"
                          className="chip chip-inv"
                          onClick={() => void toggleLabel(d.row.id, lid, false)}
                          title="remove label"
                        >
                          {l?.name ?? lid}
                          <span className="ml-1">×</span>
                        </button>
                      );
                    })}
                    {/* Native <select> for "add a label" — keeps a11y + mobile
                        friendly, no custom popover. The "" sentinel value
                        keeps the dropdown showing the prompt text until the
                        user makes a real choice. */}
                    {labels.filter((l) => !d.row.labels.includes(l.id)).length > 0 && (
                      <select
                        className="text-xs"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v) void toggleLabel(d.row.id, v, true);
                        }}
                      >
                        <option value="">+ add label</option>
                        {labels
                          .filter((l) => !d.row.labels.includes(l.id))
                          .map((l) => (
                            <option key={l.id} value={l.id}>{l.name}</option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
