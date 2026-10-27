// Cloudflare D1 store (server/d1store.js): the request it sends, and (where
// node:sqlite exists, Node 22+) the real SQL run on SQLite behind a stand-in for
// D1's REST endpoint, through the usage counter and the early-warning limiter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Store } from '../server/d1store.js';
import { storeFromEnv } from '../server/store.js';
import { handleUsage, memoryStore } from '../server/usage.js';
import { redisLimiter } from '../server/earlywarning.js';

const ACC = 'a'.repeat(32);
const DB = '12345678-1234-1234-1234-123456789abc';
const SALT = 'x'.repeat(32);

/** A stand-in for POST /accounts/:a/d1/database/:d/query backed by node:sqlite. */
async function sqliteD1() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return null; }
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { batch } = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, batch });
    const result = batch.map(({ sql, params = [] }) => {
      const st = db.prepare(sql);
      if (/^\s*select|returning/i.test(sql)) return { success: true, results: st.all(...params), meta: {} };
      const r = st.run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes) } };
    });
    return { ok: true, json: async () => ({ success: true, result, errors: [], messages: [] }) };
  };
  return { db, calls, fetchImpl };
}

test('d1 store: request shape, schema once, errors, and when it is chosen', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, batch: JSON.parse(init.body).batch });
    const n = JSON.parse(init.body).batch.length;
    return { ok: true, json: async () => ({ success: true, result: Array.from({ length: n }, () => ({ success: true, results: [{ n: 7 }], meta: { changes: 1 } })) }) };
  };
  const s = d1Store(ACC, DB, 'tok', { fetchImpl, random: () => 0.5 });
  assert.deepEqual(await s.pipeline([['INCR', 'k'], ['GET', 'k']]), [7, '7']);
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.equal(calls[0].batch.length, 4, 'two CREATE TABLE IF NOT EXISTS, then the two commands');
  assert.match(calls[0].batch[0].sql, /CREATE TABLE IF NOT EXISTS neuro_kv/);
  assert.ok(calls[0].batch.slice(2).every((q) => q.params.every((p) => typeof p === 'string')), 'params are strings');
  await s.pipeline([['GET', 'k']]);
  assert.equal(calls[1].batch.length, 1, 'tables are created once per instance');
  // missing or malformed settings: no store
  assert.equal(d1Store(undefined, DB, 'tok'), null);
  assert.equal(d1Store('not-hex', DB, 'tok'), null);
  assert.equal(d1Store(ACC, 'x/../y', 'tok'), null);
  // failures throw (callers fall back)
  const bad = d1Store(ACC, DB, 'tok', { fetchImpl: async () => ({ ok: true, json: async () => ({ success: false, errors: [{ message: 'limit' }] }) }) });
  await assert.rejects(bad.pipeline([['GET', 'k']]), /d1/);
  const down = d1Store(ACC, DB, 'tok', { fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(down.pipeline([['GET', 'k']]), /HTTP 429/);
  await assert.rejects(s.pipeline([['DEL', 'k']]), /unsupported/);
  // D1 is preferred when its three settings are there, then Upstash, else none
  const env = { NEURO_D1_ACCOUNT_ID: ACC, NEURO_D1_DATABASE_ID: DB, NEURO_D1_TOKEN: 't', KV_REST_API_URL: 'https://r.example', KV_REST_API_TOKEN: 'u' };
  assert.ok(storeFromEnv(env));
  assert.ok(storeFromEnv({ KV_REST_API_URL: 'https://r.example', KV_REST_API_TOKEN: 'u' }));
  assert.equal(storeFromEnv({}), null);
});

test('d1 store on real SQL: same numbers as the in-memory store, expiry, limiter, cleanup', async (t) => {
  const d1 = await sqliteD1();
  if (!d1) return t.skip('node:sqlite needs Node 22+');
  let clock = Date.parse('2026-10-27T10:00:00Z');
  let cleanup = false;
  const s = d1Store(ACC, DB, 'tok', { fetchImpl: d1.fetchImpl, now: () => clock, random: () => (cleanup ? 0 : 0.5) });
  const m = memoryStore();
  const now = () => new Date(clock);
  const post = (store, ip, body) => handleUsage({ method: 'POST', body: { event: 'check', ...body }, ip, ua: 'ua', now: now() }, store, SALT);
  for (const store of [s, m]) {
    await post(store, '1.1.1.1', { level: 'high', kind: 'tx', chain: 'zetaphy' });
    await post(store, '1.1.1.1', { level: 'info' });
    await post(store, '2.2.2.2', { level: 'high', chain: 'other' });
  }
  const get = async (store) => (await handleUsage({ method: 'GET', now: now() }, store, SALT)).json;
  const a = await get(s);
  const b = await get(m);
  assert.deepEqual(a, b);
  assert.equal(a.users, 2);
  assert.equal(a.checks, 3);
  assert.deepEqual(a.found, { high: 2, medium: 0, low: 0, info: 1 });
  assert.equal(a.tx, 1);
  assert.equal(a.zetaphy, 1);
  assert.equal(a.total.checks, 3);

  // INCR/EXPIRE/GET: an expired number reads as missing and starts again from 1
  assert.deepEqual(await s.pipeline([['INCR', 'e'], ['EXPIRE', 'e', 60], ['INCR', 'e']]), [1, 1, 2]);
  assert.deepEqual(await s.pipeline([['EXPIRE', 'e', 999]]), [0], 'expiry is set once');
  clock += 61_000;
  assert.deepEqual(await s.pipeline([['GET', 'e'], ['INCR', 'e'], ['GET', 'e']]), [null, 1, '1']);
  assert.deepEqual(await s.pipeline([['EXPIRE', 'e', 10], ['PERSIST', 'e']]), [1, 1]);
  clock += 11_000;
  assert.deepEqual(await s.pipeline([['GET', 'e']]), ['1'], 'persisted');
  // SET: an integer, replaces the value and clears an expiry
  assert.deepEqual(await s.pipeline([['SET', 'z', 41], ['SET', 'z', 42], ['GET', 'z']]), ['OK', 'OK', '42']);
  assert.deepEqual(await s.pipeline([['EXPIRE', 'z', 5], ['SET', 'z', 7]]), [1, 'OK']);
  clock += 6_000;
  assert.deepEqual(await s.pipeline([['GET', 'z']]), ['7']);
  await assert.rejects(s.pipeline([['SET', 'z', 'x']]), /integer/);
  // PFADD/PFCOUNT
  assert.deepEqual(await s.pipeline([['PFADD', 'u', 'a'], ['PFADD', 'u', 'a'], ['PFADD', 'u', 'b'], ['PFCOUNT', 'u'], ['PFCOUNT', 'none']]), [1, 0, 1, 2, 0]);

  // the early-warning limiter: 12 a minute per client, then refused; a new minute opens again
  const lim = redisLimiter(s, SALT, { now: () => clock });
  for (let i = 0; i < 12; i++) assert.equal((await lim.check('9.9.9.9')).ok, true);
  assert.equal((await lim.check('9.9.9.9')).ok, false);
  assert.equal((await lim.check('8.8.8.8')).ok, true, 'other clients are not affected');
  clock += 60_000;
  assert.equal((await lim.check('9.9.9.9')).ok, true);

  // cleanup removes expired rate-limit rows, keeps the monthly counters
  clock += 3 * 86400_000;
  cleanup = true;
  await s.pipeline([['GET', 'x']]);
  const left = d1.db.prepare('SELECT k FROM neuro_kv ORDER BY k').all().map((r) => r.k);
  assert.ok(left.every((k) => !k.startsWith('neuro:ew:') && !k.startsWith('neuro:rl:')), left.join(' '));
  assert.ok(left.includes('neuro:checks:2026-10'));
});
