/**
 * Tiny IndexedDB helper. We use IDB for ONE thing today: caching the
 * server-issued wrapped priv key + the credential id needed to unwrap
 * it, so a browser reload can re-derive the plaintext priv via a
 * single passkey PRF ceremony instead of a full re-login.
 *
 * Why IDB, not localStorage:
 * - localStorage stores strings only; this is fine here, but…
 * - localStorage exposes a synchronous API that touches disk on every
 *   call. IDB is async and the runtime can batch.
 * - IDB structures are easier to reason about for future caching
 *   (attachment blobs, message rows, etc.) so we set the pattern now.
 *
 * Note this stores the WRAPPED priv (server's ciphertext), not the
 * plaintext. The wrap key is held by the passkey authenticator; an
 * attacker with file-system access learns nothing useful.
 */

const DB_NAME = 'cfemail';
const DB_VERSION = 1;
const STORE_AUTH = 'auth';

export interface CachedWrap {
  /** base64url ciphertext of the wrap (AES-GCM(wrap_key, priv)). */
  wrapped_blob_b64: string;
  /** base64url random salt the server attached to the wrap. */
  wrap_salt_b64: string | null;
  /** base64url credential id we use to scope the passkey ceremony. */
  credential_id_b64: string;
  /** WebAuthn relying-party id this credential was minted under. */
  rp_id: string;
  /** PRF salt to evaluate on the authenticator (per-RP constant). */
  prf_salt_b64: string;
}

const KEY_WRAP = 'wrap';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_AUTH)) {
        db.createObjectStore(STORE_AUTH);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putCachedWrap(w: CachedWrap): Promise<void> {
  const dbp = open();
  if (!dbp) return; // no IDB available (test env or locked-down browser)
  const db = await dbp;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_AUTH, 'readwrite');
    tx.objectStore(STORE_AUTH).put(w, KEY_WRAP);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedWrap(): Promise<CachedWrap | null> {
  const dbp = open();
  if (!dbp) return null;
  const db = await dbp;
  return new Promise<CachedWrap | null>((resolve, reject) => {
    const tx = db.transaction(STORE_AUTH, 'readonly');
    const req = tx.objectStore(STORE_AUTH).get(KEY_WRAP);
    req.onsuccess = () => resolve((req.result as CachedWrap | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearCachedWrap(): Promise<void> {
  const dbp = open();
  if (!dbp) return;
  const db = await dbp;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_AUTH, 'readwrite');
    tx.objectStore(STORE_AUTH).delete(KEY_WRAP);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
