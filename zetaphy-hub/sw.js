// The hub's service worker (registered when the Offline tab is first opened, offline.js): keeps the static app
// shell so the hub, and its Offline tab, load with no network. It caches ONLY the files listed in SHELL (the hub's
// own pages, scripts, styles, icons and hub-config.json: public contract addresses), written by build.mjs with a
// version (a hash of those files). Never cached: anything from another origin (the node's RPC, explorers), POST
// requests, /api/ (the Neuro API proxy), and every same-origin file not in the list. Network first: online you
// always get the current files (and the copy is refreshed); offline the saved copy answers.
const VERSION = '__VERSION__';
const SHELL = ['__SHELL__'];
const CACHE = `zetaphy-shell-${VERSION}`;
const scope = new URL(self.registration.scope);
const urlOf = (p) => new URL(p, scope).href;
const SHELL_URLS = new Set(SHELL.map(urlOf));
const INDEX = urlOf('./');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL_URLS].map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zetaphy-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** The shell entry a request maps to (the page itself for any ?tab=… navigation), or null: not ours to cache. */
function shellKey(req) {
  if (req.method !== 'GET') return null;
  const u = new URL(req.url);
  if (u.origin !== scope.origin || u.pathname.startsWith('/api/')) return null;
  if (req.mode === 'navigate' && (u.href.split(/[?#]/)[0] === INDEX || u.href.split(/[?#]/)[0] === urlOf('./index.html'))) return INDEX;
  const bare = u.href.split('#')[0];
  return u.search === '' && SHELL_URLS.has(bare) ? bare : null;
}

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  try {
    // a slow network counts as none after 6 s (a navigation request cannot take an AbortSignal)
    let t;
    const res = await Promise.race([fetch(req), new Promise((_, no) => { t = setTimeout(() => no(new Error('slow')), 6000); })]).finally(() => clearTimeout(t));
    if (res.ok && res.type === 'basic') await cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const key = shellKey(e.request);
  if (key) e.respondWith(networkFirst(e.request, key));
});
