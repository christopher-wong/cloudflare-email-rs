/**
 * Contact autocomplete data layer.
 *
 *   GET /api/me/contacts  →  ContactView[]
 *
 * Cached in IndexedDB with a 5-minute TTL. Invalidated explicitly
 * after a successful send (so the freshly-added recipient is in the
 * next typeahead immediately). The server derives this list from the
 * user's MailboxDO message history — there's no separate contacts
 * table, see `worker/src/mailbox.rs::list_contacts`.
 *
 * Consumer pattern:
 *
 *   const { contacts, refresh } = useContacts(myAddresses);
 *   // contacts is filtered to exclude the user's own addresses and
 *   // sorted for typeahead scoring.
 *   const matches = filterContacts(contacts, query);
 */

import { useEffect, useState, useCallback } from 'react';

import type { Schemas } from './api-typed';
import {
  clearCachedContacts,
  getCachedContacts,
  putCachedContacts,
} from './idb';

export type Contact = Schemas['ContactView'];

/** Refresh sooner than this and we serve the IDB cache directly. */
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchContactsFromServer(): Promise<Contact[]> {
  const resp = await fetch('/api/me/contacts', {
    method: 'GET',
    credentials: 'include',
  });
  if (!resp.ok) {
    throw new Error(`/api/me/contacts ${resp.status}`);
  }
  return (await resp.json()) as Contact[];
}

/** Get contacts, preferring the cache when it's fresh enough. Pass
 *  `force` to bypass the cache (used after send). */
export async function loadContacts(force = false): Promise<Contact[]> {
  if (!force) {
    const cached = await getCachedContacts();
    if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
      return cached.contacts as Contact[];
    }
  }
  const fresh = await fetchContactsFromServer();
  await putCachedContacts({ fetched_at: Date.now(), contacts: fresh });
  return fresh;
}

/** Drop the cache. Compose calls this after a successful send so the
 *  next typeahead reflects the new recipient(s). */
export async function invalidateContacts(): Promise<void> {
  await clearCachedContacts();
}

// ---- hook ----------------------------------------------------------------

export interface UseContactsResult {
  contacts: Contact[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** React hook: returns the contact list, refreshing in the background
 *  on mount. `myAddresses` is filtered out so the user doesn't get
 *  themselves as a suggestion. */
export function useContacts(myAddresses: string[] = []): UseContactsResult {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const all = await loadContacts(true);
      const own = new Set(myAddresses.map((a) => canonicalize(a)));
      setContacts(all.filter((c) => !own.has(c.addr)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAddresses.join('|')]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Cache-first render so the field is populated instantly; the
      // server-fresh list lands a moment later via refresh().
      try {
        const cached = await getCachedContacts();
        if (cached && !cancelled) {
          const own = new Set(myAddresses.map((a) => canonicalize(a)));
          setContacts((cached.contacts as Contact[]).filter((c) => !own.has(c.addr)));
          setLoading(false);
        }
      } catch {
        /* fall through to network */
      }
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myAddresses.join('|')]);

  return { contacts, loading, refresh };
}

// ---- filtering / scoring -------------------------------------------------

/** Score a contact against a typed query. Higher = better. Returns
 *  null to mean "doesn't match." */
function scoreContact(c: Contact, q: string): number | null {
  const ql = q.toLowerCase();
  const addr = c.addr.toLowerCase();
  const name = (c.name ?? '').toLowerCase();
  let score = 0;
  if (addr === ql || name === ql) score += 100;
  else if (addr.startsWith(ql)) score += 60;
  else if (name.startsWith(ql)) score += 50;
  else if (addr.includes(ql)) score += 20;
  else if (name.includes(ql)) score += 15;
  else return null;
  // Recency + frequency bumps. Recency dominates; frequency breaks ties.
  const ageDays = Math.max(0, (Date.now() - c.last_seen_at) / 86_400_000);
  score += Math.max(0, 10 - ageDays / 30);
  score += Math.min(5, Math.log2(c.message_count + 1));
  return score;
}

/** Return top N contacts matching the query, sorted by score. Empty
 *  query returns the most-recent contacts (sensible default for an
 *  empty autocomplete dropdown). */
export function filterContacts(
  contacts: Contact[],
  query: string,
  limit = 8,
): Contact[] {
  if (!query.trim()) {
    return contacts.slice(0, limit);
  }
  const scored: Array<{ c: Contact; s: number }> = [];
  for (const c of contacts) {
    const s = scoreContact(c, query.trim());
    if (s !== null) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.c);
}

/** Display string for a contact in tag / suggestion UI. Falls back to
 *  the email when no name is known. */
export function displayName(c: Contact): string {
  return c.name && c.name.trim() ? c.name : c.addr;
}

/** Mirror of `worker/src/config.rs::canonical_address` for the
 *  "exclude my own addresses" filter. Lowercases + strips plus-suffix. */
export function canonicalize(addr: string): string {
  const lower = addr.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return lower;
  const local = lower.slice(0, at);
  const domain = lower.slice(at);
  const plus = local.indexOf('+');
  return plus < 0 ? lower : local.slice(0, plus) + domain;
}
