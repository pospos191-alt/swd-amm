// The assistant pages (assist.js, govassist.js) and their words: the 8 languages, the selectors and topics, the
// governance rules (params, EVM calls, the timelock queue), coverage, the Neuro-checked badge, the PQ verifier in
// "browser" mode (the wallet's ML-DSA bundle), and the hub-config the build writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id, Interface, AbiCoder, zeroPadValue, toBeHex } from 'ethers';
import { readFileSync } from 'node:fs';
import { ASSIST } from '../assist-i18n.js';
import { LANG_CODES } from '../i18n.js';
import { EVM_SELECTORS, TOPIC, SEL_TIMESTAMP, moduleOf, paramDiff, readMessage, describeCall, reviewProposals, reviewTimelock, readScheduled } from '../govassist.js';
import { SEL, readSnapshot, roundsOfData, readRounds, currentFlags, coverageOf, pct, measureCoverage, readBadge, badgeData, browserVerify } from '../assist.js';
import { immuneMirrors, hubConfig } from '../build.mjs';
import { buildArchive } from '../pqattest.js';

const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);
const abi = AbiCoder.defaultAbiCoder();

test('ASSIST words: every language has every key, translated, placeholders filled', () => {
  assert.deepEqual(Object.keys(ASSIST).sort(), [...LANG_CODES].sort());
  const en = shape(ASSIST.en);
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(ASSIST[l]), en, l);
    if (l !== 'en') for (const k of ['simNote', 'govIntro', 'imIntro', 'imPqHint']) assert.notEqual(ASSIST[l][k], ASSIST.en[k], `${l}.${k} translated`);
    assert.match(ASSIST[l].simFails('X1'), /X1/);
    assert.match(ASSIST[l].govSimFail('X2'), /X2/);
    assert.match(ASSIST[l].imCertYes('7', '0xabc'), /7[\s\S]*0xabc|0xabc[\s\S]*7/);
    assert.match(ASSIST[l].imFlagged(3), /3/);
    for (const v of Object.values(ASSIST[l].flag)) assert.ok(typeof v === 'string' && v.length > 3);
    assert.doesNotMatch(JSON.stringify(ASSIST[l]), /(?<!quantum-)\bsafe\b/i, 'never "safe"');
  }
});

test('selectors and topics are the keccak of their signatures', () => {
  for (const [sel, [sig]] of Object.entries(EVM_SELECTORS)) assert.equal(id(sig).slice(0, 10), sel, sig);
  assert.equal(TOPIC.CallScheduled, id('CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)'));
  assert.equal(TOPIC.CallExecuted, id('CallExecuted(bytes32,uint256,address,uint256,bytes)'));
  assert.equal(TOPIC.Cancelled, id('Cancelled(bytes32)'));
  assert.equal(SEL_TIMESTAMP, id('getTimestamp(bytes32)').slice(0, 10));
  for (const [k, sig] of [['snapshot', 'snapshot(uint256,uint256)'], ['roundsOf', 'roundsOf(bytes32[])'], ['badge', 'badge(address)'], ['flaggedNow', 'flaggedNow()'], ['paused', 'paused()']]) assert.equal(SEL[k], id(sig).slice(0, 10), sig);
  // and they exist in the deployed contracts' ABIs
  const art = (n) => new Interface(JSON.parse(readFileSync(new URL(`../../zetaphy-network/artifacts/${n}.json`, import.meta.url), 'utf8')).abi);
  assert.ok(art('NeuroOracleSender').getFunction('snapshot'));
  assert.ok(art('NeuroOracle').getFunction('roundsOf'));
  assert.ok(art('NeuroAttest').getFunction('badge'));
});

test('governance rules: parameter changes compared with the current ones, risky ones flagged', () => {
  assert.equal(moduleOf('/cosmos.staking.v1beta1.MsgUpdateParams'), 'staking');
  assert.equal(moduleOf('/cosmos.gov.v1.MsgUpdateParams'), 'gov');
  assert.equal(moduleOf('/cosmos.evm.vm.v1.MsgUpdateParams'), 'evm');
  assert.equal(moduleOf('/cosmos.bank.v1beta1.MsgSend'), null);
  const d = paramDiff('staking', { unbonding_time: '1814400s', max_validators: 100, bond_denom: 'azetaphy' }, { unbonding_time: '60s', max_validators: 100, bond_denom: 'azetaphy' });
  assert.deepEqual(d, [{ field: 'unbonding_time', from: '1814400s', to: '60s', flag: 'shorterUnbonding' }]);
  assert.equal(paramDiff('staking', { unbonding_time: '1814400s' }, { unbonding_time: '1209600s' })[0].flag, null, 'a modest change is listed, not flagged');
  assert.equal(paramDiff('gov', { quorum: '0.334' }, { quorum: '0.1' })[0].flag, 'lowerQuorum');
  assert.equal(paramDiff('evm', { active_static_precompiles: ['0x1', '0x2'] }, { active_static_precompiles: ['0x1'] })[0].flag, 'precompileOff');
  assert.equal(paramDiff('slashing', { slash_fraction_double_sign: '0.05' }, { slash_fraction_double_sign: '0.5' })[0].flag, 'harsherSlashing');
  const gov = 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj'; // the gov module
  const m = readMessage({ '@type': '/zetaphy.pq.v1.MsgEVMCall', sender: gov, to: '0x' + '11'.repeat(20), value: '0', data: Buffer.from(new Interface(['function setGovernance(address)']).encodeFunctionData('setGovernance', ['0x' + '22'.repeat(20)]).slice(2), 'hex').toString('base64') });
  assert.equal(m.kind, 'evm');
  assert.equal(m.fn.name, 'setGovernance(address)');
  assert.deepEqual(m.flags, ['highRisk']);
  assert.match(m.call.from, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(readMessage({ '@type': '/cosmos.upgrade.v1beta1.MsgSoftwareUpgrade', plan: { name: 'v2', height: '100' } }).flags[0], 'upgrade');
  assert.deepEqual(readMessage({ '@type': '/x.y.MsgWhatever' }).flags, ['unknown']);
  assert.equal(describeCall('0x').risk, 'info');
  assert.match(describeCall('0xdeadbeef').name, /unknown function 0xdeadbeef/);
});

test('reviewProposals: open proposals read, params diffed against the node, EVM calls simulated (a failing one flagged)', async () => {
  const rest = 'https://node/rest';
  const pages = {
    [`${rest}/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_VOTING_PERIOD&pagination.limit=50`]: { proposals: [{ id: '7', title: 'Faster unbonding', voting_end_time: '2026-11-02T00:00:00Z',
      messages: [{ '@type': '/cosmos.staking.v1beta1.MsgUpdateParams', params: { unbonding_time: '600s', max_validators: 100 } },
        { '@type': '/zetaphy.pq.v1.MsgEVMCall', sender: '0x' + '7b'.repeat(20), to: '0x' + '33'.repeat(20), value: '0', data: '0x8456cb59' }] }] },
    [`${rest}/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_DEPOSIT_PERIOD&pagination.limit=50`]: { proposals: [] },
    [`${rest}/cosmos/staking/v1beta1/params`]: { params: { unbonding_time: '1814400s', max_validators: 100 } },
  };
  const getJson = async (u) => { if (!(u in pages)) throw new Error(`404 ${u}`); return pages[u]; };
  const err = new Interface(['error Error(string)']).encodeErrorResult('Error', ['NotGovernance']);
  const send = async (method, [tx]) => { assert.equal(method, 'eth_call'); assert.equal(tx.from, '0x' + '7b'.repeat(20), 'simulated as the gov module'); return { error: { message: 'execution reverted', data: err } }; };
  const [p] = await reviewProposals({ getJson, rest, send });
  assert.equal(p.id, '7');
  assert.equal(p.status, 'voting');
  assert.deepEqual(p.messages[0].diff, [{ field: 'unbonding_time', from: '1814400s', to: '600s', flag: 'shorterUnbonding' }]);
  assert.equal(p.messages[1].sim.ok, false);
  assert.equal(p.messages[1].sim.reason, 'NotGovernance');
  assert.deepEqual(p.flags.sort(), ['shorterUnbonding', 'wouldFail']);
});

test('reviewTimelock: scheduled and not executed or cancelled, simulated as the timelock', async () => {
  const tl = '0x' + '71'.repeat(20);
  const target = '0x' + '44'.repeat(20);
  const sched = (opId, data) => ({ topics: [TOPIC.CallScheduled, opId, zeroPadValue(toBeHex(0), 32)],
    data: abi.encode(['address', 'uint256', 'bytes', 'bytes32', 'uint256'], [target, 0, data, '0x' + '00'.repeat(32), 172800]) });
  const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32), Cc = '0x' + 'cc'.repeat(32);
  const ism = new Interface(['function setIsm(address)']).encodeFunctionData('setIsm', ['0x' + '55'.repeat(20)]);
  assert.equal(readScheduled(sched(A, ism)).data, ism);
  const logs = [sched(A, ism), sched(B, '0x8456cb59'), { topics: [TOPIC.CallExecuted, B], data: '0x' }, sched(Cc, '0x3f4ba83a'), { topics: [TOPIC.Cancelled, Cc], data: '0x' }];
  const send = async (method, params) => {
    if (method === 'eth_getLogs') { assert.equal(params[0].address, tl); return { result: logs }; }
    if (params[0].to === tl) return { result: '0x' + (1_800_000_000).toString(16).padStart(64, '0') };
    assert.equal(params[0].from, tl);
    return { result: '0x' };
  };
  const ops = await reviewTimelock({ send, timelock: tl, now: 1_700_000_000 });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].fn.name, 'setIsm(address)');
  assert.deepEqual(ops[0].flags, ['highRisk']);
  assert.equal(ops[0].ready, false);
});

test('coverage in the browser: snapshot and roundsOf answers, floored percentages, unreachable mirrors', async () => {
  const k1 = '0x' + '01'.repeat(32), k2 = '0x' + '02'.repeat(32);
  const snap = abi.encode(['bytes32[]', 'uint32[]', 'bool[]'], [[k1, k2, k1], [1, 1, 2], [true, true, false]]);
  const s = readSnapshot(snap);
  assert.deepEqual(s.rounds, [1, 1, 2]);
  const flags = currentFlags([s]);
  assert.deepEqual([...flags.entries()], [[k2, 1]], 'k1 was cleared later');
  assert.equal(roundsOfData([k1]), SEL.roundsOf + abi.encode(['bytes32[]'], [[k1]]).slice(2));
  assert.deepEqual(readRounds(abi.encode(['uint32[]'], [[3, 0]])), [3, 0]);
  assert.deepEqual(coverageOf(flags, [1]), { flagged: 1, mirrored: 1, share: 1 });
  assert.equal(pct(0.9999), '99.9%');
  const zSend = async (_m, [tx]) => ({ result: tx.data.startsWith(SEL.snapshot) ? snap : '0x' });
  const chainSend = (m) => async (_x, [tx]) => (m.name === 'down' ? { error: { message: 'no' } } : { result: tx.data === SEL.paused ? '0x' + '00'.repeat(32) : abi.encode(['uint32[]'], [[0]]) });
  const r = await measureCoverage({ immune: { sender: '0x' + '99'.repeat(20), mirrors: [{ name: 'basesepolia', displayName: 'Base Sepolia', oracle: '0x' + '98'.repeat(20) }, { name: 'down', oracle: '0x' + '97'.repeat(20) }] }, zSend, chainSend });
  assert.equal(r.flagged, 1);
  assert.equal(r.mirrors[0].name, 'Base Sepolia');
  assert.equal(r.mirrors[0].share, 0);
  assert.ok(r.mirrors[1].error);
});

test('badge answers', () => {
  assert.equal(badgeData('0x' + 'Ab'.repeat(20)), SEL.badge + '0'.repeat(24) + 'ab'.repeat(20));
  const out = abi.encode(['bool', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'address', 'uint64'], [true, 3, '0x' + '11'.repeat(32), '0x' + '22'.repeat(32), zeroPadValue('0x' + Buffer.from('rules').toString('hex'), 32).replace(/^0x(0+)(.*)$/, (m, z, r) => '0x' + r + z), '0x' + '33'.repeat(20), 1_800_000_000]);
  const b = readBadge(out);
  assert.equal(b.checked, true);
  assert.equal(b.uid, 3n);
  assert.equal(b.model, 'rules');
  assert.equal(b.by, '0x' + '33'.repeat(20));
});

test('the PQ verifier in browser mode, with the wallet\'s ML-DSA-44 bundle (vendor/pqwallet.js)', async () => {
  const pqwallet = await import('../../zetaphy-wallet/vendor/pqwallet.js');
  const { ml_dsa44, keccak_256 } = pqwallet;
  const keys = ml_dsa44.keygen(new Uint8Array(32).fill(7));
  const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  const a = await buildArchive({ kind: 'neuro-report', createdAt: '2026-10-28T00:00:00Z', subject: { chain: 'eth', address: '0xabc' }, reportHash: '0x' + '11'.repeat(32), skill: '0x01', model: 'rules' },
    keys.publicKey, { sha256: sha, keccak256: (b) => keccak_256(b), sign: (m) => ml_dsa44.sign(m, keys.secretKey) });
  const r = await browserVerify(a, { evmCall: async () => { throw new Error('no node'); }, pqwallet, verdict: null });
  assert.equal(r.ok, true, r.problems.join('; '));
  a.payload.model = 'x';
  assert.equal((await browserVerify(a, { evmCall: async () => '0x', pqwallet, verdict: null })).ok, false);
});

test('hub-config: the oracle mirrors only once deployed, public data only; new contracts and the timelock pass through', () => {
  const table = JSON.parse(readFileSync(new URL('../../zetaphy-chain/hyperlane/saphan-chains.json', import.meta.url), 'utf8'));
  const read = (files) => (f) => files[f] ?? null;
  assert.deepEqual(immuneMirrors(read({ 'zetaphy-chain/hyperlane/saphan-chains.json': table })), { sender: null, mirrors: [] });
  const r = immuneMirrors(read({ 'zetaphy-chain/hyperlane/saphan-chains.json': table, 'zetaphy-chain/hyperlane/neuro-oracle.json': { sender: '0x' + '11'.repeat(20), receivers: { basesepolia: { oracle: '0x' + '22'.repeat(20) }, nochain: { oracle: '0x' + '33'.repeat(20) }, sepolia: { oracle: 'x' } } } }));
  assert.equal(r.mirrors.length, 1);
  assert.match(r.mirrors[0].rpc, /^https:\/\//);
  const cfg = hubConfig({ node: '' });
  assert.ok('immune' in cfg);
});

test('PQ attestation: anchor(bytes32) call data, and the archive with its anchor written in', async () => {
  const { anchorData, withAnchor, ANCHOR } = await import('../pqattest.js');
  const h = '0x' + 'ab'.repeat(32);
  assert.equal(anchorData(h), new Interface(['function anchor(bytes32)']).encodeFunctionData('anchor', [h]));
  assert.equal(ANCHOR, '0xeecdf927');
  const a = withAnchor({ format: 'f', payload: { x: 1 } }, { contract: '0x' + '11'.repeat(20), hash: h, time: 5n });
  assert.deepEqual(a.anchor, { chainId: 77390, contract: '0x' + '11'.repeat(20), hash: h, time: 5 });
  assert.deepEqual(a.payload, { x: 1 });
});
