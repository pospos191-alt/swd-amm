// Neuro federated learning, network side: FederatedRounds commit-reveal,
// signed envelopes, and a whole round aggregated from on-chain reveals.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, hexlify, id as hashText } from 'ethers';
import { createChain } from './helpers/evm.js';
import { commitmentFor, signEnvelope, verifyEnvelope, revealedFromEvents, digestOf } from '../src/fl.js';
import { encodeUpdate, toBase64 } from '../../zetaphy-neuro/ml/fl/codec.js';
import { privatize } from '../../zetaphy-neuro/ml/fl/dp.js';
import { aggregateRound } from '../../zetaphy-neuro/ml/fl/aggregate.js';
import { rng } from '../../zetaphy-neuro/ml/lib/rng.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggregateToCandidate, canaryRows } from '../scripts/fl-aggregate.js';
import { checkModel } from '../../zetaphy-neuro/ml/model.js';
import { checkHead } from '../../zetaphy-neuro/ml/fl/head.js';
import { makeExample, clientUpdate } from '../../zetaphy-neuro/ml/fl/client.js';

const HEAD = 'ab'.repeat(32);
const NAMES = ['gov', ...Array.from({ length: 24 }, (_, i) => `u${i}`)];
let c, fr, start;
const a = (n) => c.acct[n].toString();
const COMMIT = 200n, REVEAL = 200n;
beforeEach(async () => {
  c = await createChain(NAMES);
  start = c.blockNumber() + 10n;
  fr = await c.deploy('FederatedRounds', [a('gov'), start, COMMIT, REVEAL, 20], 'gov');
  assert.equal(await fr.call('paused'), true, 'closed by default');
  await fr.send('gov', 'setPaused', [false]);
});
const goTo = (block) => { const n = block - c.blockNumber(); if (n > 0n) c.mine(Number(n)); };
const update = (R, round = 0) => encodeUpdate({ headHash: HEAD, round, clip: 1, z: 2, values: privatize([0.2, -0.1, 0.05, 0.3], { clip: 1, z: 2 }, R.float) });

test('closed by default: no commit until governance opens it; reveals stay possible while paused', async () => {
  const closed = await c.deploy('FederatedRounds', [a('gov'), start, COMMIT, REVEAL, 20], 'gov');
  assert.equal(await closed.call('paused'), true);
  goTo(start);
  const p = update(rng('closed'));
  const salt = hashText('s');
  await assert.rejects(closed.send('u0', 'commit', [0, commitmentFor(p, salt, a('u0'))]), /IsPaused/);
  await assert.rejects(closed.send('u0', 'setPaused', [false]), /NotGovernance/);
  await closed.send('gov', 'setPaused', [false]);
  await closed.send('u0', 'commit', [0, commitmentFor(p, salt, a('u0'))]);
  await closed.send('gov', 'setPaused', [true]);
  goTo(start + COMMIT);
  assert.equal(revealedFromEvents(await closed.send('u0', 'reveal', [0, salt, p])).length, 1);
});

test('constructor and phases', async () => {
  const Z = '0x' + '00'.repeat(20);
  await assert.rejects(c.deploy('FederatedRounds', [Z, 1, 1, 1, 1], 'gov'));
  await assert.rejects(c.deploy('FederatedRounds', [a('gov'), 1, 0, 1, 1], 'gov'));
  await assert.rejects(c.deploy('FederatedRounds', [a('gov'), 1, 1, 1, 0], 'gov'));
  assert.deepEqual([...await fr.call('phaseAt', [start - 1n])], [0n, 0n]);
  assert.deepEqual([...await fr.call('phaseAt', [start])], [0n, 1n]);
  assert.deepEqual([...await fr.call('phaseAt', [start + COMMIT])], [0n, 2n]);
  assert.deepEqual([...await fr.call('phaseAt', [start + COMMIT + REVEAL])], [1n, 1n]);
  assert.equal(await fr.call('roundStart', [3]), start + 3n * (COMMIT + REVEAL));
  await assert.rejects(fr.send('u0', 'setPaused', [true]), /NotGovernance/);
});

test('commit-reveal: phase, one per address, matching salt and payload, cap', async () => {
  const R = rng('cr');
  const p = update(R);
  const salt = hashText('salt-u0');
  await assert.rejects(fr.send('u0', 'commit', [0, commitmentFor(p, salt, a('u0'))]), /WrongPhase/, 'before the round');
  goTo(start);
  await assert.rejects(fr.send('u0', 'commit', [1, commitmentFor(p, salt, a('u0'))]), /WrongPhase/, 'not this round');
  await assert.rejects(fr.send('u0', 'commit', [0, '0x' + '00'.repeat(32)]), /BadValue/);
  await fr.send('u0', 'commit', [0, commitmentFor(p, salt, a('u0'))]);
  await assert.rejects(fr.send('u0', 'commit', [0, commitmentFor(p, salt, a('u0'))]), /AlreadyCommitted/);
  await assert.rejects(fr.send('u0', 'reveal', [0, salt, p]), /WrongPhase/, 'no reveal during commit');
  await fr.send('gov', 'setPaused', [true]);
  await assert.rejects(fr.send('u1', 'commit', [0, commitmentFor(p, salt, a('u1'))]), /IsPaused/);
  await fr.send('gov', 'setPaused', [false]);
  // someone copying u0's commitment cannot reveal it as their own (sender is inside the hash)
  await fr.send('u1', 'commit', [0, commitmentFor(p, salt, a('u0'))]);
  goTo(start + COMMIT);
  await assert.rejects(fr.send('u1', 'reveal', [0, salt, p]), /BadReveal/);
  await assert.rejects(fr.send('u0', 'reveal', [0, hashText('other'), p]), /BadReveal/);
  await assert.rejects(fr.send('u0', 'reveal', [0, salt, update(R)]), /BadReveal/);
  await assert.rejects(fr.send('u2', 'reveal', [0, salt, p]), /BadReveal/, 'never committed');
  const ev = await fr.send('u0', 'reveal', [0, salt, p]);
  const got = revealedFromEvents(ev);
  assert.equal(got.length, 1);
  assert.equal(got[0].sender.toLowerCase(), a('u0').toLowerCase());
  assert.equal(hexlify(got[0].bytes), hexlify(p));
  await assert.rejects(fr.send('u0', 'reveal', [0, salt, p]), /BadReveal/, 'only once');
  goTo(start + COMMIT + REVEAL);
  await assert.rejects(fr.send('u3', 'reveal', [0, salt, p]), /WrongPhase/, 'round over');
  // cap
  await fr.send('gov', 'setMaxPerRound', [1]);
  await fr.send('u4', 'commit', [1, commitmentFor(p, salt, a('u4'))]);
  await assert.rejects(fr.send('u5', 'commit', [1, commitmentFor(p, salt, a('u5'))]), /RoundFull/);
  assert.equal(await fr.call('commits', [1]), 1n);
});

test('a whole round: 20 browsers commit and reveal, the aggregator rebuilds the update from events', async () => {
  const R = rng('round');
  goTo(start);
  const sent = [];
  for (let i = 0; i < 20; i++) {
    const p = update(R);
    const salt = hashText(`s${i}`);
    sent.push({ who: `u${i}`, p, salt });
    await fr.send(`u${i}`, 'commit', [0, commitmentFor(p, salt, a(`u${i}`))]);
  }
  await assert.rejects(fr.send('u20', 'commit', [0, hashText('x')]), /RoundFull/);
  goTo(start + COMMIT);
  const subs = [];
  for (const s of sent) subs.push(...revealedFromEvents(await fr.send(s.who, 'reveal', [0, s.salt, s.p])));
  assert.equal(await fr.call('reveals', [0]), 20n);
  const res = aggregateRound(subs, { headHash: HEAD, round: 0, dim: 4, clip: 1, z: 2 }, { minUpdates: 20 });
  assert.equal(res.accepted.length, 20);
  assert.equal(res.delta.length, 4);
});

test('signed envelopes: verify, and refuse any change', async () => {
  const w = Wallet.createRandom();
  const bytes = update(rng('env'));
  const env = await signEnvelope(w, bytes);
  const got = verifyEnvelope(env);
  assert.equal(got.sender, w.address);
  assert.equal(hexlify(got.bytes), hexlify(bytes));
  assert.match(digestOf(bytes), /^[0-9a-f]{64}$/);
  const other = Wallet.createRandom();
  assert.throws(() => verifyEnvelope({ ...env, address: other.address }), /does not match/);
  const changed = Uint8Array.from(bytes); changed[60] ^= 1;
  assert.throws(() => verifyEnvelope({ ...env, payload: toBase64(changed) }), /does not match/);
  assert.throws(() => verifyEnvelope({ ...env, format: 'x' }), /not a Neuro/);
});

test('aggregator script: signed envelopes on the real model -> candidate head, manifest, gov proposal; poison refused', async () => {
  const N = new URL('../../zetaphy-neuro/ml/', import.meta.url);
  const modelBytes = readFileSync(new URL('model.json', N));
  const model = checkModel(JSON.parse(modelBytes));
  const head = checkHead(model, JSON.parse(readFileSync(new URL('fl/head.json', N), 'utf8')));
  const canaries = canaryRows();
  const ev = readFileSync(new URL('data/redteam/evasions.jsonl', N), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const R = rng('agg-script');
  const dir = mkdtempSync(`${tmpdir()}/nfl-`);
  try {
    const subs = [];
    for (let i = 0; i < 30; i++) {
      const w = Wallet.createRandom();
      const ex = [makeExample(model, head, R.pick(ev).f, 1), makeExample(model, head, R.pick(model.check).f, 0)];
      const bytes = encodeUpdate({ headHash: head.hash, round: 5, clip: 1, z: 2, values: clientUpdate(model, head, ex, { uniform: R.float }) });
      const env = await signEnvelope(w, bytes);
      writeFileSync(`${dir}/u${i}.json`, JSON.stringify(env));
      subs.push(verifyEnvelope(env));
    }
    const r = await aggregateToCandidate({ model, modelBytes, head, submissions: subs, round: 5, canaries });
    assert.equal(r.decision.accepted, 30);
    assert.equal(r.decision.better, true, r.decision.why);
    assert.match(r.decision.manifestHash, /^0x[0-9a-f]{64}$/);
    assert.equal(r.manifest.manifest.head.id, r.head.id);
    // the CLI gives the same, byte for byte
    const out = `${dir}/out`;
    // a record with no contract: the committed one names the live testnet contract, and this test must not reach the network
    const dep = `${dir}/deployment.json`;
    writeFileSync(dep, JSON.stringify({ format: 'neuro-fl-deployment/1', network: 'test', chainId: 77390, rpc: 'https://example.invalid', rounds: null, deployBlock: null, governance: null, threatRegistry: null }));
    const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/fl-aggregate.js', import.meta.url)), '--round', '5', '--inbox', dir, '--out', out, '--deployment', dep,
      '--registry', '0x' + '22'.repeat(20), '--gov-bech32', 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700j5tzgnc', '--activation', '9000',
      '--uri', 'https://example.invalid/manifest.json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(stdout).manifestHash, r.decision.manifestHash);
    assert.equal(readFileSync(`${out}/manifest.json`, 'utf8'), r.manifest.text);
    assert.ok(existsSync(`${out}/proposal.json`) && existsSync(`${out}/body.md`));
    // colluding push-down updates (every coordinate negative, inside the shape checks): the gate refuses the round
    const evil = [];
    for (let i = 0; i < 30; i++) {
      evil.push({ sender: `0x${(i + 1).toString(16).padStart(40, '0')}`, bytes: encodeUpdate({ headHash: head.hash, round: 5, clip: 1, z: 2, values: new Array(head.dim).fill(-2.5) }) });
    }
    const bad = await aggregateToCandidate({ model, modelBytes, head, submissions: evil, round: 5, canaries });
    assert.equal(bad.decision.better, false);
    assert.match(bad.decision.why, /fell/);
    // updates computed on another head are rejected outright
    const stale = await aggregateToCandidate({ model, modelBytes, head: { ...head, hash: 'ff'.repeat(32) }, submissions: subs, round: 5, canaries });
    assert.equal(stale.decision.accepted, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
