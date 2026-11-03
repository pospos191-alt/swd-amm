// Saphan safety (Saphan PR 2): the escape hatch on the source chain and bonded challenges on ZETAPHY.
//   escape:     SaphanCheckpointer (ZETAPHY) -> heartbeat -> HyperlaneLockBoxV2; after ESCAPE_AFTER of silence the
//               lockbox stops locks and accepts an exit root signed by its ISM's validators; each address takes its
//               share (pro rata when short).
//   challenges: SaphanChallenges holds a transfer in the airlock; Neuro runners vote; upheld = veto + the attesting
//               lanes' bonds slashed (half challenger, half reserve); rejected = unhold + bond to the recipient.
// The route is the one of saphan.test.js (one EVM plays every chain; each chain has its own Mailbox).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { AbiCoder, encodeBytes32String, zeroPadValue, getCreateAddress, keccak256, getBytes, solidityPacked, id as keccakId } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain } from './helpers/evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';
import { exitTree, exitProof, exitDigest } from '../src/saphansafety.js';

const ZETAPHY = 77390;
const SEPOLIA = 11155111;
const CHAIN = 1n;
const Q = 600;
const DELAY = 3600;
const DAY = 86400;
const E = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const ROUTE_IN = encodeBytes32String('airlock');
const ROUTE_OUT = encodeBytes32String('out');
const AUDIT = ['https://audits.example/saphan.pdf', '0x' + 'a1'.repeat(32)];
const abi = AbiCoder.defaultAbiCoder();
const b32 = (x) => zeroPadValue(x, 32);
const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));
const HYP = validator(1);
const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));

let sk;
function safetyKit() {
  if (sk) return sk;
  const file = 'SafetyKit.sol';
  const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(new URL(`./helpers/${file}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  sk = Object.fromEntries(Object.entries(out.contracts[file]).map(([n, x]) => [n, { abi: x.abi, bytecode: '0x' + x.evm.bytecode.object }]));
  return sk;
}

let c, kit, zMailbox;
const a = (n) => c.acct[n].toString();
const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock')], bytecode: kit.KitMailbox.bytecode });
const withErrors = (name, ...more) => { const x = artifact(name); return { abi: [...x.abi, ...errorsOf(...more)], bytecode: x.bytecode }; };
const eth = (addr) => c.balance(Address.fromString(addr));

async function route() {
  const r = {};
  r.mailbox = await c.deployRaw(mailboxArt(), [SEPOLIA], 'gov');
  r.guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await r.guard.send('gov', 'createToken', ['ETH from Sepolia (bridged, testnet)', 'sepETH', 18]);
  r.token = await r.guard.call('token');
  r.airlock = await c.deploy('BridgeAirlock', [r.guard.address, ROUTE_IN, a('gov'), 2, Q], 'gov');
  r.hypIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
  r.lane = await c.deploy('HyperlaneLane', [r.airlock.address, a('gov'), zMailbox.address, SEPOLIA, '0x' + '00'.repeat(32), 0, ZERO, r.hypIsm.address], 'gov');
  r.ourIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [OURS.map((w) => w.address), 2], 'odeploy');
  const lbAt = getCreateAddress({ from: a('odeploy'), nonce: await c.nonce('odeploy') });
  r.outbox = await c.deployRaw(withErrors('HyperlaneOutbox', 'BridgeGuard'), [r.guard.address, ROUTE_OUT, zMailbox.address, SEPOLIA, CHAIN, b32(lbAt), ZERO], 'gov');
  r.lockbox = await c.deploy('HyperlaneLockBoxV2', [r.mailbox.address, ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
    r.ourIsm.address, a('gov'), a('guardian'), 50n * E, DELAY], 'odeploy');
  await r.lane.send('gov', 'setConfig', [zMailbox.address, SEPOLIA, b32(r.lockbox.address), CHAIN, r.lockbox.address]);
  await r.airlock.send('gov', 'setLane', [r.lane.address, true]);
  await r.airlock.send('gov', 'setLane', [a('lane2'), true]);
  await r.guard.send('gov', 'setAudit', AUDIT);
  await r.guard.send('gov', 'setRoute', [ROUTE_IN, r.airlock.address, 100n * E, true]);
  await r.guard.send('gov', 'setOutboundRoute', [ROUTE_OUT, r.outbox.address, 100n * E, true]);
  r.cp = await c.deployRaw(withErrors('SaphanCheckpointer'), [zMailbox.address, SEPOLIA, b32(r.lockbox.address)], 'gov');
  return r;
}
const lastMessage = (mb) => mb.call('lastMessage');
async function relayIn(r) { const m = await lastMessage(r.mailbox); return zMailbox.send('relayer', 'process', [messageIdMetadata(m, [HYP]), m]); }
async function relayOut(r, signers = OURS.slice(0, 2)) { const m = await lastMessage(zMailbox); return r.mailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]); }
async function lock(r, who, amount) {
  const fee = await r.lockbox.call('quoteLock', [a(who), amount]);
  await r.lockbox.send(who, 'lock', [a(who), amount], amount + fee);
  return (await r.lockbox.call('nonce')) - 1n;
}
const sign = (digest, signers) => signers.map((w) => w.signMessageSync(getBytes(digest)));

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'carol', 'attacker', 'relayer', 'lane2', 'odeploy', 'r1', 'r2', 'r3', 'op1']);
  kit = kitArtifacts();
  zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
});

test('heartbeat: ZETAPHY\'s checkpointer reaches the lockbox through our validators; each beat once, in order; only the named one', async () => {
  const r = await route();
  assert.equal(await r.lockbox.call('escaping'), false, 'no checkpointer: no escape');
  await assert.rejects(r.lockbox.send('attacker', 'setCheckpointer', [b32(r.cp.address)]), /NotGovernance/);
  await r.lockbox.send('gov', 'setCheckpointer', [b32(r.cp.address)]);
  await r.cp.send('relayer', 'beat', []);
  await assert.rejects(r.cp.send('relayer', 'beat', []), /TooSoon/);
  await relayOut(r);
  assert.equal(await r.lockbox.call('lastBeat'), 1n);
  // a checkpointer nobody named is just a wrong sender
  const other = await c.deployRaw(withErrors('SaphanCheckpointer'), [zMailbox.address, SEPOLIA, b32(r.lockbox.address)], 'attacker');
  await other.send('attacker', 'beat', []);
  await assert.rejects(relayOut(r), /WrongSender/);
  // the body must name this checkpointer and ZETAPHY's chain (a release body from it is refused)
  c.advance(3600);
  await r.cp.send('relayer', 'beat', []);
  await relayOut(r);
  assert.equal(await r.lockbox.call('lastBeat'), 2n);
  // Hyperlane's own validator cannot sign it
  c.advance(3600);
  await r.cp.send('relayer', 'beat', []);
  await assert.rejects(relayOut(r, [HYP]));
});

test('escape: 14 days without ZETAPHY stops locks; a validator-signed exit root lets each address take its share once', async () => {
  const r = await route();
  await r.lockbox.send('gov', 'setCheckpointer', [b32(r.cp.address)]);
  await lock(r, 'alice', 3n * E);
  await lock(r, 'bob', 1n * E);
  c.advance(14 * DAY + 1);
  assert.equal(await r.lockbox.call('escaping'), true);
  await assert.rejects(lock(r, 'carol', E), /Escaping/);
  await assert.rejects(r.lockbox.send('gov', 'setCheckpointer', [b32(a('gov'))]), /Escaping/, 'governance cannot call an escape off');
  // the exit root: what ZETAPHY owed each address at its last block (here: alice 3, bob 1)
  const owed = [[a('alice'), 3n * E], [a('bob'), E]];
  const { root, total } = exitTree(owed);
  const d = await r.lockbox.call('exitDigest', [root, total]);
  assert.equal(d, exitDigest({ chainId: CHAIN, lockbox: r.lockbox.address, root, total, lastHeard: await r.lockbox.call('lastHeard') }));
  await assert.rejects(r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, OURS.slice(0, 1))]), /BadSignatures/, 'below threshold');
  await assert.rejects(r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, [OURS[1], OURS[0]])]), /BadSignatures/, 'signers out of order');
  await assert.rejects(r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, [OURS[0], OURS[0]])]), /BadSignatures/, 'a signer twice');
  await assert.rejects(r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, [HYP, OURS[0]].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1)))]), /BadSignatures/, 'not our validator');
  await r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, OURS.slice(0, 2))]);
  await assert.rejects(r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, OURS.slice(0, 2))]), /ExitDone/);
  const before = await c.balance('alice');
  await assert.rejects(r.lockbox.send('alice', 'escape', [4n * E, exitProof(owed, a('alice'))]), /BadProof/, 'more than owed');
  await r.lockbox.send('alice', 'escape', [3n * E, exitProof(owed, a('alice'))]);
  assert.equal((await c.balance('alice')) - before, 3n * E);
  await assert.rejects(r.lockbox.send('alice', 'escape', [3n * E, exitProof(owed, a('alice'))]), /AlreadyClaimed/);
  await assert.rejects(r.lockbox.send('attacker', 'escape', [E, exitProof(owed, a('bob'))]), /BadProof/, 'bob\'s line is bob\'s');
  await r.lockbox.send('bob', 'escape', [E, exitProof(owed, a('bob'))]);
  assert.equal(await r.lockbox.call('locked'), 0n);
  // after the root nothing from ZETAPHY counts any more
  await r.cp.send('relayer', 'beat', []);
  await assert.rejects(relayOut(r), /ExitDone/);
});

test('escape is pro rata when the root owes more than the backing; a heartbeat before the root ends escaping', async () => {
  const r = await route();
  await r.lockbox.send('gov', 'setCheckpointer', [b32(r.cp.address)]);
  await lock(r, 'alice', 2n * E);
  c.advance(14 * DAY + 1);
  // ZETAPHY comes back in time: the escape is over, locks work again
  await r.cp.send('relayer', 'beat', []);
  await relayOut(r);
  assert.equal(await r.lockbox.call('escaping'), false);
  await lock(r, 'bob', E);
  c.advance(14 * DAY + 1);
  const owed = [[a('alice'), 4n * E], [a('bob'), 2n * E]]; // 6 owed, 3 held
  const { root, total } = exitTree(owed);
  const d = await r.lockbox.call('exitDigest', [root, total]);
  await r.lockbox.send('relayer', 'submitExitRoot', [root, total, sign(d, OURS.slice(1, 3))]);
  assert.equal(await r.lockbox.call('exitPool'), 3n * E);
  const ev = await r.lockbox.send('alice', 'escape', [4n * E, exitProof(owed, a('alice'))]);
  assert.equal(ev.find((e) => e?.name === 'Escaped').args.paid, 2n * E, 'half: 3 held for 6 owed');
  await r.lockbox.send('bob', 'escape', [2n * E, exitProof(owed, a('bob'))]);
  assert.equal(await r.lockbox.call('locked'), 0n);
  assert.equal(await eth(r.lockbox.address), 0n);
});

// ---------------------------------------------------------------- challenges

async function challengeSetup() {
  const r = await route();
  r.runners = await c.deployRaw(safetyKit().KitRunners, [], 'gov');
  for (const w of ['r1', 'r2', 'r3']) await r.runners.send('gov', 'set', [a(w), true, 5, 0]);
  r.ch = await c.deployRaw(withErrors('SaphanChallenges', 'BridgeAirlock'), [r.airlock.address, r.runners.address, a('gov'), E / 10n, 2 * DAY, 2, 3], 'gov');
  await r.airlock.send('gov', 'setChallenger', [r.ch.address]);
  await r.airlock.send('gov', 'setVetoer', [r.ch.address, true]);
  // the operators bond their lanes: the HyperlaneLane's and lane2
  await r.ch.send('op1', 'bondLane', [r.lane.address], 2n * E);
  await r.ch.send('lane2', 'bondLane', [a('lane2')], 3n * E);
  return r;
}
async function attested(r, who, amount) {
  const n = await lock(r, who, amount);
  await relayIn(r);
  const t = [CHAIN, r.lockbox.address, n, a(who), a(who), amount];
  await r.airlock.send('lane2', 'attest', t);
  return t;
}

test('challenge upheld: the transfer never mints, the lanes that vouched lose their bonds (half to the challenger)', async () => {
  const r = await challengeSetup();
  const t = await attested(r, 'alice', E);
  await assert.rejects(r.ch.send('carol', 'open', [...t, 'no such lock'], E), /Bond/);
  const ev = await r.ch.send('carol', 'open', [...t, 'no such lock on Sepolia'], E / 10n);
  const id = ev.find((e) => e?.name === 'Opened').args.id;
  await assert.rejects(r.ch.send('attacker', 'open', [...t, 'again'], E / 10n), /Twice/);
  c.advance(Q);
  await assert.rejects(r.airlock.send('relayer', 'release', t), /Blocked/, 'held while the challenge is open');
  await assert.rejects(r.ch.send('attacker', 'vote', [id, true]), /NotRunner/);
  await assert.rejects(r.ch.send('relayer', 'resolve', [id]), /TooEarly/);
  await r.ch.send('r1', 'vote', [id, true]);
  await assert.rejects(r.ch.send('r1', 'vote', [id, true]), /Twice/);
  await r.ch.send('r2', 'vote', [id, true]);
  const res = await r.ch.send('relayer', 'resolve', [id]);
  assert.equal(res.find((e) => e?.name === 'Resolved').args.slashed, 5n * E);
  await assert.rejects(r.airlock.send('relayer', 'release', t), /Blocked/, 'vetoed for good');
  assert.equal(await r.ch.call('credit', [a('carol')]), E / 10n + 5n * E / 2n);
  assert.equal(await r.ch.call('reserve'), 5n * E / 2n);
  assert.equal((await r.ch.call('laneBonds', [r.lane.address])).amount, 0n);
  const before = await c.balance('carol');
  await r.ch.send('carol', 'claim', []);
  assert.ok((await c.balance('carol')) - before > 2n * E);
  await assert.rejects(r.ch.send('attacker', 'payReserve', [a('attacker'), E]), /NotGovernance/);
  await r.ch.send('gov', 'payReserve', [a('bob'), E]);
  assert.equal(await r.ch.call('credit', [a('bob')]), E);
});

test('challenge rejected (or no quorum by the deadline): the hold is lifted and the bond pays the delayed recipient', async () => {
  const r = await challengeSetup();
  const t = await attested(r, 'alice', E);
  const id = (await r.ch.send('attacker', 'open', [...t, 'grief'], E / 10n)).find((e) => e?.name === 'Opened').args.id;
  await r.ch.send('r1', 'vote', [id, false]);
  await r.ch.send('r3', 'vote', [id, false]);
  await r.ch.send('relayer', 'resolve', [id]);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);               // minted
  assert.equal(await r.ch.call('credit', [a('alice')]), E / 10n);
  assert.equal((await r.ch.call('laneBonds', [a('lane2')])).amount, 3n * E, 'no slash');
  // a second transfer: one uphold vote only, the deadline passes
  const t2 = await attested(r, 'bob', E);
  const id2 = (await r.ch.send('attacker', 'open', [...t2, 'grief'], E / 10n)).find((e) => e?.name === 'Opened').args.id;
  await r.ch.send('r1', 'vote', [id2, true]);
  await assert.rejects(r.ch.send('relayer', 'resolve', [id2]), /TooEarly/);
  c.advance(2 * DAY + 1);
  await assert.rejects(r.ch.send('r2', 'vote', [id2, true]), /TooLate/);
  await r.ch.send('relayer', 'resolve', [id2]);
  await r.airlock.send('relayer', 'release', t2);
  assert.equal(await r.ch.call('credit', [a('bob')]), E / 10n);
});

test('the challenger can only delay: no hold after release, none without a challenge contract; lane bonds leave only after the delay', async () => {
  const r = await challengeSetup();
  const t = await attested(r, 'alice', E);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
  await assert.rejects(r.ch.send('carol', 'open', [...t, 'late'], E / 10n), /Blocked/);
  await assert.rejects(r.ch.send('carol', 'open', [CHAIN, r.lockbox.address, 99n, a('carol'), a('carol'), E, 'never attested'], E / 10n), /Blocked/);
  await assert.rejects(r.airlock.send('attacker', 'hold', [await r.airlock.call('transferId', t)]), /NotChallenger/);
  await assert.rejects(r.ch.send('attacker', 'bondLane', [a('attacker')], E), /NotLane/);
  await assert.rejects(r.ch.send('attacker', 'bondLane', [r.lane.address], E), /NotOperator/);
  await assert.rejects(r.ch.send('op1', 'unbond', [r.lane.address]), /TooEarly/);
  await r.ch.send('op1', 'requestUnbond', [r.lane.address]);
  c.advance(14 * DAY - 10);
  await assert.rejects(r.ch.send('op1', 'unbond', [r.lane.address]), /TooEarly/);
  c.advance(20);
  await r.ch.send('op1', 'unbond', [r.lane.address]);
  assert.equal(await r.ch.call('credit', [a('op1')]), 2n * E);
  // parameters do not change under an open challenge
  const t2 = await attested(r, 'bob', E);
  await r.ch.send('carol', 'open', [...t2, 'x'], E / 10n);
  await assert.rejects(r.ch.send('gov', 'setParams', [E, DAY, 1, 0]), /WrongState/);
});
