const CACHE_NAME = 'abudujana-app-v65';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './sw.js',
  './teacher-attendance-compliance.js?v=2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];
const RUNTIME_CACHE = 'abudujana-static-v72';
function fetchWithTimeout(request, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { cache: 'no-store', signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Do not let a slow CDN or a stalled shell request prevent the new worker
    // from installing. Partial precaching is safe; runtime requests have fallbacks.
    const precacheWork = (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      // External CDN and backend requests are deliberately not precached.
      // They remain normal browser network requests and are never intercepted here.
    })();
    await Promise.race([
      precacheWork,
      new Promise(resolve => setTimeout(resolve, 12000))
    ]);
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
  if (request.method !== 'GET') return false;
  // Let all cross-origin requests (CDNs, Supabase, fonts, analytics, etc.)
  // pass through untouched. Only same-origin static files are cache candidates.
  if (url.origin !== self.location.origin || isSupabaseRequest(url)) return false;
  return !url.pathname.includes('/.well-known/') && !/\/api\//.test(url.pathname);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isCacheableStaticRequest(request, url)) return;

  // JavaScript and CSS must be refreshed from the network first. A stale
  // cached application script can leave login or cloud-sync UI in an old state
  // after GitHub Pages has already published a newer index.html.
  if (url.origin === self.location.origin && /\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      try {
        const response = await fetchWithTimeout(request, 7000);
        if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response('', { status: 504, statusText: 'Application script unavailable offline' });
      }
    })());
    return;
  }

  // Always fetch the reserve workflow from the network first. Older releases
  // could keep serving a cached JavaScript file after a GitHub Pages update.
  if (url.origin === self.location.origin && /\/reserve-workflow\.js$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      try {
        const response = await fetchWithTimeout(request, 7000);
        if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        return new Response('', { status: 504, statusText: 'Reserve workflow unavailable offline' });
      }
    })());
    return;
  }

  // IMPORTANT: Keep HTML response bodies intact. index.html contains serialized
  // print-document HTML (including </body>) inside inline JavaScript strings.
  // Never inject scripts by regex/string replacement in the Service Worker:
  // an injected </script> can terminate the surrounding inline script early.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request, 7000);
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
    const networkFetch = fetchWithTimeout(request, 7000).then(response => {
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
