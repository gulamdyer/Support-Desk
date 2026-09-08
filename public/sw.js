/* Service worker: shell only, never data.
 *
 * The inbox shows live conversations. Serving a cached thread would put stale
 * messages in front of an agent who believes they are current — worse than
 * showing nothing. So API calls, media and the event stream are never cached
 * or intercepted; only the static shell is, so the app opens offline and can
 * render its own "not connected" state.
 */
const CACHE = 'inbox-shell-v3';
const SHELL = ['/', '/index.html', '/style.css', '/app.js',
  '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  // Anything live stays live: never touch it.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;

  // Navigations: try the network so a fresh shell wins, fall back when offline.
  //
  // A redeploy is not "offline" — for the ~15 seconds the container is being
  // swapped, the proxy has no backend and answers 404. That is a perfectly
  // successful HTTP response, so .catch() never fires and the agent was shown
  // a bare "404 page not found". Treat any failed status the same as a dead
  // network and serve the cached shell instead.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => (res.ok ? res : caches.match('/index.html').then((c) => c || res)))
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Static assets: network first, cache as the offline fallback.
  //
  // Cache-first would serve the previous app.js for one load after every deploy
  // — wrong for a tool that is actively being fixed. Online users always get the
  // current build; offline users still get a working shell.
  // Same reasoning for the shell's assets: a 404 mid-deploy would otherwise
  // replace app.js with an error page and leave a blank screen behind.
  e.respondWith(
    fetch(request).then((res) => {
      if (res.ok) {
        caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      }
      return caches.match(request).then((c) => c || res);
    }).catch(() => caches.match(request))
  );
});
