/**
 * Client-side crypto for cfemail.
 *
 * Two concerns live here:
 *
 *  1. **Wrap-key derivation** from the WebAuthn PRF extension output.
 *     PRF gives us a deterministic 32-byte secret per (credential, salt).
 *     We HKDF-expand it into an AES-GCM key that wraps our X25519 private
 *     key. The server stores only the ciphertext.
 *
 *  2. **Sealed-box decrypt** for inbound messages. The server encrypts to
 *     our X25519 pubkey using NaCl-compatible sealed-box semantics:
 *
 *        ephemeral_pub (32) ‖ nonce (24) ‖ ciphertext+tag
 *
 *     We derive the same symmetric key via X25519 ECDH + HKDF and decrypt
 *     with XChaCha20-Poly1305. (NB: real libsodium uses BLAKE2b for HKDF
 *     and the nonce; we mirror the server's choice of SHA-256/SHA-512 for
 *     wasm-portability.)
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { argon2id } from '@noble/hashes/argon2';
import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { asAB, b64uDecode, b64uEncode, utf8, fromUtf8 } from './b64';

const HKDF_INFO = utf8('cfemail/sealed-box/v1');
const WRAP_HKDF_INFO = utf8('cfemail/wrap-key/v1');

// -- WebAuthn PRF -> AES-GCM wrap key ---------------------------------------

export async function deriveWrapKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  // HKDF(prfOutput, "cfemail/wrap-key/v1") -> 32 bytes -> AES-GCM-256 key
  const km = hkdf(sha256, new Uint8Array(prfOutput), undefined, WRAP_HKDF_INFO, 32);
  return crypto.subtle.importKey('raw', asAB(km), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapPrivKey(
  priv: Uint8Array,
  wrapKey: CryptoKey,
): Promise<{ wrapped: Uint8Array; salt: Uint8Array }> {
  // 12-byte nonce + ciphertext; we also generate a 16-byte "wrap salt" that
  // we store alongside (currently unused — reserved for future per-user PRF
  // re-derivation paths). Returned together so the server stores both.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, asAB(priv)),
  );
  const wrapped = new Uint8Array(iv.length + ct.length);
  wrapped.set(iv);
  wrapped.set(ct, iv.length);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { wrapped, salt };
}

export async function unwrapPrivKey(
  wrapped: Uint8Array,
  wrapKey: CryptoKey,
): Promise<Uint8Array> {
  // subarray would borrow the ArrayBufferLike from the source; copy into a
  // fresh ArrayBuffer-backed Uint8Array so WebCrypto's BufferSource accepts.
  const iv = new Uint8Array(wrapped.subarray(0, 12));
  const ct = new Uint8Array(wrapped.subarray(12));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrapKey, ct);
  return new Uint8Array(pt);
}

// -- X25519 keypair ---------------------------------------------------------

export function newX25519Keypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

// -- Sealed box decrypt -----------------------------------------------------
//
// Wire layout: ephemeral_pub (32) ‖ nonce (24) ‖ ciphertext+tag

export function openSealedBox(blob: Uint8Array, priv: Uint8Array): Uint8Array {
  if (blob.length < 32 + 24 + 16) {
    throw new Error('ciphertext too short');
  }
  const ephPub = blob.subarray(0, 32);
  const nonce = blob.subarray(32, 56);
  const ct = blob.subarray(56);

  const shared = x25519.getSharedSecret(priv, ephPub);
  const aeadKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  // Server derives the nonce from SHA-512(eph_pub ‖ recipient_pub)[..24].
  // We don't actually need to re-derive it (it's transmitted in the blob),
  // but for cross-check we could. Decryption uses the transmitted nonce.
  const cipher = xchacha20poly1305(aeadKey, nonce);
  return cipher.decrypt(ct);
}

export function openSealedString(blob: Uint8Array, priv: Uint8Array): string {
  return fromUtf8(openSealedBox(blob, priv));
}

// -- (Optional) self-sealed boxes — used for drafts where the user encrypts
//    to their *own* pubkey. Mirrors the server's seal_to.

export function sealToSelf(plaintext: Uint8Array, pub: Uint8Array): Uint8Array {
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, pub);
  const aeadKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  // Deterministic nonce: SHA-512(eph_pub ‖ recipient_pub)[..24]
  const h = sha512.create();
  h.update(ephPub);
  h.update(pub);
  const nonce = h.digest().subarray(0, 24);

  const cipher = xchacha20poly1305(aeadKey, nonce);
  const ct = cipher.encrypt(plaintext);

  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return out;
}

// -- Recovery passphrase ---------------------------------------------------
//
// 12-word BIP39 mnemonic (~128 bits entropy). The server never sees the
// phrase — we use it locally to derive a second wrap key via Argon2id and
// upload only the wrapped X25519 private key.

const ARGON_PARAMS = {
  // m=64 MiB, t=3, p=4. Conservative defaults that still complete in a few
  // hundred ms on a modern laptop and would cost billions of dollars to
  // brute-force a 128-bit BIP39 phrase against.
  algorithm: 'argon2id' as const,
  version: 19,
  m: 65536, // KiB
  t: 3,
  p: 4,
  hash_len: 32,
};

export function generateRecoveryPhrase(): string {
  // 128-bit entropy → 12 words.
  return generateMnemonic(wordlist, 128);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

export interface KdfParams {
  algorithm: 'argon2id';
  version: number;
  m: number;
  t: number;
  p: number;
  hash_len: number;
  salt_b64: string;
}

/** Derive a 32-byte AES-GCM wrap key from a recovery phrase + salt. */
export async function deriveRecoveryWrapKey(
  phrase: string,
  saltOrParams: Uint8Array | KdfParams,
): Promise<{ wrapKey: CryptoKey; params: KdfParams }> {
  const params: KdfParams =
    saltOrParams instanceof Uint8Array
      ? { ...ARGON_PARAMS, salt_b64: b64uEncode(saltOrParams) }
      : saltOrParams;
  const salt = b64uDecode(params.salt_b64);
  // Normalize: BIP39 to its raw entropy bytes so we're keying off the
  // canonical form, not the user's whitespace choices.
  const norm = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  const entropy = mnemonicToEntropy(norm, wordlist);
  const km = argon2id(entropy, salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: params.hash_len,
  });
  const wrapKey = await crypto.subtle.importKey(
    'raw',
    asAB(km),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  return { wrapKey, params };
}

export function newRecoverySalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

// -- Encodings convenience -------------------------------------------------

export { b64uEncode, b64uDecode, utf8, fromUtf8 };
