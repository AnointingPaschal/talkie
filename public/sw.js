'use strict';
/* ─────────────────────────────────────────────────────────────────
   S-talk Service Worker — Offline-first
   Caches all shell assets on install. Serves from cache first,
   falls back to network. API / Socket.io bypass cache.
   ───────────────────────────────────────────────────────────────── */

const CACHE  = 's-talk-v4';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/logo.svg',
  '/manifest.json',
  '/offline.html',
  '/socket.io/socket.io.js',   // served by socket.io Server
  '/js/socket.io.js',          // our stable cached copy
];

// ── Install — pre-cache everything ───────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // addAll fails if any request fails, use individual adds
      Promise.allSettled(ASSETS.map(url =>
        fetch(url, { cache: 'no-cache' })
          .then(res => { if (res.ok) c.put(url, res); })
          .catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

// ── Activate — clear old caches ───────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch — cache-first for assets, bypass for API/sockets ───────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always bypass: socket.io transport, API calls, non-GET
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/socket.io') && url.search) return; // polling/ws handshake
  if (url.pathname.startsWith('/api/')) return;

  // Navigate requests → serve index.html from cache if offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match('/index.html').then(r => r || caches.match('/offline.html')))
    );
    return;
  }

  // Static assets — cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.ok && e.request.url.startsWith(self.location.origin)) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});

// ── Background sync message from app ─────────────────────────────
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
