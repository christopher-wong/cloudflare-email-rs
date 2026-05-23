/**
 * The persistent app frame: a square edge-to-edge layout with a sidebar of
 * mailboxes/labels on the left, a header strip on top with the brand mark
 * and the user's address, and the routed view filling the rest.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ cfemail · christopher@middleseat.vc                  · log out│
 *   ├─────────┬────────────────────────────────────────────────────┤
 *   │ INBOX   │                                                    │
 *   │ DRAFTS  │              <Outlet />                            │
 *   │ SENT    │                                                    │
 *   │ ──────  │                                                    │
 *   │ LABELS  │                                                    │
 *   └─────────┴────────────────────────────────────────────────────┘
 */

import { NavLink, Outlet, useNavigate } from 'react-router-dom';
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

export default function Chrome() {
  const { state, logout } = useApp();
  const nav = useNavigate();

  const onLogout = async () => {
    await logout();
    nav('/login');
  };

  return (
    <div className="grid h-full" style={{ gridTemplateRows: 'auto 1fr' }}>
      <header className="hair-b flex items-center justify-between px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className="font-bold tracking-widest">CFEMAIL</span>
          <span className="text-mute">·</span>
          <span className="text-sm">{state.me?.addresses[0] ?? state.me?.handle}</span>
          {state.me?.is_admin && (
            <span className="chip chip-inv">ADMIN</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <button className="btn-ghost btn label" onClick={onLogout}>
            log out
          </button>
        </div>
      </header>

      <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: '12rem 1fr' }}>
        <nav className="hair-r overflow-y-auto py-2">
          {NAV.filter((n) => !n.adminOnly || state.me?.is_admin).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                'block label px-4 py-2 ' +
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
