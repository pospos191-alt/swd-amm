// ZETAPHY Saphan, EVM routes v2: one stack per source chain, both directions.
//   source chain: HyperlaneLockBoxV2 (lock -> ZETAPHY; release <- ZETAPHY, behind OUR validators' ISM)
//   ZETAPHY:      HyperlaneLane -> BridgeAirlock -> BridgeGuard (mint), HyperlaneOutbox -> BridgeGuard (burn, outbound-only route)
// Messages go through a test Mailbox that checks a message-id multisig ISM with checkpoints
// signed here (helpers/HyperlaneKit.sol, helpers/hyperlanekit.js), as a real Mailbox would.
// One EVM plays every chain (chain id 1); each chain has its own Mailbox and Hyperlane domain.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, encodeBytes32String, zeroPadValue, getCreateAddress, keccak256, solidityPacked } from 'ethers';
import { Address } from '@ethereumjs/util';
import { createChain } from './helpers/evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';

const ZETAPHY = 77390;
const SEPOLIA = 11155111;
const BASE = 84532;
const CHAIN = 1n; // the test EVM's chain id: every "chain" here
const Q = 600;
const DELAY = 3600;
const E = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const ROUTE_IN = encodeBytes32String('airlock');
const ROUTE_OUT = encodeBytes32String('out');
const AUDIT = ['https://audits.example/saphan.pdf', '0x' + 'a1'.repeat(32)];
const abi = AbiCoder.defaultAbiCoder();
const b32 = (x) => zeroPadValue(x, 32);
const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const TOKEN = new Interface(artifact('BridgedToken').abi);
const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));

const HYP = validator(1);                       // Hyperlane's validator for the source chains (inbound)
const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1)); // our validators for origin ZETAPHY

let c, kit, zMailbox;
const a = (n) => c.acct[n].toString();

/** A Mailbox whose errors decode the recipients' custom errors too (they bubble up through process). */
const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock')], bytecode: kit.KitMailbox.bytecode });

/** The outbox, with BridgeGuard's errors (they bubble up through send). */
const outboxArt = () => { const x = artifact('HyperlaneOutbox'); return { abi: [...x.abi, ...errorsOf('BridgeGuard')], bytecode: x.bytecode }; };
const ethOf = (addr) => c.balance(Address.fromString(addr));
const RELEASE = ['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address'];
/** A Hyperlane message (version 3) as a Mailbox on `origin` would dispatch it: what a relayer hands process(). */
const message = ({ nonce = 9999, origin = ZETAPHY, sender, destination, recipient, body }) =>
  solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'], [3, nonce, origin, b32(sender), destination, b32(recipient), body]);

/** One source chain's whole route: its Mailbox and lockbox, and its own guard/token/airlock/lane/outbox on ZETAPHY. */
async function route(domain, { ours = OURS, threshold = 2, dailyLimit = 5n * E, delay = DELAY, deployer = 'odeploy' } = {}) {
  const r = { domain };
  r.mailbox = await c.deployRaw(mailboxArt(), [domain], 'gov');
  r.guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await r.guard.send('gov', 'createToken', [`ETH from ${domain} (bridged, testnet)`, `ETH${domain % 1000}`, 18]);
  r.token = await r.guard.call('token');
  r.airlock = await c.deploy('BridgeAirlock', [r.guard.address, ROUTE_IN, a('gov'), 2, Q], 'gov');
  r.hypIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
  r.lane = await c.deploy('HyperlaneLane', [r.airlock.address, a('gov'), zMailbox.address, domain, '0x' + '00'.repeat(32), 0, ZERO, r.hypIsm.address], 'gov');
  // Our ISM for origin ZETAPHY on the source chain, then the lockbox at an address fixed in advance.
  r.ourIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [ours.map((w) => w.address), threshold], deployer);
  const lbAt = getCreateAddress({ from: a(deployer), nonce: await c.nonce(deployer) });
  r.outbox = await c.deployRaw(outboxArt(), [r.guard.address, ROUTE_OUT, zMailbox.address, domain, CHAIN, b32(lbAt), ZERO], 'gov');
  r.lockbox = await c.deploy('HyperlaneLockBoxV2', [r.mailbox.address, ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
    r.ourIsm.address, a('gov'), a('guardian'), dailyLimit, delay], deployer);
  assert.equal(r.lockbox.address.toLowerCase(), lbAt.toLowerCase());
  await r.lane.send('gov', 'setConfig', [zMailbox.address, domain, b32(r.lockbox.address), CHAIN, r.lockbox.address]);
  await r.airlock.send('gov', 'setLane', [r.lane.address, true]);
  await r.airlock.send('gov', 'setLane', [a('lane2'), true]); // a second, independent lane (a key here; NeuroLane on the testnet)
  await r.guard.send('gov', 'setAudit', AUDIT);
  await r.guard.send('gov', 'setGuardian', [a('guardian'), true]);
  await r.guard.send('gov', 'setRoute', [ROUTE_IN, r.airlock.address, 100n * E, true]);
  await r.guard.send('gov', 'setOutboundRoute', [ROUTE_OUT, r.outbox.address, 100n * E, true]);
  return r;
}

const lastMessage = (mb) => mb.call('lastMessage');
/** The relayer, source -> ZETAPHY: the lock's message, signed by Hyperlane's validator for that source. */
async function relayIn(r, signers = [HYP]) {
  const m = await lastMessage(r.mailbox);
  return zMailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]);
}
/** The relayer, ZETAPHY -> source: the outbox's message, signed by our validators for origin ZETAPHY. */
async function relayOut(r, signers = OURS.slice(0, 2), m = null) {
  m ??= await lastMessage(zMailbox);
  return r.mailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]);
}
const bal = (r, who) => c.callAt(r.token, TOKEN, 'balanceOf', [a(who)]);

/** alice locks on the source; both lanes attest; after the quarantine the airlock mints on ZETAPHY. */
async function bridgeIn(r, amount, who = 'alice') {
  const fee = await r.lockbox.call('quoteLock', [a(who), amount]);
  const ev = await r.lockbox.send(who, 'lock', [a(who), amount], amount + fee);
  const n = ev.find((e) => e?.name === 'Locked').args.nonce;
  await relayIn(r);
  const t = [CHAIN, r.lockbox.address, n, a(who), a(who), amount];
  assert.equal(await r.lockbox.call('transferIds', [n]), await r.airlock.call('transferId', t));   // what the relayer gate asks the lane
  assert.equal(await r.lane.call('delivered', [await r.lockbox.call('transferIds', [n])]), true);
  await r.airlock.send('lane2', 'attest', t);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
}

/** The queued release of the last message the lockbox recorded. */
async function lastRelease(r) {
  const m = await lastMessage(zMailbox);
  return keccak256('0x' + m.slice(2 + 77 * 2));
}

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'attacker', 'relayer', 'lane2', 'odeploy', 'odeploy2']);
  kit = kitArtifacts();
  zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
});

test('round trip: lock on the source, mint on ZETAPHY, burn through the outbox, release on the source after the delay', async () => {
  const r = await route(SEPOLIA);
  const before = await c.balance('bob');
  await bridgeIn(r, 2n * E);
  assert.equal(await bal(r, 'alice'), 2n * E);
  assert.equal(await r.lockbox.call('locked'), 2n * E);
  // way back: alice sends 1.5 to bob on the source chain
  const ev = await r.outbox.send('alice', 'send', [a('bob'), 3n * E / 2n]);
  assert.equal(ev.find((e) => e?.name === 'Sent').args.amount, 3n * E / 2n);
  assert.equal(await bal(r, 'alice'), E / 2n);
  assert.equal(await c.callAt(r.token, TOKEN, 'totalSupply'), E / 2n);
  await relayOut(r);
  assert.equal(await r.lockbox.call('received'), 1n);
  const id = await lastRelease(r);
  const q = await r.lockbox.call('releases', [id]);
  assert.equal(q.to.toLowerCase(), a('bob').toLowerCase());
  assert.equal(q.amount, 3n * E / 2n);
  await assert.rejects(r.lockbox.send('relayer', 'claim', [id]), /NotReady/);
  c.advance(DELAY);
  await r.lockbox.send('relayer', 'claim', [id]);                                // anyone claims; bob is paid
  assert.equal((await c.balance('bob')) - before, 3n * E / 2n);
  assert.equal(await r.lockbox.call('locked'), E / 2n);
  await assert.rejects(r.lockbox.send('relayer', 'claim', [id]), /AlreadyClaimed/);
  await assert.rejects(relayOut(r));                                             // the Mailbox delivers a message once
});

test('ISM: our validators must sign (threshold, order, the right message); Hyperlane\'s validator cannot release', async () => {
  const r = await route(SEPOLIA);
  await bridgeIn(r, 2n * E);
  await r.outbox.send('alice', 'send', [a('bob'), E]);
  const m = await lastMessage(zMailbox);
  const tryWith = (signers, opts) => r.mailbox.send('relayer', 'process', [messageIdMetadata(m, signers, opts), m]);
  await assert.rejects(tryWith([OURS[0]]));                     // 1 of a 2-of-3
  await assert.rejects(tryWith([OURS[1], OURS[0]]));            // not in the ISM's validator order
  await assert.rejects(tryWith([HYP, OURS[0]]));                // a stranger
  await assert.rejects(tryWith([OURS[0], OURS[0]]));            // one validator twice
  await assert.rejects(tryWith([HYP]));                         // Hyperlane's own validator: not ours
  // signatures over another message do not carry over
  const other = m.slice(0, -2) + (m.slice(-2) === '00' ? '01' : '00');
  await assert.rejects(r.mailbox.send('relayer', 'process', [messageIdMetadata(other, OURS.slice(0, 2)), m]));
  assert.equal(await r.lockbox.call('received'), 0n);
  await tryWith([OURS[0], OURS[2]]);                            // any 2 of the 3, in order
  assert.equal(await r.lockbox.call('received'), 1n);
  // an ISM that refuses everything (governance's choice) stops every release; zero is never accepted
  const refusing = await c.deployRaw(kit.KitRefusingIsm, [], 'gov');
  await assert.rejects(r.lockbox.send('attacker', 'setInterchainSecurityModule', [refusing.address]), /NotGovernance/);
  await assert.rejects(r.lockbox.send('gov', 'setInterchainSecurityModule', [ZERO]));
  await r.lockbox.send('gov', 'setInterchainSecurityModule', [refusing.address]);
  await r.outbox.send('alice', 'send', [a('bob'), E / 2n]);
  await assert.rejects(relayOut(r));
  assert.equal(await r.lockbox.call('received'), 1n);
  await assert.rejects(c.deploy('HyperlaneLockBoxV2', [r.mailbox.address, ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
    ZERO, a('gov'), a('guardian'), E, DELAY], 'gov'));         // no ISM: refused at deploy
});

test('handle: only the Mailbox, origin ZETAPHY, the route\'s outbox, a body naming this chain and lockbox; each message once', async () => {
  const r = await route(SEPOLIA);
  // A key standing in as the Mailbox shows each reason (the real Mailbox ran the ISM before).
  const lb = await c.deploy('HyperlaneLockBoxV2', [a('relayer'), ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
    r.ourIsm.address, a('gov'), a('guardian'), 10n * E, 0], 'gov');
  const body = (o = {}) => abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address'],
    [o.src ?? CHAIN, o.srcContract ?? r.outbox.address, o.n ?? 0n, a('alice'), o.to ?? a('bob'), o.amount ?? E, o.dst ?? CHAIN, o.dstContract ?? lb.address]);
  const out = b32(r.outbox.address);
  await assert.rejects(lb.send('attacker', 'handle', [ZETAPHY, out, body()]), /NotMailbox/);
  for (const [args, re] of [
    [[SEPOLIA, out, body()], /WrongOrigin/],
    [[BASE, out, body()], /WrongOrigin/],
    [[ZETAPHY, b32(a('attacker')), body()], /WrongSender/],
    [[ZETAPHY, b32(r.lane.address), body()], /WrongSender/],
    [[ZETAPHY, out, body({ srcContract: a('attacker') })], /WrongSource/],
    [[ZETAPHY, out, body({ src: 77390n })], /WrongSource/],
    [[ZETAPHY, out, body({ dst: 84532n })], /WrongDestination/],
    [[ZETAPHY, out, body({ dstContract: r.lockbox.address })], /WrongDestination/],   // a message meant for another lockbox
    [[ZETAPHY, out, body({ to: ZERO })], /BadBody/],
    [[ZETAPHY, out, body({ amount: 0n })], /BadBody/],
    [[ZETAPHY, out, body() + '00'], /BadBody/],
  ]) await assert.rejects(lb.send('relayer', 'handle', args), re);
  await assert.rejects(lb.send('relayer', 'handle', [ZETAPHY, out, body()], 1n), /NoValue/);
  await lb.send('relayer', 'handle', [ZETAPHY, out, body()]);
  await assert.rejects(lb.send('relayer', 'handle', [ZETAPHY, out, body()]), /Replay/);
  await lb.send('relayer', 'handle', [ZETAPHY, out, body({ n: 1n })]);                 // the next nonce is another release
  assert.equal(await lb.call('received'), 2n);
});

test('two source chains are isolated: a message, a token or a route of chain A never releases what chain B locked', async () => {
  const A = await route(SEPOLIA);
  const B = await route(BASE, { deployer: 'odeploy2' });
  await bridgeIn(A, 3n * E, 'alice');
  await bridgeIn(B, 2n * E, 'bob');
  // inbound: B's lock re-addressed to A's lane (signed by B's source validator) is refused by A's lane (origin)
  await B.lockbox.send('bob', 'lock', [a('bob'), E], E);
  const lockB = await lastMessage(B.mailbox);
  const toLaneA = message({ nonce: 0, origin: BASE, sender: B.lockbox.address, destination: ZETAPHY, recipient: A.lane.address, body: '0x' + lockB.slice(2 + 77 * 2) });
  await assert.rejects(zMailbox.send('relayer', 'process', [messageIdMetadata(toLaneA, [HYP]), toLaneA]), /WrongOrigin/);
  const asA = message({ nonce: 0, origin: SEPOLIA, sender: B.lockbox.address, destination: ZETAPHY, recipient: A.lane.address, body: '0x' + lockB.slice(2 + 77 * 2) });
  await assert.rejects(zMailbox.send('relayer', 'process', [messageIdMetadata(asA, [HYP]), asA]), /WrongSender/);
  // A's token is not B's: alice (A tokens only) cannot burn through B's outbox, nor A's outbox burn B's token
  await assert.rejects(B.outbox.send('alice', 'send', [a('alice'), E]));   // guard B burns token B: alice has none
  assert.equal(await bal(A, 'alice'), 3n * E);
  await assert.rejects(B.guard.send('attacker', 'outbound', [ROUTE_OUT, a('bob'), E]), /NotAdapter/);
  // A's outbox message, signed by our validators, delivered toward B's lockbox: wrong sender for B
  await A.outbox.send('alice', 'send', [a('alice'), E]);
  const m = await lastMessage(zMailbox);
  // the message names A's lockbox as recipient: B's Mailbox would deliver it to A's lockbox, whose own origin
  // is fine but whose Mailbox is not B's (NotMailbox); re-addressed to B, the signatures no longer match
  await assert.rejects(B.mailbox.send('relayer', 'process', [messageIdMetadata(m, OURS.slice(0, 2)), m]));
  const toB = message({ sender: A.outbox.address, destination: BASE, recipient: B.lockbox.address, body: '0x' + m.slice(2 + 77 * 2) });
  await assert.rejects(B.mailbox.send('relayer', 'process', [messageIdMetadata(toB, OURS.slice(0, 2)), toB]), /WrongSender/);
  // an attacker's own ZETAPHY contract (here a key) dispatches a well-formed release to B's lockbox: validly signed, refused
  const forged = abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address'],
    [CHAIN, B.outbox.address, 0n, a('attacker'), a('attacker'), 2n * E, CHAIN, B.lockbox.address]);
  await zMailbox.send('attacker', 'dispatch(uint32,bytes32,bytes)', [BASE, b32(B.lockbox.address), forged]);
  await assert.rejects(relayOut(B), /WrongSender/);
  assert.equal(await B.lockbox.call('received'), 0n);
  // A's real release pays out of A's backing only
  await relayOut(A, OURS.slice(0, 2), m);
  c.advance(DELAY);
  await A.lockbox.send('relayer', 'claim', [keccak256('0x' + m.slice(2 + 77 * 2))]);
  assert.equal(await A.lockbox.call('locked'), 2n * E);
  assert.equal(await B.lockbox.call('locked'), 3n * E);              // bob's 2 + 1, untouched
  assert.equal(await ethOf(B.lockbox.address), 3n * E);
});

test('backing: even with our validators compromised, a release never takes more than this lockbox\'s own locks', async () => {
  const A = await route(SEPOLIA, { dailyLimit: 100n * E, delay: 0 });
  const B = await route(BASE, { dailyLimit: 100n * E, delay: 0, deployer: 'odeploy2' });
  await bridgeIn(A, 5n * E);
  await bridgeIn(B, E);
  // Our validators sign anything (compromised): a "release" from B's outbox for 3 ETH, which nobody burned.
  const forge = (amount, nonce) => message({ sender: B.outbox.address, destination: BASE, recipient: B.lockbox.address,
    body: abi.encode(RELEASE, [CHAIN, B.outbox.address, nonce, a('attacker'), a('attacker'), amount, CHAIN, B.lockbox.address]) });
  const m = forge(3n * E, 70n);
  await B.mailbox.send('relayer', 'process', [messageIdMetadata(m, OURS.slice(0, 2)), m]);
  const id = keccak256(abi.encode(RELEASE, [CHAIN, B.outbox.address, 70n, a('attacker'), a('attacker'), 3n * E, CHAIN, B.lockbox.address]));
  await assert.rejects(B.lockbox.send('relayer', 'claim', [id]), /OverBacking/);   // B holds 1 ETH of locks; A's 5 are on A's lockbox
  // the guardian vetoes it; B's real backing is still there
  await B.lockbox.send('guardian', 'veto', [id]);
  assert.equal(await B.lockbox.call('locked'), E);
  assert.equal(await ethOf(A.lockbox.address), 5n * E);
});

test('limits: the lockbox\'s daily release limit and the guard\'s outbound route limit', async () => {
  const r = await route(SEPOLIA, { dailyLimit: 2n * E });
  await bridgeIn(r, 5n * E);
  for (const v of [E + E / 2n, E]) { await r.outbox.send('alice', 'send', [a('bob'), v]); await relayOut(r); }
  c.advance(DELAY);
  const m1 = keccak256(abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address'],
    [CHAIN, r.outbox.address, 0n, a('alice'), a('bob'), E + E / 2n, CHAIN, r.lockbox.address]));
  const m2 = await lastRelease(r);
  await r.lockbox.send('relayer', 'claim', [m1]);
  assert.equal(await r.lockbox.call('remainingToday'), E / 2n);
  await assert.rejects(r.lockbox.send('relayer', 'claim', [m2]), /OverLimit/);        // waits for tomorrow
  c.advance(86400);
  await r.lockbox.send('relayer', 'claim', [m2]);
  // the guard's outbound limit: a route of 1 per day
  await r.guard.send('gov', 'setOutboundRoute', [ROUTE_OUT, r.outbox.address, E, true]);
  await assert.rejects(r.outbox.send('alice', 'send', [a('bob'), E + 1n]), /OverLimit/);
  await r.outbox.send('alice', 'send', [a('bob'), E]);
  // limits: guardians only lower, governance raises
  await assert.rejects(r.lockbox.send('attacker', 'lowerDailyLimit', [0n]), /NotGuardian/);
  await assert.rejects(r.lockbox.send('guardian', 'lowerDailyLimit', [3n * E]));
  await r.lockbox.send('guardian', 'lowerDailyLimit', [E]);
  await assert.rejects(r.lockbox.send('guardian', 'setDailyLimit', [9n * E]), /NotGovernance/);
  await r.lockbox.send('gov', 'setDailyLimit', [9n * E]);
  await assert.rejects(r.lockbox.send('guardian', 'raiseReleaseDelay', [DELAY]));
  await r.lockbox.send('guardian', 'raiseReleaseDelay', [2 * DELAY]);
  await assert.rejects(r.lockbox.send('guardian', 'raiseReleaseDelay', [31 * 86400]));
  await assert.rejects(r.lockbox.send('guardian', 'setReleaseDelay', [0]), /NotGovernance/);
});

test('pause and veto: guardians stop locks and payouts at once; messages are still recorded; only governance resumes', async () => {
  const r = await route(SEPOLIA);
  await bridgeIn(r, 3n * E);
  await r.outbox.send('alice', 'send', [a('bob'), E]);
  await assert.rejects(r.lockbox.send('attacker', 'pause'), /NotGuardian/);
  await r.lockbox.send('guardian', 'pause');
  await assert.rejects(r.lockbox.send('alice', 'lock', [a('alice'), E], E), /IsPaused/);
  await relayOut(r);                                                 // recorded while paused
  const id = await lastRelease(r);
  c.advance(DELAY);
  await assert.rejects(r.lockbox.send('relayer', 'claim', [id]), /IsPaused/);
  await assert.rejects(r.lockbox.send('guardian', 'unpause'), /NotGovernance/);
  await r.lockbox.send('gov', 'unpause');
  await r.lockbox.send('guardian', 'veto', [id]);
  await assert.rejects(r.lockbox.send('relayer', 'claim', [id]), /IsVetoed/);
  await assert.rejects(r.lockbox.send('guardian', 'liftVeto', [id]), /NotGovernance/);
  await assert.rejects(r.lockbox.send('guardian', 'veto', [keccak256('0x01')]), /NoRelease/);
  await r.lockbox.send('gov', 'liftVeto', [id]);
  await r.lockbox.send('relayer', 'claim', [id]);
  await assert.rejects(r.lockbox.send('guardian', 'veto', [id]), /AlreadyClaimed/);
  // the ZETAPHY side: a paused guard or a disabled outbound route burns nothing
  await r.guard.send('guardian', 'pause');
  await assert.rejects(r.outbox.send('alice', 'send', [a('bob'), E]), /BridgePaused/);
  await r.guard.send('gov', 'unpause');
  await r.guard.send('guardian', 'disableRoute', [ROUTE_OUT]);
  await assert.rejects(r.outbox.send('alice', 'send', [a('bob'), E]), /NotAdapter/);
  assert.equal(await bal(r, 'alice'), 2n * E);
  // roles
  await assert.rejects(r.lockbox.send('guardian', 'setGuardian', [a('attacker'), true]), /NotGovernance/);
  await assert.rejects(r.lockbox.send('attacker', 'setGovernance', [a('attacker')]), /NotGovernance/);
  await r.lockbox.send('gov', 'setGovernance', [a('bob')]);
  await assert.rejects(r.lockbox.send('gov', 'unpause'), /NotGovernance/);
});

test('a payout to a receiver that refuses ETH fails whole and stays claimable', async () => {
  const r = await route(SEPOLIA, { delay: 0 });
  await bridgeIn(r, 2n * E);
  const sink = await c.deployRaw(kitArtifacts().KitRefusingReceiver, [], 'gov');
  await r.outbox.send('alice', 'send', [sink.address, E]);
  await relayOut(r);
  const id = await lastRelease(r);
  await assert.rejects(r.lockbox.send('relayer', 'claim', [id]), /PayFailed/);
  assert.equal((await r.lockbox.call('releases', [id])).claimed, false);
  assert.equal(await r.lockbox.call('locked'), 2n * E);
});

test('lock: amount + the exact Mailbox fee (the rest comes back), the same body as v1 for the HyperlaneLane', async () => {
  const r = await route(SEPOLIA);
  await r.mailbox.send('gov', 'setFee', [7n]);
  assert.equal(await r.lockbox.call('quoteLock', [a('alice'), 100n]), 7n);
  await assert.rejects(r.lockbox.send('alice', 'lock', [a('alice'), 100n], 106n), /Fee/);
  const before = await c.balance('alice');
  const ev = await r.lockbox.send('alice', 'lock', [a('alice'), 100n], 1000n);
  assert.equal(before - (await c.balance('alice')), 107n);            // 893 back
  assert.equal(await ethOf(r.lockbox.address), 100n);
  assert.equal(ev.find((e) => e?.name === 'Locked').args.amount, 100n);
  assert.equal(await r.lockbox.call('body', [0n, a('alice'), a('alice'), 100n]),
    abi.encode(['uint256', 'address', 'uint256', 'address', 'address', 'uint256'], [CHAIN, r.lockbox.address, 0n, a('alice'), a('alice'), 100n]));
  await assert.rejects(r.lockbox.send('alice', 'lock', [ZERO, 1n], 8n));
  await assert.rejects(r.lockbox.send('alice', 'lock', [a('alice'), 0n], 7n));
  // the lane takes it (signed by Hyperlane's validator for the source chain) and refuses a stranger's signature
  await assert.rejects(relayIn(r, [OURS[0]]));
  await relayIn(r);
  // outbox fee: exact quote, the rest back
  await zMailbox.send('gov', 'setFee', [5n]);
  await assert.rejects(r.outbox.send('alice', 'send', [a('bob'), 1n], 4n), /Fee/);
});

test('BridgeGuard outbound-only routes: never mint, need the audit and the cap, and an id keeps its kind', async () => {
  const guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await guard.send('gov', 'createToken', ['T', 'T', 18]);
  const OUT = encodeBytes32String('o');
  const box = await c.deployRaw(kitArtifacts().KitRefusingIsm, [], 'gov'); // any contract stands for an outbox
  await assert.rejects(guard.send('gov', 'setOutboundRoute', [OUT, box.address, E, true]), /AuditMissing/);
  await guard.send('gov', 'setAudit', AUDIT);
  await assert.rejects(guard.send('gov', 'setOutboundRoute', [OUT, a('relayer'), E, true]), /NotAdapter/);   // a key
  await assert.rejects(guard.send('gov', 'setOutboundRoute', [OUT, box.address, 1001n * E, true]), /OverCap/);
  await assert.rejects(guard.send('attacker', 'setOutboundRoute', [OUT, box.address, E, true]), /NotGovernance/);
  // a key as adapter while closed, to call the guard directly
  await guard.send('gov', 'setOutboundRoute', [OUT, a('relayer'), E, false]);
  assert.equal(await guard.call('outboundOnly', [OUT]), true);
  await assert.rejects(guard.send('gov', 'setRoute', [OUT, a('relayer'), E, false]), /RouteKind/);
  await assert.rejects(guard.send('relayer', 'inbound', [OUT, a('relayer'), 1n]), /NotAdapter/);
  // an inbound route never becomes outbound-only
  const IN = encodeBytes32String('i');
  await guard.send('gov', 'setRoute', [IN, a('lane2'), E, false]);
  await assert.rejects(guard.send('gov', 'setOutboundRoute', [IN, box.address, E, false]), /RouteKind/);
  // enabled outbound-only (adapter: a contract) still refuses inbound; closing needs no gate
  await guard.send('gov', 'setOutboundRoute', [OUT, box.address, E, true]);
  await guard.send('gov', 'setOutboundRoute', [OUT, box.address, E, false]);
  assert.equal((await guard.call('routes', [OUT])).enabled, false);
});
