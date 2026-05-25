import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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

// Mirrors Labels.tsx — keep these in sync. Hashes a label name to one of
// the system's swatches so the inbox filter chip and the canonical Labels
// page show the same dot color.
const LABEL_SWATCHES = [
  '#5C7A6B', '#7E6B5A', '#6B6A8C', '#8A6B7A', '#555558',
  '#6B7E8C', '#8C7E5A', '#B43A3A', '#C9A12B',
];
function labelColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LABEL_SWATCHES[h % LABEL_SWATCHES.length];
}

export default function Inbox() {
  const [threads, setThreads] = useState<api.ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [query, setQuery] = useState('');
  const [labels, setLabels] = useState<api.Label[]>([]);
  const [labelFilter, setLabelFilter] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);
  const { state } = useApp();
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api.get<api.Label[]>('/api/labels').then(
      (l) => { if (!cancelled) setLabels(l); },
      () => { /* labels optional */ },
    );
    return () => { cancelled = true; };
  }, []);

  const load = async () => {
    try {
      const qs = new URLSearchParams({ limit: '100', inbound_only: '1' });
      if (labelFilter) qs.set('label', labelFilter);
      const t = await api.get<api.ThreadRow[]>(`/api/threads?${qs.toString()}`);
      setThreads(t);
      setSelected(new Set());
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => { void load(); }, [labelFilter]);

  useEffect(() => {
    return realtime.subscribe((ev) => {
      switch (ev.type) {
        case 'message.new':
          if (ev.direction === 'in') void load();
          break;
        case 'thread.delete':
        case 'message.delete':
        case 'message.read':
        case 'message.star':
        case 'message.label':
          void load();
          break;
      }
    });
  }, []);

  const toggleSelected = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(`delete ${ids.length} thread${ids.length === 1 ? '' : 's'}?`)) return;
    setThreads((cur) => (cur ? cur.filter((t) => !selected.has(t.id)) : cur));
    setSelected(new Set());
    await Promise.allSettled(
      ids.map((id) => api.del(`/api/threads/${encodeURIComponent(id)}`)),
    );
    void load();
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

  useEffect(() => {
    if (selectedIdx < 0) return;
    rowRefs.current[selectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const filteredThreads = useMemo(() => {
    if (!threads) return null;
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => {
      const dec = decrypted.get(t.id) ?? {};
      const haystack = [
        t.first_from_addr ?? '',
        ...t.participants,
        t.subject_hint ?? '',
        dec.subject ?? '',
        dec.snippet ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [threads, query, decrypted]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (hasMod(e)) return;
      const list = filteredThreads;
      if (!list || list.length === 0) return;
      if (e.key === 'j') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(list.length - 1, i < 0 ? 0 : i + 1));
      } else if (e.key === 'k') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i < 0 ? 0 : i - 1));
      } else if (e.key === 'Enter') {
        if (selectedIdx >= 0 && selectedIdx < list.length) {
          e.preventDefault();
          nav(`/thread/${list[selectedIdx].id}`);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filteredThreads, selectedIdx, nav]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const t = e.target as Element | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const labelFor = (t: api.ThreadRow): string => {
    if (t.first_direction === 'in') {
      if (t.first_from_name) return t.first_from_name;
      if (t.first_from_addr) return t.first_from_addr;
    }
    const others = t.participants.filter((a) => !ownAddresses.has(a.toLowerCase()));
    const list = others.length > 0 ? others : t.participants;
    if (list.length === 0) return '(no participants)';
    return list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
  };

  const threadCount = filteredThreads?.length ?? threads?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        right={
          /* Search input + filter chips stay mounted regardless of bulk
             selection state — unmounting them would strand the user with
             an active-but-invisible query and break the '/' shortcut. */
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`chip ${labelFilter === '' && !query ? 'chip-active' : ''}`}
              onClick={() => { setLabelFilter(''); setQuery(''); }}
            >
              All
            </button>
            {labels.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`chip ${labelFilter === l.id ? 'chip-active' : ''}`}
                onClick={() => setLabelFilter(labelFilter === l.id ? '' : l.id)}
              >
                <span className="dot" style={{ background: labelColor(l.name) }} />
                {l.name}
              </button>
            ))}
            <div className="relative">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search mail…"
                className="h-7 w-48 rounded-sm border border-border bg-elev px-3 text-[12.5px] text-ink placeholder:text-ink-faint outline-none transition-[border-color,box-shadow] duration-[120ms] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-ring)]"
                aria-label="Search inbox"
              />
            </div>
          </div>
        }
      >
        {selected.size > 0 ? (
          /* Bulk-select takes over the title slot, NOT the controls slot,
             so search/filter remain usable while a selection is active. */
          <div className="flex items-center gap-3">
            <span className="text-[13.5px] font-semibold text-ink">{selected.size} selected</span>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => void bulkDelete()}
            >
              Delete
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-ink">Inbox</span>
            {threadCount > 0 && (
              <span className="tnum text-[12px] text-ink-faint">{threadCount} conversation{threadCount === 1 ? '' : 's'}</span>
            )}
          </div>
        )}
      </Toolbar>

      {threads === null && !err && <Loader />}
      {err && <EmptyState title={err} />}
      {/* Truly empty inbox: no threads at all AND no filter/query active.
          The !labelFilter / !query guards prevent this card from rendering
          on top of the "no matches" card below when a filter is set. */}
      {threads && threads.length === 0 && !query && !labelFilter && (
        <EmptyState title="No conversations" hint="Emails routed to your address will appear here." />
      )}
      {threads && threads.length > 0 && filteredThreads?.length === 0 && (
        <EmptyState
          title={query ? 'No matches' : 'No conversations'}
          hint={query ? <>Nothing in your inbox matches “{query}”.</> : 'Try clearing the filter.'}
        />
      )}
      {threads && threads.length === 0 && (query || labelFilter) && (
        <EmptyState title="No conversations" hint="No threads match this filter." />
      )}

      {threads && filteredThreads && filteredThreads.length > 0 && (
        <ul className="flex-1 overflow-y-auto">
          {filteredThreads.map((t, i) => {
            const dec = decrypted.get(t.id) ?? {};
            const sender = labelFor(t);
            const isKeySelected = i === selectedIdx;
            const isBulkSelected = selected.has(t.id);
            const isUnread = t.unread_count > 0;
            const subject = dec.subject?.trim() || (sessionPriv() ? '(no subject)' : '[encrypted]');
            const preview = dec.snippet?.trim() ?? '';

            return (
              <li
                key={t.id}
                ref={(el) => { rowRefs.current[i] = el; }}
                className={[
                  'group relative grid items-center gap-3.5 px-[18px] py-3 border-b border-border cursor-pointer transition-colors duration-[120ms]',
                  'grid-cols-[32px_minmax(160px,1fr)_minmax(0,2fr)_auto]',
                  isBulkSelected ? 'bg-accent-soft' : isKeySelected ? 'bg-hover' : 'hover:bg-hover',
                ].join(' ')}
                onClick={() => nav(`/thread/${t.id}`)}
              >
                {/* Unread accent dot on left edge */}
                {isUnread && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-accent"
                    aria-label="unread"
                  />
                )}

                {/* Avatar-as-checkbox */}
                <Avatar
                  seed={t.first_from_addr ?? sender}
                  size={32}
                  selected={isBulkSelected}
                  onToggle={() => toggleSelected(t.id)}
                />

                {/* Sender name */}
                <div className={`truncate text-[13.5px] font-medium ${isUnread ? 'text-ink' : 'text-ink-muted'}`}>
                  {sender}
                  {t.message_count > 1 && (
                    <span className="ml-1.5 text-[11px] text-ink-faint">{t.message_count}</span>
                  )}
                </div>

                {/* Subject + preview */}
                <div className="min-w-0 truncate text-[13.5px]">
                  <span className={isUnread ? 'font-semibold text-ink' : 'text-ink-muted'}>
                    {subject}
                  </span>
                  {preview && (
                    <>
                      <span className="mx-1.5 text-ink-faint">·</span>
                      <span className="text-ink-faint">{preview}</span>
                    </>
                  )}
                </div>

                {/* Meta: label + lock + time — hidden on hover, replaced by actions */}
                <div className="relative flex items-center gap-2">
                  <div className={`flex items-center gap-2 transition-opacity duration-[120ms] ${isBulkSelected ? 'opacity-0' : 'group-hover:opacity-0'}`}>
                    {/* Lock icon (encryption indicator) */}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-ink-faint opacity-60 shrink-0"
                      aria-label="end-to-end encrypted"
                    >
                      <rect x="3" y="7" width="10" height="7" rx="1.5" />
                      <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
                    </svg>
                    <span className="tnum text-[12px] text-ink-faint whitespace-nowrap font-mono">
                      {relativeDate(t.last_message_at)}
                    </span>
                  </div>

                  {/* Hover-revealed action cluster */}
                  <div className={`absolute right-0 flex items-center gap-1 transition-opacity duration-[120ms] opacity-0 ${isBulkSelected ? '' : 'group-hover:opacity-100'}`}>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost p-1.5"
                      onClick={(e) => deleteThread(e, t.id)}
                      title="Delete thread"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
