/* Spood Stacker service worker
   - receives photos shared from the Android share sheet (share_target POST)
   - keeps the app (including the 10 MB stacking engine) cached for offline use */
const VERSION = 'v7';
const APP_CACHE = 'spood-app-' + VERSION;
const SHARED_CACHE = 'spood-shared';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './engine.js', './worker.js', './exif.js', './retouch.js',
  './vendor/opencv-4.10.0.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('spood-app-') && k !== APP_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);

  // Photos shared from another app arrive here as a form POST.
  if (e.request.method === 'POST' && url.pathname === scope.pathname + 'share-target/') {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const files = form.getAll('photos').filter(f => f && typeof f !== 'string');
      const cache = await caches.open(SHARED_CACHE);
      for (const k of await cache.keys()) await cache.delete(k);
      await Promise.all(files.map((f, i) => cache.put(
        new Request(scope.href + 'shared/' + String(i).padStart(3, '0')),
        new Response(f, { headers: {
          'content-type': f.type || 'image/jpeg',
          'x-name': encodeURIComponent(f.name || `photo-${i + 1}.jpg`),
          'x-modified': String(f.lastModified || 0)
        } })
      )));
      return Response.redirect(scope.href + '?shared=' + files.length, 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // App files: serve from cache, refresh in the background.
  e.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok && url.pathname.startsWith(scope.pathname)) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});
