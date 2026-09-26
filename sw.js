// Offline support: keep a copy of the game so it plays with no signal.
// Your best score lives in localStorage, not here.
// Network first, so a new version shows up as soon as you're online.

const CACHE = 'cairn-v1';
const SHELL = [
  './', 'index.html', 'css/cairn.css', 'js/cairn.js', 'js/matter.min.js', 'icon.svg', 'manifest.webmanifest',
  'fonts/cormorant-garamond-500.woff2', 'fonts/cormorant-garamond-600.woff2',
  'fonts/nunito-sans-400.woff2', 'fonts/nunito-sans-600.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))),
  );
});
