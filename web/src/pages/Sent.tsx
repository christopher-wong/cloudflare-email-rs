/** Sent = thread list showing outbound-first threads only. */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import EmptyState from '@/components/EmptyState';
import Avatar from '@/components/Avatar';

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
      switch (ev.type) {
        case 'message.new':
          if (ev.direction === 'out') void load();
          break;
        case 'thread.delete':
        case 'message.delete':
          void load();
          break;
      }
    });
  }, []);

  const decrypted = useMemo(() => {
    const map = new Map<string, { subject?: string; snippet?: string }>();
    if (!threads) return map;
    const priv = sessionPriv();
    if (!priv) return map;
    for (const t of threads) {
      const e: { subject?: string; snippet?: string } = {};
      if (t.first_subject_ct_b64) {
        try { e.subject = openSealedString(b64uDecode(t.first_subject_ct_b64), priv); }
        catch { /* keep undefined */ }
      }
      if (t.first_snippet_ct_b64) {
        try { e.snippet = openSealedString(b64uDecode(t.first_snippet_ct_b64), priv); }
        catch { /* keep undefined */ }
      }
      map.set(t.id, e);
    }
    return map;
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
            const dec = decrypted.get(t.id) ?? {};
            const sender = labelFor(t);
            const subject = dec.subject?.trim() || (sessionPriv() ? '(no subject)' : '[encrypted]');
            const preview = dec.snippet?.trim() ?? '';
            // For Sent rows the avatar represents the recipient, not us.
            // Fall back to the row label so the seed is stable.
            const avatarSeed = t.participants.find(
              (a) => !ownAddresses.has(a.toLowerCase()),
            ) ?? sender;
            return (
              <li key={t.id} className="row" onClick={() => nav(`/thread/${t.id}`)}>
                <Avatar seed={avatarSeed} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="row-sender truncate">{sender}</span>
                    {t.message_count > 1 && (
                      <span className="text-mute text-2xs">{t.message_count}</span>
                    )}
                  </div>
                  <div className="text-xs truncate">
                    <span>{subject}</span>
                    {preview && (
                      <>
                        <span className="text-mute mx-1.5">·</span>
                        <span className="text-mute">{preview}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-2xs whitespace-nowrap">{relativeDate(t.last_message_at)}</div>
                <button
                  type="button"
                  className="btn label"
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
