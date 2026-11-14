/**
 * sw.js — installs and serves the app offline. A new version is installed only if its file list is
 * signed with the release key below and every file matches; otherwise the phone keeps the version it has.
 * The app's files are always served from this verified copy, never straight from the network.
 * No data ever goes through here: this file only handles the app's own code.
 */
'use strict';
importScripts('./js/crypto.js', './js/release.js');
const RELEASE_PUB = 'BDW-OTtZ1SsNxJkcr2YkzVkONWogdqXOkFwBE9xiqnv7Y7RjL72pngl9mv_Ao3nJIFcr9xLRood9Vr0fVp_uFDQ';
const VERSION = '1.8.0-202611141333';
const CACHE = 'alasala-app-' + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const [mRes, sRes] = await Promise.all([fetch('./release.json', { cache: 'no-store' }), fetch('./release.sig', { cache: 'no-store' })]);
    if (!mRes.ok || !sRes.ok) throw new Error('release files missing');
    const text = await mRes.text();
    const manifest = await self.Release.verify(text, await sRes.text(), RELEASE_PUB);   // throws: install fails, the old version stays
    if (manifest.version !== VERSION) throw new Error('release version mismatch');
    const cache = await caches.open(CACHE);
    for (const path of Object.keys(manifest.files)) {
      const res = await fetch('./' + path, { cache: 'no-store' });
      if (!res.ok) throw new Error('missing ' + path);
      const bytes = new Uint8Array(await res.clone().arrayBuffer());
      await self.Release.checkFile(manifest, path, bytes);
      await cache.put('./' + path, new Response(bytes, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
    }
    await self.skipWaiting();
  })().catch(async (e) => { await caches.delete(CACHE); throw e; }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) { event.respondWith(new Response('', { status: 403 })); return; }   // the app never loads anything from elsewhere
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let path = url.pathname.slice(new URL(self.registration.scope).pathname.length) || 'index.html';
    if (req.mode === 'navigate') path = 'index.html';
    const hit = await cache.match('./' + path);
    if (hit) return hit;
    if (path === 'release.json' || path === 'release.sig' || path === 'sw.js') return fetch(req);
    return new Response('غير متاح دون اتصال', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
