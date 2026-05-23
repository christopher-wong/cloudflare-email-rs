/**
 * Realtime push channel.
 *
 * Opens a single WebSocket to `/api/realtime`, which the worker routes into
 * the signed-in user's MailboxDO. The DO holds the connection (hibernatably)
 * and sends a small JSON event whenever a new message is inserted, inbound
 * or outbound. Consumers subscribe with `subscribe(handler)` and call the
 * returned unsubscribe fn on cleanup.
 *
 * Reconnect: exponential backoff with jitter, capped at 30s. We never give
 * up — the page reload will only happen if the user closes the tab.
 *
 * Auth: the same session cookie that auth's the rest of the API is sent on
 * the upgrade request, so the worker's `require_auth` runs as usual. If the
 * cookie isn't valid, the upgrade is rejected with 401 and we stop trying
 * until the next call to `start()`.
 */

export type RealtimeEvent =
  | {
      type: 'message.new';
      direction: 'in' | 'out';
      msg_id: string;
      thread_id?: string;
      /** Plain header `From` address. Inbound notifies set this. */
      from_addr?: string;
      from_name?: string | null;
      /** Sealed subject (base64url) so the client can decrypt + display. */
      subject_ct_b64?: string;
    }
  | { type: 'message.read'; msg_id: string; read: boolean }
  | { type: 'message.star'; msg_id: string; starred: boolean }
  | { type: 'message.delete'; msg_id: string; thread_id?: string | null }
  | { type: 'thread.delete'; thread_id: string }
  | { type: 'message.label'; msg_id: string; label_id: string; on: boolean }
  | { type: 'draft.upsert'; draft_id: string; updated_at: number }
  | { type: 'draft.delete'; draft_id: string }
  | { type: string; [k: string]: unknown };

type Handler = (ev: RealtimeEvent) => void;

const handlers: Set<Handler> = new Set();
let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

// Heartbeat. The MailboxDO has setWebSocketAutoResponse("ping","pong")
// configured, so the runtime replies to our pings without waking the DO.
// We send a ping every 25s to keep NAT/middlebox idle timeouts from
// dropping us silently, and if we go >75s without a pong we treat the
// connection as dead and force-reconnect.
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 75_000;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastPongAt = 0;

function clearHeartbeat() {
  if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
  if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function startHeartbeat() {
  clearHeartbeat();
  lastPongAt = Date.now();
  pingTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send('ping'); } catch { /* close handler will reconnect */ }
    }
  }, PING_INTERVAL_MS);
  watchdogTimer = setInterval(() => {
    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS && socket) {
      try { socket.close(4000, 'heartbeat-timeout'); } catch { /* ignore */ }
    }
  }, 5_000);
}

function url(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/realtime`;
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer !== null) return;
  // 1s, 2s, 4s, 8s, 16s, 30s thereafter, plus up to 1s jitter.
  const base = Math.min(30_000, 1_000 * Math.pow(2, reconnectAttempt));
  const jitter = Math.floor(Math.random() * 1_000);
  const delay = base + jitter;
  reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (stopped) return;
  try {
    socket = new WebSocket(url());
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    startHeartbeat();
  });
  socket.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    if (e.data === 'pong') { lastPongAt = Date.now(); return; }
    // Any inbound message counts as proof-of-life too.
    lastPongAt = Date.now();
    let parsed: RealtimeEvent | null = null;
    try { parsed = JSON.parse(e.data) as RealtimeEvent; } catch { return; }
    if (!parsed) return;
    for (const h of handlers) {
      try { h(parsed); } catch { /* swallow per-handler errors */ }
    }
  });
  socket.addEventListener('close', () => {
    clearHeartbeat();
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    // The close event fires too — reconnect is scheduled there.
  });
}

/** Begin the connection. Idempotent. Call once after sign-in. */
export function start() {
  stopped = false;
  if (socket || reconnectTimer) return;
  connect();
}

/** Tear down the connection. Call on sign-out. */
export function stop() {
  stopped = true;
  reconnectAttempt = 0;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearHeartbeat();
  if (socket) {
    try { socket.close(1000, 'client-stop'); } catch { /* ignore */ }
    socket = null;
  }
}

/** Subscribe to events. Returns an unsubscribe function. */
export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}
