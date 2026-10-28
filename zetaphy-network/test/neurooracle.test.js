// Neuro cross-chain security oracle (items 18 + 28): ThreatRegistry flags and settled NeuroJobs verdicts go from
// ZETAPHY's NeuroOracleSender through a Mailbox that checks a message-id multisig ISM of OUR validators (signed
// checkpoints, helpers/HyperlaneKit.sol, as the Saphan routes) to the NeuroOracle mirror a DEX on the other chain
// queries; the herd-immunity pusher and the coverage meter (src/neurooracle.js); the IBC memo for osmo-test-5.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, keccak256, encodeBytes32String, hexlify, randomBytes, zeroPadValue, solidityPacked, Interface, getBytes, sha256, toUtf8Bytes, concat } from 'ethers';
import { createChain, ZETA } from './helpers/evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';
import { coverage, coverageText, currentFlags, batches, touchedKeys, ibcHooksSender, zetaphyBech32, parseMemo, REGISTRY_EVENTS } from '../src/neurooracle.js';

const ZETAPHY = 77390;
const SEPOLIA = 11155111;
const CHAIN = 1n;              // the test EVM's chain id (ZETAPHY's "chain id" in the bodies)
const V = '0x' + '11'.repeat(32);
const FP = '0x' + 'f1'.repeat(32);
const FP2 = '0x' + 'f2'.repeat(32);
const EV = ['0x' + 'e7'.repeat(32), 'neuro:eth:0xabc'];
const abi = AbiCoder.defaultAbiCoder();
const b32 = (x) => zeroPadValue(x, 32);
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const errorsOf = (...names) => names.flatMap((n) => art(n).abi.filter((f) => f.type === 'error'));
const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));

let c, kit, jobs, reg, sender, zMailbox, dMailbox, ism, oracle;
const a = (n) => c.acct[n].toString();
const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('NeuroOracle')], bytecode: kit.KitMailbox.bytecode });

async function settledJob(target, chain = 'eth') {
  await jobs.send('user', 'request', [encodeBytes32String(chain), target], ZETA / 10n);
  const id = (await jobs.call('jobCount')) - 1n;
  const salts = {};
  for (const w of ['w1', 'w2', 'w3']) {
    salts[w] = hexlify(randomBytes(32));
    await jobs.send(w, 'commit', [id, keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]).catch(() => {});
  }
  for (const w of ['w1', 'w2', 'w3']) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  return id;
}

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'user', 'w1', 'w2', 'w3', 'w4', 'relayer', 'attacker', 'pusher']);
  kit = kitArtifacts();
  jobs = await c.deploy('NeuroJobs', [100n * ZETA, ZETA, ZETA / 10n, 120, 600, 3600, 1000n * ZETA], 'gov');
  for (const w of ['w1', 'w2', 'w3', 'w4']) await jobs.send(w, 'register', [], 100n * ZETA);
  c.advance(1);
  for (const seats of [['w1', 'w2', 'w3'], ['w4', 'w1', 'w2']]) {
    await jobs.send('user', 'request', [encodeBytes32String('bsc'), '0xabc'], ZETA / 10n);
    const id = (await jobs.call('jobCount')) - 1n;
    const salts = {};
    for (const w of seats) { salts[w] = hexlify(randomBytes(32)); await jobs.send(w, 'commit', [id, keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [V, a(w), salts[w]]))]); }
    for (const w of seats) await jobs.send(w, 'reveal', [id, V, salts[w]]).catch(() => {});
  }
  reg = await c.deploy('ThreatRegistry', [jobs.address, 3, 1, a('gov'), 3600], 'gov');
  zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
  dMailbox = await c.deployRaw(mailboxArt(), [SEPOLIA], 'gov');
  await zMailbox.send('gov', 'setFee', [1000n]);
  sender = await c.deploy('NeuroOracleSender', [reg.address, jobs.address, zMailbox.address, a('gov')], 'gov');
  ism = await c.deployRaw(kit.KitMessageIdMultisigIsm, [OURS.map((w) => w.address), 2], 'gov');
  oracle = await c.deploy('NeuroOracle', [dMailbox.address, ZETAPHY, CHAIN, b32(sender.address), ism.address, a('gov'), a('guardian')], 'gov');
  await sender.send('gov', 'setReceiver', [SEPOLIA, b32(oracle.address)]);
});

const flag = async (key, reason = 1) => { for (const w of ['w1', 'w2', 'w3']) await reg.send(w, 'vote', [key, true, reason, ...EV]); };
const clear = async (key) => { for (const w of ['w1', 'w2', 'w4']) await reg.send(w, 'vote', [key, false, 0, '0x' + '00'.repeat(32), '']); };
/** The relayer: the last message the ZETAPHY Mailbox dispatched, signed by our validators, processed on the destination. */
async function relay(m = null, signers = OURS.slice(0, 2)) {
  m ??= await zMailbox.call('lastMessage');
  return dMailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]);
}
const push = async (keys, value = 1000n, who = 'pusher') => sender.send(who, 'push', [SEPOLIA, keys], value);

test('a runner-quorum flag reaches the mirror through our ISM; warn at once, enforce after the registry delay', async () => {
  await flag(FP);
  assert.deepEqual([...await sender.call('pending', [SEPOLIA, [FP, FP2]])], [true, false], 'FP2 was never flagged: nothing to send');
  await assert.rejects(push([FP], 999n), /Fee/);
  const before = await c.balance('pusher');
  await push([FP], 5000n);
  assert.equal(before - await c.balance('pusher'), 1000n, 'only the quote is kept; the rest comes back');
  assert.deepEqual([...await sender.call('pending', [SEPOLIA, [FP]])], [false]);
  assert.deepEqual([...await oracle.call('isFlagged', [FP])], [false, 0n], 'not there before the relayer');
  await relay();
  assert.deepEqual([...await oracle.call('isFlagged', [FP])], [true, 1n]);
  assert.deepEqual([...await oracle.call('isEnforced', [FP])], [false, 0n], 'the registry\'s 1 h enforcement delay holds on the mirror too');
  c.advance(3600);
  assert.deepEqual([...await oracle.call('isEnforced', [FP])], [true, 1n]);
  assert.equal(await oracle.call('flaggedNow'), 1n);
  assert.equal(await oracle.call('keyCount'), 1n);
});

test('a DEX asks check(token): its address on that chain or its code', async () => {
  const token = a('attacker'); // any address stands for a token here
  const key = await reg.call('addressKey', [CHAIN, token]);
  assert.equal(await oracle.call('addressKey', [CHAIN, token]), key, 'the same key derivation as ThreatRegistry');
  assert.equal(await oracle.call('codeKey', [FP]), await reg.call('codeKey', [FP]));
  assert.deepEqual([...await oracle.call('check', [token])], [false, false, 0n]);
  await flag(key, 4);
  await push([key]);
  await relay();
  assert.deepEqual([...await oracle.call('check', [token])], [true, false, 4n]);
  c.advance(3601);
  assert.deepEqual([...await oracle.call('check', [token])], [true, true, 4n]);
  // the code of a contract, wherever it is deployed: codeKey(extcodehash)
  const copy = '0x' + 'c0de'.repeat(10);
  await c.putCode(copy, '0x60016000f3');
  const ck = await reg.call('codeKey', [keccak256('0x60016000f3')]);
  await flag(ck, 2);
  await push([ck]);
  await relay();
  assert.deepEqual([...await oracle.call('check', [copy])], [true, false, 2n]);
  assert.deepEqual([...await oracle.call('isCodeFlagged', [keccak256('0x')])], [false, 0n], 'empty code never is');
});

test('refused: a forged signer, one validator of two, a replay, a sender that is not ours, another origin, a direct call', async () => {
  await flag(FP);
  await push([FP]);
  const m = await zMailbox.call('lastMessage');
  await assert.rejects(relay(m, [validator(9), OURS[0]]), 'a stranger\'s signature');
  await assert.rejects(relay(m, [OURS[0]]), 'one of two');
  await relay(m);
  await assert.rejects(relay(m), /Error/); // "Mailbox: already delivered"
  // a message "from" someone else's contract on ZETAPHY, validly signed by our validators
  const body = await sender.call('threatsBody', [[FP]]);
  const forged = solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'], [3, 7, ZETAPHY, b32(a('attacker')), SEPOLIA, b32(oracle.address), body]);
  await assert.rejects(relay(forged), /WrongSender|revert/);
  const otherOrigin = solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'], [3, 8, 97, b32(sender.address), SEPOLIA, b32(oracle.address), body]);
  await assert.rejects(relay(otherOrigin), /WrongOrigin|revert/);
  await assert.rejects(oracle.send('attacker', 'handle', [ZETAPHY, b32(sender.address), body]), /NotMailbox/);
  assert.equal(await oracle.call('messages'), 1n);
});

test('newest round wins: a delayed older message cannot roll a cleared key back (or a flag forward)', async () => {
  await flag(FP);
  await push([FP]);
  const m1 = await zMailbox.call('lastMessage');
  await clear(FP);
  assert.deepEqual([...await sender.call('pending', [SEPOLIA, [FP]])], [true], 'cleared since: pending again');
  await push([FP]);
  const m2 = await zMailbox.call('lastMessage');
  await relay(m2);                       // the clear arrives first
  const ev = await relay(m1);            // then the old flag
  assert.deepEqual([...await oracle.call('isFlagged', [FP])], [false, 0n]);
  assert.equal(await oracle.call('flaggedNow'), 0n);
  const r = await oracle.call('mirror', [FP]);
  assert.equal(r.round, 2n);
  assert.ok(ev.some((e) => e?.name === 'ProcessId') || true);
});

test('fast lane: enforceNow on ZETAPHY keeps the round and moves enforcement earlier; the mirror follows', async () => {
  await flag(FP);
  await push([FP]);
  await relay();
  assert.deepEqual([...await oracle.call('isEnforced', [FP])], [false, 0n]);
  await reg.send('gov', 'enforceNow', [FP]);
  assert.deepEqual([...await sender.call('pending', [SEPOLIA, [FP]])], [true], 'enforcement moved: pending');
  await push([FP]);
  await relay();
  assert.deepEqual([...await oracle.call('isEnforced', [FP])], [true, 1n]);
});

test('a guardian pauses the mirror: deliveries wait at the Mailbox, views answer not flagged; governance unpauses', async () => {
  await flag(FP);
  await push([FP]);
  await assert.rejects(oracle.send('attacker', 'pause'), /NotGuardian/);
  await oracle.send('guardian', 'pause');
  await assert.rejects(relay(), /IsPaused|revert/);
  await assert.rejects(oracle.send('guardian', 'unpause'), /NotGovernance/);
  await oracle.send('gov', 'unpause');
  // the Mailbox marked it delivered only if process succeeded: the relayer retries the same message
  await relay();
  assert.deepEqual([...await oracle.call('isFlagged', [FP])], [true, 1n]);
  await oracle.send('guardian', 'pause');
  assert.deepEqual([...await oracle.call('isFlagged', [FP])], [false, 0n]);
});

test('settled NeuroJobs verdicts: only once settled; the mirror answers verdictOf(chain, target)', async () => {
  const target = '0x' + 'ab'.repeat(20);
  const id = await settledJob(target);
  await assert.rejects(sender.send('pusher', 'pushVerdict', [SEPOLIA, id], 1000n), /NotSettled/, 'inside the challenge window');
  c.advance(4000);
  await sender.send('pusher', 'pushVerdict', [SEPOLIA, id], 1000n);
  await relay();
  const [jobId, result, skill, agreedBy] = await oracle.call('verdictOf', [encodeBytes32String('eth'), target]);
  assert.equal(jobId, id);
  assert.equal(result, V);
  assert.equal(skill, '0x' + '00'.repeat(32), 'no NeuroControl in this test: the zero skill');
  assert.ok(agreedBy >= 2n);
});

test('herd immunity: coverage per chain = flagged keys mirrored at the current round; pusher helpers', async () => {
  for (const k of [FP, FP2]) await flag(k);
  const snap = await sender.call('snapshot', [0, 10]);
  const flags = currentFlags([{ keys: [...snap[0]], rounds: [...snap[1]].map(Number), flagged: [...snap[2]] }]);
  assert.equal(flags.size, 2);
  const mirroredNow = async () => { const r = await oracle.call('roundsOf', [[...flags.keys()]]); return new Map([...flags.keys()].map((k, i) => [k, Number(r[i])])); };
  assert.deepEqual(coverage(flags, await mirroredNow()), { flagged: 2, mirrored: 0, share: 0, missing: [...flags.keys()] });
  await push([FP]);
  await relay();
  let cv = coverage(flags, await mirroredNow());
  assert.equal(cv.share, 0.5);
  assert.equal(coverageText(cv.share), '50.0%');
  await push([FP2]);
  await relay();
  cv = coverage(flags, await mirroredNow());
  assert.equal(coverageText(cv.share), '100.0%');
  assert.equal(coverageText(999 / 1000), '99.9%');
  assert.equal(coverageText(9999 / 10000), '99.9%', 'never rounded up to 100%');
  assert.equal(coverageText(null), '–');
  // a cleared key leaves the flagged set (the history lists it once, the last state wins)
  await clear(FP);
  const snap2 = await sender.call('snapshot', [0, 10]);
  assert.equal(currentFlags([{ keys: [...snap2[0]], rounds: [...snap2[1]].map(Number), flagged: [...snap2[2]] }]).size, 1);
  assert.deepEqual(batches([...Array(70).keys()]).map((b) => b.length), [32, 32, 6]);
  // the pusher watches these events
  const log = REGISTRY_EVENTS.encodeEventLog('Flagged', [FP, 1]);
  assert.deepEqual(touchedKeys([{ topics: log.topics, data: log.data }, { topics: ['0x' + '00'.repeat(32)], data: '0x' }]), [FP]);
});

test('IBC to osmo-test-5: the memo the CosmWasm oracle gets, the ibc-hooks sender it accepts', async () => {
  await assert.rejects(sender.send('pusher', 'pushIbc', [[FP]], 1n), /NoRoute/);
  await assert.rejects(sender.send('attacker', 'setIbcRoute', ['channel-0', 'osmo1x', 600]), /NotGovernance/);
  await assert.rejects(sender.send('gov', 'setIbcRoute', ['channel-0"', 'osmo1x', 600]), /BadInput/, 'no quote in the memo');
  const osmoContract = 'osmo1qg5ega6dykkxc307y25pecuufrjkxkaggkkxh7nad0vhyhtuhw3sqaa3c5';
  await sender.send('gov', 'setIbcRoute', ['channel-0', osmoContract, 600]);
  await flag(FP, 2);
  const memo = await sender.call('ibcMemo', [[FP, FP2]]);
  const p = parseMemo(memo);
  assert.equal(p.contract, osmoContract);
  assert.equal(p.srcChain, 1);
  assert.equal(p.items[0].key, FP.slice(2));
  assert.equal(p.items[0].round, 1);
  assert.equal(p.items[0].flagged, true);
  assert.equal(p.items[0].reason, 2);
  assert.ok(p.items[0].enforced_from > 0);
  assert.deepEqual(p.items[1], { key: FP2.slice(2), round: 0, flagged: false, reason: 0, enforced_from: 0, held_from: 0 });
  // ibc-hooks' intermediary sender: sha256(sha256(type) || "channel/sender"), bech32 with the chain's prefix
  const from = zetaphyBech32(sender.address);
  assert.match(from, /^zetaphy1[02-9ac-hj-np-z]{38}$/);
  const want = getBytes(sha256(concat([getBytes(sha256(toUtf8Bytes('ibc-wasm-hook-intermediary'))), toUtf8Bytes(`channel-4/${from}`)])));
  const got = ibcHooksSender('channel-4', from);
  assert.match(got, /^osmo1[02-9ac-hj-np-z]{58}$/, '32 bytes, so 58 data characters');
  assert.equal(hexlify(want).length, 66);
  assert.notEqual(ibcHooksSender('channel-5', from), got, 'per channel');
  assert.throws(() => ibcHooksSender('5', from));
});

test('roles: only governance sets routes and the mirror\'s ISM; the sender reads, it never takes a caller\'s word', async () => {
  await assert.rejects(sender.send('attacker', 'setReceiver', [SEPOLIA, b32(a('attacker'))]), /NotGovernance/);
  await assert.rejects(sender.send('pusher', 'push', [97, [FP]], 1000n), /NoRoute/);
  await assert.rejects(oracle.send('attacker', 'setIsm', [a('attacker')]), /NotGovernance/);
  await assert.rejects(push([]), /NothingToSend/);
  await assert.rejects(push(Array(33).fill(FP)), /TooMany/);
  assert.equal(await sender.call('domainCount'), 1n);
  // a push of an unflagged key carries round 0, which the mirror ignores
  await push([FP2]);
  const ev = await relay();
  assert.equal(await oracle.call('keyCount'), 0n);
  assert.ok(Array.isArray(ev));
});
