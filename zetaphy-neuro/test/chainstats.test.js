// ZETAPHY chain activity counts (server/chainstats.js) against a stand-in node
// that answers CometBFT queries from a list of transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countRange, firstBlockAt, refresh, read, handleChainStats, cometClient, CERT, MAILBOX, NAMES, REFRESH_SEC } from '../server/chainstats.js';
import { memoryStore } from '../server/usage.js';

const T0 = Date.parse('2026-09-30T23:59:00Z'); // block 1
const BLOCK_MS = 6000;
const timeOf = (h) => new Date(T0 + (h - 1) * BLOCK_MS).toISOString();

/** A node with `latest` blocks; each block has a PQ certificate, plus `txs`. */
function fakeNode(txs, latest, { earliest = 1 } = {}) {
  const all = [];
  for (let h = 1; h <= latest; h++) all.push({ height: h, actions: [CERT] });
  for (const t of txs) all.push(t);
  const calls = [];
  const comet = async (method, params) => {
    calls.push({ method, params });
    if (method === 'status') return { sync_info: { latest_block_height: String(latest), earliest_block_height: String(earliest) } };
    if (method === 'header') {
      const h = Number(params.height);
      if (h < earliest || h > latest) throw new Error('no block');
      return { header: { height: String(h), time: timeOf(h) } };
    }
    if (method === 'tx_search') {
      assert.equal(params.per_page, '1', 'only counts are asked for');
      let ok = all;
      for (const c of params.query.split(' AND ')) {
        let m;
        if ((m = /^tx\.height>=(\d+)$/.exec(c))) ok = ok.filter((t) => t.height >= Number(m[1]));
        else if ((m = /^tx\.height<=(\d+)$/.exec(c))) ok = ok.filter((t) => t.height <= Number(m[1]));
        else if ((m = /^message\.action='([^']+)'$/.exec(c))) ok = ok.filter((t) => t.actions.includes(m[1]));
        else if ((m = /^ethereum_tx\.recipient='([^']+)'$/.exec(c))) ok = ok.filter((t) => t.to === m[1]);
        else throw new Error('unexpected condition ' + c);
      }
      return { total_count: String(ok.length), txs: ok.slice(0, 1) };
    }
    throw new Error('unexpected method ' + method);
  };
  return { comet, calls };
}

const EVM = '/cosmos.evm.vm.v1.MsgEthereumTx';
const SAMPLE = [
  { height: 5, actions: ['/cosmos.bank.v1beta1.MsgSend'] },
  { height: 5, actions: ['/cosmos.staking.v1beta1.MsgDelegate'] },
  { height: 7, actions: ['/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward', '/cosmos.staking.v1beta1.MsgDelegate'] }, // one tx, two msgs
  { height: 30, actions: [EVM], to: '0x1111111111111111111111111111111111111111' },
  { height: 31, actions: [EVM], to: MAILBOX }, // a Hyperlane delivery
  { height: 31, actions: ['/ibc.applications.transfer.v1.MsgTransfer'] },
  { height: 40, actions: ['/cosmos.gov.v1.MsgVote'] },
  { height: 41, actions: ['/zetaphy.pq.v1.MsgEVMCall'] },
  { height: 42, actions: ['/cosmos.bank.v1beta1.MsgMultiSend'] },
];

test('countRange: certificates left out, deliveries counted as cross-chain, one count per message type', async () => {
  const { comet } = fakeNode(SAMPLE, 50);
  assert.deepEqual(await countRange(comet, 1, 50), { all: 9, transfers: 2, staking: 3, crossChain: 2, evm: 2, governance: 1 }, 'the block-7 tx has two staking types');
  assert.deepEqual(await countRange(comet, 31, 41), { all: 4, transfers: 0, staking: 0, crossChain: 2, evm: 1, governance: 1 });
  assert.deepEqual(await countRange(comet, 9, 8), Object.fromEntries(NAMES.map((k) => [k, 0])));
});

test('firstBlockAt: binary search over block times, bounded by the oldest block kept', async () => {
  const { comet, calls } = fakeNode([], 100_000);
  const oct = Date.parse('2026-10-01T00:00:00Z'); // block 1 is at 23:59:00 on Sep 30: block 11 is the first in October
  assert.equal(await firstBlockAt(comet, oct, 1, 100_000), 11);
  assert.ok(calls.length < 25, `${calls.length} header reads`);
  assert.equal(await firstBlockAt(comet, oct, 500, 100_000), 500, 'pruned below: the oldest block');
  assert.equal(await firstBlockAt(comet, Date.parse('2027-01-01T00:00:00Z'), 1, 100), 101, 'not reached yet');
});

test('refresh + read: this month and since genesis, month start found once', async () => {
  const store = memoryStore();
  const now = () => Date.parse('2026-10-01T00:05:00Z');
  const { comet, calls } = fakeNode(SAMPLE, 50);
  const r = await refresh(store, comet, { now });
  assert.equal(r.month, '2026-10');
  const d = await read(store, { now });
  assert.equal(d.height, 50);
  assert.equal(d.updatedAt, '2026-10-01T00:05:00.000Z');
  assert.deepEqual(d.total, { all: 9, transfers: 2, staking: 3, crossChain: 2, evm: 2, governance: 1 });
  // October starts at block 11: the block-5 and block-7 transactions are September's
  assert.deepEqual(d.thisMonth, { all: 6, transfers: 1, staking: 0, crossChain: 2, evm: 2, governance: 1 });
  const headers = calls.filter((c) => c.method === 'header').length;
  calls.length = 0;
  await refresh(store, comet, { now });
  assert.equal(calls.filter((c) => c.method === 'header').length, 0, 'month start is remembered');
  assert.ok(headers > 0);
});

test('handleChainStats: refreshes when old, one caller per hour, keeps numbers when the node is down', async () => {
  const store = memoryStore();
  let clock = Date.parse('2026-10-27T10:00:00Z');
  const now = () => clock;
  const node = fakeNode(SAMPLE, 50);
  let up = true;
  const comet = (m, p) => (up ? node.comet(m, p) : Promise.reject(new Error('down')));

  assert.deepEqual((await handleChainStats({ method: 'GET' }, null, comet, { now })).json, { enabled: false });
  assert.equal((await handleChainStats({ method: 'POST' }, store, comet, { now })).status, 405);

  const a = await handleChainStats({ method: 'GET' }, store, comet, { now });
  assert.equal(a.status, 200);
  assert.equal(a.headers['access-control-allow-origin'], '*');
  assert.equal(a.json.total.all, 9);
  assert.equal(a.json.stale, false);

  // fresh: no node calls
  node.calls.length = 0;
  clock += 3600_000;
  await handleChainStats({ method: 'GET' }, store, comet, { now });
  assert.equal(node.calls.length, 0);

  // old, node down: last numbers, marked stale; a second call in the same hour does not retry
  clock += REFRESH_SEC * 1000;
  up = false;
  const b = await handleChainStats({ method: 'GET' }, store, comet, { now });
  assert.equal(b.json.total.all, 9);
  assert.equal(b.json.stale, true);
  up = true;
  node.calls.length = 0;
  await handleChainStats({ method: 'GET' }, store, comet, { now });
  assert.equal(node.calls.length, 0, 'locked for this hour');
  clock += 3600_000;
  const c = await handleChainStats({ method: 'GET' }, store, comet, { now });
  assert.equal(c.json.stale, false);
  assert.ok(node.calls.length > 0);
});

test('cometClient: JSON-RPC POST, errors thrown', async () => {
  const seen = [];
  const ok = cometClient('https://node.example/rpc/', { fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ result: { x: 1 } }) }; } });
  assert.deepEqual(await ok('status', {}), { x: 1 });
  assert.equal(seen[0].url, 'https://node.example/rpc/');
  assert.equal(seen[0].body.method, 'status');
  const bad = cometClient('https://node.example/rpc/', { fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'nope' } }) }) });
  await assert.rejects(bad('status', {}), /nope/);
  const down = cometClient('https://node.example/rpc/', { fetchImpl: async () => ({ ok: false, status: 502 }) });
  await assert.rejects(down('status', {}), /502/);
});

test('page strings: every Neuro language, every key', async () => {
  const { CHAIN_TEXT } = await import('../web/chain.js');
  const { LANGS } = await import('../src/explain.js');
  const keys = Object.keys(CHAIN_TEXT.en);
  assert.deepEqual(Object.keys(CHAIN_TEXT).sort(), Object.keys(LANGS).sort());
  for (const [code, t] of Object.entries(CHAIN_TEXT)) {
    assert.deepEqual(Object.keys(t), keys, code);
    for (const k of keys) assert.ok(typeof t[k] === 'string' && t[k].trim(), `${code}.${k}`);
  }
});
