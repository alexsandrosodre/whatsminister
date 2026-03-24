const CACHE_NAME = 'whatsminister-v2';
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/mins/minislogo.png', '/mins/minislogoheader.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener('message', (event) => {
  const msg = event && event.data ? event.data : null;
  if (msg && msg.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isNavigation = req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';

  event.respondWith(
    (async () => {
      if (isNavigation) {
        try {
          const res = await fetch(req);
          const okToCache = req.method === 'GET' && res && res.status === 200 && res.type === 'basic';
          if (okToCache) {
            const copy = res.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, copy);
          }
          return res;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          return caches.match('/index.html');
        }
      }

      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        const okToCache = req.method === 'GET' && res && res.status === 200 && res.type === 'basic';
        if (okToCache) {
          const copy = res.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, copy);
        }
        return res;
      } catch {
        return cached;
      }
    })()
  );
});
