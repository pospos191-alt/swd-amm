// Vercel serverless function: GET/POST /api/usage
// Needs, in the Vercel project settings, a store (server/store.js):
//   - Cloudflare D1 (free): NEURO_D1_ACCOUNT_ID, NEURO_D1_DATABASE_ID and
//     NEURO_D1_TOKEN (an API token with D1: Edit), or
//   - a Redis store from the Marketplace (Upstash, free tier). It sets
//     KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN).
//   - USAGE_SALT: a random secret of 16+ characters (e.g. `openssl rand -hex 32`).
// Without them the counter stays off and the page works as before.
import { handleUsage } from '../server/usage.js';
import { storeFromEnv } from '../server/store.js';
import { clientIp, cors, hubHosts } from '../server/http.js';

const store = storeFromEnv(process.env);

const HUB_HOSTS = hubHosts();

export default async function handler(req, res) {
  const c = cors(req, HUB_HOSTS);
  for (const [k, v] of Object.entries(c.headers)) res.setHeader(k, v);
  if (c.preflight) { res.status(c.status).end(); return; }
  try {
    const out = await handleUsage({
      method: req.method,
      query: req.query,
      body: typeof req.body === 'string' ? safeJson(req.body) : req.body,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] ?? '').slice(0, 256),
      origin: req.headers.origin,
      host: req.headers.host,
      allowedHosts: HUB_HOSTS,
    }, store, process.env.USAGE_SALT);
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.status(out.status).json(out.json ?? {});
  } catch {
    res.status(503).json({ error: 'unavailable' });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
