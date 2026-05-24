/** Thin JSON-over-fetch client. The session cookie does the auth — we just
 *  set credentials: include and forward errors as thrown ApiError. */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = res.statusText;
    if (ct.includes('application/json')) {
      try { msg = (await res.json()).error || msg; } catch { /* fall through */ }
    } else {
      // Non-JSON error body — usually a Cloudflare or worker-runtime
      // HTML page on uncaught 5xx. Don't dump the whole doc into the
      // UI; keep the first line / first 200 chars so the user (and
      // log) sees something actionable, and log the rest to console
      // for debugging.
      try {
        const full = await res.text();
        const trimmed = full.trim();
        const oneLine = trimmed.replace(/\s+/g, ' ');
        msg = oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine;
        if (full.length > msg.length) {
          // eslint-disable-next-line no-console
          console.error(`api error ${res.status} ${method} ${path}\n${full}`);
        }
      } catch { /* ignore */ }
    }
    throw new ApiError(res.status, `${res.status}: ${msg || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  if (ct.includes('application/json')) return (await res.json()) as T;
  // Non-JSON: caller should use rawFetch instead.
  return (await res.text()) as unknown as T;
}

export const get  = <T,>(p: string)              => request<T>('GET', p);
export const del  = <T,>(p: string)              => request<T>('DELETE', p);
export const post = <T,>(p: string, body: any)   => request<T>('POST', p, body);
export const patch = <T,>(p: string, body: any)  => request<T>('PATCH', p, body);

/** Raw fetch — used for binary uploads/downloads (attachments). */
export async function rawFetch(method: string, path: string, body: BodyInit): Promise<Response> {
  return fetch(path, { method, credentials: 'include', body });
}

// -- Endpoint typings (only the ones the UI consumes) ----------------------

export interface PublicConfig {
  primary_domain: string;
  additional_domains: string[];
  app_host: string;
  app_name: string;
}

export interface MeResp {
  id: string;
  handle: string;
  display_name: string | null;
  is_admin: boolean;
  addresses: string[];
  pub_key_b64: string | null;
}

export interface ThreadRow {
  id: string;
  subject_hint: string | null;
  /** Ciphertext of the first message's subject — decrypt client-side. */
  first_subject_ct_b64: string | null;
  /** Ciphertext of the first message's snippet (~140 char body preview). */
  first_snippet_ct_b64: string | null;
  /** from_addr of the first message. Use with first_direction to label rows. */
  first_from_addr: string | null;
  /** Display name parsed from the first message's From header, if any.
   *  Prefer this for the row label; fall back to `first_from_addr`. */
  first_from_name: string | null;
  /** "in" or "out" — direction of the first message in the thread. */
  first_direction: 'in' | 'out' | null;
  participants: string[];
  last_message_at: number;
  message_count: number;
  unread_count: number;
  has_starred: boolean;
  archived: boolean;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  message_id: string | null;
  in_reply_to: string | null;
  from_addr: string;
  from_name: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  bcc_addrs: string[];
  sent_at: number;
  received_at: number;
  direction: 'in' | 'out' | 'draft';
  read: boolean;
  starred: boolean;
  snippet_ct_b64: string | null;
  subject_ct_b64: string;
  body_ct_b64: string;
  /** Optional sealed HTML body. When present the Thread view renders
   *  it in a sandboxed iframe and falls back to `body_ct_b64` only
   *  when this is null (legacy text-only messages). */
  body_html_ct_b64: string | null;
  size_bytes: number;
  labels: string[];
}

export interface Label {
  id: string;
  name: string;
  created_at: number;
}

export interface DraftRow {
  id: string;
  in_reply_to_message_id: string | null;
  to_addrs: string[];
  cc_addrs: string[];
  bcc_addrs: string[];
  subject_ct_b64: string | null;
  body_ct_b64: string | null;
  attachments: string[];
  updated_at: number;
}

export interface StatusResp {
  needs_bootstrap: boolean;
  is_authed: boolean;
  primary_domain: string;
  additional_domains: string[];
  app_host: string;
  app_name: string;
  user_count: number;
}
