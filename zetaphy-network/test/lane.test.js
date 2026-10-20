// The Neuro lane watcher (src/lane.js) against stand-ins for the contracts:
// it refuses to attest (or release) transfers whose sender, source contract or
// recipient is flagged in the ThreatRegistry, keeps them until the flag is
// cleared, fails closed when it cannot check, and attests nothing while Neuro
// is paused. Also: a release that fails its estimate never takes a nonce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'ethers';
import { createLaneWatcher } from '../src/lane.js';

const AIRLOCK = new Interface(JSON.parse(readFileSync(new URL('../artifacts/BridgeAirlock.json', import.meta.url), 'utf8')).abi);

const LOCKBOX = '0x' + 'b0'.repeat(20);
const ALICE = '0x' + 'a1'.repeat(20), MALLORY = '0x' + 'ee'.repeat(20);

function setup({ flagged = () => 0n, paused, release = true, releaseEstimate = async () => 100_000n } = {}) {
  const locks = [{ args: { nonce: 0n, sender: ALICE, to: ALICE, amount: 5n } }, { args: { nonce: 1n, sender: MALLORY, to: MALLORY, amount: 7n } }];
  const attested = [], released = [];
  const lockbox = { target: LOCKBOX, runner: { provider: { getBlockNumber: async () => 100 } }, filters: { Locked: () => 'Locked' },
    queryFilter: async (_f, from, to) => locks.filter(() => from <= 50 && 50 <= to) };
  const attest = async (...t) => { attested.push(t[2]); return { wait: async () => {} }; };
  attest.estimateGas = async () => 100_000n;
  const lane = { votedBy: async () => false, done: async () => false, attest };
  const releaseTx = async (...t) => { released.push(t[2]); return { wait: async () => {} }; };
  releaseTx.estimateGas = (...t) => releaseEstimate(...t);
  const airlock = {
    interface: AIRLOCK,
    transferId: async (...t) => '0x' + String(t[2]).padStart(64, '0'),
    flaggedParty: async (chain, src, sender, to) => flagged(sender, src, to),
    threshold: async () => 2n,
    status: async () => [2n, false, false, 1n],
    release: releaseTx,
  };
  const control = paused === undefined ? null : { paused };
  const w = createLaneWatcher({ lockbox, lane, airlock, control, me: ALICE, srcChainId: 97n, confirmations: 1, release,
    stateFile: join(mkdtempSync(join(tmpdir(), 'lane-')), 'state.json'), chainTime: async () => 10n });
  return { w, attested, released };
}

test('a flagged sender is neither attested nor released; it stays pending until the flag is cleared', async () => {
  let flagMallory = true;
  const { w, attested, released } = setup({ flagged: (sender) => (flagMallory && sender === MALLORY ? 1n : 0n) });
  const out = await w.tick();
  assert.deepEqual(attested, [0n]);
  assert.deepEqual(released, [0n]);
  assert.ok(out.some((l) => /lock #1: not attested \(source sender is flagged in the ThreatRegistry/.test(l)), out.join('\n'));
  assert.ok(out.some((l) => /lock #1: not released \(source sender is flagged/.test(l)), out.join('\n'));
  assert.equal(w.state.pending.length, 1); // held, not dropped
  flagMallory = false;
  await w.tick();
  assert.deepEqual(attested, [0n, 1n]);
  assert.deepEqual(released, [0n, 1n]);
  assert.equal(w.state.pending.length, 0);
});

test('a flagged source contract or recipient is refused too', async () => {
  for (const [party, label] of [[2n, 'source contract'], [3n, 'ZETAPHY recipient']]) {
    const { w, attested } = setup({ flagged: () => party });
    const out = await w.tick();
    assert.deepEqual(attested, []);
    assert.ok(out.some((l) => l.includes(`${label} is flagged`)), out.join('\n'));
  }
});

test('if the ThreatRegistry cannot be checked, nothing is attested (fail closed)', async () => {
  const { w, attested, released } = setup({ flagged: () => { throw new Error('rpc down'); } });
  const out = await w.tick();
  assert.deepEqual(attested, []);
  assert.deepEqual(released, []);
  assert.ok(out.some((l) => /could not check the ThreatRegistry/.test(l)));
  assert.equal(w.state.pending.length, 2);
});

test('nothing is attested while Neuro is paused, or when the switch cannot be read; then it resumes', async () => {
  let state = true;
  const { w, attested } = setup({ release: false, paused: async () => { if (state === null) throw new Error('down'); return state; } });
  assert.ok((await w.tick()).includes('Neuro is paused: not attesting'));
  state = null;
  assert.ok((await w.tick()).includes('could not read NeuroControl: not attesting'));
  assert.deepEqual(attested, []);
  state = false;
  await w.tick();
  assert.deepEqual(attested, [0n, 1n]);
});

test('a release that reverts in its gas estimate sends nothing (no nonce gap for the next tx); Blocked stops retrying', async () => {
  // Cosmos EVM hands the revert data back quoted; 0xa5baf151 is Blocked().
  const blocked = Object.assign(new Error('execution reverted (unknown custom error)'), { data: '"0xa5baf151"' });
  const { w, attested, released } = setup({ releaseEstimate: async (...t) => { if (t[2] === 0n) throw blocked; return 100_000n; } });
  const out = await w.tick();
  assert.deepEqual(attested, [0n, 1n]);
  assert.deepEqual(released, [1n], 'only the transfer that passes was sent');
  assert.ok(out.some((l) => /lock #0: not released \(Blocked\)/.test(l)), out.join('\n'));
  assert.equal(w.state.pending.length, 0, 'a Blocked transfer is dropped, not retried forever');
});
