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
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-12">
      <div className="card w-full max-w-[480px]">
        <div className="card-head">
          <div>
            <div className="eyebrow mb-1">welcome</div>
            <h1 className="text-[26px] font-semibold tracking-tight text-ink leading-tight">
              Set up bmail
            </h1>
          </div>
        </div>

        <div className="card-body border-b border-border">
          <p className="text-[13.5px] text-ink-muted leading-relaxed">
            No users exist yet on this instance. Create the first account — it
            will be an admin and can invite others. Make sure your
            passkey-capable device is ready.
          </p>
        </div>

        <form onSubmit={submit}>
          <div>
            <div className="field-row">
              <label className="field-label" htmlFor="bs-handle">Handle</label>
              <input
                id="bs-handle"
                className="input"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                required
              />
            </div>
            <div className="field-row" style={{ borderBottom: 0 }}>
              <label className="field-label" htmlFor="bs-local">Address</label>
              <div className="flex items-center gap-1">
                <input
                  id="bs-local"
                  className="input"
                  placeholder="christopher"
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
                  required
                  autoFocus
                />
                <span className="text-[13.5px] text-ink-muted ml-1">@{domain}</span>
              </div>
            </div>
          </div>

          {err && (
            <div className="px-[18px] py-3 text-[13px] text-danger border-t border-border">{err}</div>
          )}

          <div className="flex items-center justify-between px-[18px] py-4 border-t border-border">
            <span className="text-[12px] text-ink-faint">
              You'll register a passkey on the next screen.
            </span>
            <button type="submit" className="btn btn-primary" disabled={busy || !localPart}>
              {busy ? 'Creating…' : 'Get started'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
