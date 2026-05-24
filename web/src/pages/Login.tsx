import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint } from 'lucide-react';

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
      else if (e?.name === 'NotAllowedError') setErr('Login cancelled.');
      else setErr(e?.message || 'Login failed.');
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
      setErr(e?.message || 'Recovery failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex flex-col md:flex-row">
      {/* Left panel — brand + soft accent glow (the one permitted radial glow) */}
      <div
        className="hidden md:flex md:w-[44%] flex-col items-center justify-center px-14 py-16 relative overflow-hidden"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 50% 55%, var(--accent-soft) 0%, rgb(var(--bg)) 75%)`,
        }}
      >
        {/* Brand wordmark */}
        <div className="relative z-10 text-center select-none">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-[10px] bg-ink mb-5 relative">
            <span className="text-white font-semibold text-[22px]">b</span>
            {/* Accent dot */}
            <span
              className="absolute bottom-[-3px] right-[-3px] w-3 h-3 rounded-full border-2"
              style={{ background: 'var(--accent)', borderColor: 'rgb(var(--bg))' }}
            />
          </div>
          <div className="text-[28px] font-semibold tracking-tight text-ink">bmail</div>
          <div className="text-[14px] text-ink-muted mt-2 leading-relaxed">
            Mail nobody can read.<br />Except you.
          </div>
        </div>
      </div>

      {/* Right panel — sign-in card */}
      <div className="flex-1 flex items-center justify-center px-6 py-12 md:py-0">
        <div className="w-full max-w-[380px]">
          {/* Mobile wordmark */}
          <div className="md:hidden text-center mb-8">
            <div className="inline-flex items-center gap-2">
              <span className="w-8 h-8 rounded-[8px] bg-ink text-white font-semibold text-[15px] grid place-items-center">b</span>
              <span className="text-[20px] font-semibold tracking-tight text-ink">bmail</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="eyebrow mb-1">welcome back</div>
                <h1 className="text-[20px] font-semibold tracking-tight text-ink">Sign in</h1>
              </div>
            </div>

            {/* Mode toggle */}
            <div className="grid grid-cols-2 border-b border-border">
              <button
                type="button"
                className={`py-2.5 text-[13px] font-medium transition-colors ${
                  mode === 'passkey'
                    ? 'text-ink border-b-2 border-ink -mb-px'
                    : 'text-ink-muted hover:text-ink'
                }`}
                onClick={() => { setMode('passkey'); setErr(null); }}
              >
                Passkey
              </button>
              <button
                type="button"
                className={`py-2.5 text-[13px] font-medium transition-colors ${
                  mode === 'recovery'
                    ? 'text-ink border-b-2 border-ink -mb-px'
                    : 'text-ink-muted hover:text-ink'
                }`}
                onClick={() => { setMode('recovery'); setErr(null); }}
              >
                Recovery phrase
              </button>
            </div>

            {/* Passkey mode */}
            {mode === 'passkey' && (
              <div className="p-5 flex flex-col items-center gap-4">
                <button
                  type="button"
                  className="btn btn-primary w-full justify-center gap-2.5"
                  style={{ height: 42 }}
                  onClick={passkey}
                  disabled={busy}
                >
                  <Fingerprint size={17} />
                  {busy ? 'Authenticating…' : 'Sign in with passkey'}
                </button>
                <p className="text-[12px] text-ink-faint text-center">
                  Uses Touch ID, Windows Hello, or your security key.
                </p>
              </div>
            )}

            {/* Recovery mode */}
            {mode === 'recovery' && (
              <form onSubmit={recover}>
                <div>
                  <div className="field-row">
                    <label className="field-label" htmlFor="rec-handle">Handle</label>
                    <input
                      id="rec-handle"
                      className="input"
                      placeholder="your handle or email"
                      value={handle}
                      onChange={(e) => setHandle(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="field-row" style={{ borderBottom: 0 }}>
                    <label className="field-label" htmlFor="rec-phrase">Recovery phrase</label>
                    <div>
                      <textarea
                        id="rec-phrase"
                        className="input"
                        rows={4}
                        style={{ height: 'auto', resize: 'none' }}
                        placeholder="paste or type your twelve words, separated by spaces"
                        value={phrase}
                        onChange={(e) => setPhrase(e.target.value)}
                        required
                      />
                      <p className="text-[12px] text-ink-faint mt-1.5">
                        This will take a few seconds — Argon2id is intentionally slow.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex justify-end px-[18px] py-4 border-t border-border">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {busy ? 'Unlocking…' : 'Sign in'}
                  </button>
                </div>
              </form>
            )}

            {/* Error */}
            {err && (
              <div className="px-[18px] py-3 text-[13px] text-danger border-t border-border">{err}</div>
            )}
          </div>

          <p className="text-[12.5px] text-ink-faint text-center mt-5">
            No account? Ask an admin for an enrollment link.
          </p>
        </div>
      </div>
    </div>
  );
}
