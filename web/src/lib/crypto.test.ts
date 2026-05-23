import { describe, it, expect } from 'vitest';
import {
  newX25519Keypair,
  sealToSelf,
  openSealedBox,
  openSealedString,
  utf8,
} from './crypto';

describe('sealed-box crypto', () => {
  it('roundtrips a string sealed to a pubkey with the corresponding priv', () => {
    const { priv, pub } = newX25519Keypair();
    const plaintext = 'hello sealed world — with 🦀 emoji';
    const ct = sealToSelf(utf8(plaintext), pub);
    expect(openSealedString(ct, priv)).toBe(plaintext);
  });

  it('produces different ciphertext on repeated seals (ephemeral key)', () => {
    const { pub } = newX25519Keypair();
    const a = sealToSelf(utf8('same plaintext'), pub);
    const b = sealToSelf(utf8('same plaintext'), pub);
    // Both decrypt the same, but the wire format must differ because the
    // ephemeral pubkey + nonce are fresh each time.
    expect(a).not.toEqual(b);
  });

  it('refuses to open ciphertext under the wrong key', () => {
    const { pub } = newX25519Keypair();
    const { priv: otherPriv } = newX25519Keypair();
    const ct = sealToSelf(utf8('top secret'), pub);
    expect(() => openSealedBox(ct, otherPriv)).toThrow();
  });

  it('refuses to open a tampered ciphertext', () => {
    const { priv, pub } = newX25519Keypair();
    const ct = sealToSelf(utf8('original'), pub);
    // Flip a byte in the AEAD ciphertext region (past the 32-byte
    // ephemeral pubkey + 24-byte nonce header).
    const tampered = new Uint8Array(ct);
    tampered[60] ^= 0x01;
    expect(() => openSealedBox(tampered, priv)).toThrow();
  });

  it('rejects ciphertexts shorter than the minimum envelope', () => {
    const { priv } = newX25519Keypair();
    // 32 (ephPub) + 24 (nonce) + 16 (poly1305 tag) = 72 minimum
    const short = new Uint8Array(70);
    expect(() => openSealedBox(short, priv)).toThrow(/too short/i);
  });
});
