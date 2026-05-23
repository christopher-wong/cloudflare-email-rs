import { describe, it, expect } from 'vitest';
import { b64uEncode, b64uDecode, utf8, fromUtf8 } from './b64';

describe('b64 url-safe encoding', () => {
  it('roundtrips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16, 8]);
    const enc = b64uEncode(bytes);
    const dec = b64uDecode(enc);
    expect(Array.from(dec)).toEqual(Array.from(bytes));
  });

  it('produces url-safe output (no +, /, =)', () => {
    // Bytes that would yield + and / in standard base64.
    const bytes = new Uint8Array([0xfb, 0xff, 0xff]);
    const enc = b64uEncode(bytes);
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    expect(enc).not.toContain('=');
  });

  it('roundtrips an empty buffer', () => {
    expect(b64uDecode(b64uEncode(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it('roundtrips UTF-8 strings through utf8 + fromUtf8', () => {
    const original = 'hello, 世界 — 🦀';
    expect(fromUtf8(utf8(original))).toBe(original);
  });

  it('matches a known fixture (deterministic, not just self-roundtrip)', () => {
    // "Hi!" → 48 69 21 → base64 "SGkh"  → url-safe is the same here.
    expect(b64uEncode(utf8('Hi!'))).toBe('SGkh');
    expect(fromUtf8(b64uDecode('SGkh'))).toBe('Hi!');
  });
});
