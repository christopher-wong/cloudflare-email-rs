import { FormEvent, useEffect, useState } from 'react';

import Toolbar from '@/components/Toolbar';
import Loader from '@/components/Loader';
import * as api from '@/lib/api';
import { useApp } from '@/lib/store';

interface Invite {
  token: string;
  handle: string | null;
  addresses: string[];
  is_admin: boolean;
  expires_at: number;
}
interface AdminUser {
  id: string;
  handle: string;
  display_name: string | null;
  is_admin: boolean;
  addresses: string[];
}
interface BackupRow {
  key: string;
  size_bytes: number;
  uploaded_at: number;
}
interface BackupsResp {
  backups: BackupRow[];
  schedule_cron: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hr, dom, mon, dow] = parts;
  const isDigits = (s: string) => /^\d+$/.test(s);
  if (dom === '*' && mon === '*' && dow === '*' && isDigits(min) && isDigits(hr)) {
    return `daily at ${hr.padStart(2, '0')}:${min.padStart(2, '0')} UTC`;
  }
  if (min === '0' && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'every hour';
  }
  return cron;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ── Data table shared header/row classes ──────────────────────────

const TH = 'text-[10.5px] tracking-wider uppercase text-ink-faint font-medium';

// ── Main component ────────────────────────────────────────────────

export default function Admin() {
  const { state } = useApp();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [i, u] = await Promise.all([
        api.get<Invite[]>('/api/admin/invites'),
        api.get<AdminUser[]>('/api/admin/users'),
      ]);
      setInvites(i);
      setUsers(u);
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => { void refresh(); }, []);

  if (!state.me?.is_admin) {
    return <div className="p-8 text-center text-[13.5px] text-ink-muted">Admin only.</div>;
  }
  if (err) return <div className="p-8 text-center text-[13.5px] text-danger">{err}</div>;
  if (!invites || !users) return <Loader />;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Toolbar><span className="eyebrow">system</span></Toolbar>

      <div className="mx-auto w-full max-w-3xl px-10 py-9 flex flex-col gap-5">
        {/* Page header */}
        <div>
          <div className="eyebrow mb-1">system</div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Admin</h1>
        </div>

        {/* Create invite card */}
        <InviteForm domain={state.status?.primary_domain ?? ''} onCreated={refresh} />

        {/* Pending invites card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Pending invites</div>
              <div className="text-[12.5px] text-ink-muted">Links that haven't been claimed yet.</div>
            </div>
          </div>

          {invites.length === 0 ? (
            <div className="px-[18px] py-4 text-[13.5px] text-ink-muted">No pending invites.</div>
          ) : (
            <div className="flex flex-col text-[13px]">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3.5 px-[18px] py-2.5 border-b border-border bg-bg">
                <div className={TH}>Address / handle</div>
                <div className={TH}>Role</div>
                <div className={TH}></div>
                <div className={TH}></div>
              </div>
              {invites.map((inv) => (
                <div
                  key={inv.token}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-3.5 px-[18px] py-3 border-b border-border last:border-0 hover:bg-hover items-center"
                >
                  <div>
                    <div className="text-ink font-medium">{inv.addresses.join(', ')}</div>
                    {inv.handle && (
                      <div className="text-[12px] text-ink-faint font-mono mt-0.5">{inv.handle}</div>
                    )}
                    <div className="text-[11px] text-ink-faint font-mono mt-0.5 break-all">
                      {`${window.location.origin}/enroll?token=${inv.token}`}
                    </div>
                  </div>
                  <div>
                    {inv.is_admin
                      ? <span className="badge badge-solid">admin</span>
                      : <span className="badge badge-soft">user</span>}
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      navigator.clipboard.writeText(
                        `${window.location.origin}/enroll?token=${inv.token}`,
                      )
                    }
                  >
                    Copy link
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      if (!confirm('Revoke this invite?')) return;
                      try {
                        await api.del(`/api/admin/invites/${encodeURIComponent(inv.token)}`);
                        await refresh();
                      } catch (e: any) {
                        setErr(e?.message || 'delete failed');
                      }
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Backups card */}
        <BackupsSection />

        {/* Users card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Users</div>
              <div className="text-[12.5px] text-ink-muted">{users.length} account{users.length !== 1 ? 's' : ''} on this server.</div>
            </div>
          </div>
          <div className="flex flex-col text-[13px]">
            {/* Header row */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-3.5 px-[18px] py-2.5 border-b border-border bg-bg">
              <div className={TH}>User</div>
              <div className={TH}>Addresses</div>
              <div className={TH}>Role</div>
            </div>
            {users.map((u) => (
              <div
                key={u.id}
                className="grid grid-cols-[1fr_auto_auto] gap-3.5 px-[18px] py-3 border-b border-border last:border-0 hover:bg-hover items-center"
              >
                <div>
                  <div className="font-medium text-ink">{u.handle}</div>
                  {u.display_name && (
                    <div className="text-[12px] text-ink-muted">{u.display_name}</div>
                  )}
                </div>
                <div className="text-[12px] text-ink-faint font-mono">
                  {u.addresses.join(', ') || '—'}
                </div>
                <div>
                  {u.id === state.me?.id
                    ? <span className="badge badge-soft">this account</span>
                    : u.is_admin
                    ? <span className="badge badge-solid">admin</span>
                    : <span className="text-ink-faint text-[12px]">user</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Backups section ────────────────────────────────────────────────

function BackupsSection() {
  const [data, setData] = useState<BackupsResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setData(await api.get<BackupsResp>('/api/admin/backups'));
    } catch (e: any) {
      setErr(e?.message || 'load failed');
    }
  };

  useEffect(() => { void refresh(); }, []);

  const triggerBackup = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post<{ key: string }>('/api/admin/backup', {});
      await refresh();
    } catch (e: any) {
      setErr(e?.message || 'backup failed');
    } finally { setBusy(false); }
  };

  const restore = async (key: string) => {
    if (!confirm(
      `Restore from ${key}?\n\n` +
      `This will INSERT OR REPLACE all rows from the snapshot. ` +
      `Newer data written since this backup will be overwritten where ` +
      `keys collide. Type the snapshot date into the next prompt to confirm.`
    )) return;
    const date = key.replace(/^backups\//, '').slice(0, 10);
    const typed = prompt(`To confirm, type the snapshot date: ${date}`);
    if (typed !== date) {
      alert('Restore cancelled — confirmation did not match.');
      return;
    }
    setRestoring(key); setErr(null);
    try {
      const r = await api.post<{ restored_mailboxes: number }>(
        '/api/admin/restore', { key },
      );
      alert(`Restored ${r.restored_mailboxes} mailbox(es). Reload to see fresh data.`);
    } catch (e: any) {
      setErr(e?.message || 'restore failed');
    } finally { setRestoring(null); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="text-[13px] font-semibold text-ink">Backups</div>
          <div className="text-[12.5px] text-ink-muted">
            {data ? describeCron(data.schedule_cron) : 'Loading schedule…'}
            {data && <span className="ml-2 font-mono text-[11px] text-ink-faint">({data.schedule_cron})</span>}
          </div>
        </div>
        <div className="flex-1" />
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={triggerBackup}
        >
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      {err && (
        <div className="px-[18px] py-3 text-[13px] text-danger border-b border-border">{err}</div>
      )}

      {!data && <div className="px-[18px] py-4 text-[13.5px] text-ink-muted">Loading…</div>}
      {data && data.backups.length === 0 && (
        <div className="px-[18px] py-4 text-[13.5px] text-ink-muted">No snapshots yet.</div>
      )}
      {data && data.backups.length > 0 && (
        <div className="flex flex-col text-[13px]">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3.5 px-[18px] py-2.5 border-b border-border bg-bg">
            <div className={TH}>Snapshot</div>
            <div className={TH}>Size</div>
            <div className={TH}></div>
            <div className={TH}></div>
          </div>
          {data.backups.map((b) => (
            <div
              key={b.key}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-3.5 px-[18px] py-3 border-b border-border last:border-0 hover:bg-hover items-center"
            >
              <div>
                <div className="font-mono text-[12.5px] text-ink">{formatTimestamp(b.uploaded_at)}</div>
                <div className="font-mono text-[11px] text-ink-faint mt-0.5 break-all">{b.key}</div>
              </div>
              <div className="font-mono text-[12.5px] text-ink-muted">{formatBytes(b.size_bytes)}</div>
              <button
                className="btn btn-sm"
                onClick={() => navigator.clipboard.writeText(b.key)}
              >
                Copy key
              </button>
              <button
                className="btn btn-sm btn-danger"
                disabled={restoring === b.key}
                onClick={() => restore(b.key)}
              >
                {restoring === b.key ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Create invite form ─────────────────────────────────────────────

function InviteForm({ domain, onCreated }: { domain: string; onCreated: () => void }) {
  const [handle, setHandle] = useState('');
  const [local, setLocal] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ enroll_url: string }>('/api/admin/invites', {
        handle: handle || null,
        addresses: [`${local}@${domain}`],
        is_admin: isAdmin,
      });
      setLink(r.enroll_url);
      setHandle(''); setLocal(''); setIsAdmin(false);
      onCreated();
    } catch (e: any) {
      setErr(e?.message || 'invite failed');
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="card">
      <div className="card-head">
        <div>
          <div className="text-[13px] font-semibold text-ink">Create invite</div>
          <div className="text-[12.5px] text-ink-muted">Generate an enrollment link for a new user.</div>
        </div>
        <div className="flex-1" />
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !local}>
          {busy ? 'Creating…' : 'Create invite'}
        </button>
      </div>

      <div>
        <div className="field-row">
          <label className="field-label" htmlFor="inv-handle">Handle</label>
          <input
            id="inv-handle"
            className="input"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="optional"
          />
        </div>
        <div className="field-row">
          <label className="field-label" htmlFor="inv-local">Address</label>
          <div className="flex items-center gap-1">
            <input
              id="inv-local"
              className="input"
              value={local}
              onChange={(e) => setLocal(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
              required
            />
            <span className="text-[13.5px] text-ink-muted ml-1">@{domain}</span>
          </div>
        </div>
        <div className="field-row" style={{ borderBottom: 0 }}>
          <label className="field-label" htmlFor="inv-admin">Admin role</label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              id="inv-admin"
              type="checkbox"
              className="check"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
            />
            <span className="text-[13.5px] text-ink-muted">Grant admin role</span>
          </label>
        </div>
      </div>

      {err && (
        <div className="px-[18px] py-3 text-[13px] text-danger border-t border-border">{err}</div>
      )}
      {link && (
        <div className="flex items-center justify-between gap-3 px-[18px] py-3 border-t border-border">
          <code className="text-[11.5px] font-mono text-ink-muted break-all flex-1">{link}</code>
          <button
            type="button"
            className="btn btn-sm flex-shrink-0"
            onClick={() => navigator.clipboard.writeText(link)}
          >
            Copy
          </button>
        </div>
      )}
    </form>
  );
}
