import { FormEvent, useEffect, useState } from 'react';

import Toolbar from '@/components/Toolbar';
import * as api from '@/lib/api';
import { useApp } from '@/lib/store';
import { addPasskey } from '@/lib/webauthn';
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
    if (!confirm('remove this passkey? you can\'t undo this.')) return;
    try {
      await api.del(`/api/me/passkeys/${id}`);
      await loadPasskeys();
    } catch (e: any) {
      setErr(e?.message || 'remove failed');
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <Toolbar><span className="label">settings</span></Toolbar>

      <section className="hair-all">
        <div className="hair-b label px-3 py-2">profile</div>
        <div className="field">
          <div className="field-label">handle</div>
          <div className="field-value">{state.me?.handle}</div>
        </div>
        <div className="field">
          <div className="field-label">role</div>
          <div className="field-value">{state.me?.is_admin ? 'admin' : 'user'}</div>
        </div>
        <div className="field">
          <div className="field-label">addresses</div>
          <div className="field-value flex flex-wrap gap-1 py-2">
            {state.me?.addresses.map((a) => (
              <span key={a} className="chip">{a}</span>
            ))}
          </div>
        </div>
      </section>

      <form onSubmit={save} className="hair-all">
        <div className="hair-b label px-3 py-2">display name</div>
        <div className="field">
          <div className="field-label">name</div>
          <input
            className="field-value w-full border-0"
            placeholder="shown on outgoing mail"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        {ok && <div className="hair-t px-3 py-2 text-sm">saved</div>}
        <div className="hair-t flex justify-end p-3">
          <button type="submit" className="btn btn-primary label" disabled={busy}>
            {busy ? 'saving…' : 'save ▸'}
          </button>
        </div>
      </form>

      <section className="hair-all">
        <div className="hair-b label px-3 py-2">passkeys</div>
        {passkeys && passkeys.length === 0 && (
          <div className="text-mute p-3 text-sm">no passkeys yet</div>
        )}
        {passkeys && passkeys.length > 0 && (
          <ul>
            {passkeys.map((p) => (
              <li key={p.credential_id_b64} className="hair-b grid grid-cols-[1fr_auto] gap-3 px-3 py-2">
                <div>
                  <div className="font-bold">{p.label || 'unnamed device'}</div>
                  <div className="text-mute text-2xs">
                    added {absoluteDate(p.created_at)}
                    {p.transports && `  ·  ${p.transports}`}
                  </div>
                </div>
                <button
                  className="btn label"
                  onClick={() => removePk(p.credential_id_b64)}
                  disabled={(passkeys?.length ?? 0) <= 1}
                  title={passkeys?.length === 1 ? 'add another first' : ''}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addAnother} className="grid grid-cols-[1fr_auto] items-stretch gap-2 p-3">
          <input
            placeholder="label for this device — optional"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button type="submit" className="btn btn-primary label" disabled={pkBusy}>
            {pkBusy ? 'adding…' : 'add passkey ▸'}
          </button>
        </form>
      </section>

      <section className="hair-all">
        <div className="hair-b label px-3 py-2">recovery</div>
        <div className="text-mute p-3 text-sm">
          <p>
            you set a recovery phrase during enrollment. it was shown
            once — we don't have it. if you lose your passkeys, the phrase
            is the only way back in.
          </p>
          <p className="mt-2">
            if you've lost the phrase but still have a working passkey:
            re-enroll on a new account (admin can help), then forward your
            old mail. there is no in-app "re-generate phrase" — that
            would defeat the encryption guarantee.
          </p>
        </div>
      </section>

      <section className="hair-all">
        <div className="hair-b label px-3 py-2">encryption</div>
        <div className="text-mute p-3 text-sm">
          <p>
            subject, body, attachments, and snippets are encrypted to your
            X25519 public key on receipt. the matching private key is wrapped
            on the server, once per passkey (PRF-derived) and once for the
            recovery phrase (Argon2id-derived). neither the server nor
            cloudflare can derive the wrap key without your authenticator or
            the phrase.
          </p>
        </div>
      </section>

      {err && <div className="hair-all inv px-3 py-2 text-sm">{err}</div>}
    </div>
  );
}
