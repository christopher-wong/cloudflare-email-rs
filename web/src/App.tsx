import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

import Chrome from '@/components/Chrome';
import Loader from '@/components/Loader';

import Bootstrap from '@/pages/Bootstrap';
import Landing from '@/pages/Landing';
import Login from '@/pages/Login';
import Enroll from '@/pages/Enroll';
import Inbox from '@/pages/Inbox';
import Thread from '@/pages/Thread';
import Compose from '@/pages/Compose';
import Drafts from '@/pages/Drafts';
import Sent from '@/pages/Sent';
import Labels from '@/pages/Labels';
import Settings from '@/pages/Settings';
import Admin from '@/pages/Admin';
import Secrets from '@/pages/Secrets';
import Share from '@/pages/Share';
import SecretView from '@/pages/SecretView';
import Hosted from '@/pages/Hosted';
import HostedView from '@/pages/HostedView';
import NotFound from '@/pages/NotFound';

import { AppContext, useApp, useAppProvider } from '@/lib/store';
import * as realtime from '@/lib/realtime';
import * as notifications from '@/lib/notifications';
import { b64uDecode, openSealedString } from '@/lib/crypto';
import { sessionPriv } from '@/lib/webauthn';

export default function App() {
  const ctx = useAppProvider();
  return (
    <AppContext.Provider value={ctx}>
      <Router />
    </AppContext.Provider>
  );
}

function Router() {
  const { state } = useApp();
  const location = useLocation();
  const nav = useNavigate();

  // We don't actually re-read state here — the Provider above owns it; we
  // just want this hook to react to changes. The body of useAppProvider has
  // its own useEffect that loads /api/admin/status on mount.
  useEffect(() => {
    if (state.loading) return;
    if (state.status?.needs_bootstrap && location.pathname !== '/bootstrap') {
      nav('/bootstrap', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loading, state.status?.needs_bootstrap]);

  if (state.loading) return <Loader label="boot" />;

  // Two completely separate route trees gated on auth state. Rendering
  // one tree at a time eliminates the rank-tie between "/" → Landing and
  // the index route nested inside the Authed layout. The Authed wrapper
  // is no longer needed as a redirect gate; we just don't mount the
  // private routes when there's no `state.me`.
  if (!state.me) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/bootstrap" element={<Bootstrap />} />
        <Route path="/enroll" element={<Enroll />} />
        {/* Public viewer for password-protected secret links. Must be
            reachable without an account — the recipient is typically an
            outside user without one. */}
        <Route path="/s/:token" element={<SecretView />} />
        {/* Public landing page for hosted attachment downloads (large
            files auto-converted from outbound email). Same public
            access posture as /s/:token. */}
        <Route path="/d/:token" element={<HostedView />} />
        {/* Any other path on the public tree bounces to the landing.
            Replaces the old behavior where deep links would hit Authed
            and force a /login redirect. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/bootstrap" element={<Bootstrap />} />
      <Route path="/enroll" element={<Enroll />} />
      <Route path="/login" element={<Login />} />
      {/* Also reachable to signed-in users (no app chrome — the link is
          its own thing). */}
      <Route path="/s/:token" element={<SecretView />} />
      <Route path="/d/:token" element={<HostedView />} />
      <Route element={<AuthedShell />}>
        <Route element={<Chrome />}>
          <Route index element={<Inbox />} />
          <Route path="/thread/:id" element={<Thread />} />
          <Route path="/compose" element={<Compose />} />
          <Route path="/drafts" element={<Drafts />} />
          <Route path="/sent" element={<Sent />} />
          <Route path="/labels" element={<Labels />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/secrets" element={<Secrets />} />
          <Route path="/share" element={<Share />} />
          <Route path="/hosted" element={<Hosted />} />
          <Route path="/admin" element={<Admin />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

/**
 * Layout wrapper for authenticated routes. Hosts global side-effects
 * (realtime → notifications) that should only run while signed in.
 * The "redirect to /login when unauthenticated" responsibility moved
 * up to `Router()` — by the time AuthedShell renders, state.me is
 * guaranteed to be set, so we don't repeat the check here.
 */
function AuthedShell() {
  const { state } = useApp();
  const nav = useNavigate();

  // Global realtime listener: turns inbound message.new events into OS-
  // level Notifications when the tab is backgrounded. Decrypts the
  // subject client-side so the OS toast can show real content; sender
  // address comes pre-plaintext from the worker. Skipped when the user
  // hasn't granted notification permission, or when the document is
  // currently focused (handled inside notifications.show).
  useEffect(() => {
    if (!state.me) return;
    return realtime.subscribe((raw) => {
      if (raw.type !== 'message.new') return;
      // The realtime union's catch-all type widens fields to `unknown`,
      // so coerce the shape here once. The worker schema is fixed in
      // worker/src/email_in.rs::handle_impl notify call.
      const ev = raw as {
        type: 'message.new';
        direction: 'in' | 'out';
        msg_id: string;
        thread_id?: string;
        from_addr?: string;
        from_name?: string | null;
        subject_ct_b64?: string;
      };
      if (ev.direction !== 'in') return;
      let subject = '(no subject)';
      const priv = sessionPriv();
      if (priv && ev.subject_ct_b64) {
        try {
          subject = openSealedString(b64uDecode(ev.subject_ct_b64), priv) || subject;
        } catch { /* keep fallback */ }
      }
      const from = ev.from_name || ev.from_addr || 'new email';
      notifications.show({
        title: from,
        body: subject,
        tag: ev.msg_id,
        onClick: () => {
          if (ev.thread_id) nav(`/thread/${ev.thread_id}`);
          else nav('/');
        },
      });
    });
  }, [state.me, nav]);

  return <Outlet />;
}

import { Outlet } from 'react-router-dom';
