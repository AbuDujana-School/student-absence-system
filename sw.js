/* Abu Dujana School PWA service worker */
'use strict';
const CACHE_PREFIX = 'abu-dujana-pwa-';
const CACHE_VERSION = 'v1.0.0';
const SHELL_CACHE = CACHE_PREFIX + 'shell-' + CACHE_VERSION;
const STATIC_CACHE = CACHE_PREFIX + 'static-' + CACHE_VERSION;
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'];
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap'
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL);
    const staticCache = await caches.open(STATIC_CACHE);
    await Promise.allSettled(CDN_ASSETS.map(async url => {
      try {
        const request = new Request(url, { mode: 'no-cors', cache: 'reload' });
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) await staticCache.put(request, response);
      } catch (error) { console.info('Optional offline asset was not cached:', url, error); }
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, STATIC_CACHE].includes(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
function isStaticAsset(url) {
  return /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|svg|webp|ico)(?:$|\?)/i.test(url.pathname) ||
    url.hostname === 'cdn.tailwindcss.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'cdnjs.cloudflare.com';
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never cache database/API calls, authentication, or user/student records.
  if (url.hostname.endsWith('.supabase.co') || url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (_) {
        return (await caches.match(request)) || (await caches.match('./index.html')) || new Response('التطبيق غير متاح حالياً. افتح النظام مرة واحدة مع الاتصال بالإنترنت.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        event.waitUntil(fetch(request).then(response => {
          if (response && (response.ok || response.type === 'opaque')) return cache.put(request, response.clone());
        }).catch(() => {}));
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === 'opaque')) await cache.put(request, response.clone());
        return response;
      } catch (_) {
        return new Response('', { status: 504, statusText: 'Offline asset unavailable' });
      }
    })());
  }
});
