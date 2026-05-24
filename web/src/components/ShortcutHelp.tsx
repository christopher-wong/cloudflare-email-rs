/**
 * The `?` cheatsheet modal. Static reference list of every shortcut Chrome
 * and the list views bind. Kept in sync by hand — there is no introspection
 * of the actual key handlers.
 */

import { useEffect } from 'react';

interface Row {
  keys: string[];
  desc: string;
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Global',
    rows: [
      { keys: ['⌘', 'K'], desc: 'Open command palette' },
      { keys: ['Ctrl', 'K'], desc: 'Open command palette (Windows / Linux)' },
      { keys: ['?'], desc: 'Show this help' },
      { keys: ['c'], desc: 'Compose new email' },
      { keys: ['['], desc: 'Toggle sidebar' },
      { keys: ['Esc'], desc: 'Close dialog / drawer' },
    ],
  },
  {
    title: 'Navigate',
    rows: [
      { keys: ['g', 'i'], desc: 'Go to inbox' },
      { keys: ['g', 'd'], desc: 'Go to drafts' },
      { keys: ['g', 's'], desc: 'Go to sent' },
      { keys: ['g', 'l'], desc: 'Go to labels' },
      { keys: ['g', ','], desc: 'Go to settings' },
    ],
  },
  {
    title: 'List view',
    rows: [
      { keys: ['j'], desc: 'Next row' },
      { keys: ['k'], desc: 'Previous row' },
      { keys: ['Enter'], desc: 'Open selected thread' },
    ],
  },
];

export default function ShortcutHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="keyboard shortcuts"
    >
      {/* Scrim */}
      <div
        className="scrim"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative z-50 w-full max-w-[440px] animate-zoom-in">
        <div className="card shadow-pop">
          {/* Header */}
          <div className="card-head justify-between">
            <h2 className="text-[15px] font-semibold text-ink">Keyboard shortcuts</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
            >
              Close
            </button>
          </div>

          {/* Shortcut rows */}
          <div className="card-body max-h-[60vh] overflow-y-auto">
            {GROUPS.map((g) => (
              <section key={g.title} className="mb-5 last:mb-0">
                <div className="eyebrow mb-2">{g.title}</div>
                <ul className="flex flex-col gap-0.5">
                  {g.rows.map((r, i) => (
                    <li
                      key={i}
                      className="grid grid-cols-[auto_1fr] items-center gap-4 py-1.5"
                    >
                      <span className="flex items-center gap-1 min-w-[60px]">
                        {r.keys.map((k, j) => (
                          <span key={j} className="kbd">{k}</span>
                        ))}
                      </span>
                      <span className="text-[13px] text-ink-muted">{r.desc}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
