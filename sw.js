const CACHE_NAME = 'alasala-cache-v2';

// Fichiers statiques à mettre en cache pour l'usage hors-ligne / PWA
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './Cover.webp'
];

// Installation du Service Worker et mise en cache des ressources statiques
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Nettoyage des anciennes versions de cache
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interception des requêtes réseau
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Ignorer les protocoles non HTTP/HTTPS (comme chrome-extension://)
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // 2. Ne JAMAIS mettre en cache les requêtes envoyées à l'API Google Apps Script
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com')
  ) {
    return event.respondWith(fetch(event.request));
  }

  // 3. Ne pas mettre en cache les requêtes autres que GET (ex: POST)
  if (event.request.method !== 'GET') {
    return event.respondWith(fetch(event.request));
  }

  // 4. Stratégie Cache-First avec fallback réseau pour les assets statiques
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        // Mettre en cache uniquement les réponses valides et du même domaine ou CDN autorisés
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          (networkResponse.type === 'basic' || networkResponse.type === 'cors')
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});