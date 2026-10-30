// The Quantum safety tab (quantum-core.js, quantum.js): the rescue commitment and reads against ethers and the
// compiled QuantumRescue ABI, the same state rule as zetaphy-network/src/qsafe/rescue.js, the readiness view of the
// inventory, the explorer's exposure verdict reused, the tab's words in 8 languages, and the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, AbiCoder, keccak256, getBytes, hexlify, randomBytes } from 'ethers';
import { keccak256 as neuroKeccak } from '../../zetaphy-neuro/src/keccak.js';
import * as core from '../quantum-core.js';
import { QUANTUM } from '../quantum-i18n.js';
import { parseAddress, fmt } from '../quantum.js';
import { LANG_CODES, TAB_TEXT } from '../i18n.js';
import { FLOW } from '../flow-i18n.js';
import { FLOWS } from '../flow.js';
import { hubConfig, qsafeHub } from '../build.mjs';
import { quantumExposure } from '../../zetaphy-explorer/src/quantum.js';
import * as net from '../../zetaphy-network/src/qsafe/rescue.js';
import { summary } from '../../zetaphy-network/src/qsafe/inventory.js';

const k = (b) => neuroKeccak(b);
const abi = AbiCoder.defaultAbiCoder();
const art = JSON.parse(readFileSync(new URL('../../zetaphy-network/artifacts/QuantumRescue.json', import.meta.url), 'utf8'));
const iface = new Interface(art.abi);
const A = '0x00000000000000000000000000000000000a11ce';
const R = '0x000000000000000000000000000000000000c0de';
const Z32 = '0x' + '00'.repeat(32);

test('the rescue commitment equals the contract rule (zetaphy-network/src/qsafe/rescue.js)', () => {
  const pk = hexlify(randomBytes(1312));
  const secret = hexlify(randomBytes(32));
  const keyHash = core.keyHashOf(k, pk);
  assert.equal(keyHash, keccak256(pk));
  assert.equal(core.rescueCommitment(k, { chainId: 77390, contract: R, account: A, keyHash, secret }),
    net.commitmentOf({ chainId: 77390, contract: R, account: A, publicKey: pk, secret }));
  assert.equal(core.keyHashOf(k, '0x1234'), null);
  assert.throws(() => core.rescueCommitment(k, { chainId: 1, contract: 'nope', account: A, keyHash, secret }), /address/);
  assert.throws(() => core.rescueCommitment(k, { chainId: 1, contract: R, account: A, keyHash: '0x12', secret }), /bytes32/);
});

test('calldata and reads match the compiled ABI', () => {
  for (const sig of Object.values(core.SIG)) assert.ok(iface.getFunction(sig), sig);
  const c = '0x' + 'ab'.repeat(32);
  assert.equal(core.calldata(k, core.SIG.commit, [c]), iface.encodeFunctionData('commit', [c]));
  assert.equal(core.calldata(k, core.SIG.slotOf, [A]), iface.encodeFunctionData('slotOf', [A]));
  const d = core.decodeRescueReads({
    slot: abi.encode(['bytes32', 'bytes32', 'uint64'], [c, Z32, 5n]), effective: abi.encode(['bytes32'], [c]),
    controller: abi.encode(['address'], [A]), qday: abi.encode(['uint64'], [900n]), maturity: abi.encode(['uint64'], [10n]) });
  assert.equal(d.slot[0], c);
  assert.equal(BigInt(d.slot[2]), 5n);
  assert.equal(String(d.controller).toLowerCase(), A);
  assert.equal(BigInt(d.qday), 900n);
});

test('rescueState is the same rule as the network side', () => {
  const C = '0x' + '11'.repeat(32);
  const base = { slot: [Z32, Z32, 0n], effective: Z32, controller: '0x' + '00'.repeat(20), qday: 0n, block: 100n, maturity: 10n };
  const cases = [base, { ...base, slot: [Z32, C, 95n] }, { ...base, slot: [Z32, C, 95n], qday: 100n }, { ...base, effective: C, slot: [C, Z32, 0n] },
    { ...base, effective: C, slot: [C, Z32, 0n], qday: 90n }, { ...base, qday: 90n }, { ...base, controller: A }];
  for (const x of cases) assert.deepEqual(core.rescueState(x), net.rescueState(x));
});

test('next step for an address', () => {
  assert.equal(core.nextStep({ level: 'pq' }), 'safe');
  assert.equal(core.nextStep({ level: 'locked' }), 'safe');
  assert.equal(core.nextStep({ level: 'exposed', migration: { migrated: true } }), 'safe');
  assert.equal(core.nextStep({ level: 'exposed' }), 'rescue');
  assert.equal(core.nextStep({ level: 'hidden', rescue: 'committed' }), 'covered');
  assert.equal(core.nextStep({ level: 'exposed', rescue: 'frozen' }), 'lock');
  assert.equal(core.nextStep({ level: 'exposed', rescue: 'rescued' }), 'safe');
  assert.equal(core.nextStep({ level: 'contract' }), 'contract');
  assert.equal(core.nextStep({ level: 'unknown' }), 'unknown');
  // the explorer's verdict feeds it
  assert.equal(quantumExposure({ pq: { pubKeyType: 'eth_secp256k1', sequence: '3' }, nonce: 3n, code: '0x' }).level, 'exposed');
  assert.equal(quantumExposure({ pq: { pubKeyType: 'mldsa44' } }).level, 'pq');
});

test('readiness: the inventory summary as the tab shows it', () => {
  const q = qsafeHub();
  const s = summary();
  assert.equal(q.score, s.score);
  const r = core.readiness(q);
  assert.equal(r.score, s.score);
  assert.equal(r.pq + r.hybrid + r.partial + r.classical, s.total);
  assert.equal(r.grade, core.grade(s.score));
  assert.ok(r.open.length > 0 && r.open.length <= 8);
  assert.equal(core.readiness(null), null);
  assert.equal(core.readiness({ score: 120, total: 1 }), null);
  assert.deepEqual(core.readiness({ score: 10, total: 1, open: [{ id: '<script>' }, { id: 'ok-1', component: 'x' }] }).open.map((o) => o.id), ['ok-1']);
  assert.deepEqual([core.grade(10), core.grade(50), core.grade(80)], ['low', 'medium', 'high']);
  const kit = JSON.parse(core.rescueKit({ chainId: 77390, contract: R, account: A, keyHash: Z32, controller: A, secret: Z32, seed: Z32 }));
  assert.equal(kit.kind, 'zetaphy-quantum-rescue-v1');
  assert.equal(kit.mldsa44Seed, Z32);
});

test('address input', () => {
  assert.equal(parseAddress(` ${A} `), A);
  assert.equal(parseAddress('nope'), null);
  assert.match(parseAddress('zetaphy1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpfxk2xe') ?? 'null', /^(0x[0-9a-fA-F]{40}|null)$/);
  assert.equal(fmt('a {x} b', { x: 1 }), 'a 1 b');
});

test('the Quantum tab in 8 languages, wired into the hub', () => {
  const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([x, y]) => shape(y, `${at}/${x}`)) : [`${at}:${typeof v}`]);
  assert.deepEqual(Object.keys(QUANTUM).sort(), [...LANG_CODES].sort());
  const en = shape(QUANTUM.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(QUANTUM[l]), en, `QUANTUM.${l}`);
    assert.equal(TAB_TEXT[l].quantum?.length, 3, `${l}: tab text`);
    assert.equal(FLOW[l]?.steps?.quantum?.length, FLOWS.quantum.icons.length, `${l}: how it works`);
    assert.match(QUANTUM[l].scoreLine, /\{score\}/);
    assert.match(QUANTUM[l].levels.locked, /\{to\}/);
    assert.match(QUANTUM[l].rescueStates.maturing, /\{at\}/);
    for (const lv of ['pq', 'locked', 'exposed', 'hidden', 'contract', 'unknown']) assert.ok(QUANTUM[l].levels[lv], `${l}: level ${lv}`);
    if (l !== 'en') assert.notEqual(QUANTUM[l].intro, QUANTUM.en.intro, `${l}: translated`);
  }
  const hub = readFileSync(new URL('../hub.js', import.meta.url), 'utf8');
  assert.match(hub, /\{ id: 'quantum', page: true/);
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  for (const f of ['quantum.js', 'quantum-core.js', 'quantum-i18n.js']) assert.ok(build.includes(`'${f}'`), `${f} shipped`);
  const cfg = hubConfig({ node: '' }, { 'zetaphy-network/deployments/qsafe-77390.json': { chainId: 77390, contracts: { quantumRescue: R, pqSettlement: A } } });
  assert.equal(cfg.contracts.quantumRescue, R);
  assert.equal(cfg.contracts.pqSettlement, A);
  assert.equal(cfg.qsafe.score, summary().score);
  for (const f of ['quantum.js', 'quantum-core.js']) assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /style=|innerHTML|eval\(/, `${f}: CSP-safe`);
});
