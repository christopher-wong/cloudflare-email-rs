/**
 * Public landing page for E2E-encrypted hosted downloads.
 *
 * Auth model:
 *   - Token in the URL path identifies the row server-side.
 *   - 256-bit CEK in the URL fragment (after `#`) decrypts the
 *     ciphertext and filenames. Browsers never transmit fragments to
 *     servers, so the worker can't see the CEK.
 *
 * Anti-phishing posture is unchanged from the plaintext-hosted
 * version: sender identity goes above the fold, "this is bmail"
 * callout is explicit, recipient's own address shown when known.
 *
 * Download UX: per-file button → fetches ciphertext chunks via
 * ranged GETs → decrypts in-browser → assembles a downloadable
 * Blob. Peak memory ≈ the file's plaintext size; for true streaming
 * decrypt of multi-GB files we'd need a service worker (follow-up).
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import * as api from '@/lib/api';
import * as hosted from '@/lib/hosted';
import type { HostedFileManifest } from '@/lib/hosted';
import { asAB } from '@/lib/b64';

interface ViewMeta {
  token: string;
  sender_addr: string;
  sender_name: string | null;
  recipient_addrs: string[];
  subject: string | null;
  files: HostedFileManifest[];
  total_bytes: number;
  created_at: number;
  expires_at: number;
  download_count: number;
  revoked: boolean;
  expired: boolean;
}

type FileState =
  | { kind: 'idle' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'ready'; url: string }
  | { kind: 'error'; message: string };

// Brand mark used in the page header
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

export default function HostedView() {
  const { token } = useParams<{ token: string }>();
  const [cek] = useState<Uint8Array | null>(() =>
    typeof window !== 'undefined'
      ? hosted.decodeCekFragment(window.location.hash)
      : null,
  );
  useLocation();

  const [meta, setMeta] = useState<ViewMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({});

  // Mirror `fileStates` into a ref so the unmount cleanup can read the
  // latest snapshot. The cleanup effect is unmount-only (`[]` deps), so
  // reading `fileStates` directly there captures the initial `{}` and
  // leaks every decrypted Blob URL. The ref + unmount cleanup pattern
  // avoids re-running cleanup on every state change.
  const fileStatesRef = useRef(fileStates);
  fileStatesRef.current = fileStates;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const m = await api.get<ViewMeta>(`/api/d/${encodeURIComponent(token)}`);
        if (!cancelled) setMeta(m);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Failed to load.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    return () => {
      for (const s of Object.values(fileStatesRef.current)) {
        if (s.kind === 'ready') URL.revokeObjectURL(s.url);
      }
    };
  }, []);

  if (err) {
    return (
      <Shell>
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {err.includes('404') ? 'This link does not exist.' : err}
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

  if (meta.revoked) {
    return (
      <Shell>
        <h1 className="mb-2 text-[17px] font-semibold text-ink">Files no longer available</h1>
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          The sender revoked this download link. Ask them to share again if you still need the files.
        </div>
      </Shell>
    );
  }

  if (meta.expired) {
    return (
      <Shell>
        <h1 className="mb-2 text-[17px] font-semibold text-ink">Link expired</h1>
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          Hosted download links expire 14 days after they are sent. Ask the sender to share again if you still need the files.
        </div>
      </Shell>
    );
  }

  if (!cek) {
    return (
      <Shell>
        <h1 className="mb-2 text-[17px] font-semibold text-ink">Decryption key missing</h1>
        <div className="rounded-md border border-[#F2D6D6] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          The URL is incomplete — there&apos;s no decryption key in the fragment (the part after{' '}
          <code className="font-mono">#</code>). Open the original link from the email exactly as it was sent.
        </div>
      </Shell>
    );
  }

  const downloadFile = async (f: hosted.HostedFileManifest) => {
    if (!token || !cek) return;
    const key = f.r2_key;
    setFileStates((prev) => {
      const existing = prev[key];
      if (existing?.kind === 'ready') {
        const a = document.createElement('a');
        a.href = existing.url;
        a.download = f.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return prev;
      }
      return {
        ...prev,
        [key]: { kind: 'loading', loaded: 0, total: f.plaintext_size },
      };
    });
    try {
      const hasFsAccess =
        typeof (window as unknown as { showSaveFilePicker?: unknown })
          .showSaveFilePicker === 'function';
      if (hasFsAccess) {
        const win = window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
            types?: { accept: Record<string, string[]> }[];
          }) => Promise<FileSystemFileHandle>;
        };
        const handle = await win.showSaveFilePicker({
          suggestedName: f.filename,
        });
        const writable = await handle.createWritable();
        try {
          await hosted.streamHostedFile({
            token,
            manifest: f,
            cek,
            writeChunk: async (plaintext) => {
              await writable.write(asAB(plaintext));
            },
            onProgress: (loaded, total) => {
              setFileStates((prev) => ({
                ...prev,
                [key]: { kind: 'loading', loaded, total },
              }));
            },
          });
        } finally {
          await writable.close();
        }
        setFileStates((prev) => ({
          ...prev,
          [key]: { kind: 'ready', url: '' },
        }));
      } else if (
        await hosted.streamHostedFileViaServiceWorker({
          token,
          manifest: f,
          cek,
        })
      ) {
        setFileStates((prev) => ({
          ...prev,
          [key]: { kind: 'ready', url: '' },
        }));
      } else {
        const bytes = await hosted.fetchHostedFile({
          token,
          manifest: f,
          cek,
          onProgress: (loaded, total) => {
            setFileStates((prev) => ({
              ...prev,
              [key]: { kind: 'loading', loaded, total },
            }));
          },
        });
        const blob = new Blob([asAB(bytes)], {
          type: f.mime || 'application/octet-stream',
        });
        const url = hosted.triggerBrowserDownload(blob, f.filename);
        setFileStates((prev) => ({ ...prev, [key]: { kind: 'ready', url } }));
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setFileStates((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      }
      setFileStates((prev) => ({
        ...prev,
        [key]: { kind: 'error', message: e?.message || 'Download failed.' },
      }));
    }
  };

  const recipientLine =
    meta.recipient_addrs.length === 0
      ? null
      : meta.recipient_addrs.length === 1
        ? meta.recipient_addrs[0]
        : `${meta.recipient_addrs[0]} +${meta.recipient_addrs.length - 1} more`;

  return (
    <Shell>
      {/* Sender identity — anti-phishing, above the fold */}
      <div className="card mb-4">
        <div className="card-head">
          <div className="flex-1">
            <div className="eyebrow mb-1">sent by</div>
            <div className="text-[15px] font-medium text-ink">
              {meta.sender_name || meta.sender_addr}
            </div>
            {meta.sender_name && (
              <div className="font-mono text-[12px] text-ink-muted">{meta.sender_addr}</div>
            )}
          </div>
        </div>
        <div className="card-body space-y-2">
          {recipientLine && (
            <div>
              <div className="eyebrow mb-0.5">to</div>
              <div className="font-mono text-[12.5px] text-ink">{recipientLine}</div>
            </div>
          )}
          {meta.subject && (
            <div>
              <div className="eyebrow mb-0.5">subject</div>
              <div className="text-[13.5px] text-ink">{meta.subject}</div>
            </div>
          )}
          <div className="flex items-center justify-between pt-1">
            <span className="font-mono text-[11.5px] text-ink-faint">
              {formatDate(meta.created_at)} · expires {formatDate(meta.expires_at)}
            </span>
            <span className="pill">
              <LockIcon />
              encrypted
            </span>
          </div>
        </div>
      </div>

      {/* Security whisper */}
      <p className="mb-4 text-[12.5px] text-ink-muted">
        The decryption key only exists in your URL — the part after <code className="font-mono text-[11.5px]">#</code>.
        Anyone with the full URL can decrypt these files, so treat it like a password.
        If you don&apos;t recognize the sender, close this page.
      </p>

      {/* Files */}
      <div className="card">
        <div className="card-head">
          <div className="text-[13px] font-semibold text-ink">
            Files
          </div>
          <div className="ml-auto text-[12.5px] text-ink-muted">
            {meta.files.length} file{meta.files.length === 1 ? '' : 's'} · {formatBytes(meta.total_bytes)}
          </div>
        </div>
        <div>
          {meta.files.map((f) => {
            const st = fileStates[f.r2_key] ?? { kind: 'idle' };
            return (
              <div
                key={f.r2_key}
                className="flex items-center justify-between gap-3 border-b border-border px-[18px] py-3 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate font-mono text-[12.5px] text-ink"
                    title={f.filename}
                  >
                    {f.filename}
                  </span>
                  <span className="text-[12px] text-ink-muted">
                    {formatBytes(f.plaintext_size)} · {f.mime || 'application/octet-stream'}
                  </span>
                  {st.kind === 'loading' && (
                    <div className="mt-1.5 space-y-1">
                      <div className="flex justify-between text-[11.5px] text-ink-muted">
                        <span>{formatBytes(st.loaded)} / {formatBytes(st.total)}</span>
                        <span>{((st.loaded / st.total) * 100).toFixed(0)}%</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-sunken">
                        <div
                          className="h-full bg-accent rounded-full"
                          style={{
                            width: `${(st.loaded / st.total) * 100}%`,
                            transition: 'width 120ms linear',
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {st.kind === 'error' && (
                    <span className="mt-1 block text-[12px] text-danger">{st.message}</span>
                  )}
                </span>
                <button
                  className="btn btn-accent btn-sm shrink-0"
                  disabled={st.kind === 'loading'}
                  onClick={() => void downloadFile(f)}
                >
                  {st.kind === 'loading'
                    ? 'Decrypting…'
                    : st.kind === 'ready'
                      ? 'Download again'
                      : 'Download'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {meta.download_count > 0 && (
        <p className="mt-3 text-[12px] text-ink-faint">
          Downloaded {meta.download_count} time{meta.download_count === 1 ? '' : 's'} so far.
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto max-w-md space-y-4">
        {/* Brand mark */}
        <div className="mb-2">
          <BrandMark />
        </div>
        {children}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024)
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}
