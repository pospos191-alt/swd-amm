import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUsage, memoryStore, upstashStore, GOAL, monthsUntil } from '../server/usage.js';

const SECRET = 'test-secret-0123456789';
const oct = new Date('2026-10-19T10:00:00Z');
const post = (store, extra = {}) => handleUsage({ method: 'POST', body: { event: 'check' }, ip: '1.2.3.4', ua: 'UA', now: oct, ...extra }, store, SECRET);
const get = (store, extra = {}) => handleUsage({ method: 'GET', query: {}, now: oct, ...extra }, store, SECRET);

test('counts unique visitors and total checks', async () => {
  const s = memoryStore();
  await post(s);
  await post(s);
  await post(s, { ip: '5.6.7.8' });
  const r = await get(s);
  const { enabled, month, users, checks, goal } = r.json;
  assert.deepEqual({ enabled, month, users, checks, goal }, { enabled: true, month: '2026-10', users: 2, checks: 3, goal: GOAL });
});

test('a new month starts a fresh count', async () => {
  const s = memoryStore();
  await post(s);
  await post(s, { now: new Date('2026-11-02T00:00:00Z') });
  assert.equal((await get(s)).json.users, 1);
  assert.equal((await get(s, { query: { month: '2026-11' } })).json.users, 1);
});

test('stores no IP address or user agent', async () => {
  const s = memoryStore();
  const seen = [];
  const spy = { pipeline: (cmds) => { seen.push(...cmds.flat().map(String)); return s.pipeline(cmds); } };
  await handleUsage({ method: 'POST', body: { event: 'check' }, ip: '203.0.113.77', ua: 'SecretBrowser/1.0', now: oct }, spy, SECRET);
  const all = seen.join(' ');
  assert.ok(!all.includes('203.0.113.77'));
  assert.ok(!all.includes('SecretBrowser'));
});

test('one visitor cannot pump the check count past the daily cap', async () => {
  const s = memoryStore();
  for (let i = 0; i < 205; i++) await post(s);
  const r = await get(s);
  assert.equal(r.json.users, 1);
  assert.equal(r.json.checks, 200);
});

test('off without a store or a long enough secret', async () => {
  assert.deepEqual((await handleUsage({ method: 'POST', body: { event: 'check' } }, null, SECRET)).json, { counted: false });
  assert.deepEqual((await handleUsage({ method: 'POST', body: { event: 'check' } }, memoryStore(), 'short')).json, { counted: false });
  assert.equal((await handleUsage({ method: 'GET', now: oct }, null, undefined)).json.enabled, false);
});

test('rejects other sites, bad bodies, bad months and other methods', async () => {
  const s = memoryStore();
  assert.equal((await post(s, { origin: 'https://evil.example', host: 'neuro.example' })).status, 403);
  assert.equal((await post(s, { origin: 'null', host: 'neuro.example' })).status, 403);
  assert.equal((await post(s, { origin: 'https://neuro.example', host: 'neuro.example' })).status, 202);
  assert.equal((await post(s, { origin: 'https://app.example', host: 'neuro.example', allowedHosts: ['app.example'] })).status, 202);
  assert.equal((await post(s, { origin: 'https://evil.example', host: 'neuro.example', allowedHosts: ['app.example'] })).status, 403);
  assert.equal((await handleUsage({ method: 'POST', body: { event: 'x' } }, s, SECRET)).status, 400);
  assert.equal((await get(s, { query: { month: '2026-13' } })).json.month, '2026-10');
  assert.equal((await handleUsage({ method: 'DELETE' }, s, SECRET)).status, 405);
});

test('upstash client sends a pipeline and unwraps results', async () => {
  let sent;
  const store = upstashStore('https://r.example/', 'tok', async (url, init) => {
    sent = { url, init };
    return { ok: true, json: async () => [{ result: 1 }, { result: '7' }] };
  });
  assert.deepEqual(await store.pipeline([['PFADD', 'k', 'v'], ['GET', 'c']]), [1, '7']);
  assert.equal(sent.url, 'https://r.example/pipeline');
  assert.equal(sent.init.headers.authorization, 'Bearer tok');
  assert.equal(upstashStore(undefined, 'tok'), null);
});

test('counts what checks found (only the level word) and all-time totals across months', async () => {
  const s = memoryStore();
  const seen = [];
  const spy = { pipeline: (cmds) => { seen.push(...cmds.flat().map(String)); return s.pipeline(cmds); } };
  const p = (level, now = oct, ip = '1.2.3.4') => handleUsage({ method: 'POST', body: { event: 'check', level }, ip, ua: 'UA', now }, spy, SECRET);
  await p('high'); await p('medium'); await p('info'); await p('bogus'); await p(undefined);
  await p('high', new Date('2026-11-03T00:00:00Z'));
  const oct2 = (await get(s)).json;
  assert.equal(oct2.checks, 5);
  assert.deepEqual(oct2.found, { high: 1, medium: 1, low: 0, info: 1 });
  const nov = (await get(s, { now: new Date('2026-11-20T00:00:00Z') })).json;
  assert.deepEqual(nov.total, { checks: 6, since: '2026-10', high: 2, medium: 1, low: 0, info: 1, tx: 0, zetaphy: 0 });
  assert.equal(nov.found.high, 1);
  assert.ok(!seen.join(' ').includes('bogus'));
});

test('months for the totals', () => {
  assert.deepEqual(monthsUntil('2026-10'), ['2026-10']);
  assert.deepEqual(monthsUntil('2027-02'), ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(monthsUntil('2026-09'), []);
});

test('counts transaction checks and checks on ZETAPHY (only those two words, never the hash or address)', async () => {
  const s = memoryStore();
  const p = (body) => handleUsage({ method: 'POST', body: { event: 'check', ...body }, ip: '1.2.3.4', ua: 'UA', now: oct }, s, SECRET);
  await p({ level: 'high', kind: 'tx', chain: 'zetaphy' });
  await p({ level: 'info', kind: 'tx', chain: 'eth' });
  await p({ level: 'info', kind: 'contract', chain: 'zetaphy' });
  await p({ level: 'info', kind: 'weird', chain: 'ZETAPHY' });
  const r = (await get(s)).json;
  assert.equal(r.tx, 2);
  assert.equal(r.zetaphy, 2);
  assert.equal(r.total.tx, 2);
  assert.equal(r.total.zetaphy, 2);
  assert.equal(r.total.checks, 4);
});
