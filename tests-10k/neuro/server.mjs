// Neuro server handlers: client keys (IPv4 / IPv6 /64), CORS and client IP,
// the early-warning rate limiters and the usage counter under random traffic.

import { clientKeyOf } from '../../zetaphy-neuro/server/clientkey.js';
import { cors, clientIp, hubHosts } from '../../zetaphy-neuro/server/http.js';
import { memoryLimiter, redisLimiter } from '../../zetaphy-neuro/server/earlywarning.js';
import { handleUsage, memoryStore } from '../../zetaphy-neuro/server/usage.js';
import { ok, eq } from '../lib/harness.mjs';
import { junkText } from '../lib/rng.mjs';

// ------------------------------------------------------------------ N9: client keys
/** 8 groups -> one of the many textual forms of the same IPv6 address. */
function ipv6Text(R, groups) {
  const hex = groups.map((g) => {
    let s = g.toString(16);
    if (R.bool(0.3)) s = s.padStart(4, '0');
    return R.bool(0.3) ? s.toUpperCase() : s;
  });
  // compress the longest (or a random) run of zero groups with "::"
  const runs = [];
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i; while (j < 8 && groups[j] === 0) j++;
    runs.push([i, j]); i = j;
  }
  let text;
  if (runs.length && R.bool(0.8)) {
    const [a, b] = R.pick(runs);
    text = hex.slice(0, a).join(':') + '::' + hex.slice(b).join(':');
  } else text = hex.join(':');
  if (R.bool(0.15)) text += '%eth0'; // zone id (inside the brackets, as in [fe80::1%eth0])
  if (R.bool(0.15)) text = `[${text}]`;
  if (R.bool(0.1)) text = `  ${text} `;
  return text;
}
const ref64 = (groups) => groups.slice(0, 4).map((g) => g.toString(16)).join(':') + '::/64';

export const clientKeys = {
  group: 'Neuro', name: 'neuro/clientKeyOf', count: 400,
  what: 'rate-limit client key: every textual form of one IPv6 address (zero-compressed, padded, upper case, bracketed, zone id) gives the same /64 key; addresses in one /64 share it, other /64s do not; IPv4 and ::ffff:IPv4 give the IPv4',
  gen(R) {
    const kind = R.pick(['v6', 'v6', 'v6', 'v4', 'mapped']);
    if (kind !== 'v6') return { kind, v4: [R.int(256), R.int(256), R.int(256), R.int(256)], s1: R.u32(), s2: R.u32() };
    const groups = Array.from({ length: 8 }, () => (R.bool(0.35) ? 0 : R.int(65536)));
    return { kind, groups, other: Array.from({ length: 4 }, () => R.int(65536)), s1: R.u32(), s2: R.u32(), flip: R.int(4) };
  },
  async check({ kind, groups, v4, other, s1, s2, flip }) {
    const { rng } = await import('../lib/rng.mjs');
    const R1 = rng(s1), R2 = rng(s2);
    if (kind === 'v4') { const ip = v4.join('.'); eq(clientKeyOf(ip), ip, 'IPv4 as is'); eq(clientKeyOf(`  ${ip} `), ip, 'trimmed'); return; }
    if (kind === 'mapped') { const ip = v4.join('.'); eq(clientKeyOf(`::ffff:${ip}`), ip, 'v4-mapped'); eq(clientKeyOf(`::FFFF:${ip}`), ip, 'v4-mapped, upper case'); return; }
    const want = ref64(groups);
    const a = clientKeyOf(ipv6Text(R1, groups));
    const b = clientKeyOf(ipv6Text(R2, groups));
    eq(a, want, `/64 of ${ipv6Text(rng(s1), groups)}`);
    eq(b, want, 'second form of the same address');
    // same /64, other interface id -> same key
    const sibling = [...groups.slice(0, 4), ...other];
    eq(clientKeyOf(ipv6Text(R1, sibling)), want, 'same /64, other host');
    // another /64 -> another key
    const g2 = [...groups]; g2[flip] ^= 1 << (s2 % 16);
    ok(clientKeyOf(ipv6Text(R2, g2)) !== want, 'another /64 gets another key');
  },
};

// ------------------------------------------------------------------ N10: CORS + client IP
const HOSTS = hubHosts({ NEURO_ALLOWED_ORIGIN_HOSTS: 'app.sawasdeecoin.com, Zetaphy-Hub.vercel.app' });
const TRICKS = [
  (h) => `https://${h}`, (h) => `http://${h}`, (h) => `https://${h}.evil.com`, (h) => `https://evil${h}`, (h) => `https://${h}:8443`,
  (h) => `https://${h.toUpperCase()}`, (h) => `https://x.${h}`, (h) => `wss://${h}`, (h) => `https://${h}/path`, (h) => `https://user@${h}`,
  (h) => `https://${h}@evil.com`, (h) => `null`, (h) => `https://${h}:443`, (h) => ` https://${h}`, (h) => `https://${h}.`,
  (h) => `https://${h.replace('.', '-')}`, (h) => `//${h}`, (h) => `https://${h}%00.evil.com`,
];
/** Expected: allowed iff the Origin parses as an https URL whose host is one of the hub hosts. */
function expectAllowed(origin) {
  try { const u = new URL(origin); return u.protocol === 'https:' && HOSTS.includes(u.host.toLowerCase()); } catch { return false; }
}
export const corsHeaders = {
  group: 'Neuro', name: 'neuro/cors-clientIp', count: 400,
  what: 'CORS on random/tricky Origins: allowed only for https hub hosts (no suffix/prefix/scheme/port tricks), echoes the exact origin, preflight 204/403; clientIp prefers Vercel\'s header, first hop, <= 64 chars',
  gen(R) {
    const base = R.pick(['app.sawasdeecoin.com', 'zetaphy-hub.vercel.app', 'sawasdeecoin.com', 'evil.com']);
    const origin = R.bool(0.8) ? R.pick(TRICKS)(base) : junkText(R, 30);
    const headers = {};
    for (const h of ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']) {
      if (R.bool(0.5)) headers[h] = R.bool(0.8) ? Array.from({ length: R.range(1, 3) }, () => `${R.int(256)}.${R.int(256)}.${R.int(256)}.${R.int(256)}`).join(', ') : junkText(R, 90);
    }
    return { origin, method: R.pick(['GET', 'POST', 'OPTIONS', 'PUT']), headers, remote: R.bool() ? '10.0.0.' + R.int(256) : undefined };
  },
  check({ origin, method, headers, remote }) {
    const req = { method, headers: { ...headers, origin }, socket: remote ? { remoteAddress: remote } : undefined };
    const r = cors(req, HOSTS);
    const allowed = expectAllowed(origin);
    eq(!!r.headers['access-control-allow-origin'], allowed, `allow-origin for ${JSON.stringify(origin)}`);
    if (r.headers['access-control-allow-origin']) {
      eq(r.headers['access-control-allow-origin'], origin, 'echoes the exact origin');
      ok(r.headers.vary === 'Origin', 'Vary: Origin');
      const host = new URL(origin).host.toLowerCase();
      ok(HOSTS.includes(host) && new URL(origin).protocol === 'https:', 'only hub https origins');
    }
    eq(r.preflight, method === 'OPTIONS', 'preflight iff OPTIONS');
    if (r.preflight) eq(r.status, allowed ? 204 : 403, 'preflight status');
    const ip = clientIp(req);
    ok(typeof ip === 'string' && ip.length <= 64, 'ip is a short string');
    const first = ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for'].find((h) => typeof headers[h] === 'string' && headers[h]);
    if (first) eq(ip, headers[first].split(',')[0].trim().slice(0, 64), 'first hop of the most trusted header');
    else eq(ip, remote ?? '', 'socket address without headers');
  },
};

// ------------------------------------------------------------------ N11: limiters
function trafficPlan(R) {
  const clients = Array.from({ length: R.range(1, 6) }, (_, i) => (R.bool(0.5) ? `203.0.113.${i + 1}` : `2001:db8:${i.toString(16)}:1::${R.range(1, 9)}`));
  const events = [];
  let t = 1_800_000_000_000 + R.int(86_400_000);
  const n = R.range(20, 160);
  for (let i = 0; i < n; i++) {
    t += R.pick([0, 10, 500, 3_000, 20_000, 61_000, 3_600_000]);
    let ip = R.pick(clients);
    // the same /64 under another interface id
    if (ip.includes(':') && R.bool(0.3)) ip = ip.replace(/::\d+$/, `::${R.range(10, 99)}`);
    events.push([t, ip]);
  }
  return { perMinute: R.range(1, 15), perDay: R.range(5, 60), globalPerMinute: R.range(5, 40), events, redis: R.bool() };
}
const keyOf = (ip) => clientKeyOf(ip);
export const limiters = {
  group: 'Neuro', name: 'neuro/rate-limiters', count: 150,
  what: 'memoryLimiter / redisLimiter (on memoryStore) under random multi-client traffic: allowed requests never exceed per-minute, per-day and global caps; a refused request names a positive retryAfter; same /64 shares a budget',
  gen(R) { return trafficPlan(R); },
  async check({ perMinute, perDay, globalPerMinute, events, redis }) {
    let now = 0;
    const lim = redis
      ? redisLimiter(memoryStore(), 'x'.repeat(32), { perMinute, perDay, globalPerMinute, now: () => now })
      : memoryLimiter({ perMinute, perDay, globalPerMinute, now: () => now });
    const perMin = new Map(), perD = new Map(), glob = new Map();
    for (const [t, ip] of events) {
      now = t;
      const r = await lim.check(ip);
      if (!r.ok) { ok(Number.isInteger(r.retryAfter) && r.retryAfter > 0, `retryAfter ${r.retryAfter}`); continue; }
      const k = keyOf(ip), m = Math.floor(t / 60_000), d = Math.floor(t / 86_400_000);
      const km = `${k}|${m}`, kd = `${k}|${d}`;
      perMin.set(km, (perMin.get(km) ?? 0) + 1);
      perD.set(kd, (perD.get(kd) ?? 0) + 1);
      glob.set(m, (glob.get(m) ?? 0) + 1);
      ok(perMin.get(km) <= perMinute, `client ${k} allowed ${perMin.get(km)} > ${perMinute} in a minute`);
      ok(perD.get(kd) <= perDay, `client ${k} allowed ${perD.get(kd)} > ${perDay} in a day`);
      ok(glob.get(m) <= globalPerMinute, `all clients allowed ${glob.get(m)} > ${globalPerMinute} in a minute`);
    }
  },
};

// ------------------------------------------------------------------ N12: usage counter
export const usage = {
  group: 'Neuro', name: 'neuro/usage-counter', count: 150,
  what: 'handleUsage under random POST/GET sequences: counted checks per client per day <= 200, monthly counters equal the model, level/tx/zetaphy counters only for valid values, foreign origins refused, GET never writes',
  gen(R) {
    const clients = Array.from({ length: R.range(1, 4) }, (_, i) => `198.51.100.${i + 1}`);
    const evs = [];
    const n = R.range(10, 260);
    let day = 0;
    for (let i = 0; i < n; i++) {
      if (R.bool(0.01)) day++;
      const op = R.float();
      if (op < 0.1) evs.push({ m: 'GET', day });
      else evs.push({
        m: 'POST', day, ip: R.pick(clients), ua: R.pick(['a', 'b']),
        origin: R.pick([undefined, 'https://neuro.sawasdeecoin.com', 'https://app.sawasdeecoin.com', 'https://evil.com']),
        body: R.bool(0.95) ? { event: R.pick(['check', 'check', 'check', 'view']), level: R.pick(['high', 'medium', 'low', 'info', 'bogus', undefined]), kind: R.pick(['tx', 'contract']), chain: R.pick(['zetaphy', 'bsc']) } : null,
      });
    }
    // a heavy client to hit the per-day cap
    if (R.bool(0.3)) for (let i = 0; i < 230; i++) evs.push({ m: 'POST', day, ip: clients[0], ua: 'a', body: { event: 'check', level: 'high' } });
    return { evs };
  },
  async check({ evs }) {
    const store = memoryStore();
    const secret = 's'.repeat(32);
    const model = { checks: 0, high: 0, medium: 0, low: 0, info: 0, tx: 0, zetaphy: 0 };
    const perDay = new Map();
    let all = 0;
    for (const e of evs) {
      const now = new Date(Date.UTC(2026, 10, 3 + e.day, 12));
      if (e.m === 'GET') {
        const r = await handleUsage({ method: 'GET', query: {}, now }, store, secret);
        eq(r.status, 200, 'GET status');
        eq(r.json.checks, model.checks, 'GET checks = model');
        for (const l of ['high', 'medium', 'low', 'info']) eq(r.json.found[l], model[l], `GET ${l}`);
        eq(r.json.tx, model.tx, 'GET tx'); eq(r.json.zetaphy, model.zetaphy, 'GET zetaphy');
        continue;
      }
      const r = await handleUsage({ method: 'POST', body: e.body, ip: e.ip, ua: e.ua, origin: e.origin, host: 'neuro.sawasdeecoin.com', allowedHosts: ['app.sawasdeecoin.com'], now }, store, secret);
      if (e.origin === 'https://evil.com') { eq(r.status, 403, 'foreign origin refused'); continue; }
      if (!e.body || e.body.event !== 'check') { eq(r.status, 400, 'bad event'); continue; }
      eq(r.status, 202, 'POST accepted');
      const k = `${e.day}|${e.ip}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
      all++;
      const counted = perDay.get(k) <= 200 && all <= 10_000;
      eq(r.json.counted, counted, `counted (client's #${perDay.get(k)} today)`);
      if (counted) {
        model.checks++;
        if (['high', 'medium', 'low', 'info'].includes(e.body.level)) model[e.body.level]++;
        if (e.body.kind === 'tx') model.tx++;
        if (e.body.chain === 'zetaphy') model.zetaphy++;
      }
    }
    const r = await handleUsage({ method: 'GET', query: {}, now: new Date(Date.UTC(2026, 10, 30)) }, store, secret);
    eq(r.json.checks, model.checks, 'final checks');
    eq(r.json.total.checks, model.checks, 'all-time total');
  },
};

export default [clientKeys, corsHeaders, limiters, usage];
