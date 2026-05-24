/**
 * Client-side helpers for end-to-end encrypted hosted downloads
 * (Firefox Send / Wormhole.app model).
 *
 * The decryption key (CEK) is generated client-side and travels in
 * the URL fragment after `#`. Browsers never transmit fragments to
 * servers, so the worker has no way to learn the CEK or decrypt the
 * stored ciphertext.
 *
 * URL shape:
 *
 *   https://mail.middleseat.vc/d/<token>#k=<base64url(cek)>
 *                                 ^^^^^^^^^^^^^^^^^^^^^^^
 *                                 never sent to the server
 */

import { b64uDecode, b64uEncode } from './b64';
import { encryptChunk, decryptChunk, SECRET_CHUNK_OVERHEAD } from './secret-link';
import { uploadFile } from './uploads';
import type { UploadProgress } from './secret-link';
import type { Schemas } from './api-typed';

/** Random 256-bit CEK — drives all per-link encryption. */
export function newHostedCek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Encode a CEK into the URL fragment payload (no `#`, no `k=` prefix —
 *  caller composes the full URL). */
export function encodeCekFragment(cek: Uint8Array): string {
  return `k=${b64uEncode(cek)}`;
}

/** Parse the CEK back out of a URL fragment. Returns null if the
 *  fragment is missing or malformed — viewer renders a "needs key"
 *  error in that case. */
export function decodeCekFragment(hash: string): Uint8Array | null {
  // Strip the leading '#' (browsers include it in location.hash).
  const s = hash.startsWith('#') ? hash.slice(1) : hash;
  // Permit either `k=<key>` or just the bare base64url to be lenient
  // about how the URL was hand-typed or pasted.
  const v = s.startsWith('k=') ? s.slice(2) : s;
  if (!v) return null;
  try {
    const bytes = b64uDecode(v);
    if (bytes.length !== 32) return null;
    return bytes;
  } catch {
    return null;
  }
}

// ---- upload (sender-side) --------------------------------------------------

export interface HostedAttachmentInput {
  filename: string;
  mime: string;
  /** Source bytes. Pass a File/Blob for streaming; Uint8Array is
   *  wrapped in a Blob internally. */
  file?: Blob;
  bytes?: Uint8Array;
}

export interface PreparedHostedFile {
  r2_key: string;
  size: number;
  plaintext_size: number;
  chunk_size: number;
  chunk_count: number;
  /** Cleartext — surfaced in the sender dashboard and the
   *  recipient's pre-download preview. File *contents* on R2 stay
   *  encrypted; the filename trade is "useful UX" vs "metadata
   *  privacy from R2 breach." See the rationale on the worker-side
   *  struct in api/hosted.rs. */
  filename: string;
  mime: string;
}

/** Upload a single attachment encrypted under the given CEK. Mirrors
 *  `secret-link.uploadAttachmentChunked` but writes to the
 *  `hosted/...` R2 prefix and skips the secret-link create call. */
export async function uploadHostedFile(opts: {
  input: HostedAttachmentInput;
  cek: Uint8Array;
  onProgress?: UploadProgress;
}): Promise<PreparedHostedFile> {
  const source: Blob | Uint8Array =
    opts.input.file ?? opts.input.bytes ?? new Uint8Array();
  const result = await uploadFile({
    kind: 'hosted',
    source,
    mime: 'application/octet-stream',
    transform: (plaintext, idx, isFinal) =>
      encryptChunk(opts.cek, plaintext, idx, isFinal),
    onProgress: opts.onProgress,
  });
  return {
    r2_key: result.r2_key,
    size: result.size,
    plaintext_size: result.plaintext_size,
    chunk_size: result.chunk_size,
    chunk_count: result.chunk_count,
    filename: opts.input.filename,
    mime: opts.input.mime || 'application/octet-stream',
  };
}

/** Request payload for `POST /api/hosted/create`. Sourced from the
 *  OpenAPI spec so any worker-side schema change shows up as a TS
 *  error here on the next `make openapi`. */
export type CreateHostedReq = Schemas['HostedCreateReq'];

export type CreateHostedResp = Schemas['HostedCreateResp'];

/** POST /api/hosted/create. Caller is responsible for combining
 *  `url_prefix` + `'#' + encodeCekFragment(cek)` into the final
 *  share URL — the server never sees the CEK. */
export async function createHostedLink(
  body: CreateHostedReq,
): Promise<CreateHostedResp> {
  const r = await fetch('/api/hosted/create', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error || msg;
    } catch {
      /* keep statusText */
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return (await r.json()) as CreateHostedResp;
}

// ---- viewer-side (recipient) -----------------------------------------------

/** Manifest entry returned by `GET /api/d/:token`. Same shape as the
 *  uploader writes via `PreparedHostedFile`. */
export interface HostedFileManifest {
  r2_key: string;
  size: number;
  plaintext_size: number;
  chunk_size: number;
  chunk_count: number;
  filename: string;
  mime: string;
}

/** Decrypt one chunk of a hosted file at the given index. Caller
 *  provides the ciphertext bytes already fetched via ranged GET. */
export function decryptHostedChunk(
  cek: Uint8Array,
  ciphertext: Uint8Array,
  chunkIndex: number,
  isFinal: boolean,
): Uint8Array {
  const dec = decryptChunk(cek, ciphertext, chunkIndex);
  if (dec.isFinal !== isFinal) {
    throw new Error(`chunk ${chunkIndex} final flag mismatch — possible tampering`);
  }
  return dec.plaintext;
}

/** Compute the encrypted byte range for chunk `i` of a hosted file.
 *  Used by both the buffered and streaming download paths. */
export function chunkRange(
  manifest: HostedFileManifest,
  i: number,
): { offset: number; length: number; plaintextLength: number; isFinal: boolean } {
  const isFinal = i === manifest.chunk_count - 1;
  const plaintextLength = isFinal
    ? manifest.plaintext_size - i * manifest.chunk_size
    : manifest.chunk_size;
  return {
    offset: i * (manifest.chunk_size + SECRET_CHUNK_OVERHEAD),
    length: plaintextLength + SECRET_CHUNK_OVERHEAD,
    plaintextLength,
    isFinal,
  };
}

/** Buffered download path: fetch every chunk into memory, decrypt,
 *  return the full plaintext. Used by the memory-fallback download
 *  in `HostedView` when the FileSystem Access API isn't available
 *  (Firefox / Safari). Streaming path uses `fetchHostedChunk` + an
 *  external write target instead. */
export async function fetchHostedFile(opts: {
  token: string;
  manifest: HostedFileManifest;
  cek: Uint8Array;
  onProgress?: UploadProgress;
}): Promise<Uint8Array> {
  const m = opts.manifest;
  const out = new Uint8Array(m.plaintext_size);
  let writeOffset = 0;
  for (let i = 0; i < m.chunk_count; i++) {
    const range = chunkRange(m, i);
    const ct = await fetchRange(opts.token, m.r2_key, range.offset, range.length);
    const plaintext = decryptHostedChunk(opts.cek, ct, i, range.isFinal);
    out.set(plaintext, writeOffset);
    writeOffset += plaintext.length;
    opts.onProgress?.(writeOffset, m.plaintext_size);
  }
  if (writeOffset !== m.plaintext_size) {
    throw new Error('hosted file size mismatch');
  }
  return out;
}

/** Streaming download path: fetch + decrypt one chunk at a time,
 *  delivering plaintext to a caller-provided write callback. The
 *  caller wires `writeChunk` to either a `FileSystemWritableFileStream`
 *  (for true streaming to disk) or a chunk accumulator. Peak browser
 *  memory ≈ one chunk regardless of total file size. */
export async function streamHostedFile(opts: {
  token: string;
  manifest: HostedFileManifest;
  cek: Uint8Array;
  writeChunk: (plaintext: Uint8Array) => Promise<void>;
  onProgress?: UploadProgress;
}): Promise<void> {
  const m = opts.manifest;
  let loaded = 0;
  for (let i = 0; i < m.chunk_count; i++) {
    const range = chunkRange(m, i);
    const ct = await fetchRange(opts.token, m.r2_key, range.offset, range.length);
    const plaintext = decryptHostedChunk(opts.cek, ct, i, range.isFinal);
    await opts.writeChunk(plaintext);
    loaded += plaintext.length;
    opts.onProgress?.(loaded, m.plaintext_size);
  }
}

async function fetchRange(
  token: string,
  r2_key: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const qs = new URLSearchParams({ r2_key });
  const headers: Record<string, string> = {
    range: `bytes=${offset}-${offset + length - 1}`,
  };
  const r = await fetch(
    `/api/d/${encodeURIComponent(token)}/file?${qs.toString()}`,
    { method: 'GET', headers, credentials: 'omit' },
  );
  if (!r.ok && r.status !== 206) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error || msg;
    } catch {
      /* binary body */
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

/** Build the share URL the sender hands to the recipient (or which
 *  Compose splices into the outbound email body). The CEK lives in
 *  the URL fragment so it never reaches the server. */
export function buildShareUrl(urlPrefix: string, cek: Uint8Array): string {
  return `${urlPrefix}#${encodeCekFragment(cek)}`;
}

/** Browser download helper — synthesizes a click on a hidden `<a download>`.
 *  Caller owns lifecycle of the object URL (revoke when no longer needed). */
export function triggerBrowserDownload(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}

// ---- service-worker streaming download -------------------------------------

const SW_PATH = '/sw-download.js';
let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register (or reuse) the streaming-download service worker. Returns
 *  null when SW isn't available (e.g. dev mode, browsers with SW
 *  disabled, or insecure contexts). Caller falls back to the buffered
 *  download path when this returns null. */
export async function ensureDownloadServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  // Only enable in production builds — dev mode doesn't bundle the SW
  // and the registration would 404. See vite.config.ts for the
  // separate rollup entry that emits sw-download.js.
  if (import.meta.env?.DEV) return null;
  if (swRegistrationPromise) return swRegistrationPromise;
  swRegistrationPromise = (async () => {
    try {
      const reg = await navigator.serviceWorker.register(SW_PATH, {
        scope: '/',
        type: 'module',
      });
      // Wait until the worker is in `activated` so the first download
      // doesn't race the activation event.
      const sw = reg.active ?? reg.waiting ?? reg.installing;
      if (sw && sw.state !== 'activated') {
        await new Promise<void>((resolve) => {
          const onChange = () => {
            if (sw.state === 'activated') {
              sw.removeEventListener('statechange', onChange);
              resolve();
            }
          };
          sw.addEventListener('statechange', onChange);
        });
      }
      return reg;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('hosted-download SW registration failed:', e);
      return null;
    }
  })();
  return swRegistrationPromise;
}

/** Stream a hosted file to disk via the SW. The browser receives a
 *  normal streaming Response under the synthetic `/sw-download/<id>`
 *  URL and writes it as the user's saved file. No bytes pass through
 *  JS heap memory — peak browser memory ≈ one decrypted chunk
 *  (~5 MiB) regardless of total size.
 *
 *  Caller is responsible for falling back when this returns false
 *  (no SW available). */
export async function streamHostedFileViaServiceWorker(opts: {
  token: string;
  manifest: HostedFileManifest;
  cek: Uint8Array;
}): Promise<boolean> {
  const reg = await ensureDownloadServiceWorker();
  if (!reg) return false;
  const target = reg.active ?? navigator.serviceWorker.controller;
  if (!target) return false;

  const id =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  target.postMessage({
    type: 'init',
    id,
    config: {
      token: opts.token,
      r2_key: opts.manifest.r2_key,
      cek_b64: b64uEncode(opts.cek),
      filename: opts.manifest.filename,
      mime: opts.manifest.mime || 'application/octet-stream',
      plaintext_size: opts.manifest.plaintext_size,
      chunk_size: opts.manifest.chunk_size,
      chunk_count: opts.manifest.chunk_count,
    },
  });

  // A hidden iframe pointed at the synthetic URL triggers the
  // SW-mediated download without a top-level navigation (which
  // would unload the page). Browsers treat the streaming Response's
  // `Content-Disposition: attachment` as a download trigger inside
  // the iframe context.
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = `/sw-download/${encodeURIComponent(id)}`;
  document.body.appendChild(iframe);
  // Remove the iframe after a generous delay so its document is
  // fully torn down. The download itself is handed off to the
  // browser at this point and isn't bound to the iframe lifetime.
  window.setTimeout(() => iframe.remove(), 60_000);
  return true;
}
