// Monthly usage counter for the plan's gate: "Neuro users >= 1,000 per month
// before investing in step 2".
//
// Privacy: no IP address, user agent or contract address is stored. A visitor
// becomes a one-way HMAC of (month, ip, user agent) under a server secret, and
// that value only goes into a Redis HyperLogLog, which keeps an approximate
// count, not the values. A new month gives every visitor a new, unlinkable id.
//
// Numbers are approximate (HyperLogLog ~1% error) and can be inflated by
// someone rotating IPs. Treat them as a signal, not an audited figure.

import { createHmac } from 'node:crypto';

export const GOAL = 1000;
// Totals add up the monthly counters from the first month the counter ran.
export const FIRST_MONTH = '2026-10';
// What a check found (src/analyze.js levels). Only this word is sent, never the contract.
export const LEVELS = ['high', 'medium', 'low', 'info'];
const MAX_CHECKS_PER_VISITOR_PER_DAY = 200;
const KEEP_SECONDS = 400 * 24 * 3600; // a bit over a year of monthly history
const P = 'neuro:';

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return null; } };
const monthOf = (d) => d.toISOString().slice(0, 7);
const dayOf = (d) => d.toISOString().slice(0, 10);
/** Every month from FIRST_MONTH to `month`, inclusive (YYYY-MM). */
export function monthsUntil(month) {
  const out = [];
  let [y, m] = FIRST_MONTH.split('-').map(Number);
  const [ey, em] = month.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Framework-free handler.
 * @param {{method:string, query?:object, body?:any, ip?:string, ua?:string, origin?:string, host?:string, allowedHosts?:string[], now?:Date}} req
 * @param {{pipeline:(cmds:Array<Array<string|number>>)=>Promise<Array<any>>}|null} store
 * @param {string|undefined} secret
 * @returns {Promise<{status:number, json?:object, headers?:object}>}
 */
export async function handleUsage(req, store, secret) {
  const now = req.now ?? new Date();
  const enabled = !!store && typeof secret === 'string' && secret.length >= 16;

  if (req.method === 'GET') {
    const month = typeof req.query?.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)
      ? req.query.month : monthOf(now);
    if (!enabled) return { status: 200, json: { enabled: false, month, goal: GOAL } };
    const [users, checks, ...lv] = await store.pipeline([
      ['PFCOUNT', `${P}users:${month}`], ['GET', `${P}checks:${month}`],
      ...LEVELS.map((l) => ['GET', `${P}level:${l}:${month}`]),
    ]);
    // all-time: the sum of every month's counters since FIRST_MONTH
    const months = monthsUntil(monthOf(now));
    const keys = [`${P}checks:`, ...LEVELS.map((l) => `${P}level:${l}:`)];
    const vals = await store.pipeline(keys.flatMap((k) => months.map((mo) => ['GET', k + mo])));
    const sum = (i) => vals.slice(i * months.length, (i + 1) * months.length).reduce((a, v) => a + (Number(v) || 0), 0);
    const total = { checks: sum(0), since: FIRST_MONTH };
    LEVELS.forEach((l, i) => { total[l] = sum(i + 1); });
    return {
      status: 200,
      headers: { 'cache-control': 'public, max-age=60' },
      json: {
        enabled: true, month, users: Number(users) || 0, checks: Number(checks) || 0, goal: GOAL,
        found: Object.fromEntries(LEVELS.map((l, i) => [l, Number(lv[i]) || 0])), total,
      },
    };
  }

  if (req.method === 'POST') {
    // Browsers send Origin on cross-site POSTs; refuse other sites' pages (but the
  // ZETAPHY hub's, which proxies /api/* here: req.allowedHosts).
    if (req.origin && req.host && hostOf(req.origin) !== req.host && !(req.allowedHosts ?? []).includes(hostOf(req.origin))) return { status: 403, json: { error: 'origin' } };
    if (!req.body || req.body.event !== 'check') return { status: 400, json: { error: 'event' } };
    if (!enabled) return { status: 202, json: { counted: false } };

    const month = monthOf(now);
    const day = dayOf(now);
    const id = createHmac('sha256', secret).update(`${month}|${req.ip ?? ''}|${req.ua ?? ''}`).digest('hex').slice(0, 32);
    const rl = `${P}rl:${day}:${id}`;
    const [, seenToday] = await store.pipeline([
      ['PFADD', `${P}users:${month}`, id],
      ['INCR', rl],
      ['EXPIRE', rl, 2 * 24 * 3600],
      ['EXPIRE', `${P}users:${month}`, KEEP_SECONDS],
    ]);
    let counted = false;
    if (Number(seenToday) <= MAX_CHECKS_PER_VISITOR_PER_DAY) {
      // counters are kept for good (they are small and make the all-time totals)
      const level = LEVELS.includes(req.body.level) ? req.body.level : null;
      await store.pipeline([
        ['INCR', `${P}checks:${month}`], ['PERSIST', `${P}checks:${month}`],
        ...(level ? [['INCR', `${P}level:${level}:${month}`]] : []),
      ]);
      counted = true;
    }
    return { status: 202, json: { counted } };
  }

  return { status: 405, json: { error: 'method' }, headers: { allow: 'GET, POST' } };
}

/** Upstash Redis REST client (what Vercel's Redis/KV integration provides). */
export function upstashStore(url, token, fetchImpl = globalThis.fetch) {
  if (!url || !token) return null;
  return {
    async pipeline(cmds) {
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/pipeline`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(cmds),
      });
      if (!res.ok) throw new Error(`redis HTTP ${res.status}`);
      const out = await res.json();
      return out.map((r) => {
        if (r.error) throw new Error(`redis: ${r.error}`);
        return r.result;
      });
    },
  };
}

/** In-memory store for local runs and tests (exact counts, no expiry). */
export function memoryStore() {
  const kv = new Map();
  const run = ([cmd, key, ...rest]) => {
    switch (cmd) {
      case 'PFADD': {
        const s = kv.get(key) ?? new Set();
        const before = s.size;
        rest.forEach((v) => s.add(v));
        kv.set(key, s);
        return s.size > before ? 1 : 0;
      }
      case 'PFCOUNT': return kv.get(key)?.size ?? 0;
      case 'INCR': { const v = Number(kv.get(key) ?? 0) + 1; kv.set(key, String(v)); return v; }
      case 'GET': return kv.get(key) ?? null;
      case 'EXPIRE': return kv.has(key) ? 1 : 0;
      case 'PERSIST': return kv.has(key) ? 1 : 0;
      default: throw new Error(`unsupported ${cmd}`);
    }
  };
  return { async pipeline(cmds) { return cmds.map(run); } };
}
