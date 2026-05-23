import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import { sessionPriv } from '@/lib/webauthn';
import * as realtime from '@/lib/realtime';
import { relativeDate } from '@/lib/time';
import { useApp } from '@/lib/store';

export default function Inbox() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state } = useApp();
  const nav = useNavigate();

  const load = async () => {
    try {
      const t = await api.get<api.ThreadRow[]>('/api/threads?limit=100&inbound_only=1');
      setThreads(t);
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => {
    void load();
    return realtime.subscribe((ev) => {
      if (ev.type === 'message.new' && ev.direction === 'in') void load();
    });
  }, []);

  const deleteThread = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('delete this thread? messages and attachments will be removed.')) return;
    // Optimistic update — drop the row immediately so the click feels fast.
    setThreads((cur) => (cur ? cur.filter((t) => t.id !== id) : cur));
    try {
      await api.del(`/api/threads/${encodeURIComponent(id)}`);
    } catch (err: any) {
      setErr(err?.message || 'delete failed');
      void load();
    }
  };

  // Decrypt the first-message subject for each row. Cheap (one HKDF + AEAD
  // per row), and the priv key stays in memory.
  const decryptedSubjects = useMemo(() => {
    if (!threads) return new Map<string, string>();
    const priv = sessionPriv();
    if (!priv) return new Map<string, string>();
    const m = new Map<string, string>();
    for (const t of threads) {
      if (!t.first_subject_ct_b64) continue;
      try {
        m.set(t.id, openSealedString(b64uDecode(t.first_subject_ct_b64), priv));
      } catch { /* decrypt failed for this row — leave undefined */ }
    }
    return m;
  }, [threads]);

  const ownAddresses = useMemo(
    () => new Set((state.me?.addresses ?? []).map((a) => a.toLowerCase())),
    [state.me?.addresses],
  );

  const labelFor = (t: api.ThreadRow): string => {
    // For an inbound-first thread we show the sender; for an outbound-first
    // thread we show "to <other parties>". Falls back to all participants.
    if (t.first_direction === 'in' && t.first_from_addr) return t.first_from_addr;
    const others = t.participants.filter((a) => !ownAddresses.has(a.toLowerCase()));
    const list = others.length > 0 ? others : t.participants;
    if (list.length === 0) return '(no participants)';
    return list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
  };

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          <Link to="/compose" className="btn btn-primary label">
            compose ▸
          </Link>
        }
      >
        <span className="label">inbox</span>
        <span className="text-mute text-xs">{state.me?.addresses.join(', ')}</span>
      </Toolbar>

      {threads === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {threads && threads.length === 0 && (
        <EmptyState
          title="inbox is empty"
          hint="emails routed to your address(es) will appear here once received."
        />
      )}
      {threads && threads.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {threads.map((t) => {
            const subject = decryptedSubjects.get(t.id);
            return (
              <li
                key={t.id}
                className={'row ' + (t.unread_count > 0 ? 'unread' : '')}
                onClick={() => nav(`/thread/${t.id}`)}
              >
                <div className="truncate">{labelFor(t)}</div>
                <div className="flex items-center gap-2 truncate">
                  {subject ? (
                    <span className="truncate">{subject || '(no subject)'}</span>
                  ) : (
                    <span className="text-mute text-xs">
                      {sessionPriv() ? '(no subject)' : '[encrypted]'}
                    </span>
                  )}
                  {t.has_starred && <span className="chip">★</span>}
                  {t.message_count > 1 && (
                    <span className="chip">{t.message_count}</span>
                  )}
                </div>
                <div className="text-right text-xs">
                  {relativeDate(t.last_message_at)}
                </div>
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
