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

type AttState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; bytes: Uint8Array }
  | { kind: 'error'; message: string };

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="grid place-items-center rounded-[8px] bg-ink text-white font-semibold relative"
        style={{ width: 28, height: 28, fontSize: 14 }}
      >
        b
        <span
          className="absolute right-[-2px] bottom-[-2px] w-[9px] h-[9px] rounded-full border-2 border-elev bg-accent"
          aria-hidden="true"
        />
      </div>
      <span className="text-[14px] font-semibold tracking-tight text-ink">bmail</span>
    </div>
  );
}

function LockIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 1 1 5 0v2" />
    </svg>
  );
}

export default function SecretView() {
  const { token } = useParams<{ token: string }>();
  const [meta, setMeta] = useState<ViewMeta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<DecodedSecret | null>(null);
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
        if (!cancelled) setLoadErr(e?.message || 'Failed to load.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    return () => {
      for (const s of Object.values(attState)) {
        if (s.kind === 'ready') URL.revokeObjectURL(s.url);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tryOpen = async () => {
    if (!meta || !token) return;
    setBusy(true);
    setOpenErr(null);
    try {
      const params: KdfParams = JSON.parse(meta.kdf_params);
      const salt = b64uDecode(meta.argon_salt_b64);
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
      const msg = e?.message || 'Failed to open.';
      if (/self_destructed/i.test(msg)) {
        setOpenErr(
          'Too many failed attempts — this link has self-destructed and the content has been deleted.',
        );
        try {
          if (token) {
            const m = await api.get<ViewMeta>(`/api/s/${encodeURIComponent(token)}`);
            setMeta(m);
          }
        } catch {
          /* probe failure is fine */
        }
      } else if (/401|bad password|invalid/i.test(msg)) {
        const remainingMatch = /attempts_remaining"?:\s*(\d+)/.exec(msg);
        if (remainingMatch) {
          const n = Number(remainingMatch[1]);
          setOpenErr(
            n <= 3
              ? `Wrong password — ${n} attempt${n === 1 ? '' : 's'} left before this link self-destructs.`
              : `Wrong password — ${n} attempts left.`,
          );
        } else {
          setOpenErr('Wrong password.');
        }
      } else if (/410|expired/i.test(msg)) {
        setOpenErr('This link has expired.');
      } else if (/revoked/i.test(msg)) {
        setOpenErr('This link was revoked or already used.');
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
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {loadErr.includes('404') ? 'This link does not exist.' : loadErr}
        </div>
      </Shell>
    );
  }

  if (!meta) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-muted">
          <span className="inline-block h-3.5 w-3.5 animate-pulse-soft rounded-full border border-border bg-sunken" />
          Loading…
        </div>
      </Shell>
    );
  }

  if (meta.self_destructed) {
    return (
      <Shell>
        <div className="eyebrow mb-1">secret message</div>
        <h1 className="mb-3 text-[17px] font-semibold text-ink">Link self-destructed</h1>
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          This link self-destructed after too many failed unlock attempts. The content has been deleted from our servers.
        </div>
        <p className="mt-3 text-[12.5px] text-ink-muted">
          Ask the sender to share a new link if you still need it.
        </p>
      </Shell>
    );
  }

  if (meta.revoked || meta.expired) {
    return (
      <Shell>
        <div className="eyebrow mb-1">secret message</div>
        <h1 className="mb-3 text-[17px] font-semibold text-ink">
          {meta.revoked ? 'Link revoked' : 'Link expired'}
        </h1>
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {meta.revoked ? 'This link was revoked or already used.' : 'This link has expired.'}
        </div>
      </Shell>
    );
  }

  const downloadAttachment = async (att: secretLink.DecodedAttachmentMeta) => {
    if (!token || !passwordCheck || !decoded) return;
    const r2_key = att.manifest.r2_key;
    setAttState((prev) => {
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
      const msg = e?.message || 'Download failed.';
      const friendly = /self_destructed/i.test(msg)
        ? 'This link has self-destructed (too many failed unlocks).'
        : /410|expired/i.test(msg)
          ? 'This link has expired.'
          : /409|not yet opened/i.test(msg)
            ? 'Please reopen the message.'
            : msg;
      setAttState((prev) => ({
        ...prev,
        [r2_key]: { kind: 'error', message: friendly },
      }));
    }
  };

  // Decoded / unlocked state
  if (decoded) {
    return (
      <Shell>
        {/* Sender header */}
        <div className="card mb-4">
          <div className="card-head">
            <div className="flex-1">
              <div className="eyebrow mb-1">secret message</div>
              <div className="text-[15px] font-medium text-ink">
                {decoded.sender_name || decoded.sender_addr}
                {decoded.sender_name && (
                  <span className="ml-2 font-mono text-[12px] text-ink-muted">
                    &lt;{decoded.sender_addr}&gt;
                  </span>
                )}
              </div>
              {decoded.recipient_addr && (
                <div className="mt-1 text-[12.5px] text-ink-muted">
                  <span className="font-normal">to </span>
                  {decoded.recipient_addr}
                </div>
              )}
            </div>
            <span className="pill shrink-0">
              <LockIcon />
              encrypted
            </span>
          </div>
          {decoded.subject && (
            <div className="border-b border-border px-[18px] py-3">
              <div className="eyebrow mb-0.5">subject</div>
              <div className="font-mono text-[13px] text-ink">{decoded.subject}</div>
            </div>
          )}
        </div>

        {/* Message body */}
        <div className="card mb-4">
          <div className="card-body">
            <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">
              {looksLikeHtml(decoded.body) ? (
                <div dangerouslySetInnerHTML={{ __html: decoded.body }} />
              ) : (
                decoded.body
              )}
            </div>
          </div>
        </div>

        {/* Attachments */}
        {decoded.attachments.length > 0 && (
          <div className="card mb-4">
            <div className="card-head">
              <div className="text-[13px] font-semibold text-ink">
                Attachments
              </div>
              <div className="ml-auto text-[12.5px] text-ink-muted">
                {decoded.attachments.length} file{decoded.attachments.length === 1 ? '' : 's'}
              </div>
            </div>
            <div>
              {decoded.attachments.map((a) => {
                const st = attState[a.manifest.r2_key] ?? { kind: 'idle' as const };
                return (
                  <div
                    key={a.manifest.r2_key}
                    className="flex items-center justify-between gap-3 border-b border-border px-[18px] py-3 last:border-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] text-ink" title={a.filename}>
                        {a.filename}
                      </span>
                      <span className="text-[12px] text-ink-muted">
                        {formatBytes(a.size)} · {a.mime || 'application/octet-stream'}
                      </span>
                      {st.kind === 'error' && (
                        <span className="mt-1 block text-[12px] text-danger">{st.message}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost shrink-0"
                      disabled={st.kind === 'loading'}
                      onClick={() => void downloadAttachment(a)}
                    >
                      {st.kind === 'loading'
                        ? 'Fetching…'
                        : st.kind === 'ready'
                          ? 'Download again'
                          : 'Download'}
                    </button>
                  </div>
                );
              })}
            </div>
            {decoded.policy === 'one_time' && (
              <div className="card-body border-t border-border">
                <p className="text-[12px] text-ink-muted">
                  One-time view: you have ~5 minutes after the first open to download all files.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Expiry footer */}
        <p className="text-[12px] text-ink-muted">
          {decoded.policy === 'one_time'
            ? 'This link was set to one-time view. Opening it has started its expiry clock.'
            : decoded.expires_at
              ? `This link expires ${formatDate(decoded.expires_at)}.`
              : null}
        </p>
      </Shell>
    );
  }

  // Locked / password form
  return (
    <Shell>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="eyebrow mb-1">secret message</div>
            <div className="text-[15px] font-medium text-ink">
              {meta.sender_name || meta.sender_addr}
            </div>
          </div>
          <span className="pill ml-auto shrink-0">
            <LockIcon />
            encrypted
          </span>
        </div>

        <div className="card-body space-y-4">
          <p className="text-[13.5px] text-ink-muted">
            Enter the password they shared with you to read this message.
          </p>

          {/* Hint */}
          {meta.hint && (
            <div className="rounded-md border border-border bg-sunken px-3 py-2">
              <span className="eyebrow mr-2">hint</span>
              <span className="text-[13px] text-ink">{meta.hint}</span>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void tryOpen();
            }}
            className="space-y-3"
          >
            <input
              autoFocus
              className="input font-mono"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="submit"
              className="btn btn-accent w-full"
              disabled={busy || !password}
            >
              <LockIcon />
              {busy ? 'Checking…' : 'Decrypt message'}
            </button>
          </form>

          {openErr && (
            <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {openErr}
            </div>
          )}

          {/* Encryption whisper */}
          <p className="text-[12px] text-ink-muted">
            Your password runs through Argon2id in your browser — only a derived check value is sent to verify it. The server never sees your password.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto max-w-md space-y-4">
        <div className="mb-2">
          <BrandMark />
        </div>
        {children}
      </div>
    </div>
  );
}

function triggerDownload(url: string, filename: string) {
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
