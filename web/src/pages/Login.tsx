import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useApp } from '@/lib/store';
import { login, recoveryLogin, PrfUnsupportedError } from '@/lib/webauthn';

type Mode = 'passkey' | 'recovery';

export default function Login() {
  const nav = useNavigate();
  const { refresh } = useApp();
  const [mode, setMode] = useState<Mode>('passkey');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [handle, setHandle] = useState('');
  const [phrase, setPhrase] = useState('');

  const passkey = async () => {
    setBusy(true);
    setErr(null);
    try {
      await login();
      await refresh();
      nav('/', { replace: true });
    } catch (e: any) {
      if (e instanceof PrfUnsupportedError) setErr(e.message);
      else if (e?.name === 'NotAllowedError') setErr('login cancelled');
      else setErr(e?.message || 'login failed');
    } finally {
      setBusy(false);
    }
  };

  const recover = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await recoveryLogin(handle.trim(), phrase);
      await refresh();
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e?.message || 'recovery failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <div className="label">BMAIL</div>
        <h1 className="mt-2 text-3xl font-bold tracking-wider">enter</h1>
      </div>

      <div className="hair-all w-full">
        <div className="hair-b grid grid-cols-2">
          <button
            type="button"
            className={'label py-2 ' + (mode === 'passkey' ? 'inv' : '')}
            onClick={() => { setMode('passkey'); setErr(null); }}
          >
            passkey
          </button>
          <button
            type="button"
            className={'label py-2 ' + (mode === 'recovery' ? 'inv' : '')}
            onClick={() => { setMode('recovery'); setErr(null); }}
          >
            recovery phrase
          </button>
        </div>

        {mode === 'passkey' && (
          <div className="p-4">
            <button
              type="button"
              className="btn btn-primary w-full py-3 text-base label"
              onClick={passkey}
              disabled={busy}
            >
              {busy ? 'authenticating…' : 'sign in with passkey ▸'}
            </button>
            <p className="text-mute mt-3 text-center text-xs">
              uses Touch ID / Windows Hello / your security key
            </p>
          </div>
        )}

        {mode === 'recovery' && (
          <form onSubmit={recover}>
            <div className="field">
              <div className="field-label">handle</div>
              <input
                className="field-value w-full border-0"
                placeholder="your handle or email"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="hair-t p-3">
              <div className="label mb-2">12-word recovery phrase</div>
              <textarea
                className="w-full"
                rows={4}
                placeholder="paste or type your twelve words, separated by spaces"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                required
              />
              <p className="text-mute mt-2 text-xs">
                this will take a few seconds — Argon2id is intentionally slow.
              </p>
            </div>
            <div className="hair-t flex justify-end p-3">
              <button type="submit" className="btn btn-primary label" disabled={busy}>
                {busy ? 'unlocking…' : 'sign in ▸'}
              </button>
            </div>
          </form>
        )}

        {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}
      </div>

      <p className="text-mute text-center text-xs">
        no account? ask an admin for an enrollment link.
      </p>
    </div>
  );
}
