/**
 * The one true upload helper. Mirrors `worker/src/api/uploads.rs`:
 * pick a `kind` (`attach` / `hosted` / `secret`), pass a Blob (or a
 * function that produces per-chunk bytes for encrypted flows), and
 * this drives the multipart R2 upload to completion.
 *
 * Peak browser memory is one chunk (~5 MiB) regardless of file size —
 * we slice the source Blob lazily via `Blob.slice` + `arrayBuffer`.
 *
 * Single-shot uploads aren't a special case at the API level: we just
 * use multipart with one part, which R2 permits when the part is the
 * final/only one.
 */

import { asAB } from './b64';

export type UploadKind = 'attach' | 'hosted' | 'secret';

/** Plaintext chunk size: 5 MiB, the R2 multipart non-final minimum.
 *  Each chunk becomes one R2 part. Last chunk may be smaller. */
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

export type UploadProgress = (loaded: number, total: number) => void;

/** Optional per-chunk transform — used by the secret-link encrypted
 *  flow to wrap each plaintext chunk in the framed AEAD ciphertext
 *  format before it leaves the browser. For non-encrypted flows, omit
 *  this and bytes upload as-is. */
export type ChunkTransform = (
  plaintext: Uint8Array,
  chunkIndex: number,
  isFinal: boolean,
) => Uint8Array;

export interface UploadResult {
  r2_key: string;
  /** Total ciphertext bytes uploaded to R2 (may be larger than the
   *  plaintext input if `transform` adds AEAD overhead per chunk). */
  size: number;
  /** Only present for `kind=attach` — the MailboxDO attachment row id
   *  registered by the worker at /complete. */
  attachment_id?: string;
  /** Total plaintext bytes consumed (the size of the input). */
  plaintext_size: number;
  /** Uniform plaintext chunk size used during this upload. */
  chunk_size: number;
  /** Number of chunks (and R2 parts). */
  chunk_count: number;
}

export interface UploadOpts {
  kind: UploadKind;
  /** The source bytes. Blob is preferred for large files (lazy
   *  slicing); Uint8Array is wrapped in a Blob internally. */
  source: Blob | Uint8Array;
  /** Real mime of the source. For encrypted flows, the worker stores
   *  "application/octet-stream" on R2 regardless — this field is just
   *  for the post-complete metadata (the `attach` flow records mime on
   *  the MailboxDO row so outbound MIME assembly can include it). */
  mime: string;
  /** Per-chunk transform — encrypted flows pass an encryption fn. */
  transform?: ChunkTransform;
  /** For `kind=attach` only: the sealed filename to store on the
   *  MailboxDO row. The plaintext filename leaves the browser only via
   *  outbound MIME headers when the message is sent. */
  filenameCtB64?: string;
  /** For `kind=attach` only: associate with a draft so autosave
   *  cleanup can find it. Optional. */
  draftId?: string | null;
  /** Progress reporter — reports plaintext bytes processed. */
  onProgress?: UploadProgress;
}

interface InitResp {
  r2_key: string;
  upload_id: string;
}
interface PartResp {
  part_number: number;
  etag: string;
}
interface CompleteResp {
  r2_key: string;
  size: number;
  attachment_id?: string;
}

export async function uploadFile(opts: UploadOpts): Promise<UploadResult> {
  const blob: Blob =
    opts.source instanceof Blob
      ? opts.source
      : new Blob([asAB(opts.source)], { type: opts.mime });
  const plaintextSize = blob.size;
  const chunkSize = UPLOAD_CHUNK_BYTES;
  const chunkCount = Math.max(1, Math.ceil(plaintextSize / chunkSize));

  const init = await postJson<InitResp>('/api/uploads/init', {
    kind: opts.kind,
    mime: opts.mime || 'application/octet-stream',
  });

  const parts: { part_number: number; etag: string }[] = [];
  let totalCiphertext = 0;
  let loaded = 0;
  try {
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, plaintextSize);
      const slice = blob.slice(start, end);
      const plaintext = new Uint8Array(await slice.arrayBuffer());
      const isFinal = i === chunkCount - 1;
      const wire = opts.transform
        ? opts.transform(plaintext, i, isFinal)
        : plaintext;
      totalCiphertext += wire.length;
      const partNumber = i + 1; // R2 part numbers are 1-indexed.
      const resp = await fetch('/api/uploads/parts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-r2-key': init.r2_key,
          'x-upload-id': init.upload_id,
          'x-part-number': String(partNumber),
          'content-type': 'application/octet-stream',
        },
        body: asAB(wire),
      });
      if (!resp.ok) {
        throw new Error(`part ${partNumber} failed (${resp.status})`);
      }
      const p = (await resp.json()) as PartResp;
      parts.push({ part_number: p.part_number, etag: p.etag });
      loaded += plaintext.length;
      opts.onProgress?.(loaded, plaintextSize);
    }
    const complete = await postJson<CompleteResp>(
      '/api/uploads/complete',
      {
        r2_key: init.r2_key,
        upload_id: init.upload_id,
        parts,
        size: totalCiphertext,
        ...(opts.kind === 'attach' && {
          filename_ct_b64: opts.filenameCtB64 ?? null,
          mime: opts.mime,
          draft_id: opts.draftId ?? null,
        }),
      },
    );
    return {
      r2_key: complete.r2_key,
      size: complete.size,
      attachment_id: complete.attachment_id,
      plaintext_size: plaintextSize,
      chunk_size: chunkSize,
      chunk_count: chunkCount,
    };
  } catch (e) {
    // Best-effort abort so we don't leak an in-flight multipart upload.
    // R2's own multipart auto-cleanup eventually catches abandoned
    // ones, but explicit abort is cheaper and frees the slot now.
    try {
      await postJson('/api/uploads/abort', {
        r2_key: init.r2_key,
        upload_id: init.upload_id,
      });
    } catch {
      /* swallow — main error is what matters */
    }
    throw e;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = j.error || msg;
    } catch {
      /* keep statusText */
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  return (await r.json()) as T;
}
