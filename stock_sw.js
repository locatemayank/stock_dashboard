/* Stock Dashboard Service Worker */
'use strict';

var CACHE_NAME = 'stock-dash-v1';
var APP_SHELL  = ['./stock_dashboard.html', './stock_manifest.json', './stock_icon.svg'];

// Install: cache app shell immediately
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(APP_SHELL).catch(function(){});
    })
  );
});

// Activate: delete old caches, take control
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// Fetch strategy
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // Live data APIs — always network, no cache
  var liveApis = [
    'finnhub.io', 'finance.yahoo.com', 'open-meteo.com',
    'allorigins.win', 'corsproxy.io', 'open.er-api.com',
    'dataviz.cnn.io', 'nominatim.openstreetmap.org'
  ];
  if (liveApis.some(function(d){ return url.indexOf(d) > -1; })) {
    e.respondWith(
      fetch(e.request).catch(function() {
        return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // Google Fonts — cache indefinitely
  if (url.indexOf('fonts.googleapis.com') > -1 || url.indexOf('fonts.gstatic.com') > -1) {
    e.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(e.request).then(function(cached) {
          return cached || fetch(e.request).then(function(resp) {
            cache.put(e.request, resp.clone());
            return resp;
          });
        });
      })
    );
    return;
  }

  // App shell — cache first, update in background
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      var network = fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          caches.open(CACHE_NAME).then(function(c) { c.put(e.request, resp.clone()); });
        }
        return resp;
      }).catch(function() { return cached; });
      return cached || network;
    })
  );
});
