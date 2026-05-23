/** A dead-simple global store. No external dep. */

import { createContext, useContext, useEffect, useState } from 'react';
import * as api from './api';
import * as realtime from './realtime';
import { sessionClearPriv } from './webauthn';

export interface User {
  id: string;
  handle: string;
  display_name: string | null;
  is_admin: boolean;
  addresses: string[];
  /** Cleartext X25519 pubkey — base64url. Used for self-sealing drafts. */
  pub_key_b64: string | null;
}

export interface AppState {
  status: api.StatusResp | null;
  me: User | null;
  loading: boolean;
}

interface Ctx {
  state: AppState;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setMe: (u: User | null) => void;
}

export const AppContext = createContext<Ctx>(null as any);
export const useApp = () => useContext(AppContext);

export function useAppProvider(): Ctx {
  const [state, setState] = useState<AppState>({
    status: null,
    me: null,
    loading: true,
  });

  const refresh = async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const status = await api.get<api.StatusResp>('/api/admin/status');
      let me: User | null = null;
      if (status.is_authed) {
        try {
          me = await api.get<User>('/api/me');
        } catch {
          me = null;
        }
      }
      setState({ status, me, loading: false });
      if (me) realtime.start(); else realtime.stop();
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  };

  const logout = async () => {
    sessionClearPriv();
    realtime.stop();
    try {
      await api.post('/api/auth/logout', {});
    } catch {}
    setState((s) => ({ ...s, me: null }));
  };

  const setMe = (u: User | null) => setState((s) => ({ ...s, me: u }));

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, refresh, logout, setMe };
}
