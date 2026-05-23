/**
 * Thread view: loads all messages in a thread, decrypts subject/body
 * client-side using the in-memory X25519 private key, renders each message
 * collapsed-by-default with the most recent expanded.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';

import { marked } from 'marked';

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import * as realtime from '@/lib/realtime';
import { sessionPriv } from '@/lib/webauthn';
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
  attachments: DecodedAttachment[];
}

export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<api.MessageRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // attachments keyed by message_id
  const [attsByMsg, setAttsByMsg] = useState<Record<string, AttachmentRow[]>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get<api.MessageRow[]>(`/api/threads/${id}`);
        if (cancelled) return;
        setMsgs(data);
        if (data.length > 0) setExpandedId(data[data.length - 1].id);
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
      // React to changes that affect THIS thread. We re-fetch on
      // new/delete events for the thread, and on read/star events for
      // any message we're currently rendering. We don't try to be
      // surgical — a re-fetch is cheap and avoids divergence bugs.
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
          if (msgs?.some((m) => m.id === ev.msg_id)) void load();
          break;
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [id, msgs]);

  const priv = sessionPriv();
  const decoded = useMemo<Decoded[] | null>(() => {
    if (!msgs) return null;
    if (!priv) return [];
    return msgs.map((row) => {
      let subject = '';
      let body = '';
      try {
        subject = openSealedString(b64uDecode(row.subject_ct_b64), priv);
      } catch { subject = '[decrypt failed]'; }
      try {
        body = openSealedString(b64uDecode(row.body_ct_b64), priv);
      } catch { body = '[decrypt failed]'; }
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
      return { row, subject, body, attachments };
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
        const { openSealedBox } = await import('@/lib/crypto');
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
        title="session expired"
        hint={
          <>
            your private key is held only in memory and was cleared when the
            tab reloaded. <Link to="/login" className="underline">sign in again</Link>{' '}
            to decrypt this thread.
          </>
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
                    Render both directions identically. Outbound bodies are
                    the user's own markdown source — we always parsed those
                    here. Inbound bodies are plain text post html_to_text
                    (the server already stripped HTML tags on receive), so
                    feeding them through marked is safe: any markdown-ish
                    syntax that survived (`*`, `_`, URLs) gets the same
                    treatment as our own source, and the html_to_text
                    sanitization guarantees there's no markup to escape.
                  */}
                  <div
                    className="prose-sm font-sans text-sm leading-snug"
                    dangerouslySetInnerHTML={{
                      __html: marked.parse(d.body, {
                        async: false,
                        gfm: true,
                        breaks: true,
                      }) as string,
                    }}
                  />
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
