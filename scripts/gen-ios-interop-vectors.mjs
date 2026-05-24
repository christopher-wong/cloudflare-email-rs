#!/usr/bin/env node
/**
 * Generate interop test vectors for the bmail iOS chunked-AEAD primitive.
 *
 * Mirrors the exact wire format implemented in:
 *   web/src/lib/secret-link.ts  (encryptChunk / decryptChunk)
 *
 * Wire layout per chunk:
 *   [4-byte big-endian header] [24-byte nonce] [ciphertext + 16-byte tag]
 *
 * Header (u32 big-endian):
 *   bit 31      = isFinal flag
 *   bits 0..30  = plaintext length
 *
 * AAD = u32_be(chunkIndex) || u8(isFinal ? 1 : 0)  — 5 bytes
 *
 * Output: JSON written to bmailTests/InteropVectors.json and echoed to stdout.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Resolve root relative to this script's location.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- imports from noble packages (installed at cfemail root) ---------------
// Use createRequire so we can load CJS-compatible noble packages from a
// well-known absolute path regardless of where the script is invoked from.
import { createRequire } from 'module';
const require = createRequire(join(ROOT, 'package.json'));

const { xchacha20poly1305 } = await import(`${ROOT}/node_modules/@noble/ciphers/chacha.js`);
const { argon2id } = await import(`${ROOT}/node_modules/@noble/hashes/argon2.js`);
const { hkdf } = await import(`${ROOT}/node_modules/@noble/hashes/hkdf.js`);
const { sha256 } = await import(`${ROOT}/node_modules/@noble/hashes/sha256.js`);

// ---- helpers ----------------------------------------------------------------

function aadFor(chunkIndex, isFinal) {
  const out = new Uint8Array(5);
  out[0] = (chunkIndex >>> 24) & 0xff;
  out[1] = (chunkIndex >>> 16) & 0xff;
  out[2] = (chunkIndex >>> 8) & 0xff;
  out[3] = chunkIndex & 0xff;
  out[4] = isFinal ? 1 : 0;
  return out;
}

/**
 * Deterministic encryptChunk — accepts an explicit nonce so the test vector
 * is reproducible across runs.  The real implementation generates a random
 * nonce; here we take it as input and record it in the vector so iOS can
 * decrypt without knowing the original nonce.
 */
function encryptChunkWithNonce(cek, plaintext, chunkIndex, isFinal, nonce24) {
  const cipher = xchacha20poly1305(cek, nonce24, aadFor(chunkIndex, isFinal));
  const ct = cipher.encrypt(plaintext);
  const header = new Uint8Array(4);
  const finalBit = isFinal ? 0x80 : 0x00;
  header[0] = ((plaintext.length >>> 24) & 0x7f) | finalBit;
  header[1] = (plaintext.length >>> 16) & 0xff;
  header[2] = (plaintext.length >>> 8) & 0xff;
  header[3] = plaintext.length & 0xff;
  const out = new Uint8Array(4 + 24 + ct.length);
  out.set(header, 0);
  out.set(nonce24, 4);
  out.set(ct, 28);
  return out;
}

function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}

// ---- test parameters --------------------------------------------------------

// Fixed CEK: 32 bytes of 0x42.
const CEK = new Uint8Array(32).fill(0x42);

// Fixed nonces (deterministic for reproducibility — 24 bytes each).
const NONCE_0 = new Uint8Array(24).fill(0x01);
const NONCE_1 = new Uint8Array(24).fill(0x02);
const NONCE_2 = new Uint8Array(24).fill(0x03);

// ---- chunked-AEAD vectors ---------------------------------------------------

// Vector 0: "hello world", chunkIndex=0, isFinal=true
const plain0 = new TextEncoder().encode('hello world');
const enc0 = encryptChunkWithNonce(CEK, plain0, 0, true, NONCE_0);

// Vector 1: 100 KiB of 0xAB, chunkIndex=0, isFinal=false
const plain1 = new Uint8Array(100 * 1024).fill(0xab);
const enc1 = encryptChunkWithNonce(CEK, plain1, 0, false, NONCE_1);

// Vector 2: empty bytes, chunkIndex=42, isFinal=true
const plain2 = new Uint8Array(0);
const enc2 = encryptChunkWithNonce(CEK, plain2, 42, true, NONCE_2);

// ---- Argon2id vector --------------------------------------------------------
// password="passphrase", salt=0x01*16, m=65536, t=3, p=4, len=32
const argonPassword = new TextEncoder().encode('passphrase');
const argonSalt = new Uint8Array(16).fill(0x01);
const argonHash = argon2id(argonPassword, argonSalt, {
  m: 65536,
  t: 3,
  p: 4,
  dkLen: 32,
});

// ---- HKDF-SHA256 vector -----------------------------------------------------
// ikm = 0x03*32, salt = 0x04*16, info = "cfemail-test", L = 32
const hkdfIkm = new Uint8Array(32).fill(0x03);
const hkdfSalt = new Uint8Array(16).fill(0x04);
const hkdfInfo = new TextEncoder().encode('cfemail-test');
const hkdfOutput = hkdf(sha256, hkdfIkm, hkdfSalt, hkdfInfo, 32);

// ---- assemble JSON ----------------------------------------------------------

const vectors = {
  cek_b64: toB64(CEK),

  chunkedAEAD: [
    {
      description: 'hello world, index=0, isFinal=true',
      plaintext_b64: toB64(plain0),
      chunkIndex: 0,
      isFinal: true,
      framedChunk_b64: toB64(enc0),
    },
    {
      description: '100KiB of 0xAB, index=0, isFinal=false',
      plaintext_b64: toB64(plain1),
      chunkIndex: 0,
      isFinal: false,
      framedChunk_b64: toB64(enc1),
    },
    {
      description: 'empty plaintext, index=42, isFinal=true',
      plaintext_b64: toB64(plain2),
      chunkIndex: 42,
      isFinal: true,
      framedChunk_b64: toB64(enc2),
    },
  ],

  argon2id: {
    description: 'password=passphrase, salt=0x01*16, m=65536, t=3, p=4, len=32',
    password_utf8: 'passphrase',
    salt_b64: toB64(argonSalt),
    m: 65536,
    t: 3,
    p: 4,
    hash_len: 32,
    expected_b64: toB64(argonHash),
  },

  hkdfSha256: {
    description: 'ikm=0x03*32, salt=0x04*16, info=cfemail-test, L=32',
    ikm_b64: toB64(hkdfIkm),
    salt_b64: toB64(hkdfSalt),
    info_utf8: 'cfemail-test',
    length: 32,
    expected_b64: toB64(hkdfOutput),
  },
};

const outPath = join(__dirname, '../../bmail-ios/bmailTests/InteropVectors.json');
// Ensure the directory exists (it should already from the iOS project).
writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n');
console.log('Wrote vectors to:', outPath);
console.log(JSON.stringify(vectors, null, 2));
