// Saphan PR 6, item S10: the guided recovery after an incident. pause -> a snapshot of who is owed what, rebuilt from
// public events (src/saphanrecovery.js) -> SaphanRecoveryClaims (the escape hatch's exit tree: same leaf, same proofs)
// -> resume. CLI: node scripts/saphan.js recovery plan|snapshot|proof|start.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { createChain } from './helpers/evm.js';
import { kit } from './helpers/saphankits.js';
import { snapshot, claimsFile, readEvents, balancesFromTransfers, plan } from '../src/saphanrecovery.js';
import { exitTree, exitProof } from '../src/saphansafety.js';

const E = 10n ** 18n;
const DAY = 86400;
let c, token;
const a = (n) => c.acct[n].toString();
const SCRIPT = new URL('../scripts/saphan.js', import.meta.url).pathname;

beforeEach(async () => {
  c = await createChain(['gov', 'alice', 'bob', 'carol', 'dave', 'erin', 'attacker', 'insurance', 'anyone']);
  token = await c.deployRaw(kit('TokenKit.sol').KitToken, ['sepETH (stand-in)', 'sepETH', 18], 'gov');
});

/** The incident: token(X) as it stood (alice 5 -> 1 to carol, bob 3, the attacker minted 10 through a bug). */
async function history() {
  const logs = [];
  const tx = async (from, fn, args) => { const r = await c.rawTx(from, token.address, token.iface.encodeFunctionData(fn, args)); assert.ok(r.ok); logs.push(...r.logs); };
  await tx('gov', 'mint', [a('alice'), 5n * E]);
  await tx('gov', 'mint', [a('bob'), 3n * E]);
  await tx('alice', 'transfer', [a('carol'), E]);
  await tx('gov', 'mint', [a('attacker'), 10n * E]);
  // a provider that answers eth_getLogs from those logs (what readEvents asks a node)
  const provider = { getLogs: async ({ address, topics }) => logs.filter((l) => getAddress(l.address) === getAddress(address) && l.topics[0] === topics[0]) };
  return provider;
}

test('snapshot from events: balances + unpaid releases + unminted locks, the attacker left out; same tree as the escape hatch', async () => {
  const zetaphy = await history();
  const ev = await readEvents({ zetaphy, token: token.address, toBlock: 100 });
  assert.equal(ev.transfers.length, 4);
  assert.deepEqual(balancesFromTransfers(ev.transfers).map(([x, v]) => [x, v]).sort(),
    [[getAddress(a('alice')), 4n * E], [getAddress(a('attacker')), 10n * E], [getAddress(a('bob')), 3n * E], [getAddress(a('carol')), E]].sort());
  const s = snapshot({ ...ev,
    releasesQueued: [{ id: '0x01', to: a('dave'), amount: 2n * E }, { id: '0x02', to: a('bob'), amount: 9n * E }], released: ['0x02'],
    locks: [{ transferId: '0x10', sender: a('erin'), amount: E }, { transferId: '0x11', sender: a('carol'), amount: E }], minted: ['0x11'],
    exclude: [a('attacker')] });
  assert.equal(s.total, 11n * E);
  assert.deepEqual(s.excluded, [[getAddress(a('attacker')), 10n * E]]);
  const f = claimsFile(s.entries);
  assert.equal(f.root, exitTree(s.entries).root);
  assert.deepEqual(f.claims[getAddress(a('dave'))].proof, exitProof(s.entries, a('dave')));
  assert.equal(f.claims[getAddress(a('dave'))].owed, (2n * E).toString());
});

test('claims contract: governance sets the root once; each line pays once, pro rata when short; late coins and leftovers are swept', async () => {
  const zetaphy = await history();
  const s = snapshot({ ...(await readEvents({ zetaphy, token: token.address, toBlock: 100 })), exclude: [a('attacker')] }); // alice 4, bob 3, carol 1
  const f = claimsFile(s.entries);
  await assert.rejects(c.deploy('SaphanRecoveryClaims', [a('gov'), '0x' + '00'.repeat(20), a('insurance'), DAY], 'gov'), /deploy failed/, 'claim period >= 7 days');
  const k = await c.deploy('SaphanRecoveryClaims', [a('gov'), '0x' + '00'.repeat(20), a('insurance'), 7 * DAY], 'gov');
  await k.sendValue('anyone', 6n * E);                                  // the insurance pays 6 of the 8 owed
  const proof = (n) => f.claims[getAddress(a(n))].proof;
  await assert.rejects(k.send('alice', 'claim', [4n * E, proof('alice')]), /NotStarted/);
  await assert.rejects(k.send('attacker', 'start', [f.root, f.total]), /NotGovernance/);
  await k.send('gov', 'start', [f.root, f.total]);
  await assert.rejects(k.send('gov', 'start', [f.root, f.total]), /AlreadyStarted/);
  await k.sendValue('anyone', E);                                       // after start: not in the pool (swept later)
  assert.equal(await k.call('pool'), 6n * E);
  const before = await c.balance('alice');
  await assert.rejects(k.send('alice', 'claim', [5n * E, proof('alice')]), /BadProof/);
  await assert.rejects(k.send('attacker', 'claim', [4n * E, proof('alice')]), /BadProof/, 'a line pays only its own address');
  await k.send('alice', 'claim', [4n * E, proof('alice')]);
  assert.equal((await c.balance('alice')) - before, 3n * E, '4 x 6/8');
  await assert.rejects(k.send('alice', 'claim', [4n * E, proof('alice')]), /AlreadyClaimed/);
  await k.send('bob', 'claim', [3n * E, proof('bob')]);
  await assert.rejects(k.send('anyone', 'sweep', []), /StillOpen/);
  c.advance(7 * DAY + 1);
  await assert.rejects(k.send('carol', 'claim', [E, proof('carol')]), /Closed/);
  const ins = await c.balance('insurance');
  await k.send('anyone', 'sweep', []);
  assert.equal((await c.balance('insurance')) - ins, 6n * E - 3n * E - 2250000000000000000n + E, 'carol\'s unclaimed share + the late coin');
  await assert.rejects(k.send('anyone', 'sweep', []), /Closed/);
});

test('token pool: fund() with approve; full pay when covered; native coins refused', async () => {
  const entries = [[a('alice'), 2n * E], [a('bob'), E]];
  const f = claimsFile(entries);
  const k = await c.deploy('SaphanRecoveryClaims', [a('gov'), token.address, a('insurance'), 7 * DAY], 'gov');
  await assert.rejects(k.sendValue('anyone', E), /WrongAsset/);
  await token.send('gov', 'mint', [a('insurance'), 5n * E]);
  await token.send('insurance', 'approve', [k.address, 5n * E]);
  await k.send('insurance', 'fund', [5n * E]);
  await k.send('gov', 'start', [f.root, f.total]);
  await k.send('alice', 'claim', [2n * E, f.claims[getAddress(a('alice'))].proof]);
  assert.equal(await token.call('balanceOf', [a('alice')]), 2n * E);
  assert.equal(await k.call('payout', [E]), E);
});

test('plan and CLI: the next step from the state; snapshot -> claims file -> proof -> the timelock calls for start()', async () => {
  assert.equal(plan({}).next, 'pause');
  assert.equal(plan({ paused: true, snapshot: true }).next, 'deploy');
  assert.equal(plan({ paused: true, snapshot: true, claims: '0x1', funded: true, started: true, deadlinePassed: true, resumed: true }).next, null);
  const dir = mkdtempSync(join(tmpdir(), 'saphan-recovery-'));
  try {
    const events = { transfers: [{ from: '0x' + '00'.repeat(20), to: a('alice'), value: '5' }, { from: '0x' + '00'.repeat(20), to: a('attacker'), value: '9' }],
      releasesQueued: [{ id: '0x01', to: a('bob'), amount: '2' }], released: [], locks: [], minted: [] };
    writeFileSync(join(dir, 'events.json'), JSON.stringify(events));
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ paused: true }));
    const cli = (...args) => JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }).trim().split('\n').pop());
    assert.equal(cli('recovery', 'plan', '--state', join(dir, 'state.json')).next, 'snapshot');
    const f = cli('recovery', 'snapshot', '--events', join(dir, 'events.json'), '--exclude', a('attacker'));
    assert.equal(f.total, '7');
    assert.deepEqual(f.excluded, [[getAddress(a('attacker')), '9']]);
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(f));
    const p = cli('recovery', 'proof', '--file', join(dir, 'claims.json'), '--account', a('bob'));
    assert.equal(p.owed, '2');
    assert.deepEqual(p.proof, exitProof([[a('alice'), 5n], [a('bob'), 2n]], a('bob')));
    const st = cli('recovery', 'start', '--claims', a('anyone'), '--file', join(dir, 'claims.json'));
    const sched = new Interface(['function schedule(address,uint256,bytes,bytes32,bytes32,uint256)']).decodeFunctionData('schedule', st.schedule);
    assert.equal(sched[0], getAddress(a('anyone')));
    assert.equal(sched[2], new Interface(['function start(bytes32,uint256)']).encodeFunctionData('start', [f.root, 7n]));
    assert.equal(sched[4], keccak256(toUtf8Bytes(`saphan-recovery:${f.root}`)));
    assert.equal(sched[5], 172800n);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
