/**
 * Redeem an invite by registering a passkey. Two screens:
 *
 *   1. The enroll form (handle / device label) → triggers WebAuthn create()
 *      with PRF eval. On success we receive a 12-word recovery phrase from
 *      the client crypto flow.
 *
 *   2. The recovery phrase reveal. The user MUST confirm they've saved it
 *      before we route them into the inbox.
 */

import { FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import RecoveryReveal from '@/components/RecoveryReveal';
import { useApp } from '@/lib/store';
import { registerWithInvite, PrfUnsupportedError } from '@/lib/webauthn';

export default function Enroll() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useApp();
  const token = params.get('token') || '';

  const [displayName, setDisplayName] = useState('');
  const [credLabel, setCredLabel] = useState(detectDevice());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) {
      setErr('missing invite token');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await registerWithInvite(token, {
        displayName: displayName || undefined,
        credLabel: credLabel || undefined,
      });
      setPhrase(r.recovery_phrase);
    } catch (e: any) {
      if (e instanceof PrfUnsupportedError) setErr(e.message);
      else setErr(e?.message || 'enrollment failed');
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    // Zero the phrase from this component's state before navigating.
    setPhrase(null);
    await refresh();
    nav('/', { replace: true });
  };

  // Step 2: recovery phrase reveal
  if (phrase) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-[480px]">
          <div className="mb-5">
            <div className="eyebrow mb-1">invite · step 2 of 2</div>
            <h1 className="text-[26px] font-semibold tracking-tight text-ink">Save your recovery phrase</h1>
          </div>
          <RecoveryReveal phrase={phrase} onContinue={finish} />
        </div>
      </div>
    );
  }

  // Step 1: enrollment form
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-12">
      <div className="card w-full max-w-[480px]">
        <div className="card-head">
          <div>
            <div className="eyebrow mb-1">invite</div>
            <h1 className="text-[26px] font-semibold tracking-tight text-ink leading-tight">
              Claim your address
            </h1>
          </div>
        </div>

        <div className="card-body border-b border-border">
          <p className="text-[13.5px] text-ink-muted leading-relaxed">
            Your passkey unlocks your mailbox. We use its PRF extension to
            derive an encryption key locally — Cloudflare never sees it.
          </p>
          <p className="text-[13.5px] text-ink-muted leading-relaxed mt-2">
            After registration you'll get a one-time 12-word recovery phrase.
            Save it. If you lose your passkey, it's your only way back in.
          </p>
        </div>

        <form onSubmit={submit}>
          <div>
            <div className="field-row">
              <label className="field-label" htmlFor="enroll-name">Display name</label>
              <input
                id="enroll-name"
                className="input"
                placeholder="optional — shown on outgoing mail"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field-row" style={{ borderBottom: 0 }}>
              <label className="field-label" htmlFor="enroll-device">Device</label>
              <input
                id="enroll-device"
                className="input"
                value={credLabel}
                onChange={(e) => setCredLabel(e.target.value)}
                placeholder="e.g. macbook touch id"
              />
            </div>
          </div>

          {err && (
            <div className="px-[18px] py-3 text-[13px] text-danger border-t border-border">{err}</div>
          )}

          <div className="flex items-center justify-between px-[18px] py-4 border-t border-border">
            <span className="text-[12px] text-ink-faint">
              Requires PRF: Chrome 116+, Safari 17.4+, FF 122+
            </span>
            <button
              type="submit"
              className="btn btn-accent"
              disabled={busy || !token}
            >
              {busy ? 'Registering…' : 'Create my inbox →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function detectDevice(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iphone face id / touch id';
  if (/Macintosh/.test(ua)) return 'mac touch id';
  if (/Android/.test(ua)) return 'android screen lock';
  if (/Windows/.test(ua)) return 'windows hello';
  return 'this device';
}
