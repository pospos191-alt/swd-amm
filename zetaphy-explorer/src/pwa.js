// Installable app (PWA): registers sw.js, which caches the static app shell only (never
// node answers). Not registered inside a frame (the hub embeds the explorer and is its own
// app) or on plain http (except localhost). The service worker updates itself on a new deploy.
export function registerServiceWorker(win = window) {
  try {
    const nav = win.navigator;
    if (!nav?.serviceWorker || win.top !== win) return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(win.location.hostname);
    if (win.location.protocol !== 'https:' && !local) return null;
    return nav.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' })
      .then((reg) => { reg.update?.().catch(() => {}); return reg; })
      .catch(() => null);
  } catch { return null; }
}
