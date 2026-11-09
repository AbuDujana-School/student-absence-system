const CACHE_NAME = 'abudujana-app-v6';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];
const RUNTIME_CACHE = 'abudujana-static-v6';
const CDN_PRECACHE = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap'
];
const CDN_HOSTS = new Set([
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.allSettled(CDN_PRECACHE.map(url => runtime.add(url)));
  })().catch(error => { console.error('App shell precache failed:', error); }));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => ![CACHE_NAME, RUNTIME_CACHE].includes(key)).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function isSupabaseRequest(url) {
  return url.hostname.endsWith('.supabase.co') ||
    /\/(rest\/v1|auth\/v1|storage\/v1|functions\/v1|realtime\/v1)(\/|$)/.test(url.pathname);
}
function isCacheableStaticRequest(request, url) {
  if (request.method !== 'GET' || isSupabaseRequest(url)) return false;
  if (url.origin === self.location.origin) {
    return !url.pathname.includes('/.well-known/') && !/\/api\//.test(url.pathname);
  }
  return CDN_HOSTS.has(url.hostname);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isCacheableStaticRequest(request, url)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok && url.origin === self.location.origin) {
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', response.clone()).catch(() => {});
        }
        return response;
      } catch (error) {
        const cached = await caches.match('./index.html') || await caches.match('./');
        if (cached) return cached;
        return new Response('التطبيق غير متاح حالياً. افتحه مرة واحدة مع اتصال بالإنترنت.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const networkFetch = fetch(request).then(response => {
      if (response && (response.ok || response.type === 'opaque')) cache.put(request, response.clone()).catch(() => {});
      return response;
    });
    if (cached) {
      event.waitUntil(networkFetch.catch(() => {}));
      return cached;
    }
    try { return await networkFetch; }
    catch (error) {
      return new Response('', { status: 504, statusText: 'Offline resource unavailable' });
    }
  })());
});
