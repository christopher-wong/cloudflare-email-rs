/**
 * Cmd/Ctrl-K command palette: a scrim-backed modal pinned at 12vh from the
 * top. Actions are passed in as props rather than imported globally because
 * some of them (toggle sidebar, log out, show shortcuts) are bound to
 * Chrome-local state.
 *
 * Behavior:
 *   - Fuzzy substring match against label + keywords.
 *   - Arrow-key + Enter navigation; Escape / scrim-click closes.
 *   - Selection resets on open; clamps when the filtered list shrinks.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteAction {
  id: string;
  label: string;
  /** Extra search terms not visible in the label. */
  keywords?: string[];
  /** Optional shortcut hint shown on the right of the row. */
  hint?: string;
  run: () => void;
}

export default function CommandPalette({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query/selection on open and pull focus into the input.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((a) => {
      const hay = (a.label + ' ' + (a.keywords?.join(' ') ?? '')).toLowerCase();
      return hay.includes(needle);
    });
  }, [q, actions]);

  // Clamp the selection when the filtered list changes length.
  useEffect(() => {
    if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, idx]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = filtered[idx];
      if (a) {
        onClose();
        a.run();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="command palette"
    >
      {/* Scrim */}
      <div
        className="scrim"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — pinned at 12vh from the top, centered horizontally */}
      <div
        className="relative z-50 mx-auto mt-[12vh] w-full max-w-[560px] px-4"
        style={{ maxHeight: 'calc(100vh - 14vh)' }}
      >
        <div className="rounded-lg bg-elev shadow-pop overflow-hidden animate-zoom-in">
          {/* Search input */}
          <div className="flex items-center gap-2.5 px-3.5 border-b border-border h-11">
            <SearchIcon />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search commands…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              className="flex-1 bg-transparent outline-none text-[13.5px] text-ink placeholder:text-ink-faint"
            />
          </div>

          {/* Results */}
          <ul className="max-h-[min(60vh,380px)] overflow-y-auto py-1.5">
            {filtered.length === 0 && (
              <li className="px-3.5 py-3 text-[13px] text-ink-faint">No results</li>
            )}
            {filtered.map((a, i) => {
              const selected = i === idx;
              return (
                <li
                  key={a.id}
                  className={[
                    'flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2 mx-1.5 rounded-sm',
                    selected
                      ? 'bg-accent-soft text-accent-ink'
                      : 'text-ink-muted hover:bg-hover hover:text-ink',
                  ].join(' ')}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => {
                    onClose();
                    a.run();
                  }}
                >
                  <span className="truncate text-[13.5px] font-medium">{a.label}</span>
                  {a.hint && <span className="kbd shrink-0">{a.hint}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-ink-faint"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
