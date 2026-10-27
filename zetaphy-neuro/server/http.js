// What the Vercel functions (api/*.js) share: the caller's IP, and CORS for the ZETAPHY hub.
//
// The hub (app.sawasdeecoin.com) shows the Neuro page in a frame and its page calls
// this site's API directly (web/api.js), not through the hub's /api rewrite: behind
// that rewrite every visitor would arrive from Vercel's proxy address and share one
// rate-limit and visitor bucket. So the hub's origins may read the answers here.

export const DEFAULT_HUB_HOSTS = 'app.sawasdeecoin.com,zetaphy-hub.vercel.app';

export function hubHosts(env = process.env) {
  return String(env.NEURO_ALLOWED_ORIGIN_HOSTS ?? DEFAULT_HUB_HOSTS).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Vercel's own header first: a client can send any X-Forwarded-For it likes. */
export function clientIp(req) {
  for (const h of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const v = req.headers?.[h];
    if (typeof v === 'string' && v) return v.split(',')[0].trim().slice(0, 64);
  }
  return req.socket?.remoteAddress ?? '';
}

const hostOf = (origin) => { try { const u = new URL(origin); return u.protocol === 'https:' ? u.host.toLowerCase() : ''; } catch { return ''; } };

/**
 * CORS headers for a request from one of the hub's https origins (none otherwise),
 * and whether it is a preflight that the function answers at once.
 */
export function cors(req, hosts, methods = 'GET, POST') {
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
  const ok = origin && hosts.includes(hostOf(origin));
  const headers = ok ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') {
    return { preflight: true, status: ok ? 204 : 403, headers: ok ? { ...headers, 'access-control-allow-methods': methods, 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } : {} };
  }
  return { preflight: false, headers };
}
