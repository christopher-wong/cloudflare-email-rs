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

/** Inline sent row — same visual grid as inbox rows, with recipient avatar. */
function SentRow({
  t,
  sender,
  subject,
  preview,
  avatarSeed,
  onOpen,
  onDelete,
}: {
  t: api.ThreadRow;
  sender: string;
  subject: string;
  preview: string;
  avatarSeed: string;
  onOpen: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <li
      className="group relative grid cursor-pointer items-center gap-3.5 border-b border-border px-[18px] py-3 transition-colors duration-[120ms] hover:bg-hover"
      style={{ gridTemplateColumns: '32px minmax(160px,1fr) minmax(0,2fr) auto' }}
      onClick={onOpen}
    >
      {/* Recipient avatar */}
      <Avatar seed={avatarSeed} size={32} />

      {/* Recipient name */}
      <div className="truncate text-[13.5px] font-medium text-ink-muted">
        {sender}
        {t.message_count > 1 && (
          <span className="ml-1.5 text-[11px] text-ink-faint">{t.message_count}</span>
        )}
      </div>

      {/* Subject + preview */}
      <div className="min-w-0 truncate text-[13.5px]">
        <span className="text-ink-muted">{subject}</span>
        {preview && (
          <>
            <span className="mx-1.5 text-ink-faint">·</span>
            <span className="text-ink-faint">{preview}</span>
          </>
        )}
      </div>

      {/* Meta + hover actions */}
      <div className="relative flex items-center gap-2">
        <div className="flex items-center gap-2 transition-opacity duration-[120ms] group-hover:opacity-0">
          {/* Lock indicator */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-ink-faint opacity-60"
            aria-label="end-to-end encrypted"
          >
            <rect x="3" y="7" width="10" height="7" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
          </svg>
          <span className="tnum whitespace-nowrap font-mono text-[12px] text-ink-faint">
            {relativeDate(t.last_message_at)}
          </span>
        </div>
        {/* Hover-revealed actions */}
        <div className="absolute right-0 flex items-center gap-1 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100">
          <button
            type="button"
            className="btn btn-sm btn-ghost p-1.5"
            onClick={onDelete}
            title="Delete thread"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </li>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export default function Sent() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { state } = useApp();
  const nav = useNavigate();

  const load = async () => {
    try {
      const t = await api.get<api.ThreadRow[]>('/api/threads?limit=100');
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
    return 'To ' + list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
  };

  const deleteThread = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this thread? Messages and attachments will be removed.')) return;
    setThreads((cur) => (cur ? cur.filter((t) => t.id !== id) : cur));
    try {
      await api.del(`/api/threads/${encodeURIComponent(id)}`);
    } catch (err: any) {
      setErr(err?.message || 'delete failed');
      void load();
    }
  };

  const sentCount = threads?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold text-ink">Sent</span>
          {sentCount > 0 && (
            <span className="tnum text-[12px] text-ink-faint">{sentCount} message{sentCount === 1 ? '' : 's'}</span>
          )}
        </div>
      </Toolbar>

      {threads === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {threads && threads.length === 0 && (
        <EmptyState
          title="Nothing sent yet"
          hint="Sent messages will appear here."
          icon={<SendIcon />}
        />
      )}
      {threads && threads.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {threads.map((t) => {
            const dec = decrypted.get(t.id) ?? {};
            const sender = labelFor(t);
            const subject = dec.subject?.trim() || (sessionPriv() ? '(no subject)' : '[encrypted]');
            const preview = dec.snippet?.trim() ?? '';
            const avatarSeed = t.participants.find(
              (a) => !ownAddresses.has(a.toLowerCase()),
            ) ?? sender;
            return (
              <SentRow
                key={t.id}
                t={t}
                sender={sender}
                subject={subject}
                preview={preview}
                avatarSeed={avatarSeed}
                onOpen={() => nav(`/thread/${t.id}`)}
                onDelete={(e) => void deleteThread(e, t.id)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
