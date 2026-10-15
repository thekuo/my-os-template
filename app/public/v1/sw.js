// my-os v1 app shell: stale-while-revalidate for the page and its static files, so the app opens instantly and updates
// in the background. Never touches /api/* or /login (data comes from the network; the app keeps its own last-state copy).
const CACHE = 'myos-v1-shell-3';
const SHELL = ['/', '/app.css?v=3', '/app.js?v=3', '/model.js?v=3', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { credentials: 'same-origin' })
    .then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('myos-v1-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/sw.js') return;
  const isPage = req.mode === 'navigate';
  const key = isPage ? '/' : url.pathname + url.search;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(key);
    const net = fetch(req).then((r) => {
      // only good responses are cached (a signed-out 401 login page never replaces the shell)
      if (r.ok && !r.redirected) c.put(key, r.clone());
      return r;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Offline', { status: 503 });
  }));
});
