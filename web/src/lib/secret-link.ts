/**
 * Client-side crypto for password-protected secret links.
 *
 * Mirrors the server-side model in `worker/src/api/secret.rs`. Three
 * primitives:
 *
 *   1. CEK — a random 32-byte content-encryption key. Encrypts the subject,
 *      body, and each attachment under XChaCha20-Poly1305 (nonce-prefixed
 *      wire format: nonce(24) ‖ ct+tag).
 *
 *   2. Password-derived material. Argon2id(password, salt) produces 32B of
 *      output, then HKDF splits it into two domain-separated keys:
 *        - `check`   — sent to the server, compared against the stored
 *                      `password_check` to gate access.
 *        - `wrapKey` — AES-GCM-256 key, used to wrap the CEK.
 *      The split is what lets the server check the password without ever
 *      learning a key that decrypts content.
 *
 *   3. `password_wrap` = AES-GCM(CEK, wrapKey). Server stores this, returns
 *      it on a successful open, and the viewer unwraps locally with its
 *      derived wrapKey to recover the CEK.
 */

import { argon2id } from '@noble/hashes/argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { asAB, b64uDecode, b64uEncode, utf8 } from './b64';
import { uploadFile } from './uploads';

const ARGON_PARAMS = {
  algorithm: 'argon2id' as const,
  version: 19,
  m: 65536, // KiB → 64 MiB
  t: 3,
  p: 4,
  hash_len: 32,
};

export interface KdfParams {
  algorithm: 'argon2id';
  version: number;
  m: number;
  t: number;
  p: number;
  hash_len: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { ...ARGON_PARAMS };

/** Mirrored from `worker/src/api/secret.rs::SECRET_MAX_LINK_BYTES`. Used
 *  for client-side pre-flight so a user uploading a multi-hundred-MB
 *  payload sees the error before the upload starts. */
export const SECRET_MAX_LINK_BYTES = 256 * 1024 * 1024;
/** Mirrored from `SECRET_MAX_PER_ATTACHMENT_BYTES` — keep in sync.
 *  Applies only to the single-shot `/api/secret/attachments` endpoint;
 *  the multipart-upload path can ingest arbitrarily large files
 *  (capped by `SECRET_MAX_LINK_BYTES`). */
export const SECRET_MAX_PER_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** R2's multipart-part floor. Every non-final ciphertext chunk we
 *  upload must be ≥ this many bytes. We pick the plaintext chunk size
 *  so that ciphertext + 44 bytes overhead lands just above the floor. */
export const SECRET_CHUNK_PLAINTEXT_BYTES = 5 * 1024 * 1024;
/** Per-chunk wire-format overhead: 4 bytes framing header + 24 bytes
 *  nonce + 16 bytes AEAD tag. */
export const SECRET_CHUNK_OVERHEAD = 4 + 24 + 16;
/** Threshold above which the client switches from single-shot upload
 *  (raw ciphertext PUT to /api/secret/attachments) to R2 multipart
 *  (POST /api/secret/uploads + per-part). Below 5 MiB we can't multipart
 *  anyway (R2 rejects sub-5-MiB parts unless they're final), so anything
 *  in that range goes single-shot. */
export const SECRET_MULTIPART_THRESHOLD = SECRET_CHUNK_PLAINTEXT_BYTES;

// ---- chunked AEAD framing -------------------------------------------------
//
// Wire layout per chunk:
//
//   [ 4 bytes header ] [ 24 bytes nonce ] [ N bytes ciphertext+tag ]
//
// Header layout (big-endian u32):
//   - bit 31:        final flag (1 = last chunk of file)
//   - bits 0..30:    plaintext length (max 2 GiB; we use ≤ 5 MiB in practice)
//
// AAD per chunk: [ u32 chunk_index (big-endian) ] [ u8 final_flag ]
//
// The AAD binds each chunk to its position in the stream, so an
// attacker can't reorder or drop the final chunk without breaking
// AEAD authentication.

function aadFor(chunkIndex: number, isFinal: boolean): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = (chunkIndex >>> 24) & 0xff;
  out[1] = (chunkIndex >>> 16) & 0xff;
  out[2] = (chunkIndex >>> 8) & 0xff;
  out[3] = chunkIndex & 0xff;
  out[4] = isFinal ? 1 : 0;
  return out;
}

export function encryptChunk(
  cek: Uint8Array,
  plaintext: Uint8Array,
  chunkIndex: number,
  isFinal: boolean,
): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const cipher = xchacha20poly1305(cek, nonce, aadFor(chunkIndex, isFinal));
  const ct = cipher.encrypt(plaintext);
  const header = new Uint8Array(4);
  const finalBit = isFinal ? 0x80 : 0x00;
  header[0] = ((plaintext.length >>> 24) & 0x7f) | finalBit;
  header[1] = (plaintext.length >>> 16) & 0xff;
  header[2] = (plaintext.length >>> 8) & 0xff;
  header[3] = plaintext.length & 0xff;
  const out = new Uint8Array(4 + 24 + ct.length);
  out.set(header, 0);
  out.set(nonce, 4);
  out.set(ct, 28);
  return out;
}

export interface ParsedChunkHeader {
  plaintextLength: number;
  isFinal: boolean;
  encryptedLength: number;
}

export function parseChunkHeader(header: Uint8Array): ParsedChunkHeader {
  if (header.length < 4) throw new Error('chunk header truncated');
  const isFinal = (header[0] & 0x80) !== 0;
  const plaintextLength =
    ((header[0] & 0x7f) << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
  return {
    plaintextLength,
    isFinal,
    encryptedLength: 4 + 24 + plaintextLength + 16,
  };
}

export function decryptChunk(
  cek: Uint8Array,
  encryptedChunk: Uint8Array,
  expectedIndex: number,
): { plaintext: Uint8Array; isFinal: boolean } {
  const header = parseChunkHeader(encryptedChunk);
  if (encryptedChunk.length < header.encryptedLength) {
    throw new Error(
      `chunk truncated: have ${encryptedChunk.length}, need ${header.encryptedLength}`,
    );
  }
  const nonce = encryptedChunk.subarray(4, 28);
  const ct = encryptedChunk.subarray(28, header.encryptedLength);
  const cipher = xchacha20poly1305(cek, nonce, aadFor(expectedIndex, header.isFinal));
  const plaintext = cipher.decrypt(ct);
  if (plaintext.length !== header.plaintextLength) {
    throw new Error('plaintext length mismatch');
  }
  return { plaintext, isFinal: header.isFinal };
}

export function newSalt(bytes = 16): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

export function newCek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Argon2id(password, salt) → 32B. Long-running on weak devices (~hundreds
 *  of ms at the chosen params). Callers should show a "deriving…" spinner. */
export function deriveArgonOutput(
  password: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Uint8Array {
  return argon2id(utf8(password.normalize('NFKC')), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: params.hash_len,
  });
}

/** HKDF-split the Argon2id output into the server-check value and the
 *  AES-GCM wrap key. Domain separation is what keeps `password_check` from
 *  being usable to decrypt anything if the server's DB is leaked. */
export function deriveCheckAndWrap(argonOutput: Uint8Array): {
  check: Uint8Array;
  wrapKeyBytes: Uint8Array;
} {
  const check = hkdf(sha256, argonOutput, undefined, utf8('cfemail/secret-link/check/v1'), 32);
  const wrapKeyBytes = hkdf(sha256, argonOutput, undefined, utf8('cfemail/secret-link/wrap/v1'), 32);
  return { check, wrapKeyBytes };
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asAB(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM wrap the CEK under the password-derived wrap key. Wire layout:
 *  iv(12) ‖ ct+tag. */
export async function wrapCek(cek: Uint8Array, wrapKeyBytes: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(wrapKeyBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, asAB(cek)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

export async function unwrapCek(
  wrapped: Uint8Array,
  wrapKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(wrapKeyBytes);
  const iv = new Uint8Array(wrapped.subarray(0, 12));
  const ct = new Uint8Array(wrapped.subarray(12));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

/** XChaCha20-Poly1305 encrypt under the CEK. Wire layout: nonce(24) ‖ ct+tag. */
export function encryptWithCek(cek: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const cipher = xchacha20poly1305(cek, nonce);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return out;
}

export function decryptWithCek(cek: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < 24 + 16) throw new Error('ciphertext too short');
  const nonce = blob.subarray(0, 24);
  const ct = blob.subarray(24);
  const cipher = xchacha20poly1305(cek, nonce);
  return cipher.decrypt(ct);
}

// -- High-level helpers used by Compose and the public viewer -------------

export type SecretPolicy = 'one_time' | '1h' | '24h' | '14d' | 'never';

export interface SecretAttachmentInput {
  filename: string;
  mime: string;
  /** Plaintext bytes OR a File handle for streaming uploads. Files
   *  larger than SECRET_MULTIPART_THRESHOLD MUST come in via `file`
   *  so we don't have to hold them all in memory; bytes-mode is fine
   *  for small attachments. */
  bytes?: Uint8Array;
  file?: Blob;
}

export interface PreparedAttachment {
  r2_key: string;
  mime: string;
  /** Total ciphertext bytes uploaded to R2. */
  size: number;
  filename_ct_b64: string;
  /** Total plaintext bytes — used by the viewer to know how big the
   *  decoded file will be. */
  plaintext_size: number;
  /** Uniform plaintext chunk size (last chunk may be smaller). */
  chunk_size: number;
  /** Number of chunks; >= 1. */
  chunk_count: number;
}

/** Per-chunk progress callback. `loaded` and `total` are plaintext bytes
 *  so the UI can show a meaningful percentage. */
export type UploadProgress = (loaded: number, total: number) => void;

/** Upload one attachment to R2 using the unified upload pipeline,
 *  encrypting each plaintext chunk with the secret-link CEK before it
 *  leaves the browser. Delegates the multipart machinery to
 *  `uploads.uploadFile` and just passes an `encryptChunk` transform —
 *  this keeps the encrypted and non-encrypted upload paths sharing the
 *  same code in both server and client.
 */
export async function uploadAttachmentChunked(opts: {
  input: SecretAttachmentInput;
  cek: Uint8Array;
  onProgress?: UploadProgress;
}): Promise<PreparedAttachment> {
  const source: Blob | Uint8Array =
    opts.input.file ?? opts.input.bytes ?? new Uint8Array();
  const filenameCt = encryptChunk(opts.cek, utf8(opts.input.filename), 0, true);
  const result = await uploadFile({
    kind: 'secret',
    source,
    mime: opts.input.mime || 'application/octet-stream',
    transform: (plaintext, idx, isFinal) =>
      encryptChunk(opts.cek, plaintext, idx, isFinal),
    onProgress: opts.onProgress,
  });
  return {
    r2_key: result.r2_key,
    mime: opts.input.mime || 'application/octet-stream',
    size: result.size,
    filename_ct_b64: b64uEncode(filenameCt),
    plaintext_size: result.plaintext_size,
    chunk_size: result.chunk_size,
    chunk_count: result.chunk_count,
  };
}

/** Prepare the create-request payload from plaintext inputs. Uploads
 *  every attachment via `uploadAttachmentChunked`, then returns the
 *  payload for the /api/secret/create call.
 *
 *  `onProgress` reports plaintext bytes across all attachments — the UI
 *  shows aggregate progress so a 10-file upload doesn't bounce per file. */
export async function prepareCreateRequest(opts: {
  password: string;
  subject: string;
  body: string;
  attachments: SecretAttachmentInput[];
  /** Email recipient for the compose flow. Omit when generating a
   *  share-only link with no email. */
  recipient?: string | null;
  hint?: string | null;
  policy: SecretPolicy;
  onProgress?: UploadProgress;
}): Promise<{
  recipient: string | null;
  hint: string | null;
  policy: SecretPolicy;
  argon_salt_b64: string;
  kdf_params: string;
  password_check_b64: string;
  password_wrap_b64: string;
  subject_ct_b64: string;
  body_ct_b64: string;
  attachments: PreparedAttachment[];
}> {
  const salt = newSalt();
  const argonOut = deriveArgonOutput(opts.password, salt);
  const { check, wrapKeyBytes } = deriveCheckAndWrap(argonOut);
  const cek = newCek();
  const passwordWrap = await wrapCek(cek, wrapKeyBytes);

  // Subject and body stay in the single-blob format — they're tiny and
  // the create endpoint already inlines them on the secret_links row.
  const subjectCt = encryptWithCek(cek, utf8(opts.subject));
  const bodyCt = encryptWithCek(cek, utf8(opts.body));

  const totalPlaintext = opts.attachments.reduce(
    (n, a) => n + (a.file ? a.file.size : a.bytes?.length ?? 0),
    0,
  );
  let cumulative = 0;
  const prepared: PreparedAttachment[] = [];
  for (const input of opts.attachments) {
    const meta = await uploadAttachmentChunked({
      input,
      cek,
      onProgress: (loaded, total) => {
        opts.onProgress?.(cumulative + loaded, totalPlaintext);
        if (loaded === total) cumulative += total;
      },
    });
    prepared.push(meta);
  }

  return {
    recipient: opts.recipient ?? null,
    hint: opts.hint ?? null,
    policy: opts.policy,
    argon_salt_b64: b64uEncode(salt),
    kdf_params: JSON.stringify(DEFAULT_KDF_PARAMS),
    password_check_b64: b64uEncode(check),
    password_wrap_b64: b64uEncode(passwordWrap),
    subject_ct_b64: b64uEncode(subjectCt),
    body_ct_b64: b64uEncode(bodyCt),
    attachments: prepared,
  };
}

// -- Viewer-side: turn a password + /open response into plaintext --------

/** Per-attachment manifest entry returned by /open. Bytes live in R2
 *  keyed by `r2_key` — fetch with `fetchAttachment` only when the user
 *  actually wants the file. */
export interface SecretAttachmentManifest {
  r2_key: string;
  mime: string;
  /** Total ciphertext bytes. */
  size: number;
  filename_ct_b64: string;
  /** Total plaintext bytes. Optional for backwards compat with the
   *  pre-chunked format; absent → unknown, viewer falls back to
   *  full-object fetch. */
  plaintext_size?: number;
  /** Uniform plaintext chunk size. 0 or undefined → not chunked. */
  chunk_size?: number;
  /** Chunk count; defaults to 1 for non-chunked files. */
  chunk_count?: number;
}

export interface OpenResponse {
  password_wrap_b64: string;
  subject_ct_b64: string;
  body_ct_b64: string;
  attachments: SecretAttachmentManifest[];
  sender_addr?: string;
  sender_name?: string | null;
  recipient_addr?: string | null;
  policy?: SecretPolicy;
  first_opened_at?: number | null;
  expires_at?: number;
}

export interface DecodedAttachmentMeta {
  /** Full server-side manifest, passed to `fetchAttachment` when the
   *  user actually requests this file. Carries chunk_size / chunk_count
   *  so the viewer can do ranged downloads without re-querying the
   *  server. */
  manifest: SecretAttachmentManifest;
  filename: string;
  mime: string;
  /** Plaintext byte size; falls back to `size` (ciphertext) for
   *  pre-chunked attachments that didn't record the plaintext total. */
  size: number;
}

export interface DecodedSecret {
  /** CEK derived from the password — kept so we can decrypt individual
   *  attachment streams on demand. */
  cek: Uint8Array;
  subject: string;
  body: string;
  attachments: DecodedAttachmentMeta[];
  sender_addr?: string;
  sender_name?: string | null;
  recipient_addr?: string | null;
  policy?: SecretPolicy;
  expires_at?: number;
}

/** Decrypt the parts of the /open response that come back inline:
 *  subject, body, and each attachment's filename. Attachment bytes are
 *  fetched on demand via `fetchAttachment`. */
export async function decodeOpenResponse(
  resp: OpenResponse,
  argonOutput: Uint8Array,
): Promise<DecodedSecret> {
  const { wrapKeyBytes } = deriveCheckAndWrap(argonOutput);
  const cek = await unwrapCek(b64uDecode(resp.password_wrap_b64), wrapKeyBytes);
  const dec = new TextDecoder();
  const subject = dec.decode(decryptWithCek(cek, b64uDecode(resp.subject_ct_b64)));
  const body = dec.decode(decryptWithCek(cek, b64uDecode(resp.body_ct_b64)));
  const attachments = resp.attachments.map((a): DecodedAttachmentMeta => {
    // Filename can be in the legacy single-blob format or the new
    // single-chunk framed format. Try framed first, fall back to legacy
    // — distinguishing by length isn't reliable across very short
    // filenames, so we just attempt both.
    const ctBytes = b64uDecode(a.filename_ct_b64);
    let filename: string;
    try {
      filename = dec.decode(decryptChunk(cek, ctBytes, 0).plaintext);
    } catch {
      filename = dec.decode(decryptWithCek(cek, ctBytes));
    }
    return {
      manifest: a,
      filename,
      mime: a.mime,
      size: a.plaintext_size ?? a.size,
    };
  });
  return {
    cek,
    subject,
    body,
    attachments,
    sender_addr: resp.sender_addr,
    sender_name: resp.sender_name,
    recipient_addr: resp.recipient_addr,
    policy: resp.policy,
    expires_at: resp.expires_at,
  };
}

/** Fetch + decrypt a single attachment.
 *
 *  Chunked path (when `chunk_count > 1`): issues one ranged POST per
 *  chunk, decrypts in order, concatenates. Peak browser memory ~=
 *  one chunk's plaintext (5 MiB), regardless of total file size.
 *
 *  Single-chunk path: pulls the entire ciphertext in one request,
 *  decrypts the single framed chunk.
 *
 *  Legacy non-chunked path (manifest with no chunk_size): falls back
 *  to the pre-chunked single-blob format (`decryptWithCek`). Kept for
 *  read-compat in case an older attachment ever lands in front of
 *  newer viewer code.
 */
export async function fetchAttachment(opts: {
  token: string;
  manifest: SecretAttachmentManifest;
  passwordCheck: Uint8Array;
  cek: Uint8Array;
  onProgress?: UploadProgress;
}): Promise<Uint8Array> {
  const { token, manifest, passwordCheck, cek } = opts;
  const chunkCount = manifest.chunk_count ?? 1;
  const chunkSize = manifest.chunk_size ?? 0;
  const plaintextSize = manifest.plaintext_size ?? 0;

  // Non-chunked legacy fallback. Old attachments encoded as a single
  // `nonce(24) || ct+tag` blob with no framing header — recognised here
  // by chunk_size === 0.
  if (chunkSize === 0) {
    const ct = await fetchRange(token, manifest.r2_key, passwordCheck);
    return decryptWithCek(cek, ct);
  }

  // Single-chunk path: file fits in one chunk. Fetch the whole object
  // (it's at most CHUNK + 44 bytes) and decrypt the one framed chunk.
  if (chunkCount === 1) {
    const ct = await fetchRange(token, manifest.r2_key, passwordCheck);
    const { plaintext, isFinal } = decryptChunk(cek, ct, 0);
    if (!isFinal) throw new Error('expected final chunk');
    opts.onProgress?.(plaintext.length, plaintext.length);
    return plaintext;
  }

  // Multi-chunk path: ranged reads, one chunk at a time.
  const out = new Uint8Array(plaintextSize);
  let writeOffset = 0;
  for (let i = 0; i < chunkCount; i++) {
    const isFinal = i === chunkCount - 1;
    const thisChunkPlaintext = isFinal
      ? plaintextSize - i * chunkSize
      : chunkSize;
    const encryptedOffset = i * (chunkSize + SECRET_CHUNK_OVERHEAD);
    const encryptedLength = thisChunkPlaintext + SECRET_CHUNK_OVERHEAD;
    const ct = await fetchRange(
      token,
      manifest.r2_key,
      passwordCheck,
      encryptedOffset,
      encryptedLength,
    );
    const dec = decryptChunk(cek, ct, i);
    if (dec.isFinal !== isFinal) {
      throw new Error(`chunk ${i} final flag mismatch — possible tampering`);
    }
    out.set(dec.plaintext, writeOffset);
    writeOffset += dec.plaintext.length;
    opts.onProgress?.(writeOffset, plaintextSize);
  }
  if (writeOffset !== plaintextSize) {
    throw new Error(`final size mismatch (wrote ${writeOffset}, expected ${plaintextSize})`);
  }
  return out;
}

async function fetchRange(
  token: string,
  r2_key: string,
  passwordCheck: Uint8Array,
  offset?: number,
  length?: number,
): Promise<Uint8Array> {
  const body: Record<string, unknown> = {
    password_check_b64: b64uEncode(passwordCheck),
    r2_key,
  };
  if (offset !== undefined) body.offset = offset;
  if (length !== undefined) body.length = length;
  const resp = await fetch(`/api/s/${encodeURIComponent(token)}/attachment`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      const j = await resp.json();
      msg = j.error || msg;
    } catch {
      /* binary body */
    }
    throw new Error(`${resp.status}: ${msg}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}
