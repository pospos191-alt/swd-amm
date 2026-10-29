// zkML, on-chain side: NeuroScoreVerifier (Groth16, exported from the FINAL zkey of the phase-2 ceremony by
// zetaphy-neuro/ml/onchain/zk/run.js --install) accepts the committed proof that a committed feature vector yields
// margin Z under model hash H, binds H itself (MODEL_HASH, verifyModelProof), rejects tampered public signals, and
// rejects proofs made with a NON-FINAL zkey (before the beacon) or a FORGED one (an independent setup of the same
// circuit), even though each of those proofs is valid under its own key.
// Until the public ceremony (zk/ceremony/transcript.json) is final, the committed verifier comes from a REHEARSAL of
// that ceremony on one machine: testnet only (docs/future/onchain-ml.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChain } from './helpers/evm.js';
import { evalFixed, fromHex, quantizeVector } from '../../zetaphy-neuro/ml/onchain/fixed.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/neuroscore-zk.json', import.meta.url), 'utf8'));
const ML = new URL('../../zetaphy-neuro/ml/onchain/', import.meta.url);
const FIXED = JSON.parse(readFileSync(new URL('model.fixed.json', ML), 'utf8'));
const HELD = JSON.parse(readFileSync(new URL('heldout.json', ML), 'utf8'));
const TRANSCRIPT = JSON.parse(readFileSync(new URL('zk/ceremony/transcript.json', ML), 'utf8'));
const SOL = readFileSync(new URL('../contracts/NeuroScoreVerifier.sol', import.meta.url), 'utf8');
const calldataGas = (words) => words.reduce((g, w) => { const h = BigInt(w).toString(16).padStart(64, '0'); let s = 0; for (let i = 0; i < 64; i += 2) s += h.slice(i, i + 2) === '00' ? 4 : 16; return g + s; }, 0);
const args = (x) => [x.a, x.b, x.c, x.publicSignals];
const bound = (x) => [x.a, x.b, x.c, x.publicSignals[0], x.publicSignals[1]];

async function setup() {
  const c = await createChain(['deployer', 'anyone']);
  const v = await c.deploy('NeuroScoreVerifier', [], 'deployer');
  return { c, v };
}

test('the fixture is for the committed model: H in the proof = keccak256(model bytes); Z = the JS fixed-point margin of its row', () => {
  assert.equal(FX.hash, FIXED.hash, 'rerun ml/onchain/zk/run.js --install after a model change');
  const [, margin, hi, lo] = FX.publicSignals.map(BigInt);
  assert.equal('0x' + ((hi << 128n) | lo).toString(16).padStart(64, '0'), FIXED.hash);
  const row = HELD.rows.find((r) => r.id === FX.row);
  assert.ok(row, FX.row);
  const v = new Array(FIXED.features.length).fill(0);
  for (const [i, x] of row.x) v[i] = x;
  assert.equal(margin - BigInt(FX.marginOffset), BigInt(evalFixed(fromHex(FIXED.bytes), quantizeVector(v)).margin));
  // the negative proofs are for the same statement (same public signals): only the key differs
  assert.deepEqual(FX.nonFinal.publicSignals, FX.publicSignals);
  assert.deepEqual(FX.forged.publicSignals, FX.publicSignals);
  assert.notDeepEqual(FX.nonFinal.a, FX.a);
  assert.notDeepEqual(FX.forged.a, FX.a);
});

test('the verifier says where its key came from: MODEL_HASH, the final zkey and the ceremony link; rehearsal labelled', async () => {
  const { v } = await setup();
  assert.equal(await v.call('MODEL_HASH', []), FIXED.hash);
  assert.equal(await v.call('ZKEY_SHA256', []), '0x' + FX.ceremony.zkeySha256);
  assert.equal(await v.call('CEREMONY_LINK', []), '0x' + FX.ceremony.link);
  assert.equal(FX.ceremony.steps.at(-1).type, 'beacon', 'exported only from a final (beaconed) zkey');
  assert.equal(TRANSCRIPT.circuit.modelHash, FIXED.hash, 'the public ceremony is for the committed model');
  const last = TRANSCRIPT.contributions.at(-1);
  if (last?.type === 'beacon') {
    // the public ceremony is final: the committed verifier must be the one exported from it
    assert.equal(FX.ceremony.link, last.link);
    assert.equal(FX.ceremony.zkeySha256, last.zkeySha256);
    assert.doesNotMatch(SOL, /REHEARSAL/);
  } else {
    assert.match(FX.ceremony.kind, /rehearsal/);
    assert.match(SOL.split('\n').slice(0, 3).join('\n'), /REHEARSAL setup.*\n.*Testnet only/);
  }
});

test('NeuroScoreVerifier accepts the proof and rejects any changed public signal or proof element; gas measured', async () => {
  const { v } = await setup();
  assert.equal(await v.call('verifyProof', args(FX)), true);
  assert.equal(await v.call('verifyModelProof', bound(FX)), true);
  const g = await v.gas('anyone', 'verifyProof', args(FX));
  const gb = await v.gas('anyone', 'verifyModelProof', bound(FX));
  const cdg = calldataGas([...FX.a, ...FX.b.flat(), ...FX.c, ...FX.publicSignals]) + 64;
  console.log(`verifyProof: execution gas ${g.exec}, + 21000 + calldata ${cdg} = ${g.exec + 21000 + cdg} as a transaction; verifyModelProof: execution gas ${gb.exec}`);
  for (let i = 0; i < 4; i++) {
    const pub = FX.publicSignals.slice();
    pub[i] = '0x' + (BigInt(pub[i]) + 1n).toString(16);
    assert.equal(await v.call('verifyProof', [FX.a, FX.b, FX.c, pub]), false, `public signal ${i} changed`);
  }
  // a different margin (e.g. a lower score) with the same proof: refused
  const lower = FX.publicSignals.slice();
  lower[1] = '0x' + (BigInt(lower[1]) - 10_000_000n).toString(16);
  assert.equal(await v.call('verifyProof', [FX.a, FX.b, FX.c, lower]), false);
  assert.equal(await v.call('verifyModelProof', [FX.a, FX.b, FX.c, FX.publicSignals[0], lower[1]]), false);
  assert.equal(await v.call('verifyModelProof', [FX.a, FX.b, FX.c, '0x' + (BigInt(FX.publicSignals[0]) + 1n).toString(16), FX.publicSignals[1]]), false);
  // a broken proof point is not on the curve: refused (returns false)
  const a = [FX.a[0], '0x' + (BigInt(FX.a[1]) + 1n).toString(16)];
  assert.equal(await v.call('verifyProof', [a, FX.b, FX.c, FX.publicSignals]), false);
});

test('a proof from a NON-FINAL zkey (before the beacon) or a FORGED zkey (independent setup) is refused', async () => {
  const { v } = await setup();
  for (const [what, x] of [['non-final', FX.nonFinal], ['forged', FX.forged]]) {
    assert.equal(await v.call('verifyProof', args(x)), false, `${what}: verifyProof`);
    assert.equal(await v.call('verifyModelProof', bound(x)), false, `${what}: verifyModelProof`);
  }
});
