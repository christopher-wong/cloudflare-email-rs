/**
 * The webauthn library is mostly thin wrappers around `navigator.credentials`
 * — not useful to test that, the browser owns it. What IS our logic is the
 * priv-key stash / clear lifecycle: it controls how the in-memory copy stays
 * coherent. As of the Proton-style refactor, the priv is held in memory only;
 * the *wrapped* priv lives in IndexedDB and is unwrapped via a passkey PRF
 * ceremony in `unlock()` (separately tested via mocks where useful).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sessionStashPriv, sessionPriv, sessionClearPriv } from './webauthn';

beforeEach(() => {
  sessionClearPriv();
  // Wipe the in-memory side-channel just in case a previous test stashed.
  (window as any)['__cfemail_priv_session__'] = null;
});

describe('priv key (memory-only) lifecycle', () => {
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

  it('does NOT survive a synthetic "cold read" (simulated reload)', async () => {
    // Memory-only by design: blowing away the in-memory copy without
    // calling unlock() must return null. Cold-tab UX is restored via
    // the IDB-cached wrapped blob + passkey PRF in unlock(), not by
    // re-reading from disk here.
    const priv = new Uint8Array([9, 9, 9]);
    await sessionStashPriv(priv);
    (window as any)['__cfemail_priv_session__'] = null;
    expect(sessionPriv()).toBeNull();
  });

  it('clears the in-memory copy on logout', async () => {
    const priv = new Uint8Array([1]);
    await sessionStashPriv(priv);
    sessionClearPriv();
    expect(sessionPriv()).toBeNull();
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
