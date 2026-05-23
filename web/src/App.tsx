import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

import Chrome from '@/components/Chrome';
import Loader from '@/components/Loader';

import Bootstrap from '@/pages/Bootstrap';
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
import NotFound from '@/pages/NotFound';

import { AppContext, useAppProvider } from '@/lib/store';

export default function App() {
  const ctx = useAppProvider();
  return (
    <AppContext.Provider value={ctx}>
      <Router />
    </AppContext.Provider>
  );
}

function Router() {
  const { state } = useAppProvider();
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

  return (
    <Routes>
      <Route path="/bootstrap" element={<Bootstrap />} />
      <Route path="/enroll" element={<Enroll />} />
      <Route path="/login" element={<Login />} />
      <Route element={<Authed />}>
        <Route element={<Chrome />}>
          <Route index element={<Inbox />} />
          <Route path="/thread/:id" element={<Thread />} />
          <Route path="/compose" element={<Compose />} />
          <Route path="/drafts" element={<Drafts />} />
          <Route path="/sent" element={<Sent />} />
          <Route path="/labels" element={<Labels />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin" element={<Admin />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function Authed() {
  const { state } = useAppProvider();
  if (!state.me) return <Navigate to="/login" replace />;
  // Just render the nested routes; Chrome is the layout.
  // (React Router treats this <Authed/> as a layout route so children render
  // via Outlet inside Chrome.)
  return <RouteOutlet />;
}

import { Outlet } from 'react-router-dom';
function RouteOutlet() { return <Outlet />; }
