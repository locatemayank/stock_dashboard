'use strict';
const CACHE = 'portfolio-predictor-v1';
const PRECACHE = ['./', './index.html', './data/market_history.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE.map(u => new Request(u, {cache:'reload'}))))
      .catch(() => {}) // ignore if market_history.js doesn't exist yet
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for API calls; cache-first for local assets
  const url = new URL(e.request.url);
  const isLocal = url.hostname === self.location.hostname || e.request.url.startsWith('file://');
  if (!isLocal) return; // let external API calls pass through unmodified
  e.respondWith(
    fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
