// Vercel serverless function: GET/POST /api/usage
// Needs, in the Vercel project settings:
//   - a Redis store from the Marketplace (Upstash, free tier). It sets
//     KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN).
//   - USAGE_SALT: a random secret of 16+ characters (e.g. `openssl rand -hex 32`).
// Without them the counter stays off and the page works as before.
import { handleUsage, upstashStore } from '../server/usage.js';

const store = upstashStore(
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN,
);

// Vercel's own header first: a client can send any X-Forwarded-For it likes.
function clientIp(req) {
  for (const h of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const v = req.headers[h];
    if (typeof v === 'string' && v) return v.split(',')[0].trim().slice(0, 64);
  }
  return req.socket?.remoteAddress ?? '';
}

export default async function handler(req, res) {
  try {
    const out = await handleUsage({
      method: req.method,
      query: req.query,
      body: typeof req.body === 'string' ? safeJson(req.body) : req.body,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] ?? '').slice(0, 256),
      origin: req.headers.origin,
      host: req.headers.host,
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
