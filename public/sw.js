/*
 * Service worker — makes MathFall playable with no connection.
 *
 * Note the one thing that cannot be cached: Web Speech API recognition streams
 * audio to a vendor server, so *voice* still needs a network even when the
 * game itself is fully offline. The keypad is the offline path, and the UI
 * says so rather than leaving a dead microphone button.
 *
 * Asset filenames are content-hashed at build time and therefore unknown here,
 * so the strategy is runtime rather than precache:
 *   - navigations: network first, cached shell as fallback
 *   - static assets: stale-while-revalidate
 *   - audio: cache on demand only (the tracks are several MB each)
 */

const VERSION = 'mathfall-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const MEDIA = `${VERSION}-media`;

const SHELL_URLS = ['./', './index.html', './site.webmanifest', './favicon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // addAll rejects the whole batch if any single request fails, which
      // would leave the worker uninstalled. Failures here are not fatal.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation: prefer fresh, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL).then((c) => c.put('./index.html', copy));
          return response;
        })
        .catch(async () => (await caches.match('./index.html')) ?? Response.error()),
    );
    return;
  }

  // Music: large, and only worth storing once actually played.
  //
  // Audio elements issue Range requests, which come back as 206 Partial
  // Content. Cache.put() rejects those outright — a partial body is not a
  // valid cache entry — so a naive `response.ok` check (206 is "ok") throws
  // an unhandled rejection on every seek. Only whole 200 responses are stored.
  if (url.pathname.includes('/audio/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        if (response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(MEDIA).then((c) => c.put(request, copy)).catch(() => undefined);
        }
        return response;
      })),
    );
    return;
  }

  // Everything else: serve cache immediately, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          // Same rule as above: only complete, same-origin 200s are cacheable.
          if (response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(ASSETS).then((c) => c.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    }),
  );
});
