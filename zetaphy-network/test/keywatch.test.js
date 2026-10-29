// Key watch (scripts/key-watch.js): detection on a mocked chain, dedupe, RPC-down throttling, issue delivery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Interface, parseEther, getAddress, id as keccakId } from 'ethers';
import { runWatch, buildConfig, loadConfig, decodeLog, deliver, renderAlerts, renderHealth, marker, makeRpc, newState, TOPICS } from '../scripts/key-watch.js';

const EOA = getAddress('0x' + '11'.repeat(20));
const TL = getAddress('0x' + '22'.repeat(20));
const BOX = getAddress('0x' + '33'.repeat(20));
const ATTACKER = getAddress('0x' + 'ee'.repeat(20));
const T0 = Date.parse('2026-11-05T00:00:00Z');
const HOUR = 3600_000;

const TIMELOCK = new Interface([
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
]);
const BRIDGE = new Interface(['event Paused(address indexed by)', 'event ReleaseVetoed(bytes32 indexed id, address indexed by)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const OZ = new Interface(['event Paused(address account)']);

function config(over = {}) {
  return buildConfig({
    defaults: { balanceDropPct: 10, balanceDropMin: '0.05', confirmations: 0, logChunk: 100, maxBlocksPerRun: 1000, maxLagBlocks: 5000, rpcDownNoticeHours: 24 },
    chains: {
      testchain: {
        chainId: 31337, rpc: ['http://mock'], explorer: 'https://scan.example', displayName: 'Test chain', ...over,
        watch: [
          { address: EOA, label: 'deployer', kind: 'eoa' },
          { address: TL, label: 'timelock', kind: 'timelock' },
          { address: BOX, label: 'lockbox', kind: 'bridge' },
        ],
      },
    },
  });
}

/** A mocked chain: head, balances, nonces, logs; `down` makes every call throw. */
function mockChain() {
  const c = { head: 100, balances: { [EOA]: parseEther('1'), [TL]: 0n, [BOX]: parseEther('5') }, nonces: { [EOA]: 7 }, logs: [], down: false, getLogsCalls: [] };
  const guard = () => { if (c.down) throw new Error('connect ECONNREFUSED'); };
  c.rpc = {
    getBlockNumber: async () => { guard(); return c.head; },
    getBalance: async (a) => { guard(); return c.balances[getAddress(a)] ?? 0n; },
    getTransactionCount: async (a) => { guard(); return c.nonces[getAddress(a)] ?? 0; },
    getLogs: async (f) => {
      guard();
      c.getLogsCalls.push(f);
      const addrs = f.address.map((a) => a.toLowerCase());
      return c.logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock && addrs.includes(l.address.toLowerCase()) && f.topics[0].includes(l.topics[0]));
    },
    getBlock: async (n) => ({ number: n, timestamp: 1_800_000_000 }),
    getTransaction: async (h) => ({ hash: h, from: ATTACKER }),
  };
  c.emit = (iface, address, name, values, block, i = 0) => {
    const { topics, data } = iface.encodeEventLog(iface.getEvent(name), values);
    c.logs.push({ address, topics, data, blockNumber: block, transactionHash: '0x' + block.toString(16).padStart(64, '0'), index: i });
  };
  return c;
}

const run = (cfg, chain, state, now = T0, extra = {}) => runWatch({ config: cfg, state, rpcFor: () => chain.rpc, now, ...extra });

test('first run is a baseline: no alerts, state remembers block, nonce and balance', async () => {
  const c = mockChain();
  const r = await run(config(), c, undefined);
  assert.deepEqual(r.alerts, []);
  assert.equal(r.state.chains.testchain.lastBlock, 100);
  assert.equal(r.state.chains.testchain.accounts[EOA.toLowerCase()].nonce, 7);
  assert.equal(r.state.chains.testchain.accounts[BOX.toLowerCase()].balance, parseEther('5').toString());
});

test('a timelock CallScheduled is a critical alert with the ready time, the sender and explorer links', async () => {
  const c = mockChain();
  const cfg = config();
  const { state } = await run(cfg, c);
  c.head = 120;
  c.emit(TIMELOCK, TL, 'CallScheduled', ['0x' + 'ab'.repeat(32), 0n, BOX, 0n, '0xdeadbeef00', '0x' + '00'.repeat(32), 172800n], 110);
  c.emit(TIMELOCK, TL, 'RoleGranted', [keccakId('PROPOSER_ROLE'), ATTACKER, TL], 111);
  c.emit(BRIDGE, BOX, 'Transfer', [EOA, ATTACKER, 1n], 112); // not a watched event
  const r = await run(cfg, c, state);
  assert.deepEqual(r.alerts.map((a) => [a.severity, a.title]), [['critical', 'CallScheduled on timelock'], ['critical', 'RoleGranted on timelock']]);
  const text = renderAlerts(r.alerts);
  assert.match(text, /ready at 2027-01-17T08:00:00.000Z/); // 1_800_000_000 + 172800 s
  assert.match(text, /\(https:\/\/scan\.example\/tx\/0x0{62}6e\)/);
  assert.match(text, new RegExp(`sent by \\[${ATTACKER}\\]`));
  assert.match(text, /role: PROPOSER_ROLE/);
  assert.match(text, /data: 0xdeadbeef \(selector, 5 bytes\)/);
  assert.equal(r.state.chains.testchain.lastBlock, 120);
  assert.equal(r.stats.testchain.scanned, 20);
  // the same blocks are not scanned again; nothing new, nothing reported
  const r2 = await run(cfg, c, r.state);
  assert.deepEqual(r2.alerts, []);
});

test('Paused (indexed and OpenZeppelin forms) and guardian vetoes decode', () => {
  const c = mockChain();
  c.emit(BRIDGE, BOX, 'Paused', [ATTACKER], 1);
  c.emit(OZ, BOX, 'Paused', [ATTACKER], 2);
  c.emit(BRIDGE, BOX, 'ReleaseVetoed', ['0x' + '01'.repeat(32), ATTACKER], 3);
  const d = c.logs.map(decodeLog);
  assert.deepEqual(d.map((x) => [x.name, x.severity, x.args.by ?? x.args.account]), [['Paused', 'high', ATTACKER], ['Paused', 'high', ATTACKER], ['ReleaseVetoed', 'high', ATTACKER]]);
  assert.ok(TOPICS.includes(c.logs[0].topics[0]));
});

test('an EOA nonce increase is critical; expectNonceUpTo and allowOutgoing silence it', async () => {
  const c = mockChain();
  let cfg = config();
  const { state } = await run(cfg, c);
  c.nonces[EOA] = 8;
  const r = await run(cfg, c, state);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].severity, 'critical');
  assert.equal(r.alerts[0].key, `nonce:testchain:${EOA.toLowerCase()}:8`);
  assert.match(r.alerts[0].lines.join('\n'), /nonce 7 → 8: \*\*1 new transaction/);
  // planned: expectNonceUpTo 8
  cfg.chains.testchain.watch[0].expectNonceUpTo = 8;
  assert.deepEqual((await run(cfg, c, state)).alerts, []);
  cfg = config();
  cfg.chains.testchain.watch[0].allowOutgoing = true;
  assert.deepEqual((await run(cfg, c, state)).alerts, []);
});

test('a balance drop past 10% or 0.05 alerts; small drops and rises do not', async () => {
  const c = mockChain();
  const cfg = config();
  let { state } = await run(cfg, c);
  c.balances[BOX] = parseEther('4.99'); // -0.01: under both thresholds
  c.balances[EOA] = parseEther('1.5');  // a rise
  let r = await run(cfg, c, state);
  assert.deepEqual(r.alerts, []);
  state = r.state;
  c.balances[BOX] = parseEther('4.9'); // -0.09 >= 0.05
  r = await run(cfg, c, state);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].title, 'balance drop on lockbox');
  assert.match(r.alerts[0].lines.join('\n'), /balance 4\.99 → 4\.9 \(-0\.09\)/);
});

test('dedupe: an alert already reported (state.seen) or already in the issue is not posted again', async () => {
  const c = mockChain();
  const cfg = config();
  const base = await run(cfg, c);
  c.nonces[EOA] = 9;
  const r1 = await run(cfg, c, base.state);
  assert.equal(r1.alerts.length, 1);
  // state lost after the alert was posted? the same nonce is found again from an older state, but state.seen stops it
  const old = structuredClone(base.state);
  old.seen = r1.state.seen;
  assert.deepEqual((await run(cfg, c, old)).alerts, []);
  // and if state.seen is gone too, the marker in the open issue stops it
  const gh = fakeGitHub();
  assert.deepEqual((await deliver(gh, { label: 'security-alert', items: r1.alerts, render: renderAlerts, title: () => 'Security alert' })).posted, 1);
  const again = await run(cfg, c, base.state);
  assert.equal(again.alerts.length, 1);
  const d2 = await deliver(gh, { label: 'security-alert', items: again.alerts, render: renderAlerts, title: () => 'Security alert' });
  assert.deepEqual([d2.posted, d2.skipped], [0, 1]);
  assert.equal(gh.issues.length, 1);
  assert.equal(gh.issues[0].comments.length, 0);
  // a new alert goes to the same open issue as a comment
  c.nonces[EOA] = 10;
  const r3 = await run(cfg, c, again.state);
  await deliver(gh, { label: 'security-alert', items: r3.alerts, render: renderAlerts, title: () => 'Security alert' });
  assert.equal(gh.issues.length, 1);
  assert.equal(gh.issues[0].comments.length, 1);
  assert.ok(gh.issues[0].comments[0].includes(marker(`nonce:testchain:${EOA.toLowerCase()}:10`)));
  assert.deepEqual(gh.issues[0].labels, ['security-alert']);
});

test('RPC down: at most one notice a day, none before quietUntil, state kept, back up resets', async () => {
  const c = mockChain();
  const cfg = config({ quietUntil: '2026-11-01T00:00:00Z' });
  const base = await run(cfg, c);
  c.down = true;
  // before quietUntil (paused chain): silent
  let r = await run(cfg, c, base.state, Date.parse('2026-10-30T00:00:00Z'));
  assert.deepEqual([r.alerts, r.health], [[], []]);
  assert.equal(r.state.chains.testchain.lastBlock, 100); // nothing lost
  // down for less than the grace (60 min) after quietUntil? still counted from the first failure (Oct 30), so a notice now.
  // A fresh blip on an always-on chain is not reported:
  const blip = await run(config(), c, base.state, T0);
  assert.deepEqual(blip.health, []);
  assert.equal((await run(config(), c, blip.state, T0 + 30 * 60_000)).health.length, 0);
  assert.equal((await run(config(), c, blip.state, T0 + 61 * 60_000)).health.length, 1);
  // after: one notice, then nothing for 24 h (runs every 15 min)
  r = await run(cfg, c, r.state, T0);
  assert.equal(r.health.length, 1);
  assert.match(r.health[0].text, /can't reach \*\*Test chain\*\* \(chain 31337\) on 1 RPC\(s\) since 2026-10-30T00:00:00.000Z/);
  assert.equal(r.health[0].key, 'rpcdown:testchain:2026-11-05');
  let notices = 1;
  for (let t = T0 + 0.25 * HOUR; t < T0 + 24 * HOUR; t += 0.25 * HOUR) {
    r = await run(cfg, c, r.state, t);
    notices += r.health.length;
  }
  assert.equal(notices, 1);
  r = await run(cfg, c, r.state, T0 + 24 * HOUR);
  assert.equal(r.health.length, 1);
  // back up: the down marker is cleared, scanning continues from block 101
  c.down = false;
  c.head = 150;
  r = await run(cfg, c, r.state, T0 + 25 * HOUR);
  assert.equal(r.health.length, 0);
  assert.equal(r.state.chains.testchain.down, null);
  assert.equal(c.getLogsCalls[0].fromBlock, 101);
  // and the health issue dedupes by day as well
  const gh = fakeGitHub();
  const h = [{ key: 'rpcdown:testchain:2026-11-05', chain: 'testchain', text: 'down' }];
  await deliver(gh, { label: 'key-watch-health', items: h, render: renderHealth, title: () => 'health' });
  assert.equal((await deliver(gh, { label: 'key-watch-health', items: h, render: renderHealth, title: () => 'health' })).posted, 0);
});

test('far behind: skips ahead with a warning; getLogs is chunked', async () => {
  const c = mockChain();
  const cfg = config();
  const { state } = await run(cfg, c);
  c.head = 100 + 6000; // > maxLagBlocks 5000
  const r = await run(cfg, c, state);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].severity, 'warning');
  assert.equal(r.alerts[0].key, 'gap:testchain:101-5100');
  assert.equal(r.state.chains.testchain.lastBlock, 6100);
  assert.equal(c.getLogsCalls.length, 10); // 1000 blocks in chunks of 100
  assert.ok(c.getLogsCalls.every((f) => f.toBlock - f.fromBlock < 100));
});

test('a failing getLogs keeps the last scanned block, to retry next run', async () => {
  const c = mockChain();
  const cfg = config();
  const { state } = await run(cfg, c);
  c.head = 400;
  const orig = c.rpc.getLogs;
  let n = 0;
  c.rpc.getLogs = async (f) => { if (++n === 2) throw new Error('rate limited'); return orig(f); };
  const r = await run(cfg, c, state);
  assert.equal(r.state.chains.testchain.lastBlock, 200);
});

test('Cosmos REST: validator jailed and new gov proposals alert', async () => {
  const c = mockChain();
  const cfg = config({ rest: 'https://rest.example', validators: ['zetaphyvaloper1abc'] });
  let jailed = false, props = [{ id: '3', title: 'old', status: 'PROPOSAL_STATUS_PASSED', messages: [] }];
  const fetchJson = async (url) => url.includes('/validators/')
    ? { validator: { jailed, status: jailed ? 'BOND_STATUS_UNBONDING' : 'BOND_STATUS_BONDED', description: { moniker: 'v1' } } }
    : { proposals: props };
  const base = await run(cfg, c, undefined, T0, { fetchJson });
  assert.deepEqual(base.alerts, []);
  jailed = true;
  props = [{ id: '4', title: 'Schedule a timelock call', status: 'PROPOSAL_STATUS_VOTING_PERIOD', messages: [{ '@type': '/cosmos.evm.vm.v1.MsgEVMCall' }] }, ...props];
  const r = await run(cfg, c, base.state, T0, { fetchJson });
  assert.deepEqual(r.alerts.map((a) => [a.severity, a.title]), [['critical', 'validator JAILED'], ['high', 'new gov proposal #4']]);
});

test('the committed key-watch.json loads: four chains, deployer and validator everywhere, timelock on ZETAPHY', () => {
  const cfg = loadConfig();
  assert.deepEqual(Object.keys(cfg.chains).sort(), ['arbitrumsepolia', 'basesepolia', 'sepolia', 'zetaphy']);
  for (const ch of Object.values(cfg.chains)) {
    assert.ok(ch.rpc.length >= 1 && ch.explorer.startsWith('https://'));
    const eoas = ch.watch.filter((w) => w.kind === 'eoa').map((w) => w.address);
    assert.ok(eoas.includes('0x6af57fC3633dD0F7907f7900dbd4A2822F43a245'));
    assert.ok(eoas.includes('0x80b654fdB439348D2A3DC7bbF0eC398e165019Bc'));
  }
  assert.equal(cfg.chains.zetaphy.chainId, 77390);
  assert.equal(cfg.chains.zetaphy.quietUntil, Date.parse('2026-11-01T00:00:00Z'));
  assert.ok(cfg.chains.zetaphy.watch.some((w) => w.kind === 'timelock' && w.address === '0x731db92410B3b15Ae4b6b41E47fc3c9a66390340'));
  // deployed routes are added from saphan-routes.json
  const withRoute = buildConfig({ chains: { zetaphy: { chainId: 77390, rpc: ['https://x'] }, sepolia: { chainId: 11155111, rpc: ['https://y'] } } }, {},
    { routes: { sepolia: { zetaphy: { bridgeGuard: BOX }, origin: { lockbox: TL, timelock: EOA, ism: ATTACKER } } } });
  assert.deepEqual(withRoute.chains.sepolia.watch.map((w) => [w.address, w.kind]), [[TL, 'bridge'], [EOA, 'timelock']]);
  assert.deepEqual(withRoute.chains.zetaphy.watch.map((w) => w.kind), ['bridge']);
});

test('makeRpc: a dead RPC fails fast and the next URL answers (real HTTP, ethers JsonRpcProvider)', async () => {
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const m = JSON.parse(b);
      const result = m.method === 'eth_blockNumber' ? '0x2a' : m.method === 'eth_chainId' ? '0x7a69' : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  const dead = makeRpc(['http://127.0.0.1:1'], 31337, { timeoutMs: 2000 });
  await assert.rejects(dead.getBlockNumber());
  dead.destroy();
  const rpc = makeRpc(['http://127.0.0.1:1', `http://127.0.0.1:${port}`], 31337, { timeoutMs: 2000 });
  assert.equal(await rpc.getBlockNumber(), 42);
  rpc.destroy();
  srv.close();
});

function fakeGitHub() {
  const gh = {
    issues: [],
    ensureLabel: async () => null,
    openIssue: async (label) => {
      const i = gh.issues.find((x) => x.labels.includes(label) && x.state === 'open');
      return i ? { number: i.number, body: i.body } : null;
    },
    comments: async (n) => gh.issues.find((x) => x.number === n).comments.map((body) => ({ body })),
    createIssue: async (title, body, labels) => { const i = { number: gh.issues.length + 1, title, body, labels, state: 'open', comments: [] }; gh.issues.push(i); return i; },
    comment: async (n, body) => { gh.issues.find((x) => x.number === n).comments.push(body); },
  };
  return gh;
}

test('newState is empty', () => assert.deepEqual(newState(), { version: 1, chains: {}, cosmos: {}, seen: [] }));
