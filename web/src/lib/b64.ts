/** base64url ⇄ Uint8Array helpers used everywhere on the wire.
 *
 * Note: TS 5.7+ narrows the result of `new Uint8Array(n)` to
 * `Uint8Array<ArrayBuffer>` (rather than `Uint8Array<ArrayBufferLike>`),
 * which makes the result satisfy `BufferSource` at WebCrypto/WebAuthn
 * call sites without an explicit cast. We pin the return type here so
 * any caller chaining off `b64uDecode` keeps the same guarantee.
 */

export function b64uEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = (4 - (s.length % 4)) % 4;
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  // TextEncoder returns Uint8Array<ArrayBufferLike>; copy into a fresh
  // Uint8Array(n) to land on the ArrayBuffer variant for WebCrypto inputs.
  const e = new TextEncoder().encode(s);
  const out = new Uint8Array(e.length);
  out.set(e);
  return out;
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/** Adapt any Uint8Array to the strict ArrayBuffer-backed variant required
 *  by WebCrypto / WebAuthn input slots. Cheap when already ArrayBuffer-backed
 *  (zero-copy reinterpret); copies otherwise. */
export function asAB(b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (b.buffer instanceof ArrayBuffer) {
    return b as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(b.length);
  copy.set(b);
  return copy;
}
