// Offline support: network-first for app files (so updates arrive), cache as fallback.
const CACHE = 'stride-v3';
const ASSETS = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/util.js', 'js/store.js', 'js/vdot.js',
  'js/plan.js', 'js/gym.js', 'js/coach.js', 'js/health.js', 'js/tracker.js', 'js/config.js', 'js/google.js', 'js/sync.js', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never cache API calls
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
