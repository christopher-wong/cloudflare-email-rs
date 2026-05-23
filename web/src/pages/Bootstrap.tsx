/**
 * First-run page. Visible only when no users exist yet (status.needs_bootstrap
 * = true). Creates the first user — automatically admin — by posting to
 * /api/bootstrap to mint an admin invite, then redirecting to /enroll with
 * that token.
 */

import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/lib/store';
import * as api from '@/lib/api';

export default function Bootstrap() {
  const { state } = useApp();
  const nav = useNavigate();
  const domain = state.status?.primary_domain ?? '';
  const [handle, setHandle] = useState('admin');
  const [localPart, setLocalPart] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const addr = `${localPart}@${domain}`;
      const { invite_token } = await api.post<{ invite_token: string }>(
        '/api/bootstrap',
        { handle, addresses: [addr] },
      );
      nav(`/enroll?token=${encodeURIComponent(invite_token)}`, { replace: true });
    } catch (e: any) {
      setErr(e.message || 'bootstrap failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-xl flex-col gap-6 p-8">
      <header>
        <div className="label">BMAIL · bootstrap</div>
        <h1 className="mt-1 text-2xl font-bold">First user</h1>
        <p className="text-mute mt-2 text-sm">
          No users exist yet on this instance. Create the first one — they will
          be an admin and can invite others. Make sure your passkey-capable
          device is ready.
        </p>
      </header>

      <form onSubmit={submit} className="hair-all">
        <div className="field">
          <div className="field-label">handle</div>
          <input
            className="field-value w-full border-0"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <div className="field-label">address</div>
          <div className="field-value flex w-full items-stretch">
            <input
              className="w-full border-0"
              placeholder="christopher"
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
              required
              autoFocus
            />
            <span className="text-mute self-center pl-2">@{domain}</span>
          </div>
        </div>

        {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}

        <div className="hair-t flex items-center justify-between p-3">
          <span className="text-mute text-xs">
            you'll register a passkey on the next screen
          </span>
          <button type="submit" className="btn btn-primary label" disabled={busy}>
            {busy ? 'creating…' : 'continue ▸'}
          </button>
        </div>
      </form>
    </div>
  );
}
