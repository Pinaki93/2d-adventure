const CACHE = 'fruit-trail-v1';
const ASSETS = ['./', 'index.html', 'style.css', 'game.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
));
self.addEventListener('fetch', event => {
  if (event.request.method === 'GET') event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then(response => response || caches.match('./')))
  );
});
