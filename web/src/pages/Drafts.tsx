import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import Toolbar from '@/components/Toolbar';
import EmptyState from '@/components/EmptyState';
import Loader from '@/components/Loader';
import Avatar from '@/components/Avatar';

import * as api from '@/lib/api';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import * as realtime from '@/lib/realtime';
import { sessionPriv } from '@/lib/webauthn';
import { relativeDate } from '@/lib/time';

/** Inline draft row — same visual grid as inbox rows. */
function DraftRow({
  d,
  onOpen,
  onDelete,
}: {
  d: api.DraftRow & { subject: string };
  onOpen: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const recipient = d.to_addrs[0] ?? '(no recipient)';
  const moreRecipients = d.to_addrs.length > 1 ? ` +${d.to_addrs.length - 1}` : '';

  return (
    <li
      className="group relative grid cursor-pointer items-center gap-3.5 border-b border-border px-[18px] py-3 transition-colors duration-[120ms] hover:bg-hover"
      style={{ gridTemplateColumns: '32px minmax(160px,1fr) minmax(0,2fr) auto' }}
      onClick={onOpen}
    >
      {/* Avatar */}
      <Avatar seed={recipient} size={32} />

      {/* Recipient */}
      <div className="truncate text-[13.5px] font-medium text-ink-muted">
        {recipient}
        {moreRecipients && <span className="text-ink-faint">{moreRecipients}</span>}
      </div>

      {/* Subject */}
      <div className="min-w-0 truncate text-[13.5px] text-ink-muted">
        {d.subject || '(no subject)'}
      </div>

      {/* Meta + hover actions */}
      <div className="relative flex items-center gap-2">
        <div className="flex items-center gap-2 transition-opacity duration-[120ms] group-hover:opacity-0">
          <span className="tnum whitespace-nowrap font-mono text-[12px] text-ink-faint">
            {relativeDate(d.updated_at)}
          </span>
        </div>
        <div className="absolute right-0 flex items-center gap-1 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100">
          <button
            type="button"
            className="btn btn-sm btn-ghost p-1.5"
            onClick={onDelete}
            title="Discard draft"
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

function DraftsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export default function Drafts() {
  const [drafts, setDrafts] = useState<api.DraftRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const load = async () => {
    try {
      const d = await api.get<api.DraftRow[]>('/api/drafts');
      setDrafts(d);
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => {
    void load();
    return realtime.subscribe((ev) => {
      if (ev.type === 'draft.upsert' || ev.type === 'draft.delete') void load();
    });
  }, []);

  const deleteDraft = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Discard this draft?')) return;
    setDrafts((cur) => (cur ? cur.filter((d) => d.id !== id) : cur));
    try {
      await api.del(`/api/drafts/${encodeURIComponent(id)}`);
    } catch (err: any) {
      setErr(err?.message || 'delete failed');
      void load();
    }
  };

  const decoded = drafts?.map((d) => {
    const priv = sessionPriv();
    let subject = '';
    if (d.subject_ct_b64 && priv) {
      try { subject = openSealedString(b64uDecode(d.subject_ct_b64), priv); } catch {}
    }
    return { ...d, subject };
  });

  const draftCount = decoded?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          <Link to="/compose" className="btn btn-accent">
            New message
          </Link>
        }
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold text-ink">Drafts</span>
          {draftCount > 0 && (
            <span className="tnum text-[12px] text-ink-faint">{draftCount} draft{draftCount === 1 ? '' : 's'}</span>
          )}
        </div>
      </Toolbar>

      {drafts === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {drafts && drafts.length === 0 && (
        <EmptyState
          title="No drafts"
          hint="Autosave kicks in while you compose."
          icon={<DraftsIcon />}
        />
      )}
      {decoded && decoded.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {decoded.map((d) => (
            <DraftRow
              key={d.id}
              d={d}
              onOpen={() => nav('/compose', { state: { draftId: d.id } })}
              onDelete={(e) => void deleteDraft(e, d.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
