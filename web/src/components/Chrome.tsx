/**
 * The persistent app frame: two-column grid (232px sidebar + fluid main).
 * On mobile the sidebar becomes an overlay drawer sliding in from the left.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  [logo] bmail                  [search ⌘K]       [log out]   │  ← 56px topbar
 *   ├──────────────┬─────────────────────────────────────────────────┤
 *   │  Compose  C  │                                                 │
 *   │  ─────────── │              <Outlet />                        │
 *   │  Inbox       │                                                 │
 *   │  Drafts      │                                                 │
 *   │  Sent        │                                                 │
 *   │  ─────────── │                                                 │
 *   │  LABELS      │                                                 │
 *   │  ─────────── │                                                 │
 *   │  Settings    │                                                 │
 *   │  [avatar] Me │                                                 │
 *   └──────────────┴─────────────────────────────────────────────────┘
 */

import { Link, NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState, useMemo, type ReactNode } from 'react';
import { useApp } from '@/lib/store';
import { isEditableTarget, isModK, hasMod } from '@/lib/shortcuts';
import { sessionPriv, unlock } from '@/lib/webauthn';
import Avatar from '@/components/Avatar';
import CommandPalette, { type PaletteAction } from '@/components/CommandPalette';
import ShortcutHelp from '@/components/ShortcutHelp';

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

  const [desktopOpen, setDesktopOpen] = useState<boolean>(loadSidebarPref);
  const [mobileOpen, setMobileOpen] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PREF_KEY, desktopOpen ? '1' : '0');
    } catch {
      /* localStorage unavailable — pref won't persist */
    }
  }, [desktopOpen]);

  // Close the mobile drawer on every navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Escape closes the mobile drawer.
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

  // On desktop, toggle the persistent sidebar preference.
  // On mobile, toggle the overlay drawer.
  const onToggleSidebar = () => {
    if (window.matchMedia(DESKTOP_MQ).matches) {
      setDesktopOpen((v) => !v);
    } else {
      setMobileOpen((v) => !v);
    }
  };

  // Global keyboard shortcuts.
  const gPrefixRef = useRef<{ until: number } | null>(null);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Cmd/Ctrl-K always wins — even from inside a text field.
      if (isModK(e)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      // Everything else is suppressed while a modal is open or while typing.
      if (paletteOpen || helpOpen) return;
      if (isEditableTarget(e.target)) return;

      // g-prefix sequences expire after 1s.
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
        }
      }

      if (hasMod(e)) return;

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
      { id: 'compose', label: 'Compose new email', hint: 'c', keywords: ['new', 'write', 'mail'], run: () => nav('/compose') },
      { id: 'go-inbox', label: 'Go to inbox', hint: 'g i', keywords: ['inbox', 'mail'], run: () => nav('/') },
      { id: 'go-drafts', label: 'Go to drafts', hint: 'g d', keywords: ['drafts'], run: () => nav('/drafts') },
      { id: 'go-sent', label: 'Go to sent', hint: 'g s', keywords: ['sent'], run: () => nav('/sent') },
      { id: 'go-labels', label: 'Go to labels', hint: 'g l', keywords: ['labels', 'tags'], run: () => nav('/labels') },
      { id: 'go-settings', label: 'Go to settings', hint: 'g ,', keywords: ['settings', 'preferences'], run: () => nav('/settings') },
      { id: 'toggle-sidebar', label: 'Toggle sidebar', hint: '[', keywords: ['nav', 'menu', 'collapse'], run: onToggleSidebar },
      { id: 'shortcuts', label: 'Show keyboard shortcuts', hint: '?', keywords: ['help', 'keys'], run: () => setHelpOpen(true) },
      { id: 'logout', label: 'Log out', keywords: ['signout', 'exit'], run: () => { void onLogout(); } },
    ];
    if (state.me?.is_admin) {
      acts.splice(6, 0, {
        id: 'go-admin',
        label: 'Go to admin',
        keywords: ['admin'],
        run: () => nav('/admin'),
      });
    }
    return acts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.me?.is_admin]);

  const primaryAddress = state.me?.addresses?.[0] ?? state.me?.handle ?? '';
  const displayName = state.me?.handle ?? primaryAddress.split('@')[0] ?? '';

  return (
    <div className={`grid h-full grid-cols-1 ${desktopOpen ? 'md:grid-cols-[232px_1fr]' : ''}`}>
      {/* Mobile scrim */}
      {mobileOpen && (
        <div
          className="scrim md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <nav
        aria-label="navigation"
        className={[
          'absolute inset-y-0 left-0 z-30 flex w-[232px] flex-col border-r border-border bg-bg overflow-y-auto',
          'transition-transform duration-150 ease-out',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'md:relative md:translate-x-0',
          desktopOpen ? 'md:flex' : 'md:hidden',
        ].join(' ')}
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)' }}
      >
        <SidebarContents
          state={state}
          primaryAddress={primaryAddress}
          displayName={displayName}
          onLogout={onLogout}
          onCompose={() => nav('/compose')}
        />
      </nav>

      {/* Main column */}
      <div className="flex min-w-0 flex-col overflow-hidden">
        {/* Topbar */}
        <header
          className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80 px-[22px]"
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingRight: 'env(safe-area-inset-right)' }}
        >
          {/* Hamburger (mobile) / collapse button (desktop) */}
          <button
            type="button"
            aria-label="toggle navigation"
            aria-expanded={mobileOpen || desktopOpen}
            onClick={onToggleSidebar}
            className="btn btn-ghost btn-sm shrink-0 md:hidden"
          >
            <HamburgerIcon open={mobileOpen} />
          </button>
          <button
            type="button"
            aria-label="toggle navigation"
            aria-expanded={desktopOpen}
            onClick={onToggleSidebar}
            className="btn btn-ghost btn-sm shrink-0 hidden md:inline-flex"
          >
            <HamburgerIcon open={false} />
          </button>

          {/* Address chip — shown when sidebar is hidden */}
          {!desktopOpen && primaryAddress && (
            <span className="chip hidden md:inline-flex font-mono text-[12px]">{primaryAddress}</span>
          )}

          <div className="flex-1" />

          {/* Search / command palette trigger */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden sm:flex items-center gap-2 h-[34px] px-3 rounded-md border border-border bg-elev text-ink-faint text-[13px] hover:border-border-strong hover:text-ink-muted transition-colors duration-[120ms] w-[320px]"
            aria-label="open command palette"
          >
            <SearchIcon />
            <span className="flex-1 text-left">Search mail, people, threads…</span>
            <span className="kbd">⌘K</span>
          </button>

          {/* Right actions */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="btn btn-ghost btn-sm sm:hidden"
            aria-label="open command palette"
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void onLogout()}
          >
            Log out
          </button>
        </header>

        {/* Routed content */}
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <UnlockGate>
            <Outlet />
          </UnlockGate>
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

// ---------------------------------------------------------------------------
// Sidebar contents
// ---------------------------------------------------------------------------

interface SidebarContentsProps {
  state: ReturnType<typeof useApp>['state'];
  primaryAddress: string;
  displayName: string;
  onLogout: () => void;
  onCompose: () => void;
}

function SidebarContents({ state, primaryAddress, displayName, onLogout, onCompose }: SidebarContentsProps) {
  const domain = primaryAddress.includes('@') ? primaryAddress.split('@')[1] : 'private email';

  return (
    <div className="flex flex-col h-full px-[14px] py-[18px] gap-0">
      {/* Brand block */}
      <div className="flex items-center gap-2.5 mb-5">
        <div className="relative shrink-0 w-7 h-7 rounded-[8px] bg-ink text-white grid place-items-center font-semibold text-[13px] select-none">
          b
          <span className="absolute -right-0.5 -bottom-0.5 w-[9px] h-[9px] rounded-full bg-accent border-2 border-bg" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-[14px] text-ink leading-tight tracking-[-0.01em]">bmail</div>
          <div className="text-[11px] text-ink-faint leading-tight font-mono">{domain}</div>
        </div>
      </div>

      {/* Compose button */}
      <button
        type="button"
        onClick={onCompose}
        className="btn btn-primary w-full justify-between mb-4"
      >
        <span>Compose</span>
        <span className="kbd text-white/70 border-white/20 bg-white/10">C</span>
      </button>

      {/* Primary nav */}
      <div className="flex flex-col gap-0.5">
        <PrimaryNavItem to="/" end label="Inbox" icon={<InboxIcon />} />
        <PrimaryNavItem to="/drafts" label="Drafts" icon={<DraftsIcon />} />
        <PrimaryNavItem to="/sent" label="Sent" icon={<SentIcon />} />
      </div>

      {/* Sharing section */}
      <div className="flex flex-col gap-0.5 mt-4">
        <div className="eyebrow px-[10px] mb-1.5">Sharing</div>
        <PrimaryNavItem to="/share" label="Share" icon={<ShareIcon />} />
        <PrimaryNavItem to="/secrets" label="Secrets" icon={<SecretsIcon />} />
        <PrimaryNavItem to="/hosted" label="Hosted" icon={<HostedIcon />} />
      </div>

      <div className="flex-1" />

      {/* Account section */}
      <div className="flex flex-col gap-0.5 mt-4">
        <div className="eyebrow px-[10px] mb-1.5">Account</div>
        <PrimaryNavItem to="/settings" label="Settings" icon={<SettingsIcon />} />
        {state.me?.is_admin && (
          <PrimaryNavItem to="/admin" label="Admin" icon={<AdminIcon />} />
        )}
      </div>

      {/* Account block */}
      <div className="mt-3 border-t border-border pt-3">
        <NavLink
          to="/settings"
          className="flex items-center gap-2.5 px-[10px] py-2 rounded-sm hover:bg-hover transition-colors duration-[120ms]"
        >
          <Avatar seed={primaryAddress} size={28} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink leading-tight truncate">{displayName}</div>
            <div className="text-[11.5px] text-ink-faint font-mono leading-tight truncate">{primaryAddress}</div>
          </div>
        </NavLink>
        <button
          type="button"
          onClick={onLogout}
          className="btn btn-ghost btn-sm w-full justify-start mt-1"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

function PrimaryNavItem({ to, end, label, icon }: { to: string; end?: boolean; label: string; icon: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        'nav-item' + (isActive ? ' is-active' : '')
      }
    >
      <span className="shrink-0 text-ink-faint">{icon}</span>
      {label}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// Inline SVG icons (stroke, 16×16 viewport, 1.5px stroke)
// ---------------------------------------------------------------------------

function HamburgerIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <line x1="2" y1="2" x2="13" y2="13" />
        <line x1="13" y1="2" x2="2" y2="13" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <line x1="1.5" y1="3" x2="13.5" y2="3" />
      <line x1="1.5" y1="7.5" x2="13.5" y2="7.5" />
      <line x1="1.5" y1="12" x2="13.5" y2="12" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function DraftsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function SentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

function SecretsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function HostedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function FingerprintIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 17.5c1.18.8 3.46 1.87 6.26 2.31" />
      <path d="M20 10c.49 1.88.75 3.87.75 6" />
      <path d="M22 12a9.99 9.99 0 0 0-3.82-7.89" />
      <path d="M7.37 10.4a4 4 0 0 1 7.32-1.42" />
      <path d="M5.45 17.38A14.83 14.83 0 0 1 5 14" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Unlock gate
// ---------------------------------------------------------------------------

/**
 * Replaces the routed content when the user is signed in but the in-memory
 * X25519 private key is missing. The sidebar / chrome remain rendered so
 * navigation, logout, and the command palette still work.
 */
// Routes that don't read user mail and therefore don't need the X25519
// priv. Visiting these while locked should NOT trigger the unlock prompt
// — that was blocking the user from creating a new share or secret link
// before they'd unlocked the session.
const UNGATED_PATHS = new Set<string>(['/share', '/secrets', '/hosted', '/settings', '/admin']);

function UnlockGate({ children }: { children: ReactNode }) {
  const { state } = useApp();
  const location = useLocation();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  void tick;

  if (!state.me) return <>{children}</>;
  if (sessionPriv()) return <>{children}</>;
  if (UNGATED_PATHS.has(location.pathname)) return <>{children}</>;

  const doUnlock = async () => {
    setBusy(true);
    setErr(null);
    try {
      await unlock();
      setTick((t) => t + 1);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unlock failed';
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="card w-full max-w-sm animate-zoom-in">
        <div className="card-body flex flex-col items-center gap-5 text-center py-10">
          {/* Icon */}
          <div className="w-14 h-14 rounded-full border border-border bg-bg grid place-items-center text-ink-faint">
            <FingerprintIcon />
          </div>

          {/* Copy */}
          <div>
            <div className="eyebrow mb-2">bmail · locked</div>
            <h1 className="text-[26px] font-semibold tracking-tight leading-[1.15] text-ink">
              Unlock to read
            </h1>
          </div>
          <p className="text-[13.5px] text-ink-muted max-w-[28ch]">
            Your subjects, bodies, and attachments are encrypted. Use your passkey to decrypt this session — no full sign-in needed.
          </p>

          {/* Action */}
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy}
            onClick={() => void doUnlock()}
          >
            {busy ? 'Unlocking…' : 'Unlock with passkey'}
          </button>

          {/* Error */}
          {err && (
            <div className="w-full rounded-sm border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[12.5px] text-danger text-left">
              {err}
            </div>
          )}

          {/* Recovery link */}
          <p className="text-[12px] text-ink-faint">
            No passkey on this device?{' '}
            <Link to="/login" className="link">Use the full sign-in flow</Link>
            {' '}or unlock with your recovery phrase.
          </p>
        </div>
      </div>
    </div>
  );
}
