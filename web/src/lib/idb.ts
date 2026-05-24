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
const DB_VERSION = 3;
const STORE_AUTH = 'auth';
/** Per-draft transient state — currently just the hosted-attachment
 *  CEK + uploaded file manifest. Keyed by client-generated draft id.
 *  Cleared on successful send (or explicit draft delete). */
const STORE_DRAFT_HOSTED = 'draft_hosted';
/** Cached derived contact list. One row per cache, keyed by `'list'`
 *  — the underlying API call is per-user (session cookie) so we don't
 *  need a user-id key. Refreshed by `lib/contacts.ts`. */
const STORE_CONTACTS = 'contacts';

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
      if (!db.objectStoreNames.contains(STORE_DRAFT_HOSTED)) {
        db.createObjectStore(STORE_DRAFT_HOSTED);
      }
      if (!db.objectStoreNames.contains(STORE_CONTACTS)) {
        db.createObjectStore(STORE_CONTACTS);
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

// ---- per-draft hosted state ----
//
// Stored as `{ cek_b64, files }` — the CEK is a 32-byte AES key that
// we encode as base64url for IDB JSON safety (structured-clone of
// Uint8Array works too but b64 keeps backups / debugging simpler).

export interface DraftHostedState {
  cek_b64: string;
  /** Mirrors `PreparedHostedFile[]` from web/src/lib/hosted.ts plus a
   *  client-local `id` per row so the Compose UI can identify rows
   *  for removal. */
  files: Array<{
    id: string;
    filename: string;
    mime: string;
    plaintext_size: number;
    prepared: unknown;
  }>;
}

export async function putDraftHosted(
  draftId: string,
  state: DraftHostedState,
): Promise<void> {
  const dbp = open();
  if (!dbp) return;
  const db = await dbp;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DRAFT_HOSTED, 'readwrite');
    tx.objectStore(STORE_DRAFT_HOSTED).put(state, draftId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDraftHosted(
  draftId: string,
): Promise<DraftHostedState | null> {
  const dbp = open();
  if (!dbp) return null;
  const db = await dbp;
  return new Promise<DraftHostedState | null>((resolve, reject) => {
    const tx = db.transaction(STORE_DRAFT_HOSTED, 'readonly');
    const req = tx.objectStore(STORE_DRAFT_HOSTED).get(draftId);
    req.onsuccess = () =>
      resolve((req.result as DraftHostedState | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDraftHosted(draftId: string): Promise<void> {
  const dbp = open();
  if (!dbp) return;
  const db = await dbp;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_DRAFT_HOSTED, 'readwrite');
    tx.objectStore(STORE_DRAFT_HOSTED).delete(draftId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- contacts cache ----
//
// `lib/contacts.ts` owns the policy (TTL, invalidation); this module
// just provides typed get/put/delete on a single keyed slot.

export interface CachedContacts {
  fetched_at: number;
  /** Anything JSON-serializable; lib/contacts.ts narrows it to
   *  ContactView[] from the generated OpenAPI types. */
  contacts: unknown[];
}

const KEY_CONTACTS = 'list';

export async function putCachedContacts(c: CachedContacts): Promise<void> {
  const dbp = open();
  if (!dbp) return;
  const db = await dbp;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CONTACTS, 'readwrite');
    tx.objectStore(STORE_CONTACTS).put(c, KEY_CONTACTS);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedContacts(): Promise<CachedContacts | null> {
  const dbp = open();
  if (!dbp) return null;
  const db = await dbp;
  return new Promise<CachedContacts | null>((resolve, reject) => {
    const tx = db.transaction(STORE_CONTACTS, 'readonly');
    const req = tx.objectStore(STORE_CONTACTS).get(KEY_CONTACTS);
    req.onsuccess = () =>
      resolve((req.result as CachedContacts | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearCachedContacts(): Promise<void> {
  const dbp = open();
  if (!dbp) return;
  const db = await dbp;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_CONTACTS, 'readwrite');
    tx.objectStore(STORE_CONTACTS).delete(KEY_CONTACTS);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
