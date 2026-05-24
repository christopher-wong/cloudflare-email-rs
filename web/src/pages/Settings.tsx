import { FormEvent, useEffect, useState } from 'react';
import { Lock } from 'lucide-react';

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import { useApp } from '@/lib/store';
import { addPasskey } from '@/lib/webauthn';
import * as notifications from '@/lib/notifications';
import { absoluteDate } from '@/lib/time';

interface Passkey {
  credential_id_b64: string;
  label: string | null;
  created_at: number;
  aaguid_b64: string | null;
  transports: string | null;
}

export default function Settings() {
  const { state, refresh } = useApp();
  const [displayName, setDisplayName] = useState(state.me?.display_name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [pkBusy, setPkBusy] = useState(false);
  const [newLabel, setNewLabel] = useState('');

  const [notifyState, setNotifyState] = useState(notifications.permissionState());
  const enableNotifications = async () => {
    const next = await notifications.requestPermission();
    setNotifyState(next);
  };

  const loadPasskeys = async () => {
    try {
      const list = await api.get<Passkey[]>('/api/me/passkeys');
      setPasskeys(list);
    } catch {
      /* tolerable */
    }
  };

  useEffect(() => {
    void loadPasskeys();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await api.patch('/api/me', { display_name: displayName || null });
      await refresh();
      setOk(true);
    } catch (e: any) {
      setErr(e?.message || 'save failed');
    } finally {
      setBusy(false);
    }
  };

  const addAnother = async (e: FormEvent) => {
    e.preventDefault();
    setPkBusy(true);
    setErr(null);
    try {
      await addPasskey({ label: newLabel || undefined });
      setNewLabel('');
      await loadPasskeys();
    } catch (e: any) {
      setErr(e?.message || 'add passkey failed');
    } finally {
      setPkBusy(false);
    }
  };

  const removePk = async (id: string) => {
    if (!confirm("remove this passkey? you can't undo this.")) return;
    try {
      await api.del(`/api/me/passkeys/${id}`);
      await loadPasskeys();
    } catch (e: any) {
      setErr(e?.message || 'remove failed');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Toolbar><span className="eyebrow">settings</span></Toolbar>

      <div className="mx-auto w-full max-w-3xl px-10 py-9 flex flex-col gap-5">
        {/* Page header */}
        <div>
          <div className="eyebrow mb-1">settings</div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Account preferences</h1>
        </div>

        {/* Profile card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Profile</div>
              <div className="text-[12.5px] text-ink-muted">Your identity on this server.</div>
            </div>
          </div>
          <div>
            <div className="field-row">
              <label className="field-label">Handle</label>
              <div className="text-[13.5px] font-mono text-ink">{state.me?.handle}</div>
            </div>
            <div className="field-row">
              <label className="field-label">Role</label>
              <div className="text-[13.5px] text-ink">
                {state.me?.is_admin
                  ? <span className="badge badge-solid">admin</span>
                  : <span className="text-ink-muted">user</span>}
              </div>
            </div>
            <div className="field-row">
              <label className="field-label">Addresses</label>
              <div className="flex flex-wrap gap-1.5">
                {state.me?.addresses.map((a) => (
                  <span key={a} className="chip">{a}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Display name card */}
        <form onSubmit={save} className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Display name</div>
              <div className="text-[12.5px] text-ink-muted">Shown on outgoing mail.</div>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              {ok && <span className="text-[12.5px] text-ink-muted">Saved</span>}
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
          <div>
            <div className="field-row">
              <label className="field-label" htmlFor="display-name">Name</label>
              <input
                id="display-name"
                className="input"
                placeholder="shown on outgoing mail"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          </div>
        </form>

        {/* Passkeys card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Passkeys</div>
              <div className="text-[12.5px] text-ink-muted">Devices that can decrypt your inbox.</div>
            </div>
            <div className="flex-1" />
            <form onSubmit={addAnother} className="flex items-center gap-2">
              <input
                className="input"
                style={{ width: 180 }}
                placeholder="device label (optional)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <button type="submit" className="btn btn-sm" disabled={pkBusy}>
                {pkBusy ? 'Adding…' : '+ Add passkey'}
              </button>
            </form>
          </div>
          {passkeys && passkeys.length === 0 && (
            <div className="px-[18px] py-4 text-[13.5px] text-ink-muted">No passkeys registered yet.</div>
          )}
          {passkeys && passkeys.length > 0 && (
            <div>
              {passkeys.map((p, idx) => (
                <div
                  key={p.credential_id_b64}
                  className="field-row"
                  style={idx === passkeys.length - 1 ? { borderBottom: 0 } : {}}
                >
                  <div className="flex items-center gap-2">
                    <Lock size={13} className="text-ink-faint flex-shrink-0" />
                    <span className="text-[13px] text-ink-muted">{p.label || 'Unnamed device'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-[12px] text-ink-faint font-mono">
                      Added {absoluteDate(p.created_at)}
                      {p.transports && <span className="ml-2">{p.transports}</span>}
                    </div>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => removePk(p.credential_id_b64)}
                      disabled={(passkeys?.length ?? 0) <= 1}
                      title={passkeys?.length === 1 ? 'add another first' : ''}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notifications card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Notifications</div>
              <div className="text-[12.5px] text-ink-muted">Desktop alerts for new mail.</div>
            </div>
          </div>
          <div className="field-row" style={{ borderBottom: 0 }}>
            <label className="field-label">Desktop notifications</label>
            <div className="flex items-center justify-between">
              <div className="text-[12.5px] text-ink-muted max-w-[32ch]">
                {notifyState === 'granted' && "Enabled — you'll see a system toast when the tab is in the background."}
                {notifyState === 'denied' && 'Denied — re-enable in your browser settings if you change your mind.'}
                {notifyState === 'default' && "Click enable to get a toast when a new email arrives while this tab isn't focused."}
                {notifyState === 'unsupported' && "This browser doesn't support the Notifications API."}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={notifyState !== 'default'}
                onClick={() => void enableNotifications()}
              >
                {notifyState === 'granted' ? 'Enabled' : notifyState === 'denied' ? 'Blocked' : 'Enable'}
              </button>
            </div>
          </div>
        </div>

        {/* Recovery card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Recovery</div>
              <div className="text-[12.5px] text-ink-muted">Your fallback if you lose your passkeys.</div>
            </div>
            <span className="pill ml-auto">
              <Lock size={11} />
              encrypted
            </span>
          </div>
          <div className="card-body text-[13.5px] text-ink-muted space-y-2">
            <p>
              You set a recovery phrase during enrollment. It was shown
              once — we don't have it. If you lose your passkeys, the phrase
              is the only way back in.
            </p>
            <p>
              If you've lost the phrase but still have a working passkey:
              re-enroll on a new account (admin can help), then forward your
              old mail. There is no in-app "re-generate phrase" — that
              would defeat the encryption guarantee.
            </p>
          </div>
        </div>

        {/* Encryption card */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="text-[13px] font-semibold text-ink">Encryption</div>
              <div className="text-[12.5px] text-ink-muted">How your mail is protected.</div>
            </div>
          </div>
          <div className="card-body text-[13.5px] text-ink-muted">
            <p>
              Subject, body, attachments, and snippets are encrypted to your
              X25519 public key on receipt. The matching private key is wrapped
              on the server — once per passkey (PRF-derived) and once for the
              recovery phrase (Argon2id-derived). Neither the server nor
              Cloudflare can derive the wrap key without your authenticator or
              the phrase.
            </p>
          </div>
        </div>

        {/* Danger zone */}
        {err && (
          <div className="text-[13px] text-danger px-[18px] py-3 rounded-md border border-danger/30 bg-danger/[0.04]">
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
