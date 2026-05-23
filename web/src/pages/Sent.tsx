/** Sent = thread list showing outbound-first threads only. */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import { sessionPriv } from '@/lib/webauthn';
import * as realtime from '@/lib/realtime';
import { relativeDate } from '@/lib/time';
import { useApp } from '@/lib/store';

export default function Sent() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state } = useApp();
  const nav = useNavigate();

  const load = async () => {
    try {
      const t = await api.get<api.ThreadRow[]>('/api/threads?limit=100');
      // "Sent" shows threads that *started* outbound. Threads where the
      // first message is inbound are someone else's email to us — those
      // belong in Inbox.
      setThreads(t.filter((row) => row.first_direction === 'out'));
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => {
    void load();
    return realtime.subscribe((ev) => {
      if (ev.type === 'message.new' && ev.direction === 'out') void load();
    });
  }, []);

  const decryptedSubjects = useMemo(() => {
    if (!threads) return new Map<string, string>();
    const priv = sessionPriv();
    if (!priv) return new Map<string, string>();
    const m = new Map<string, string>();
    for (const t of threads) {
      if (!t.first_subject_ct_b64) continue;
      try {
        m.set(t.id, openSealedString(b64uDecode(t.first_subject_ct_b64), priv));
      } catch { /* decrypt failed — leave undefined */ }
    }
    return m;
  }, [threads]);

  const ownAddresses = useMemo(
    () => new Set((state.me?.addresses ?? []).map((a) => a.toLowerCase())),
    [state.me?.addresses],
  );

  const labelFor = (t: api.ThreadRow): string => {
    const others = t.participants.filter((a) => !ownAddresses.has(a.toLowerCase()));
    const list = others.length > 0 ? others : t.participants;
    if (list.length === 0) return '(no recipients)';
    return 'to ' + list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
  };

  const deleteThread = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('delete this thread? messages and attachments will be removed.')) return;
    setThreads((cur) => (cur ? cur.filter((t) => t.id !== id) : cur));
    try {
      await api.del(`/api/threads/${encodeURIComponent(id)}`);
    } catch (err: any) {
      setErr(err?.message || 'delete failed');
      void load();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <span className="label">sent</span>
      </Toolbar>
      {threads === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {threads && threads.length === 0 && <EmptyState title="nothing sent yet" />}
      {threads && threads.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {threads.map((t) => {
            const subject = decryptedSubjects.get(t.id);
            return (
              <li key={t.id} className="row" onClick={() => nav(`/thread/${t.id}`)}>
                <div className="truncate">{labelFor(t)}</div>
                <div className="flex items-center gap-2 truncate">
                  {subject ? (
                    <span className="truncate">{subject || '(no subject)'}</span>
                  ) : (
                    <span className="text-mute text-xs">
                      {sessionPriv() ? '(no subject)' : '[encrypted]'}
                    </span>
                  )}
                  {t.message_count > 1 && (
                    <span className="chip">{t.message_count}</span>
                  )}
                </div>
                <div className="text-right text-xs">{relativeDate(t.last_message_at)}</div>
                <button
                  type="button"
                  className="btn label ml-2"
                  onClick={(e) => deleteThread(e, t.id)}
                  title="delete thread"
                >
                  delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
