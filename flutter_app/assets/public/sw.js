'use strict';
const VERSION = 'stalk-v6';
const ASSETS  = [
  '/', '/index.html', '/style.css', '/app.js',
  '/logo.svg', '/manifest.json',
];

// ── Install: cache everything ─────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: wipe old caches ─────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for assets, network-first for API/socket ───
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always skip socket.io and API calls — need live server
  if (url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api')) return;

  // Navigation — try network, fall back to cached index
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Assets — cache-first, then network, then cache miss
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Cache new successful GET responses
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
