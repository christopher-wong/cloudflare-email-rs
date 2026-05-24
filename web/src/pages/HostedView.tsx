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

import { useEffect, useState } from 'react';
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

export default function HostedView() {
  const { token } = useParams<{ token: string }>();
  // react-router strips the fragment; read it directly off
  // window.location so we get the part after `#`.
  const [cek] = useState<Uint8Array | null>(() =>
    typeof window !== 'undefined'
      ? hosted.decodeCekFragment(window.location.hash)
      : null,
  );
  // We use useLocation purely to retrigger renders when the route
  // changes; the actual fragment read is from window.location.
  useLocation();

  const [meta, setMeta] = useState<ViewMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fileStates, setFileStates] = useState<Record<string, FileState>>({});

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const m = await api.get<ViewMeta>(`/api/d/${encodeURIComponent(token)}`);
        if (!cancelled) setMeta(m);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Revoke any object URLs we created when unmounting.
  useEffect(() => {
    return () => {
      for (const s of Object.values(fileStates)) {
        if (s.kind === 'ready') URL.revokeObjectURL(s.url);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) {
    return (
      <Shell>
        <p className="inv px-3 py-2 text-sm">
          {err.includes('404') ? 'this link does not exist' : err}
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
  if (meta.revoked) {
    return (
      <Shell>
        <h1 className="mb-3 text-lg">files no longer available</h1>
        <p className="inv px-3 py-2 text-sm">
          the sender revoked this download link. ask them to share again
          if you still need the files.
        </p>
      </Shell>
    );
  }
  if (meta.expired) {
    return (
      <Shell>
        <h1 className="mb-3 text-lg">link expired</h1>
        <p className="inv px-3 py-2 text-sm">
          hosted download links expire 14 days after they're sent. ask
          the sender to share again if you still need the files.
        </p>
      </Shell>
    );
  }
  if (!cek) {
    return (
      <Shell>
        <h1 className="mb-3 text-lg">decryption key missing</h1>
        <p className="inv px-3 py-2 text-sm">
          The URL is incomplete — there's no decryption key in the
          fragment (the part after <code>#</code>). Open the original
          link from the email exactly as it was sent.
        </p>
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
      // Download path preference (best → fallback):
      //   1. FileSystem Access API: native save dialog, true streaming
      //      to disk. Chromium-family.
      //   2. Service-worker streaming Response: handed to the browser
      //      as a synthetic download URL whose body is a stream of
      //      decrypted chunks. Firefox / Safari.
      //   3. In-memory Blob + Blob URL: simple, but caps at browser
      //      Blob memory limits. Dev mode and any env where SW isn't
      //      available.
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
        // Mark as ready without a Blob URL — the bytes already
        // landed on disk via the FSA writer.
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
        // SW takes ownership of the download — chunks are pulled by
        // the SW's ReadableStream `pull` callback as the browser
        // drains the response. We can't track per-chunk progress
        // from the page (the SW does the fetching), so flip the row
        // straight to "ready" once we've handed off.
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
      // User-cancelled the save dialog → silently return to idle.
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
        [key]: { kind: 'error', message: e?.message || 'download failed' },
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
      {/* Sender identity above the fold, anti-phishing posture. */}
      <div className="hair-all mb-4 p-4">
        <div className="text-mute text-xs uppercase">sent by</div>
        <div className="mt-1 text-lg font-medium">
          {meta.sender_name || meta.sender_addr}
        </div>
        {meta.sender_name && (
          <div className="text-mute font-mono text-xs">{meta.sender_addr}</div>
        )}
        {recipientLine && (
          <>
            <div className="text-mute mt-3 text-xs">to</div>
            <div className="font-mono text-xs">{recipientLine}</div>
          </>
        )}
        {meta.subject && (
          <div className="mt-2 text-sm">
            <span className="text-mute text-xs uppercase">subject </span>
            {meta.subject}
          </div>
        )}
        <div className="text-mute mt-3 text-xs">
          {formatDate(meta.created_at)} · expires {formatDate(meta.expires_at)}
        </div>
      </div>

      <div
        className="hair-all mb-4 p-3 text-xs"
        style={{ background: 'var(--bg-mute,#f5f5f5)' }}
      >
        <strong>You're on bmail's encrypted-download page.</strong> These
        files are end-to-end encrypted — the decryption key only exists
        in your URL (the part after <code>#</code>), so our servers can't
        read your files. Anyone with the full URL can decrypt them, so
        treat it like a password. If you weren't expecting this email
        or you don't recognize {meta.sender_name || meta.sender_addr},
        don't download anything — close the page.
      </div>

      <h2 className="label mb-2">
        files ({meta.files.length}, {formatBytes(meta.total_bytes)} encrypted on R2)
      </h2>
      <ul className="hair-all divide-y">
        {meta.files.map((f) => {
          const st = fileStates[f.r2_key] ?? { kind: 'idle' };
          return (
            <li
              key={f.r2_key}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0">
                <span
                  className="block truncate font-mono text-sm"
                  title={f.filename}
                >
                  {f.filename}
                </span>
                <span className="text-mute text-xs">
                  {formatBytes(f.plaintext_size)} ·{' '}
                  {f.mime || 'application/octet-stream'}
                </span>
                {st.kind === 'loading' && (
                  <span className="text-mute mt-1 block text-xs">
                    {formatBytes(st.loaded)} / {formatBytes(st.total)} (
                    {((st.loaded / st.total) * 100).toFixed(0)}%)
                  </span>
                )}
                {st.kind === 'error' && (
                  <span className="mt-1 block text-xs text-red-600">
                    {st.message}
                  </span>
                )}
              </span>
              <button
                className="btn btn-primary label py-1 px-3 text-xs"
                disabled={st.kind === 'loading'}
                onClick={() => void downloadFile(f)}
              >
                {st.kind === 'loading'
                  ? 'decrypting…'
                  : st.kind === 'ready'
                    ? 'download again'
                    : 'download'}
              </button>
            </li>
          );
        })}
      </ul>

      {meta.download_count > 0 && (
        <p className="text-mute mt-3 text-xs">
          downloaded {meta.download_count} time
          {meta.download_count === 1 ? '' : 's'} so far.
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto my-10 max-w-2xl px-4">
      <div className="hair-all bg-white p-4">
        <div className="text-mute mb-2 font-mono text-[10px] uppercase tracking-widest">
          bmail · encrypted download
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
