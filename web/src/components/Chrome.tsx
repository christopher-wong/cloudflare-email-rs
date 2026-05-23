/**
 * The persistent app frame: a square edge-to-edge layout with a sidebar of
 * mailboxes/labels on the left, a header strip on top with the brand mark
 * and the user's address, and the routed view filling the rest.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ☰  cfemail · christopher@middleseat.vc               · log out│
 *   ├─────────┬────────────────────────────────────────────────────┤
 *   │ INBOX   │                                                    │
 *   │ DRAFTS  │              <Outlet />                            │
 *   │ SENT    │                                                    │
 *   │ ──────  │                                                    │
 *   │ LABELS  │                                                    │
 *   └─────────┴────────────────────────────────────────────────────┘
 *
 * The sidebar is collapsible. On md+ screens it sits in-flow as a grid
 * column and the hamburger toggles a persisted "show/hide" preference. On
 * smaller screens it is fully out of flow and slides in from the left as
 * an overlay drawer with a tap-to-dismiss backdrop, the same hamburger
 * driving an ephemeral open/closed state that resets on every navigation.
 */

import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useApp } from '@/lib/store';
import { isEditableTarget, isModK, hasMod } from '@/lib/shortcuts';
import CommandPalette, { type PaletteAction } from '@/components/CommandPalette';
import ShortcutHelp from '@/components/ShortcutHelp';

interface NavItem {
  to: string;
  label: string;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'inbox' },
  { to: '/drafts', label: 'drafts' },
  { to: '/sent', label: 'sent' },
  { to: '/labels', label: 'labels' },
  { to: '/settings', label: 'settings' },
  { to: '/admin', label: 'admin', adminOnly: true },
];

const SIDEBAR_PREF_KEY = 'cfemail.sidebar.open';
const DESKTOP_MQ = '(min-width: 768px)';

function loadSidebarPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(SIDEBAR_PREF_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

export default function Chrome() {
  const { state, logout } = useApp();
  const nav = useNavigate();
  const location = useLocation();

  // `desktopOpen` is the persisted show/hide preference used on md+ screens.
  // `mobileOpen` is an ephemeral overlay-drawer state used on <md screens; it
  // always resets on navigation (see effect below) so a route change doubles
  // as drawer dismissal.
  const [desktopOpen, setDesktopOpen] = useState<boolean>(loadSidebarPref);
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PREF_KEY, desktopOpen ? '1' : '0');
    } catch {
      /* localStorage unavailable (private mode, etc.) — pref just won't persist */
    }
  }, [desktopOpen]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const onLogout = async () => {
    await logout();
    nav('/login');
  };

  // One button, two meanings: on desktop it flips the persistent
  // preference; on mobile it flips the overlay drawer. We branch at click
  // time on a media query so the same icon serves both, with the
  // semantic split kept in this single place.
  const onToggleSidebar = () => {
    if (window.matchMedia(DESKTOP_MQ).matches) {
      setDesktopOpen((v) => !v);
    } else {
      setMobileOpen((v) => !v);
    }
  };

  const items = NAV.filter((n) => !n.adminOnly || state.me?.is_admin);

  // Global keyboard shortcuts. The handler is intentionally a single
  // useEffect so all the bookkeeping (g-prefix state, "in editable" gate,
  // modal gate) lives in one place. A ref holds the prefix because we
  // don't want every keystroke to re-render Chrome.
  const gPrefixRef = useRef<{ until: number } | null>(null);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl-K always wins — even from inside a text field, it should
      // pop the palette. The palette's own input field handles Esc/Enter
      // internally once it's open.
      if (isModK(e)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      // Everything else is suppressed while a modal is open (the modal
      // owns the keyboard) or while the user is typing somewhere.
      if (paletteOpen || helpOpen) return;
      if (isEditableTarget(e.target)) return;

      // Sequence shortcuts: g followed by another letter within 1s. The
      // prefix expires automatically.
      const now = Date.now();
      const prefix = gPrefixRef.current;
      if (prefix && now < prefix.until) {
        gPrefixRef.current = null;
        if (hasMod(e)) return;
        switch (e.key) {
          case 'i': e.preventDefault(); nav('/'); return;
          case 'd': e.preventDefault(); nav('/drafts'); return;
          case 's': e.preventDefault(); nav('/sent'); return;
          case 'l': e.preventDefault(); nav('/labels'); return;
          case ',': e.preventDefault(); nav('/settings'); return;
          // Unknown follow-up: fall through and let the key behave normally.
        }
      }

      if (hasMod(e)) return; // single-letter shortcuts only fire bare

      switch (e.key) {
        case '?':
          e.preventDefault();
          setHelpOpen(true);
          return;
        case 'c':
          e.preventDefault();
          nav('/compose');
          return;
        case '[':
          e.preventDefault();
          onToggleSidebar();
          return;
        case 'g':
          e.preventDefault();
          gPrefixRef.current = { until: now + 1000 };
          return;
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, helpOpen]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const acts: PaletteAction[] = [
      { id: 'compose', label: 'compose new email', hint: 'c', keywords: ['new', 'write', 'mail'], run: () => nav('/compose') },
      { id: 'go-inbox', label: 'go to inbox', hint: 'g i', keywords: ['inbox', 'mail'], run: () => nav('/') },
      { id: 'go-drafts', label: 'go to drafts', hint: 'g d', keywords: ['drafts'], run: () => nav('/drafts') },
      { id: 'go-sent', label: 'go to sent', hint: 'g s', keywords: ['sent'], run: () => nav('/sent') },
      { id: 'go-labels', label: 'go to labels', hint: 'g l', keywords: ['labels', 'tags'], run: () => nav('/labels') },
      { id: 'go-settings', label: 'go to settings', hint: 'g ,', keywords: ['settings', 'preferences'], run: () => nav('/settings') },
      { id: 'toggle-sidebar', label: 'toggle sidebar', hint: '[', keywords: ['nav', 'menu', 'collapse'], run: onToggleSidebar },
      { id: 'shortcuts', label: 'show keyboard shortcuts', hint: '?', keywords: ['help', 'keys'], run: () => setHelpOpen(true) },
      { id: 'logout', label: 'log out', keywords: ['signout', 'exit'], run: () => { void onLogout(); } },
    ];
    if (state.me?.is_admin) {
      acts.splice(6, 0, {
        id: 'go-admin',
        label: 'go to admin',
        keywords: ['admin'],
        run: () => nav('/admin'),
      });
    }
    return acts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.me?.is_admin]);

  return (
    <div className="grid h-full" style={{ gridTemplateRows: 'auto 1fr' }}>
      <header className="hair-b sticky top-0 z-30 flex items-center justify-between gap-2 bg-white px-2 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            aria-label="toggle navigation"
            aria-expanded={mobileOpen || desktopOpen}
            onClick={onToggleSidebar}
            className="btn btn-ghost"
            style={{ padding: '0.375rem 0.5rem', lineHeight: 0 }}
          >
            <Hamburger open={mobileOpen} />
          </button>
          <span className="font-bold tracking-widest">CFEMAIL</span>
          <span className="text-mute hidden sm:inline">·</span>
          <span className="hidden truncate text-sm sm:inline">
            {state.me?.addresses[0] ?? state.me?.handle}
          </span>
          {state.me?.is_admin && (
            <span className="chip chip-inv hidden sm:inline-flex">ADMIN</span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            className="btn-ghost btn label hidden items-center gap-2 sm:inline-flex"
            onClick={() => setPaletteOpen(true)}
            title="open command palette"
          >
            <span>cmd</span>
            <span className="kbd">⌘K</span>
          </button>
          <button className="btn-ghost btn label" onClick={onLogout}>
            log out
          </button>
        </div>
      </header>

      <div
        className={
          'relative grid h-full overflow-hidden ' +
          (desktopOpen ? 'md:grid-cols-[12rem_1fr]' : '')
        }
      >
        {/* Backdrop: only present on small screens when the drawer is open. */}
        {mobileOpen && (
          <div
            className="absolute inset-0 z-20 md:hidden"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar — single element that flips between an out-of-flow overlay
            drawer on mobile and an in-flow grid column on md+. The `absolute`
            base + `md:relative` reset is what powers the dual behavior; the
            grid columns above only allocate space when desktopOpen is true. */}
        <nav
          aria-label="navigation"
          className={
            'absolute inset-y-0 left-0 z-30 w-48 overflow-y-auto bg-paper py-2 hair-r ' +
            'transition-transform duration-150 ease-out ' +
            (mobileOpen ? 'translate-x-0' : '-translate-x-full') +
            ' md:relative md:translate-x-0 md:bg-transparent ' +
            (desktopOpen ? 'md:block' : 'md:hidden')
          }
        >
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                'block label px-4 py-3 md:py-2 ' +
                (isActive ? 'inv' : 'hover:bg-ink hover:text-paper')
              }
              style={{ borderBottom: 'none' }}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        <main className="overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function Hamburger({ open }: { open: boolean }) {
  // Two rasterized icons rather than a CSS-animated morph: simpler, and
  // crisp at any zoom level given the brutalist 1px-stroke aesthetic.
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <line x1="2" y1="2" x2="14" y2="14" stroke="currentColor" strokeWidth="2" />
        <line x1="14" y1="2" x2="2" y2="14" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2" width="14" height="2" fill="currentColor" />
      <rect x="1" y="7" width="14" height="2" fill="currentColor" />
      <rect x="1" y="12" width="14" height="2" fill="currentColor" />
    </svg>
  );
}
