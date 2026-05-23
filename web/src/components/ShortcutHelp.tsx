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
    title: 'global',
    rows: [
      { keys: ['⌘', 'K'], desc: 'open command palette' },
      { keys: ['Ctrl', 'K'], desc: 'open command palette (windows/linux)' },
      { keys: ['?'], desc: 'show this help' },
      { keys: ['c'], desc: 'compose new email' },
      { keys: ['['], desc: 'toggle sidebar' },
      { keys: ['Esc'], desc: 'close dialog / drawer' },
    ],
  },
  {
    title: 'navigate',
    rows: [
      { keys: ['g', 'i'], desc: 'go to inbox' },
      { keys: ['g', 'd'], desc: 'go to drafts' },
      { keys: ['g', 's'], desc: 'go to sent' },
      { keys: ['g', 'l'], desc: 'go to labels' },
      { keys: ['g', ','], desc: 'go to settings' },
    ],
  },
  {
    title: 'list view',
    rows: [
      { keys: ['j'], desc: 'next row' },
      { keys: ['k'], desc: 'previous row' },
      { keys: ['Enter'], desc: 'open selected thread' },
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
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="keyboard shortcuts"
    >
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 mx-3 max-h-[80vh] w-full max-w-md overflow-y-auto bg-paper hair-all">
        <div className="hair-b flex items-center justify-between px-3 py-2">
          <span className="label">keyboard shortcuts</span>
          <button className="btn-ghost btn label" onClick={onClose}>
            close
          </button>
        </div>
        <div className="px-3 py-2">
          {GROUPS.map((g) => (
            <section key={g.title} className="mb-3 last:mb-0">
              <div className="label text-mute mb-1">{g.title}</div>
              <ul>
                {g.rows.map((r, i) => (
                  <li
                    key={i}
                    className="grid grid-cols-[auto_1fr] items-center gap-3 py-1"
                  >
                    <span className="flex items-center gap-1">
                      {r.keys.map((k, j) => (
                        <span key={j} className="kbd">{k}</span>
                      ))}
                    </span>
                    <span className="text-sm">{r.desc}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
