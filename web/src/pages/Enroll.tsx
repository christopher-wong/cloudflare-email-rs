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

  return (
    <div className="mx-auto flex h-full max-w-xl flex-col gap-6 p-8">
      {!phrase && (
        <>
          <header>
            <div className="label">CFEMAIL · enroll</div>
            <h1 className="mt-1 text-2xl font-bold">Register your passkey</h1>
            <p className="text-mute mt-2 text-sm">
              Your passkey unlocks your mailbox. We use its PRF extension to
              derive an encryption key locally — Cloudflare never sees it.
            </p>
            <p className="text-mute mt-1 text-sm">
              After registration you'll get a one-time 12-word recovery
              phrase. Save it. If you lose your passkey, it's your only way
              back in.
            </p>
          </header>

          <form onSubmit={submit} className="hair-all">
            <div className="field">
              <div className="field-label">display name</div>
              <input
                className="field-value w-full border-0"
                placeholder="optional — shown on outgoing mail"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field">
              <div className="field-label">device</div>
              <input
                className="field-value w-full border-0"
                value={credLabel}
                onChange={(e) => setCredLabel(e.target.value)}
                placeholder="e.g. macbook touch id"
              />
            </div>

            {err && <div className="hair-t inv px-3 py-2 text-sm">{err}</div>}

            <div className="hair-t flex items-center justify-between p-3">
              <span className="text-mute text-xs">requires PRF: Chrome 116+, Safari 17.4+, FF 122+</span>
              <button type="submit" className="btn btn-primary label" disabled={busy || !token}>
                {busy ? 'registering…' : 'create passkey ▸'}
              </button>
            </div>
          </form>
        </>
      )}

      {phrase && (
        <>
          <header>
            <div className="label">CFEMAIL · enroll · step 2 of 2</div>
            <h1 className="mt-1 text-2xl font-bold">Save your recovery phrase</h1>
          </header>
          <RecoveryReveal phrase={phrase} onContinue={finish} />
        </>
      )}
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
