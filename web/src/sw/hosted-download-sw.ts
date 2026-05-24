/**
 * Streaming-download service worker for hosted (E2E) attachments.
 *
 * Why this exists: FileSystem Access API is Chromium-only at the
 * scale we care about. For Firefox + Safari users on multi-GB
 * downloads, the in-memory Blob path would OOM. The
 * service-worker-streams pattern (popularized by Mozilla's StreamSaver)
 * lets us hand the browser a streaming Response body whose chunks
 * are produced lazily — same memory profile as a server-side
 * stream, but the decrypt happens here in the SW.
 *
 * Flow:
 *
 *   1. Main thread `postMessage({type:'init', id, config})` to SW.
 *   2. Main thread anchors / navigates to `/sw-download/<id>`.
 *   3. SW fetch handler matches the URL, looks up config in
 *      PENDING, builds a ReadableStream that pulls ciphertext from
 *      /api/d/:token/file (with Range) chunk-by-chunk, decrypts via
 *      the same chunked AEAD format the rest of the app uses, and
 *      enqueues plaintext.
 *   4. Browser sees a normal `Content-Disposition: attachment`
 *      response and streams it to disk.
 *
 * Self-cleaning: PENDING entries TTL after 5 minutes. The SW would
 * normally outlive a single download but we don't want stale
 * configs lingering if the navigation never lands.
 */

/// <reference lib="webworker" />

import { decryptChunk, SECRET_CHUNK_OVERHEAD } from '@/lib/secret-link';
import { b64uDecode } from '@/lib/b64';

declare const self: ServiceWorkerGlobalScope;

interface DownloadConfig {
  token: string;
  r2_key: string;
  cek_b64: string;
  filename: string;
  mime: string;
  plaintext_size: number;
  chunk_size: number;
  chunk_count: number;
  /** When this config was registered (ms epoch). Used for TTL. */
  registered_at: number;
}

const PENDING: Map<string, DownloadConfig> = new Map();
const CONFIG_TTL_MS = 5 * 60 * 1000;

/** Lifecycle: claim clients immediately so the SW takes effect on
 *  first install without requiring a reload. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Receive download configs from the main thread. We trust the
 *  config blindly because (a) the SW shares an origin with the page
 *  that posted it, and (b) the worst a malicious config can do is
 *  fetch + decrypt blobs the page itself could already fetch. */
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; id?: string; config?: DownloadConfig };
  if (data?.type === 'init' && data.id && data.config) {
    PENDING.set(data.id, { ...data.config, registered_at: Date.now() });
    // Opportunistic GC on every init — keeps PENDING bounded without
    // a separate timer.
    const cutoff = Date.now() - CONFIG_TTL_MS;
    for (const [k, v] of PENDING.entries()) {
      if (v.registered_at < cutoff) PENDING.delete(k);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const match = url.pathname.match(/^\/sw-download\/([^/]+)$/);
  if (!match) return;
  const id = match[1];
  const config = PENDING.get(id);
  if (!config) {
    event.respondWith(
      new Response('download not found (config expired or never registered)', {
        status: 404,
      }),
    );
    return;
  }
  // One-shot: pop the config so a second navigation doesn't double
  // up. The SW keeps the local `config` reference for the lifetime
  // of the stream.
  PENDING.delete(id);
  event.respondWith(buildStreamingResponse(config));
});

function buildStreamingResponse(config: DownloadConfig): Response {
  const cek = b64uDecode(config.cek_b64);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Bookkeeping: which chunk are we on. `pull` is called when
      // the consumer wants more — perfect for our chunk-at-a-time
      // model. We close the stream after the final chunk.
      const state = controllerState.get(controller) ?? { nextChunk: 0 };
      controllerState.set(controller, state);
      const i = state.nextChunk;
      if (i >= config.chunk_count) {
        controller.close();
        return;
      }
      const isFinal = i === config.chunk_count - 1;
      const thisChunkPlaintext = isFinal
        ? config.plaintext_size - i * config.chunk_size
        : config.chunk_size;
      const offset = i * (config.chunk_size + SECRET_CHUNK_OVERHEAD);
      const length = thisChunkPlaintext + SECRET_CHUNK_OVERHEAD;
      try {
        const ct = await fetchRange(
          config.token,
          config.r2_key,
          offset,
          length,
        );
        const dec = decryptChunk(cek, ct, i);
        if (dec.isFinal !== isFinal) {
          throw new Error(`chunk ${i} final flag mismatch`);
        }
        controller.enqueue(dec.plaintext);
        state.nextChunk = i + 1;
      } catch (e) {
        controller.error(e);
        controllerState.delete(controller);
      }
    },
    cancel() {
      // User cancelled the download in the browser — just clear
      // bookkeeping; the per-chunk fetch will be aborted naturally
      // as the stream goes away.
    },
  });
  const headers = new Headers({
    'content-type': config.mime || 'application/octet-stream',
    'content-length': String(config.plaintext_size),
    'content-disposition': `attachment; filename="${sanitizeFilename(config.filename)}"`,
    // Disable the response from being cached — it's a synthetic
    // stream tied to one specific (token, fragment-key) pair.
    'cache-control': 'no-store',
  });
  return new Response(stream, { status: 200, headers });
}

/** Per-stream state — `pull` doesn't get an explicit chunk index so
 *  we keep a side-table keyed by the controller. The stream's
 *  closure pins this Map entry until cancel/close. */
const controllerState: WeakMap<
  ReadableStreamDefaultController<Uint8Array>,
  { nextChunk: number }
> = new WeakMap();

async function fetchRange(
  token: string,
  r2_key: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const qs = new URLSearchParams({ r2_key });
  const resp = await fetch(
    `/api/d/${encodeURIComponent(token)}/file?${qs.toString()}`,
    {
      method: 'GET',
      headers: { range: `bytes=${offset}-${offset + length - 1}` },
      // SW fetches default to no-credentials, which is what we want
      // here — the public download endpoint requires none.
      credentials: 'omit',
    },
  );
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`hosted chunk fetch failed (${resp.status})`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function sanitizeFilename(name: string): string {
  // Inside `filename="..."` only `"` and `\` are unsafe; line breaks
  // would also break the header. Strip rather than encode — the
  // server-side download path takes the same approach.
  return name.replace(/[\r\n"\\]/g, '');
}
