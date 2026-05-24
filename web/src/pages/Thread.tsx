/**
 * Thread view: loads all messages in a thread, decrypts subject/body
 * client-side using the in-memory X25519 private key, renders each message
 * collapsed-by-default with the most recent expanded.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import Avatar from '@/components/Avatar';
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
  bodyHtml: string | null;
  attachments: DecodedAttachment[];
}

export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<api.MessageRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [imagesShown, setImagesShown] = useState<Record<string, boolean>>({});
  const [attsByMsg, setAttsByMsg] = useState<Record<string, AttachmentRow[]>>({});
  const initialExpansionApplied = useRef(false);

  useEffect(() => {
    initialExpansionApplied.current = false;
  }, [id]);

  const [labels, setLabels] = useState<api.Label[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.get<api.Label[]>('/api/labels').then(
      (l) => { if (!cancelled) setLabels(l); },
      () => { /* tolerable */ },
    );
    return () => { cancelled = true; };
  }, []);

  const toggleLabel = async (msgId: string, labelId: string, on: boolean) => {
    setMsgs((cur) =>
      cur
        ? cur.map((m) => {
            if (m.id !== msgId) return m;
            const has = m.labels.includes(labelId);
            return {
              ...m,
              labels: on
                ? (has ? m.labels : [...m.labels, labelId])
                : m.labels.filter((lid) => lid !== labelId),
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
        await Promise.allSettled(
          data
            .filter((m) => m.direction === 'in' && !m.read)
            .map((m) => api.patch(`/api/messages/${m.id}`, { read: true })),
        );
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
      try { subject = openSealedString(b64uDecode(row.subject_ct_b64), priv); }
      catch { subject = '[decrypt failed]'; }
      try { body = openSealedString(b64uDecode(row.body_ct_b64), priv); }
      catch { body = '[decrypt failed]'; }
      if (row.body_html_ct_b64) {
        try { bodyHtml = openSealedString(b64uDecode(row.body_html_ct_b64), priv); }
        catch { /* keep text fallback */ }
      }
      const rawAtts = attsByMsg[row.id] ?? [];
      const attachments: DecodedAttachment[] = rawAtts.map((a) => {
        let filename = a.r2_key.split('/').pop() ?? 'attachment';
        if (a.filename_ct_b64) {
          try { filename = openSealedString(b64uDecode(a.filename_ct_b64), priv); }
          catch { /* keep fallback */ }
        }
        return { row: a, filename };
      });
      return { row, subject, body, bodyHtml, attachments };
    });
  }, [msgs, attsByMsg]);

  const downloadAttachment = async (att: DecodedAttachment) => {
    if (!priv) return;
    try {
      const resp = await api.rawFetch('GET', `/api/attachments/${encodeURIComponent(att.row.id)}`, '');
      if (!resp.ok) throw new Error(`download failed (${resp.status})`);
      const ct = new Uint8Array(await resp.arrayBuffer());
      let bytes: Uint8Array;
      try { bytes = openSealedBox(ct, priv); }
      catch { bytes = ct; }
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
  if (msgs.length === 0) return <EmptyState title="Thread not found" />;
  if (!priv) {
    return (
      <EmptyState
        title="Vault locked"
        hint="Decrypt this thread by unlocking with your passkey. Your private key is held only in memory."
        action={
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              try {
                await unlock();
                setMsgs(null);
                const data = await api.get<api.MessageRow[]>(`/api/threads/${id}`);
                setMsgs(data);
              } catch (e: any) {
                setErr(e?.message || 'unlock failed');
              }
            }}
          >
            Unlock with passkey
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
            className="btn btn-accent"
          >
            Reply
          </Link>
        }
      >
        <button className="btn btn-ghost btn-sm" onClick={() => nav('/')}>
          <ChevronLeftIcon />
          Back
        </button>
      </Toolbar>

      {/* Thread header */}
      <div className="flex items-center gap-3 border-b border-border px-[18px] py-4">
        <h1 className="flex-1 truncate text-[17px] font-semibold text-ink leading-snug">
          {subject || '(no subject)'}
        </h1>
        <span className="pill shrink-0">
          <LockIcon size={11} />
          Encrypted
        </span>
      </div>

      {/* Messages */}
      <ul className="flex-1 overflow-y-auto">
        {decoded.map((d) => {
          const open = expandedId === d.row.id;
          const fromLabel = d.row.from_name ?? d.row.from_addr;
          return (
            <li key={d.row.id} className="border-b border-border last:border-0">
              {/* Collapsed header — always visible */}
              <button
                className="group flex w-full items-center gap-3 px-[18px] py-3.5 text-left transition-colors duration-[120ms] hover:bg-hover"
                onClick={() => setExpandedId(open ? null : d.row.id)}
              >
                <Avatar seed={d.row.from_addr} size={32} />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-ink">{fromLabel}</span>
                  {d.row.from_name && d.row.from_name !== d.row.from_addr && (
                    <span className="truncate font-mono text-[12px] text-ink-muted">{d.row.from_addr}</span>
                  )}
                  {d.row.direction === 'out' && (
                    <span className="badge badge-soft shrink-0">sent</span>
                  )}
                </div>
                <span className="tnum shrink-0 font-mono text-[12px] text-ink-faint">
                  {relativeDate(d.row.sent_at)}
                </span>
                <ChevronIcon open={open} />
              </button>

              {/* Expanded body */}
              {open && (
                <div className="border-t border-border px-[18px] py-4">
                  {/* Recipients line */}
                  <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-muted">
                    <span>To</span>
                    {d.row.to_addrs.map((a) => (
                      <span key={a} className="font-mono">{a}</span>
                    ))}
                    {d.row.cc_addrs.length > 0 && (
                      <>
                        <span className="text-ink-faint">·</span>
                        <span>Cc</span>
                        {d.row.cc_addrs.map((a) => (
                          <span key={a} className="font-mono">{a}</span>
                        ))}
                      </>
                    )}
                    <span className="ml-auto tnum font-mono text-ink-faint">{absoluteDate(d.row.sent_at)}</span>
                  </div>

                  {/* Body */}
                  {d.bodyHtml ? (
                    <>
                      <HtmlMessageFrame
                        html={d.bodyHtml}
                        loadImages={imagesShown[d.row.id] ?? false}
                      />
                      {!imagesShown[d.row.id] && (
                        <button
                          type="button"
                          className="btn btn-sm mt-3"
                          onClick={() => setImagesShown((p) => ({ ...p, [d.row.id]: true }))}
                          title="Load remote images via our proxy. The sender will not see your IP."
                        >
                          Show images
                        </button>
                      )}
                    </>
                  ) : (
                    <div
                      className="prose-sm font-sans text-[14px] leading-relaxed text-ink"
                      dangerouslySetInnerHTML={{
                        __html:
                          d.row.direction === 'out'
                            ? d.body
                            : (marked.parse(d.body, { async: false, gfm: true, breaks: true }) as string),
                      }}
                    />
                  )}

                  {/* Attachments */}
                  {d.attachments.length > 0 && (
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                      {d.attachments.map((a) => (
                        <button
                          key={a.row.id}
                          type="button"
                          onClick={() => void downloadAttachment(a)}
                          className="flex items-center gap-2 rounded-sm border border-border bg-elev px-3 py-1.5 text-[12.5px] text-ink-muted transition-colors duration-[120ms] hover:border-border-strong hover:bg-hover"
                          title={`${a.row.mime} · ${formatBytes(a.row.size_bytes)}`}
                        >
                          <PaperclipIcon />
                          <span className="max-w-[16rem] truncate">{a.filename}</span>
                          <span className="text-ink-faint">{formatBytes(a.row.size_bytes)}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Labels */}
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    <span className="text-[12px] text-ink-faint">Labels</span>
                    {d.row.labels.map((lid) => {
                      const l = labels.find((x) => x.id === lid);
                      return (
                        <button
                          key={lid}
                          type="button"
                          className="chip"
                          onClick={() => void toggleLabel(d.row.id, lid, false)}
                          title="Remove label"
                        >
                          {l?.name ?? lid}
                          <span className="text-ink-faint">×</span>
                        </button>
                      );
                    })}
                    {labels.filter((l) => !d.row.labels.includes(l.id)).length > 0 && (
                      <select
                        className="h-7 rounded-sm border border-border bg-elev px-2 text-[12.5px] text-ink-muted outline-none focus:border-accent"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v) void toggleLabel(d.row.id, v, true);
                        }}
                      >
                        <option value="">+ Add label</option>
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

      {/* Reply composer footer */}
      <div className="border-t border-border bg-elev">
        <div className="px-[18px] py-3 text-[12px] text-ink-muted">
          <LockIcon size={11} />
          {' '}Encrypted to {last.from_addr}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-[18px] py-3">
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
            className="btn btn-accent"
          >
            Reply
          </Link>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline', verticalAlign: 'middle', opacity: 0.6 }}
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-ink-faint transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
