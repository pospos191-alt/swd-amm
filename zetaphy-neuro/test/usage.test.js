import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUsage, memoryStore, upstashStore, GOAL } from '../server/usage.js';

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
  assert.deepEqual(r.json, { enabled: true, month: '2026-10', users: 2, checks: 3, goal: GOAL });
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
