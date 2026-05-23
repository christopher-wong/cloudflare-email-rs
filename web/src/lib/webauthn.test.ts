/**
 * The webauthn library is mostly thin wrappers around `navigator.credentials`
 * — not useful to test that, the browser owns it. What IS our logic is the
 * priv-key stash / load lifecycle: it controls how the in-memory + on-disk
 * copies stay coherent, which is the bit that broke when we moved between
 * sessionStorage and localStorage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStashPriv, sessionPriv, sessionClearPriv } from './webauthn';

beforeEach(() => {
  sessionClearPriv();
  try { window.localStorage.clear(); } catch { /* jsdom may not have it */ }
  // Also wipe the in-memory side-channel
  (window as any)['__cfemail_priv_session__'] = null;
});

describe('priv key persistence', () => {
  it('returns null when nothing has been stashed', () => {
    expect(sessionPriv()).toBeNull();
  });

  it('returns the stashed bytes after a stash', async () => {
    const priv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await sessionStashPriv(priv);
    const got = sessionPriv();
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rehydrates the in-memory copy from localStorage on a cold read', async () => {
    const priv = new Uint8Array([9, 9, 9]);
    await sessionStashPriv(priv);
    // Simulate a reload — wipe the in-memory side, keep localStorage.
    (window as any)['__cfemail_priv_session__'] = null;
    const got = sessionPriv();
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([9, 9, 9]);
  });

  it('clears both the in-memory and on-disk copies on logout', async () => {
    const priv = new Uint8Array([1]);
    await sessionStashPriv(priv);
    sessionClearPriv();
    expect(sessionPriv()).toBeNull();
    expect(window.localStorage.getItem('cfemail.priv.b64')).toBeNull();
  });

  it('zeroes the in-memory bytes on clear (defense-in-depth)', async () => {
    const priv = new Uint8Array([42, 42, 42, 42]);
    await sessionStashPriv(priv);
    sessionClearPriv();
    // The Uint8Array we passed in should be zeroed in-place. This is a
    // mitigation against the priv lingering in memory after logout if
    // the GC hasn't run yet.
    expect(Array.from(priv)).toEqual([0, 0, 0, 0]);
  });
});
