// Service worker of the ZETAPHY explorer: caches the static app shell only.
//   - Only this site's own GET requests for shell files are handled (pages, style, scripts,
//     icons, manifest, and labels.json / crosschain.json, which are built per deploy). Node answers
//     (RPC / REST, any other host), config.json and everything
//     else go straight to the network and are never stored.
//   - Network first: an online visitor always gets the deployed files (a new deploy is used at
//     once); the cache is only the fallback when the network is down. A new sw.js replaces the
//     old one at once (skipWaiting + clients.claim) and old caches are deleted.
//   - Offline, a page load gets offline.html (the explorer needs the node to show anything).
const VERSION = 'zetaphy-explorer-shell-v2';
const SHELL = [
  'index.html', 'offline.html', 'style.css', 'favicon.svg', 'logo.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'src/app.js', 'src/dom.js', 'src/i18n.js', 'src/config.js', 'src/rpc.js', 'src/chain.js', 'src/evm.js', 'src/cosmos.js', 'src/threat.js',
  'src/format.js', 'src/wallet-safety.js', 'src/wallet-safety-i18n.js', 'src/wallet-safety.css', 'src/pwa.js', 'vendor/zetaphy-lib.js',
  'labels.json', 'crosschain.json', 'src/insight.css', 'src/labels.js', 'src/risk.js',
];
// Paths (relative to the scope) that are shell files; others are not touched.
const SHELL_PATH = /^(|index\.html|offline\.html|labels\.json|crosschain\.json|style\.css|favicon\.svg|logo\.svg|manifest\.webmanifest|icon-\d+\.png|src\/[a-z0-9-]+\.(js|css)|vendor\/[a-z0-9-]+\.js)$/;
const scopePath = () => new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // one by one: a file missing from a deploy must not stop the install
    await Promise.all(SHELL.map((p) => cache.add(new Request(p, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k.startsWith('zetaphy-explorer-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** The shell path of a request, or null (other origin, not GET, not a shell file). */
function shellPath(req) {
  if (req.method !== 'GET') return null;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return null; // node RPC / REST, IPFS, anything off-site: never handled
  const base = scopePath();
  if (!url.pathname.startsWith(base)) return null;
  const rel = url.pathname.slice(base.length);
  return SHELL_PATH.test(rel) ? rel : null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const rel = shellPath(req);
  if (rel == null) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok && res.type === 'basic') await cache.put(rel === '' ? 'index.html' : req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') return (await cache.match('offline.html')) ?? Response.error();
      const hit = await cache.match(rel === '' ? 'index.html' : req, { ignoreSearch: true });
      if (hit) return hit;
      throw e;
    }
  })());
});
