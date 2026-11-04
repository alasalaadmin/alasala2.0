/**
 * Service Worker — تطبيق المتابعة (PWA)
 * - Never touches Apps Script calls or any non-GET request (they go straight to the network).
 * - App shell: network-first, falls back to cache, and ALWAYS returns a valid Response.
 * - Google Fonts: stale-while-revalidate so the text looks right offline.
 * Bump CACHE_VERSION on every deployment to force clients to refresh.
 */
const CACHE_VERSION = 'v25';
const SHELL_CACHE = 'moutabaa-shell-' + CACHE_VERSION;
const FONT_CACHE = 'moutabaa-fonts-' + CACHE_VERSION;

const CORE_ASSETS = ['./', './index.html', './styles.css', './manifest.json'];
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png', './Cover.webp'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(CORE_ASSETS);
    // optional files must never make the installation fail
    await Promise.all(OPTIONAL_ASSETS.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, FONT_CACHE];
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') self.skipWaiting();
});

function offlineResponse() {
  return new Response('أنت غير متصل بالإنترنت.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POSTs (login, saves) are never intercepted
  const url = new URL(req.url);

  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // Google Fonts: stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && (res.status === 200 || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || offlineResponse();
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell: network-first, cache fallback
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await caches.match('./index.html')) || (await caches.match('./'));
        if (shell) return shell;
      }
      return offlineResponse();
    }
  })());
});
