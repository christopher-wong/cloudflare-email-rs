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
import { useEffect, useState } from 'react';
import { useApp } from '@/lib/store';

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

  return (
    <div className="grid h-full" style={{ gridTemplateRows: 'auto 1fr' }}>
      <header className="hair-b flex items-center justify-between gap-2 px-2 py-2 sm:px-4">
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
        <div className="flex items-center gap-4">
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
