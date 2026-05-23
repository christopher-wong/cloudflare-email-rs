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

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import { sessionPriv } from '@/lib/webauthn';
import { absoluteDate, relativeDate } from '@/lib/time';

interface Decoded {
  row: api.MessageRow;
  subject: string;
  body: string;
}

export default function Thread() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<api.MessageRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
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
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'load failed');
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

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
      return { row, subject, body };
    });
  }, [msgs]);

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
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-snug">
                    {d.body}
                  </pre>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
