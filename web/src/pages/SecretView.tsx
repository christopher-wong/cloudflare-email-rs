/**
 * Public viewer for password-protected secret links.
 *
 * Unauthenticated. The token comes from the URL. We hit
 * `GET /api/s/:token` for metadata (salt + KDF params + hint + sender name),
 * prompt the user for the password, derive Argon2id locally, send the
 * `check` value to `POST /api/s/:token/open`, and on success decrypt the
 * subject / body / attachments client-side.
 *
 * The server never sees the password or any plaintext.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import * as api from '@/lib/api';
import * as secretLink from '@/lib/secret-link';
import type { OpenResponse, DecodedSecret, KdfParams } from '@/lib/secret-link';
import { asAB, b64uDecode, b64uEncode } from '@/lib/b64';

interface ViewMeta {
  token: string;
  sender_addr: string;
  sender_name: string | null;
  recipient_addr: string | null;
  hint: string | null;
  argon_salt_b64: string;
  kdf_params: string;
  policy: secretLink.SecretPolicy;
  created_at: number;
  expires_at: number;
  first_opened_at: number | null;
  opens_count: number;
  revoked: boolean;
  expired: boolean;
  self_destructed?: boolean;
}

/** Per-attachment UI state — we keep `bytes` and the object URL out of
 *  the main DecodedSecret so the initial render is cheap and downloads
 *  happen lazily on click. */
type AttState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; bytes: Uint8Array }
  | { kind: 'error'; message: string };

export default function SecretView() {
  const { token } = useParams<{ token: string }>();
  const [meta, setMeta] = useState<ViewMeta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<DecodedSecret | null>(null);
  // Cached after successful /open so per-attachment fetches don't need
  // to re-run Argon2id every download.
  const [passwordCheck, setPasswordCheck] = useState<Uint8Array | null>(null);
  const [attState, setAttState] = useState<Record<string, AttState>>({});

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const m = await api.get<ViewMeta>(`/api/s/${encodeURIComponent(token)}`);
        if (!cancelled) setMeta(m);
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message || 'failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Release any object URLs we built when the component unmounts.
  useEffect(() => {
    return () => {
      for (const s of Object.values(attState)) {
        if (s.kind === 'ready') URL.revokeObjectURL(s.url);
      }
    };
    // intentionally only on unmount — per-attachment cleanup is handled
    // inline when a fetch supersedes a prior ready/error state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tryOpen = async () => {
    if (!meta || !token) return;
    setBusy(true);
    setOpenErr(null);
    try {
      const params: KdfParams = JSON.parse(meta.kdf_params);
      const salt = b64uDecode(meta.argon_salt_b64);
      // Argon2id is the slow part — typically a few hundred ms. We show
      // the "checking…" state during this work so the user understands
      // why the click didn't respond instantly.
      const argonOut = secretLink.deriveArgonOutput(password, salt, params);
      const { check } = secretLink.deriveCheckAndWrap(argonOut);
      const resp = await api.post<OpenResponse>(
        `/api/s/${encodeURIComponent(token)}/open`,
        { password_check_b64: b64uEncode(check) },
      );
      const dec = await secretLink.decodeOpenResponse(resp, argonOut);
      setDecoded(dec);
      setPasswordCheck(check);
    } catch (e: any) {
      const msg = e?.message || 'failed to open';
      // The server returns "bad password" (401); AES-GCM auth failure on
      // unwrap is "Cipher: invalid tag" or similar — collapse both into a
      // single message so we don't leak which check the server failed on.
      // Self-destruct is signaled as 410 + "self_destructed".
      if (/self_destructed/i.test(msg)) {
        setOpenErr(
          'too many failed attempts — this link has self-destructed and the content has been deleted.',
        );
        // Re-fetch metadata so the next render hits the self_destructed branch
        // (which renders a clean explanation instead of the password form).
        try {
          if (token) {
            const m = await api.get<ViewMeta>(`/api/s/${encodeURIComponent(token)}`);
            setMeta(m);
          }
        } catch {
          /* probe failure is fine — the inline error already conveys it */
        }
      } else if (/401|bad password|invalid/i.test(msg)) {
        // Worker propagates `attempts_remaining` in the error body — pull
        // it out if present so the user knows how close they are to
        // self-destruct.
        const remainingMatch = /attempts_remaining"?:\s*(\d+)/.exec(msg);
        if (remainingMatch) {
          const n = Number(remainingMatch[1]);
          setOpenErr(
            n <= 3
              ? `wrong password (${n} attempt${n === 1 ? '' : 's'} left before this link self-destructs)`
              : `wrong password (${n} attempts left)`,
          );
        } else {
          setOpenErr('wrong password');
        }
      } else if (/410|expired/i.test(msg)) {
        setOpenErr('this link has expired');
      } else if (/revoked/i.test(msg)) {
        setOpenErr('this link was revoked or used up');
      } else {
        setOpenErr(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  if (loadErr) {
    return (
      <Shell>
        <p className="inv px-3 py-2 text-sm">
          {loadErr.includes('404') ? 'this link does not exist' : loadErr}
        </p>
      </Shell>
    );
  }

  if (!meta) {
    return (
      <Shell>
        <p className="text-mute text-sm">loading…</p>
      </Shell>
    );
  }

  if (meta.self_destructed) {
    return (
      <Shell>
        <h1 className="mb-3 text-lg">secret message</h1>
        <p className="inv px-3 py-2 text-sm">
          this link self-destructed after too many failed unlock attempts.
          the content has been deleted from our servers.
        </p>
        <p className="text-mute mt-3 text-xs">
          ask the sender to share a new link if you still need it.
        </p>
      </Shell>
    );
  }

  if (meta.revoked || meta.expired) {
    return (
      <Shell>
        <h1 className="mb-3 text-lg">secret message</h1>
        <p className="inv px-3 py-2 text-sm">
          {meta.revoked ? 'this link was revoked or already used' : 'this link has expired'}
        </p>
      </Shell>
    );
  }

  const downloadAttachment = async (att: secretLink.DecodedAttachmentMeta) => {
    if (!token || !passwordCheck || !decoded) return;
    const r2_key = att.manifest.r2_key;
    setAttState((prev) => {
      // If we already have it ready, just re-trigger the browser download.
      const existing = prev[r2_key];
      if (existing && existing.kind === 'ready') {
        triggerDownload(existing.url, att.filename);
        return prev;
      }
      return { ...prev, [r2_key]: { kind: 'loading' } };
    });
    try {
      const bytes = await secretLink.fetchAttachment({
        token,
        manifest: att.manifest,
        passwordCheck,
        cek: decoded.cek,
      });
      const url = URL.createObjectURL(
        new Blob([asAB(bytes)], { type: att.mime || 'application/octet-stream' }),
      );
      setAttState((prev) => ({
        ...prev,
        [r2_key]: { kind: 'ready', url, bytes },
      }));
      triggerDownload(url, att.filename);
    } catch (e: any) {
      const msg = e?.message || 'download failed';
      // The one-time grace window has expired — surface a useful message.
      const friendly = /self_destructed/i.test(msg)
        ? 'this link has self-destructed (too many failed unlocks)'
        : /410|expired/i.test(msg)
          ? 'this link has expired'
          : /409|not yet opened/i.test(msg)
            ? 'please reopen the message'
            : msg;
      setAttState((prev) => ({
        ...prev,
        [r2_key]: { kind: 'error', message: friendly },
      }));
    }
  };

  if (decoded) {
    return (
      <Shell>
        <header className="hair-b mb-3 pb-2">
          <div className="text-xs text-mute">from</div>
          <div className="font-medium">
            {decoded.sender_name || decoded.sender_addr}
            {decoded.sender_name && (
              <span className="text-mute ml-2 text-xs">&lt;{decoded.sender_addr}&gt;</span>
            )}
          </div>
          {decoded.recipient_addr && (
            <>
              <div className="mt-2 text-xs text-mute">to</div>
              <div>{decoded.recipient_addr}</div>
            </>
          )}
          <div className="mt-2 text-xs text-mute">subject</div>
          <div className="font-mono text-sm">{decoded.subject || '(no subject)'}</div>
        </header>
        <div className="prose-sm whitespace-pre-wrap break-words text-sm leading-relaxed">
          {looksLikeHtml(decoded.body) ? (
            <div dangerouslySetInnerHTML={{ __html: decoded.body }} />
          ) : (
            decoded.body
          )}
        </div>
        {decoded.attachments.length > 0 && (
          <div className="hair-t mt-4 pt-2">
            <div className="text-mute mb-1 text-xs uppercase">attachments</div>
            <ul className="space-y-1">
              {decoded.attachments.map((a) => {
                const st = attState[a.manifest.r2_key] ?? { kind: 'idle' as const };
                return (
                  <li
                    key={a.manifest.r2_key}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate" title={a.filename}>
                      {a.filename}{' '}
                      <span className="text-mute text-xs">
                        {formatBytes(a.size)} · {a.mime || 'application/octet-stream'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {st.kind === 'error' && (
                        <span className="text-xs text-red-600">{st.message}</span>
                      )}
                      <button
                        type="button"
                        className="btn label py-1 px-2 text-xs"
                        disabled={st.kind === 'loading'}
                        onClick={() => void downloadAttachment(a)}
                      >
                        {st.kind === 'loading'
                          ? 'fetching…'
                          : st.kind === 'ready'
                            ? 'download again'
                            : 'download'}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {decoded.policy === 'one_time' && (
              <p className="text-mute mt-2 text-xs">
                one-time view: you have ~5 minutes after the first open to
                download all files. after that the link is gone.
              </p>
            )}
          </div>
        )}
        <footer className="text-mute mt-6 text-xs">
          {decoded.policy === 'one_time' ? (
            <p>this link was set to one-time view. opening it has started its expiry clock.</p>
          ) : decoded.expires_at ? (
            <p>this link expires {formatDate(decoded.expires_at)}.</p>
          ) : null}
        </footer>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-4">
        <h1 className="text-lg">secret message</h1>
        <p className="text-mute mt-1 text-sm">
          {meta.sender_name || meta.sender_addr} sent you an encrypted message.
          Enter the password they shared with you to read it.
        </p>
      </header>
      {meta.hint && (
        <p className="hair-all mb-3 px-3 py-2 text-sm">
          <span className="text-mute mr-2 text-xs uppercase">hint</span>
          {meta.hint}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void tryOpen();
        }}
        className="space-y-2"
      >
        <input
          autoFocus
          className="hair-all w-full px-2 py-2 font-mono"
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button
          type="submit"
          className="btn btn-primary label w-full py-2"
          disabled={busy || !password}
        >
          {busy ? 'checking…' : 'unlock ▸'}
        </button>
      </form>
      {openErr && <p className="inv mt-3 px-3 py-2 text-sm">{openErr}</p>}
      <p className="text-mute mt-6 text-xs">
        We never see your password. It runs through Argon2id in your browser,
        and only a derived check value is sent to verify the password.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto my-10 max-w-xl px-4">
      <div className="hair-all bg-white p-4">{children}</div>
    </div>
  );
}

function triggerDownload(url: string, filename: string) {
  // Synthesize a click on an <a download> rather than nav-ing the user
  // away — works for any blob: URL and lets the filename hint through.
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}
