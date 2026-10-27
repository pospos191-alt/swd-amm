// Vercel serverless function: POST /api/early-warning  {chain, address}
// Neuro's early-warning tier (server/earlywarning.js): runs the private rule
// pack against a contract's code and answers only
// { warnings: [{ reason, severity, ref }] }. Advisory; not part of verdicts.
// Needs, in the Vercel project settings (Environment Variables, Production),
// ONE of:
//   - NEURO_PRIVATE_RULES: the pack itself (JSON, or base64 of the JSON), or
//   - NEURO_RULES_TOKEN: a fine-grained GitHub token with read-only access
//     to the private rules repo (Contents: Read), plus optionally
//     NEURO_RULES_REPO (default pospos191-alt/zetaphy-private) and
//     NEURO_RULES_PATH (default rules/pack.json). Re-read every 10 minutes.
// Without them it answers { warnings: [], configured: false }.
// Rate limits: per IP, in the usage counter's store (server/store.js: D1 or Redis) when it
// and USAGE_SALT are set (shared by all instances),
// otherwise in this instance's memory.
import { handleEarlyWarning, createPackLoader, memoryLimiter, redisLimiter, answerCache } from '../server/earlywarning.js';
import { storeFromEnv } from '../server/store.js';

const loader = createPackLoader({ env: process.env });
const store = storeFromEnv(process.env);
const salt = process.env.USAGE_SALT;
const limiter = store && typeof salt === 'string' && salt.length >= 16 ? redisLimiter(store, salt) : memoryLimiter();
const cache = answerCache();

// Vercel's own header first: a client can send any X-Forwarded-For it likes.
function clientIp(req) {
  for (const h of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
    const v = req.headers[h];
    if (typeof v === 'string' && v) return v.split(',')[0].trim().slice(0, 64);
  }
  return req.socket?.remoteAddress ?? '';
}

// The ZETAPHY hub (zetaphy-hub) shows this page in its own site and proxies /api/*
// here, so its POSTs carry the hub's Origin.
const HUB_HOSTS = String(process.env.NEURO_ALLOWED_ORIGIN_HOSTS ?? 'app.sawasdeecoin.com,zetaphy-hub.vercel.app')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export default async function handler(req, res) {
  try {
    const out = await handleEarlyWarning({
      method: req.method,
      body: typeof req.body === 'string' ? safeJson(req.body) : req.body,
      ip: clientIp(req),
      origin: req.headers.origin,
      host: req.headers.host,
      allowedHosts: HUB_HOSTS,
    }, { loader, limiter, cache });
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.status(out.status).json(out.json ?? {});
  } catch {
    // Nothing about the request, the pack or the token goes to the logs.
    res.status(503).json({ error: 'unavailable' });
  }
}

function safeJson(s) {
  if (s.length > 4096) return null;
  try { return JSON.parse(s); } catch { return null; }
}
