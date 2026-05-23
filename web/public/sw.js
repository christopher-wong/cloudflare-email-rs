/**
 * cfemail service worker.
 *
 * Three strategies, picked per URL:
 *
 *   /api/*           → network only (and never cached). The mailbox API is
 *                      session-bound and the bodies are E2E-encrypted blobs
 *                      keyed to an in-memory private key; caching them is
 *                      both useless and a footgun.
 *
 *   /assets/*        → cache-first. Vite emits content-hashed bundles, so a
 *                      given URL is immutable for life. First hit goes to the
 *                      network, every subsequent hit comes from cache.
 *
 *   navigation + the
 *   shell (manifest,
 *   icons, favicon)  → network-first with cache fallback. We always try the
 *                      network so new deploys are picked up, but fall back to
 *                      the cached app shell when offline so the home-screen
 *                      app launches without a network round-trip.
 *
 * Bumping VERSION invalidates every previous cache on activation.
 */

const VERSION = 'v1';
const SHELL = `cfemail-shell-${VERSION}`;
const ASSETS = `cfemail-assets-${VERSION}`;

// Resources we pre-cache at install. The root document is critical (it's
// what gets served for any client-side route on cold launch). The icons
// and manifest are tiny and almost always wanted right after install.
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // addAll is atomic — if any one fetch fails the install fails, which
      // is what we want: a half-populated shell is worse than no shell.
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS]);
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin traffic. Cross-origin (fonts.googleapis.com,
  // for one) is left to the default browser cache.
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) return; // network-only via default

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSETS));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstShell(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, SHELL));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const fresh = await fetch(req);
  if (fresh.ok) cache.put(req, fresh.clone());
  return fresh;
}

// Navigation requests always go to network first (so new deploys win), with
// the cached root document as a fallback for offline launches. We cache the
// network response under `/` regardless of the requested path because the
// SPA serves the same document for every client-side route.
async function networkFirstShell(req) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put('/', fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match('/');
    if (cached) return cached;
    return new Response('offline', { status: 503, statusText: 'offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((fresh) => {
      if (fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })
    .catch(() => cached);
  return cached || network;
}
