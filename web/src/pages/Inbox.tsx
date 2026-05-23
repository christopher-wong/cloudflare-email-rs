import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';
import Avatar from '@/components/Avatar';

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import { sessionPriv } from '@/lib/webauthn';
import * as realtime from '@/lib/realtime';
import { relativeDate } from '@/lib/time';
import { useApp } from '@/lib/store';
import { isEditableTarget, hasMod } from '@/lib/shortcuts';

export default function Inbox() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);
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
      // Re-fetch on anything that could change what the inbox shows:
      // a new inbound message, a thread or message getting deleted from
      // another tab, or read/star state flipping (which changes the
      // unread badge and the star chip on the row).
      switch (ev.type) {
        case 'message.new':
          if (ev.direction === 'in') void load();
          break;
        case 'thread.delete':
        case 'message.delete':
        case 'message.read':
        case 'message.star':
          void load();
          break;
      }
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

  // Decrypt the first-message subject and snippet for each row. Cheap
  // (one HKDF + AEAD per ciphertext) and the priv key stays in memory.
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

  // j/k row navigation. The selected row scrolls into view, and Enter opens
  // the thread. The handler bails out when focus is in an editable element
  // so it doesn't fight with the global Chrome shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (hasMod(e)) return;
      if (!threads || threads.length === 0) return;
      if (e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(threads.length - 1, i < 0 ? 0 : i + 1));
      } else if (e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i < 0 ? 0 : i - 1));
      } else if (e.key === 'Enter') {
        if (selectedIdx >= 0 && selectedIdx < threads.length) {
          e.preventDefault();
          nav(`/thread/${threads[selectedIdx].id}`);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [threads, selectedIdx, nav]);

  // Keep the selected row visible. `nearest` avoids jumpy autoscroll while
  // the user is moving slowly through a small list.
  useEffect(() => {
    if (selectedIdx < 0) return;
    rowRefs.current[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

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
          {threads.map((t, i) => {
            const dec = decrypted.get(t.id) ?? {};
            const sender = labelFor(t);
            const isSelected = i === selectedIdx;
            const subject = dec.subject?.trim() || (sessionPriv() ? '(no subject)' : '[encrypted]');
            const preview = dec.snippet?.trim() ?? '';
            return (
              <li
                key={t.id}
                ref={(el) => { rowRefs.current[i] = el; }}
                className={
                  'row ' +
                  (t.unread_count > 0 ? 'unread ' : '') +
                  (isSelected ? 'inv' : '')
                }
                onClick={() => nav(`/thread/${t.id}`)}
              >
                <Avatar seed={t.first_from_addr ?? sender} />
                <div className="min-w-0">
                  {/* Top row: bold sender on the left, count + star chips
                      on the right of the same line. */}
                  <div className="flex items-baseline gap-2">
                    <span className="row-sender truncate">{sender}</span>
                    {t.message_count > 1 && (
                      <span className="text-mute text-2xs">{t.message_count}</span>
                    )}
                    {t.has_starred && <span className="text-2xs">★</span>}
                  </div>
                  {/* Bottom row: subject, then preview in muted text after
                      a separator. Both truncate to one line each so the row
                      height stays stable. */}
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
                <div className="text-2xs whitespace-nowrap">
                  {relativeDate(t.last_message_at)}
                </div>
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
