// GamePointLa Service Worker
const CACHE = 'gamepointla-v3';
const ASSETS = [
  './',
  './index.html',
  '/app',
  './manifest.webmanifest',
  '/app/lib/mp4-muxer.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only intercept real http(s) requests. blob:/data: URLs (e.g. the export
  // pipeline's URL.createObjectURL(blob) download link) aren't network
  // requests and aren't valid to re-fetch from the service worker's own
  // execution context — a blob URL is scoped to the page that created it.
  // Without this guard, "blob:https://..." fails the origin check below
  // (it doesn't start with self.location.origin) and falls into the
  // cross-origin branch, whose fetch() then fails and returns an empty 503
  // — which is exactly what surfaces to the user as "Download failed" on
  // Android Chrome. Returning without calling respondWith() lets the
  // browser handle these natively.
  if (!e.request.url.startsWith('http')) return;

  // Don't cache cross-origin or Google Fonts requests at SW level
  if (!e.request.url.startsWith(self.location.origin)) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});