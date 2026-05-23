/**
 * Cmd/Ctrl-K command palette: a centered modal listing app-wide actions
 * (compose, navigate, toggle sidebar, log out, etc.) filtered by a single
 * substring match against label + keywords.
 *
 * Open/close is owned by the parent (Chrome) so the same hotkey that opens
 * it from anywhere can also be re-pressed to close. Actions are passed in
 * as props rather than imported globally because some of them (toggle
 * sidebar, log out, show shortcuts) are bound to Chrome-local state.
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
    // Microtask to ensure the modal is mounted before we focus.
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

  // Clamp the selection any time the filtered list changes length.
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
      className="fixed inset-0 z-50 flex items-start justify-center"
      style={{ paddingTop: 'max(10vh, env(safe-area-inset-top))' }}
      role="dialog"
      aria-modal="true"
      aria-label="command palette"
    >
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 mx-3 w-full max-w-xl bg-paper hair-all">
        <input
          ref={inputRef}
          type="text"
          placeholder="type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          className="w-full"
          style={{ border: 'none', borderBottom: '1px solid #000', padding: '0.625rem 0.75rem' }}
        />
        <ul className="max-h-[60vh] overflow-y-auto">
          {filtered.length === 0 && (
            <li className="text-mute px-3 py-3 text-sm">no matches</li>
          )}
          {filtered.map((a, i) => {
            const selected = i === idx;
            return (
              <li
                key={a.id}
                className={
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 ' +
                  (selected ? 'inv' : 'hover:bg-ink hover:text-paper')
                }
                onMouseMove={() => setIdx(i)}
                onClick={() => {
                  onClose();
                  a.run();
                }}
              >
                <span className="truncate label">{a.label}</span>
                {a.hint && <span className="kbd whitespace-nowrap">{a.hint}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
