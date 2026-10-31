// txguard.js: no stuck transactions. The node must answer before the wallet opens, a stuck account is refused,
// one wallet request at a time, and the watch always ends in a clear state (in a block, failed, never broadcast,
// still pending, or stopped by the page closing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as txg from '../txguard.js';

const H = '0x' + 'ab'.repeat(32);
const FROM = '0x' + '11'.repeat(20);

/** A fake node: `state` drives the answers; `calls` records the methods asked. */
function node(state = {}) {
  const calls = [];
  const rpc = async (m, p) => {
    calls.push(m);
    if (state.down) throw new Error('ECONNREFUSED');
    if (m === 'eth_chainId') return state.chainId ?? '0x12e4e';
    if (m === 'eth_getTransactionCount') return p[1] === 'pending' ? (state.pending ?? '0x5') : (state.mined ?? '0x5');
    if (m === 'eth_getTransactionReceipt') return state.receipt?.() ?? null;
    if (m === 'eth_getTransactionByHash') return state.known ? { hash: H } : null;
    return null;
  };
  return { rpc, calls };
}
/** A clock the watch advances by sleeping. */
function clock() { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; }

test('preflight: a node that is down or on another chain stops before the wallet', async () => {
  await assert.rejects(txg.preflight({ rpc: node({ down: true }).rpc, chainId: 77390, from: FROM, lang: 'th' }), (e) => e.txGuard === 'down' && /ไม่ตอบ/.test(e.message));
  await assert.rejects(txg.preflight({ rpc: node({ chainId: '0x1' }).rpc, chainId: 77390, from: FROM }), (e) => e.txGuard === 'down');
  await txg.preflight({ rpc: node().rpc, chainId: 77390, from: FROM });
});

test('preflight: an account with transactions stuck in the node is refused, with how to cancel them', async () => {
  await assert.rejects(txg.preflight({ rpc: node({ pending: '0x7', mined: '0x5' }).rpc, chainId: 77390, from: FROM, lang: 'en' }),
    (e) => e.txGuard === 'stuck' && /2 earlier/.test(e.message) && /Cancel/.test(e.message));
  assert.equal(await txg.stuckCount(node({ down: true }).rpc, FROM), 0, 'unknown counts as none (the node check already failed)');
});

test('walletLock: a second request while the wallet still shows the first is refused; released after an answer or an error', async () => {
  const lock = txg.walletLock();
  let release;
  const first = lock.run(() => new Promise((r) => { release = r; }), 'en');
  assert.equal(lock.busy(), true);
  await assert.rejects(lock.run(async () => 'second', 'en'), (e) => e.txGuard === 'busy');
  release(H);
  assert.equal(await first, H);
  assert.equal(lock.busy(), false);
  await assert.rejects(lock.run(async () => { throw new Error('user rejected'); }), /user rejected/);
  assert.equal(await lock.run(async () => 'next'), 'next', 'a rejection in the wallet frees the lock');
  let t = 0;
  const slow = txg.walletLock({ maxMs: 1000, now: () => t });
  slow.run(() => new Promise(() => {})); // the wallet never answers
  t = 1001;
  assert.equal(await slow.run(async () => 'after'), 'after', 'a request the wallet never answers does not lock the page for good');
});

test('watchTx: in a block, failed, never broadcast, still pending, stopped', async () => {
  let c = clock();
  let n = 0;
  assert.equal((await txg.watchTx({ rpc: node({ receipt: () => (++n > 2 ? { status: '0x1' } : null), known: true }).rpc, hash: H, ...c })).status, 'ok');
  c = clock();
  assert.equal((await txg.watchTx({ rpc: node({ receipt: () => ({ status: '0x0' }) }).rpc, hash: H, ...c })).status, 'failed');
  c = clock();
  assert.equal((await txg.watchTx({ rpc: node({}).rpc, hash: H, dropMs: 10_000, ...c })).status, 'dropped', 'the node never saw it');
  c = clock();
  assert.equal((await txg.watchTx({ rpc: node({ pending: '0x6', mined: '0x5' }).rpc, hash: H, from: FROM, dropMs: 10_000, timeoutMs: 30_000, ...c })).status, 'timeout',
    'queued in the node (counted in the pending nonce) is not "never broadcast"');
  c = clock();
  assert.equal((await txg.watchTx({ rpc: node({ known: true }).rpc, hash: H, timeoutMs: 30_000, ...c })).status, 'timeout');
  const ctl = new AbortController();
  ctl.abort();
  assert.equal((await txg.watchTx({ rpc: node({ known: true }).rpc, hash: H, signal: ctl.signal, ...clock() })).status, 'stopped');
});

test('guardedSend: nothing is sent to the wallet when the node is down; a dropped one says how to clear it', async () => {
  let asked = 0;
  const request = async () => { asked++; return H; };
  await assert.rejects(txg.guardedSend({ rpc: node({ down: true }).rpc, chainId: 77390, from: FROM, request }), (e) => e.txGuard === 'down');
  assert.equal(asked, 0, 'the wallet never opened');
  await assert.rejects(txg.guardedSend({ rpc: node({}).rpc, chainId: 77390, from: FROM, request, watch: { dropMs: 0, everyMs: 0 } }),
    (e) => e.txGuard === 'dropped' && e.hash === H && /Clear activity tab data/.test(e.message));
  assert.equal(await txg.guardedSend({ rpc: node({ receipt: () => ({ status: '0x1' }) }).rpc, chainId: 77390, from: FROM, request }), H);
});

test('pageSignal: closing the page (not the back/forward cache) stops the watch', () => {
  const ls = {};
  const win = { addEventListener: (k, f) => { ls[k] = f; } };
  const s = txg.pageSignal(win);
  ls.pagehide({ persisted: true });
  assert.equal(s.aborted, false);
  ls.pagehide({ persisted: false });
  assert.equal(s.aborted, true);
});

test('every message exists in all 8 languages', () => {
  for (const l of txg.TXG_LANGS) for (const k of ['down', 'busy', 'stuck', 'timeout', 'dropped', 'failed', 'cancelled']) {
    const m = txg.txgText(l, k, 3);
    assert.ok(typeof m === 'string' && m.length > 10, `${l}.${k}`);
    if (l !== 'en') assert.notEqual(m, txg.txgText('en', k, 3), `${l}.${k} translated`);
  }
});

test('every app sends through the guard', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  for (const [file, imp] of [['zetaphy-hub/hub.js', './txguard.js'], ['zetaphy-hub/forecasts.js', './txguard.js'], ['zetaphy-dex/web/app.js', './lib/txguard.js'],
    ['zetaphy-nft/web/app.js', './lib/txguard.js'], ['zetaphy-explorer/src/contractview.js', './txguard.js']]) {
    const s = read(file);
    assert.ok(s.includes(`from '${imp}'`), `${file} imports the guard`);
    assert.match(s, /preflight|guardedSend/, `${file} checks the node before the wallet`);
    assert.match(s, /walletLock/, `${file} keeps one wallet request at a time`);
  }
});
