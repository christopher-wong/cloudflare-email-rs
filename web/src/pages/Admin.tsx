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

  const deleteInvite = async (token: string) => {
    if (!confirm('revoke this invite?')) return;
    try {
      await api.del(`/api/admin/invites/${encodeURIComponent(token)}`);
      await refresh();
    } catch (e: any) {
      setErr(e?.message || 'delete failed');
    }
  };

  if (!state.me?.is_admin) {
    return <div className="p-8 text-center label">admin only</div>;
  }
  if (err) return <div className="p-8 text-center label">{err}</div>;
  if (!invites || !users) return <Loader />;

  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <Toolbar><span className="label">admin</span></Toolbar>

      <InviteForm domain={state.status?.primary_domain ?? ''} onCreated={refresh} />

      <section className="hair-all">
        <div className="hair-b label px-3 py-2">invites — pending</div>
        {invites.length === 0 && (
          <div className="text-mute p-3 text-sm">no pending invites</div>
        )}
        {invites.length > 0 && (
          <ul>
            {invites.map((i) => (
              <li key={i.token} className="hair-b grid grid-cols-[1fr_auto_auto] gap-3 p-3">
                <div>
                  <div className="text-xs">
                    {i.addresses.join(', ')} {i.is_admin && <span className="chip ml-2">ADMIN</span>}
                  </div>
                  <div className="text-mute text-2xs mt-1 break-all">
                    {`${window.location.origin}/enroll?token=${i.token}`}
                  </div>
                </div>
                <button
                  className="btn label"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `${window.location.origin}/enroll?token=${i.token}`,
                    )
                  }
                >
                  copy link
                </button>
                <button
                  className="btn label"
                  onClick={() => deleteInvite(i.token)}
                  title="revoke this invite"
                >
                  revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BackupsSection />

      <section className="hair-all">
        <div className="hair-b label px-3 py-2">users</div>
        <ul>
          {users.map((u) => (
            <li key={u.id} className="hair-b grid grid-cols-[1fr_auto] gap-3 p-3">
              <div>
                <div className="font-bold">{u.handle} {u.is_admin && <span className="chip ml-2">ADMIN</span>}</div>
                <div className="text-mute text-xs">{u.addresses.join(', ') || '(no addresses)'}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// backups
// ──────────────────────────────────────────────────────────────────

/// Best-effort cron-to-English. Returns the raw string if the pattern
/// isn't one of the common shapes we handle, so the user always sees
/// *something* truthful even if it isn't pretty.
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
      alert('restore cancelled — confirmation did not match');
      return;
    }
    setRestoring(key); setErr(null);
    try {
      const r = await api.post<{ restored_mailboxes: number }>(
        '/api/admin/restore', { key },
      );
      alert(`restored ${r.restored_mailboxes} mailbox(es). Reload to see fresh data.`);
    } catch (e: any) {
      setErr(e?.message || 'restore failed');
    } finally { setRestoring(null); }
  };

  return (
    <section className="hair-all">
      <div className="hair-b flex items-center justify-between gap-3 px-3 py-2">
        <span className="label">backups</span>
        <button
          className="btn label"
          disabled={busy}
          onClick={triggerBackup}
          title="run a backup right now"
        >
          {busy ? 'backing up…' : 'back up now ▸'}
        </button>
      </div>

      <div className="hair-b px-3 py-2 text-xs">
        <span className="text-mute">schedule</span>
        <span className="ml-2">
          {data ? describeCron(data.schedule_cron) : '…'}
        </span>
        {data && (
          <code className="text-mute ml-2 text-2xs">({data.schedule_cron})</code>
        )}
      </div>

      {err && <div className="hair-b inv px-3 py-2 text-sm">{err}</div>}

      {!data && <div className="text-mute p-3 text-sm">loading…</div>}
      {data && data.backups.length === 0 && (
        <div className="text-mute p-3 text-sm">no snapshots yet</div>
      )}
      {data && data.backups.length > 0 && (
        <ul>
          {data.backups.map((b) => (
            <li
              key={b.key}
              className="hair-b grid grid-cols-[1fr_auto_auto] items-center gap-3 p-3"
            >
              <div>
                <div className="text-xs">{formatTimestamp(b.uploaded_at)}</div>
                <div className="text-mute text-2xs mt-1 break-all">
                  {b.key} · {formatBytes(b.size_bytes)}
                </div>
              </div>
              <button
                className="btn label"
                onClick={() => navigator.clipboard.writeText(b.key)}
                title="copy R2 key"
              >
                copy key
              </button>
              <button
                className="btn label"
                disabled={restoring === b.key}
                onClick={() => restore(b.key)}
                title="overwrite live data from this snapshot"
              >
                {restoring === b.key ? 'restoring…' : 'restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

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
    <form onSubmit={submit} className="hair-all">
      <div className="hair-b label px-3 py-2">new invite</div>
      <div className="field">
        <div className="field-label">handle</div>
        <input className="field-value w-full border-0" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="optional" />
      </div>
      <div className="field">
        <div className="field-label">address</div>
        <div className="field-value flex w-full items-stretch">
          <input
            className="w-full border-0"
            value={local}
            onChange={(e) => setLocal(e.target.value.toLowerCase().replace(/[^a-z0-9._+-]/g, ''))}
            required
          />
          <span className="text-mute self-center pl-2">@{domain}</span>
        </div>
      </div>
      <div className="field">
        <div className="field-label">admin</div>
        <label className="field-value flex items-center gap-2">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          <span className="text-xs">grant admin role</span>
        </label>
      </div>
      {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}
      {link && (
        <div className="hair-t flex items-center justify-between gap-3 p-3 text-xs">
          <code className="break-all">{link}</code>
          <button type="button" className="btn label" onClick={() => navigator.clipboard.writeText(link)}>
            copy
          </button>
        </div>
      )}
      <div className="hair-t flex justify-end p-3">
        <button type="submit" className="btn btn-primary label" disabled={busy || !local}>
          {busy ? 'creating…' : 'create invite ▸'}
        </button>
      </div>
    </form>
  );
}
