// ZETAPHY Saphan, token routes: tokens born on ZETAPHY go out to an EVM chain and come back.
//   ZETAPHY:     ZetaphyTokenVault(token, X): escrows; releases burns from X after a delay (Hyperlane's validator for X)
//   chain X:     SaphanSyntheticToken(token, X): mints after a delay (OUR validators for origin ZETAPHY); sendBack burns
// Messages go through a test Mailbox that checks a message-id multisig ISM with checkpoints signed here
// (helpers/HyperlaneKit.sol), as a real Mailbox would. One EVM plays every chain (chain id 1); each chain has its
// own Mailbox and Hyperlane domain. Test tokens, plain and odd: helpers/TokenKit.sol.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, zeroPadValue, getCreateAddress, keccak256, solidityPacked } from 'ethers';
import { createChain } from './helpers/evm.js';
import { kitArtifacts, tokenKitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';

const ZETAPHY = 77390;
const BASE = 84532;
const ARB = 421614;
const CHAIN = 1n; // the test EVM's chain id: every "chain" here
const DELAY = 3600;
const E = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const abi = AbiCoder.defaultAbiCoder();
const b32 = (x) => zeroPadValue(x, 32);
const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));
const BODY = ['uint256', 'address', 'uint256', 'address', 'address', 'uint256', 'uint256', 'address', 'address'];

// Hyperlane's validator for each destination (they secure the way back to ZETAPHY), and our validators for origin ZETAPHY.
const HYP = { [BASE]: validator(11), [ARB]: validator(12) };
const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));

let c, kit, tk, zMailbox, mailboxes;
const a = (n) => c.acct[n].toString();
const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('ZetaphyTokenVault', 'SaphanSyntheticToken')], bytecode: kit.KitMailbox.bytecode });
const message = ({ nonce = 9999, origin, sender, destination, recipient, body }) =>
  solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'], [3, nonce, origin, b32(sender), destination, b32(recipient), body]);
const cfg = (o) => [o.mailbox, o.remoteDomain, CHAIN, b32(o.remote), ZERO, o.originToken, o.ism, o.governance ?? a('gov'), o.guardian ?? a('guardian'), o.dailyLimit, o.delay ?? DELAY];

/** A plain test token on ZETAPHY ("born on ZETAPHY"), alice holding 1,000. */
async function newToken(symbol = 'tBZTPHY', decimals = 18, art = null) {
  const t = await c.deployRaw(art ?? tk.KitToken, art ? [] : [`${symbol} (test)`, symbol, decimals], 'gov');
  await t.send('gov', 'mint', [a('alice'), 1000n * 10n ** BigInt(decimals)]);
  return t;
}

/**
 * One token route: ZetaphyTokenVault(token, dest) on ZETAPHY and SaphanSyntheticToken(token, dest) on dest, the synthetic's
 * address fixed in advance (its deployer's nonce), as the saphan-route workflow does. Opened (unpaused) by governance.
 */
async function tokenRoute(token, dest, { decimals = 18, ours = OURS, threshold = 2, lockCap = 100n * E, releaseLimit = 50n * E, mintLimit = 50n * E,
  supplyCap = 100n * E, threats = ZERO, open = true, deployer = 'ddeploy' } = {}) {
  const r = { dest, token };
  r.mailbox = mailboxes[dest] ??= await c.deployRaw(mailboxArt(), [dest], 'gov');
  r.hypIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [[HYP[dest].address], 1], 'gov');        // on ZETAPHY: Hyperlane's validator for dest
  r.ourIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [ours.map((w) => w.address), threshold], deployer); // on dest: ours
  const synAt = getCreateAddress({ from: a(deployer), nonce: await c.nonce(deployer) });
  r.vault = await c.deploy('ZetaphyTokenVault', [cfg({ mailbox: zMailbox.address, remoteDomain: dest, remote: synAt, originToken: token.address,
    ism: r.hypIsm.address, dailyLimit: releaseLimit }), decimals, lockCap, threats], 'zdeploy');
  r.syn = await c.deploy('SaphanSyntheticToken', [`zTOKEN on ${dest}`, `z${dest}`, decimals, cfg({ mailbox: r.mailbox.address, remoteDomain: ZETAPHY,
    remote: r.vault.address, originToken: token.address, ism: r.ourIsm.address, dailyLimit: mintLimit }), supplyCap], deployer);
  assert.equal(r.syn.address.toLowerCase(), synAt.toLowerCase());
  assert.equal(await r.vault.call('paused'), true);  // deployed closed
  assert.equal(await r.syn.call('paused'), true);
  if (open) { await r.vault.send('gov', 'unpause'); await r.syn.send('gov', 'unpause'); }
  return r;
}

const lastMessage = (mb) => mb.call('lastMessage');
const idOf = (m) => keccak256('0x' + m.slice(2 + 77 * 2));
/** ZETAPHY -> dest: the vault's message, signed by our validators. */
async function relayOut(r, signers = OURS.slice(0, 2), m = null) {
  m ??= await lastMessage(zMailbox);
  await r.mailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]);
  return idOf(m);
}
/** dest -> ZETAPHY: the synthetic's message, signed by Hyperlane's validator for dest. */
async function relayIn(r, signers = [HYP[r.dest]], m = null) {
  m ??= await lastMessage(r.mailbox);
  await zMailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]);
  return idOf(m);
}
const tbal = (t, who) => t.call('balanceOf', [a(who)]);

/** alice locks on ZETAPHY for `to` on dest; relayed; minted after the delay. */
async function out(r, amount, to = 'alice', who = 'alice') {
  await r.token.send(who, 'approve', [r.vault.address, amount]);
  await r.vault.send(who, 'lock', [a(to), amount]);
  const id = await relayOut(r);
  c.advance(DELAY);
  await r.syn.send('relayer', 'claim', [id]);
  return id;
}
/** `who` sends back from dest to `to` on ZETAPHY; relayed; released after the delay. */
async function back(r, amount, to = 'alice', who = 'alice') {
  await r.syn.send(who, 'sendBack', [a(to), amount]);
  const id = await relayIn(r);
  c.advance(DELAY);
  await r.vault.send('relayer', 'claim', [id]);
  return id;
}

/** A body as the vault (ZETAPHY -> dest) or the synthetic (dest -> ZETAPHY) writes it, with any field replaced. */
const bodyOf = (o) => abi.encode(BODY, [o.srcChain ?? CHAIN, o.src, o.nonce ?? 7, o.sender ?? a('attacker'), o.to ?? a('attacker'), o.amount ?? E, o.dstChain ?? CHAIN, o.dst, o.token]);

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'attacker', 'relayer', 'zdeploy', 'ddeploy', 'ddeploy2']);
  kit = kitArtifacts();
  tk = tokenKitArtifacts();
  zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
  mailboxes = {};
});

test('round trip: lock on ZETAPHY, mint on the destination after the delay, send back, release on ZETAPHY after the delay', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE, { open: false });
  await T.send('alice', 'approve', [r.vault.address, 5n * E]);
  await assert.rejects(r.vault.send('alice', 'lock', [a('bob'), 5n * E]), /IsPaused/);                // deployed closed
  await assert.rejects(r.vault.send('guardian', 'unpause'), /NotGovernance/);
  await r.vault.send('gov', 'unpause');
  await r.syn.send('gov', 'unpause');
  const ev = await r.vault.send('alice', 'lock', [a('bob'), 5n * E]);
  assert.equal(ev.find((e) => e?.name === 'Sent').args.amount, 5n * E);
  assert.equal(await tbal(T, 'alice'), 995n * E);
  assert.equal(await r.vault.call('locked'), 5n * E);
  assert.equal(await T.call('balanceOf', [r.vault.address]), 5n * E);
  const m = await lastMessage(zMailbox);
  assert.equal((m.length - 2) / 2, 77 + 288);
  const id = await relayOut(r);
  assert.equal(await r.syn.call('received'), 1n);                                                      // what the relayer gate compares with vault.nonce()
  const q = await r.syn.call('pending', [id]);
  assert.deepEqual([q.to.toLowerCase(), q.amount, q.done], [a('bob').toLowerCase(), 5n * E, false]);
  await assert.rejects(r.syn.send('relayer', 'claim', [id]), /NotReady/);
  c.advance(DELAY);
  await r.syn.send('relayer', 'claim', [id]);                                                         // anyone claims; bob gets the synthetic
  assert.equal(await tbal(r.syn, 'bob'), 5n * E);
  assert.equal(await r.syn.call('totalSupply'), 5n * E);
  await assert.rejects(r.syn.send('relayer', 'claim', [id]), /AlreadyDone/);
  await assert.rejects(relayOut(r));                                                                   // the Mailbox delivers a message once
  // way back: bob sends 2 to alice on ZETAPHY
  await r.syn.send('bob', 'sendBack', [a('alice'), 2n * E]);
  assert.equal(await r.syn.call('totalSupply'), 3n * E);
  assert.equal(await r.syn.call('nonce'), 1n);
  const rid = await relayIn(r);
  assert.equal(await r.vault.call('received'), 1n);
  await assert.rejects(r.vault.send('relayer', 'claim', [rid]), /NotReady/);
  c.advance(DELAY);
  await r.vault.send('relayer', 'claim', [rid]);
  assert.equal(await tbal(T, 'alice'), 997n * E);
  assert.equal(await r.vault.call('locked'), 3n * E);
  await assert.rejects(r.syn.send('bob', 'sendBack', [a('alice'), 4n * E]));                           // bob has 3
});

test('a message from another origin or sender, or with a wrong source, destination or token, is refused', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE);
  await out(r, 5n * E);
  // ZETAPHY -> destination: what the synthetic accepts
  const toSyn = (o) => message({ origin: o.origin ?? ZETAPHY, sender: o.sender ?? r.vault.address, destination: BASE, recipient: r.syn.address,
    body: o.body ?? bodyOf({ src: r.vault.address, dst: r.syn.address, token: T.address, ...o.b }) });
  const deliverSyn = (m) => r.mailbox.send('relayer', 'process', [messageIdMetadata(m, OURS.slice(0, 2)), m]);
  for (const [m, re] of [
    [toSyn({ origin: ARB }), /WrongOrigin/],
    [toSyn({ sender: a('attacker') }), /WrongSender/],
    [toSyn({ b: { src: a('attacker') } }), /WrongSource/],
    [toSyn({ b: { srcChain: 5n } }), /WrongSource/],
    [toSyn({ b: { dst: a('bob') } }), /WrongDestination/],
    [toSyn({ b: { dstChain: 5n } }), /WrongDestination/],
    [toSyn({ b: { token: a('attacker') } }), /WrongToken/],
    [toSyn({ b: { amount: 0n } }), /BadBody/],
    [toSyn({ body: abi.encode(['uint256'], [1]) }), /BadBody/],
  ]) await assert.rejects(deliverSyn(m), re);
  // destination -> ZETAPHY: what the vault accepts
  const toVault = (o) => message({ origin: o.origin ?? BASE, sender: o.sender ?? r.syn.address, destination: ZETAPHY, recipient: r.vault.address,
    body: bodyOf({ src: r.syn.address, dst: r.vault.address, token: T.address, ...o.b }) });
  const deliverVault = (m) => zMailbox.send('relayer', 'process', [messageIdMetadata(m, [HYP[BASE]]), m]);
  for (const [m, re] of [
    [toVault({ origin: ZETAPHY }), /WrongOrigin/],
    [toVault({ sender: a('attacker') }), /WrongSender/],
    [toVault({ b: { src: a('attacker') } }), /WrongSource/],
    [toVault({ b: { dst: a('bob') } }), /WrongDestination/],
    [toVault({ b: { token: a('bob') } }), /WrongToken/],
    [toVault({ b: { to: ZERO } }), /BadBody/],
  ]) await assert.rejects(deliverVault(m), re);
  // only the Mailbox may call handle, without value
  await assert.rejects(r.vault.send('attacker', 'handle', [BASE, b32(r.syn.address), bodyOf({ src: r.syn.address, dst: r.vault.address, token: T.address })]), /NotMailbox/);
  await assert.rejects(r.syn.send('attacker', 'handle', [ZETAPHY, b32(r.vault.address), bodyOf({ src: r.vault.address, dst: r.syn.address, token: T.address })]), /NotMailbox/);
  assert.equal(await r.vault.call('locked'), 5n * E);
  assert.equal(await r.vault.call('received'), 0n);
});

test('replay: the Mailbox delivers once; the same body in another message is refused (Replay)', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE);
  await out(r, 5n * E);
  await r.syn.send('alice', 'sendBack', [a('alice'), E]);
  const m = await lastMessage(r.mailbox);
  await relayIn(r, undefined, m);
  await assert.rejects(relayIn(r, undefined, m));                                                       // already delivered
  const again = '0x' + m.slice(2, 4) + '0000beef' + m.slice(12);                                     // another Mailbox nonce, same body
  await assert.rejects(relayIn(r, undefined, again), /Replay/);
  // and toward the destination
  await T.send('alice', 'approve', [r.vault.address, E]);
  await r.vault.send('alice', 'lock', [a('alice'), E]);
  const mo = await lastMessage(zMailbox);
  await relayOut(r, undefined, mo);
  await assert.rejects(relayOut(r, undefined, '0x' + mo.slice(2, 4) + '0000beef' + mo.slice(12)), /Replay/);
  assert.equal(await r.vault.call('received'), 1n);
  assert.equal(await r.syn.call('received'), 2n);
});

test("token A's messages cannot reach token B's vault or synthetic", async () => {
  const A = await newToken('tA'), B = await newToken('tB');
  const ra = await tokenRoute(A, BASE), rb = await tokenRoute(B, BASE, { deployer: 'ddeploy2' });
  await out(ra, 5n * E);
  await out(rb, 5n * E);
  // synthetic A's real burn, re-addressed to vault B, validly signed: the sender is not B's synthetic
  await ra.syn.send('alice', 'sendBack', [a('alice'), E]);
  const m = await lastMessage(ra.mailbox);
  const toB = message({ origin: BASE, sender: ra.syn.address, destination: ZETAPHY, recipient: rb.vault.address, body: '0x' + m.slice(2 + 77 * 2) });
  await assert.rejects(relayIn(rb, undefined, toB), /WrongSender/);
  // a forged message that claims to come from synthetic B but names token A (signed by the destination's validator)
  const forged = message({ origin: BASE, sender: rb.syn.address, destination: ZETAPHY, recipient: rb.vault.address,
    body: bodyOf({ src: rb.syn.address, dst: rb.vault.address, token: A.address, amount: 3n * E }) });
  await assert.rejects(relayIn(rb, undefined, forged), /WrongToken/);
  // vault A's lock re-addressed to synthetic B
  await A.send('alice', 'approve', [ra.vault.address, E]);
  await ra.vault.send('alice', 'lock', [a('alice'), E]);
  const mo = await lastMessage(zMailbox);
  const toSynB = message({ origin: ZETAPHY, sender: ra.vault.address, destination: BASE, recipient: rb.syn.address, body: '0x' + mo.slice(2 + 77 * 2) });
  await assert.rejects(relayOut(rb, undefined, toSynB), /WrongSender/);
  assert.equal(await rb.vault.call('locked'), 5n * E);
  assert.equal(await B.call('balanceOf', [rb.vault.address]), 5n * E);
  // token A's vault never holds or pays token B
  await relayIn(ra, undefined, m);
  c.advance(DELAY);
  await ra.vault.send('relayer', 'claim', [idOf(m)]);
  assert.equal(await A.call('balanceOf', [ra.vault.address]), 5n * E);   // 5 + 1 locked, 1 released
  assert.equal(await B.call('balanceOf', [rb.vault.address]), 5n * E);
});

test("destination X's burn cannot release destination Y's escrow; each vault pays at most its own backing", async () => {
  const T = await newToken();
  const X = await tokenRoute(T, BASE), Y = await tokenRoute(T, ARB, { deployer: 'ddeploy2' });
  await out(X, 5n * E);
  await out(Y, E);
  // X's real burn, delivered to vault Y: X's domain is not Y's
  await X.syn.send('alice', 'sendBack', [a('alice'), 3n * E]);
  const m = await lastMessage(X.mailbox);
  const toY = message({ origin: BASE, sender: X.syn.address, destination: ZETAPHY, recipient: Y.vault.address, body: '0x' + m.slice(2 + 77 * 2) });
  await assert.rejects(relayIn(Y, [HYP[BASE]], toY));                                     // vault Y's ISM: only Y's validator
  const toYasY = message({ origin: ARB, sender: X.syn.address, destination: ZETAPHY, recipient: Y.vault.address, body: '0x' + m.slice(2 + 77 * 2) });
  await assert.rejects(relayIn(Y, [HYP[BASE]], toYasY));                                  // signed by X's validator: refused by Y's ISM
  await assert.rejects(relayIn(Y, [HYP[ARB]], toYasY), /WrongSender/);                    // even signed by Y's validator: not Y's synthetic
  // Y's own validator signs a forged release of 3 (Y holds 1): queued, but never paid beyond Y's backing
  const forged = message({ origin: ARB, sender: Y.syn.address, destination: ZETAPHY, recipient: Y.vault.address,
    body: bodyOf({ src: Y.syn.address, dst: Y.vault.address, token: T.address, amount: 3n * E }) });
  const fid = await relayIn(Y, [HYP[ARB]], forged);
  c.advance(DELAY);
  await assert.rejects(Y.vault.send('relayer', 'claim', [fid]), /OverBacking/);           // X's 5 are in X's vault, out of reach
  await Y.vault.send('guardian', 'veto', [fid]);
  // X's own burn is paid from X's vault
  await relayIn(X, undefined, m);
  c.advance(DELAY);
  await X.vault.send('relayer', 'claim', [idOf(m)]);
  assert.deepEqual([await X.vault.call('locked'), await Y.vault.call('locked')], [2n * E, E]);
  assert.equal(await T.call('balanceOf', [X.vault.address]), 2n * E);
  assert.equal(await T.call('balanceOf', [Y.vault.address]), E);
});

test('limits: release and mint per day (over it waits for tomorrow), the lock cap and the supply cap', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE, { lockCap: 20n * E, releaseLimit: 3n * E, mintLimit: 4n * E, supplyCap: 15n * E });
  await T.send('alice', 'approve', [r.vault.address, 1000n * E]);
  await r.vault.send('alice', 'lock', [a('alice'), 3n * E]);
  const m1 = await relayOut(r);
  await r.vault.send('alice', 'lock', [a('alice'), 3n * E]);
  const m2 = await relayOut(r);
  c.advance(DELAY);
  await r.syn.send('relayer', 'claim', [m1]);
  await assert.rejects(r.syn.send('relayer', 'claim', [m2]), /OverLimit/);              // 3 + 3 > 4 today
  assert.equal(await r.syn.call('remainingToday'), E);
  c.advance(86400);
  await r.syn.send('relayer', 'claim', [m2]);
  await assert.rejects(r.vault.send('alice', 'lock', [a('alice'), 15n * E]), /OverCap/);   // 6 + 15 > 20 locked
  await r.vault.send('alice', 'lock', [a('alice'), 10n * E]);
  const m3 = await relayOut(r);
  c.advance(DELAY + 86400);
  await r.syn.send('gov', 'setDailyLimit', [100n * E]);
  await assert.rejects(r.syn.send('relayer', 'claim', [m3]), /OverCap/);                  // 6 + 10 > 15 supply
  await r.syn.send('gov', 'setSupplyCap', [16n * E]);
  await r.syn.send('relayer', 'claim', [m3]);
  // the release limit on ZETAPHY
  await r.syn.send('alice', 'sendBack', [a('alice'), 2n * E]);
  const b1 = await relayIn(r);
  await r.syn.send('alice', 'sendBack', [a('alice'), 2n * E]);
  const b2 = await relayIn(r);
  c.advance(DELAY);
  await r.vault.send('relayer', 'claim', [b1]);
  await assert.rejects(r.vault.send('relayer', 'claim', [b2]), /OverLimit/);
  c.advance(86400);
  await r.vault.send('relayer', 'claim', [b2]);
  assert.equal(await r.vault.call('locked'), 12n * E);
  // guardians only lower, governance raises
  await assert.rejects(r.vault.send('attacker', 'lowerLockCap', [0n]), /NotGuardian/);
  await assert.rejects(r.vault.send('guardian', 'lowerLockCap', [30n * E]));
  await r.vault.send('guardian', 'lowerLockCap', [12n * E]);
  await assert.rejects(r.vault.send('alice', 'lock', [a('alice'), 1n]), /OverCap/);
  await assert.rejects(r.vault.send('guardian', 'setLockCap', [99n * E]), /NotGovernance/);
  await r.syn.send('guardian', 'lowerSupplyCap', [0n]);
  await assert.rejects(r.syn.send('guardian', 'setSupplyCap', [99n * E]), /NotGovernance/);
  await assert.rejects(r.syn.send('guardian', 'lowerDailyLimit', [200n * E]));
  await r.syn.send('guardian', 'lowerDailyLimit', [E]);
  await assert.rejects(r.syn.send('guardian', 'raiseDelay', [DELAY]));
  await r.syn.send('guardian', 'raiseDelay', [2 * DELAY]);
  await assert.rejects(r.syn.send('guardian', 'raiseDelay', [31 * 86400]));
  await assert.rejects(r.syn.send('guardian', 'setDelay', [0]), /NotGovernance/);
});

test('pause and veto: guardians stop at once; only governance reopens or lifts a veto', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE);
  await T.send('alice', 'approve', [r.vault.address, 1000n * E]);
  await r.vault.send('alice', 'lock', [a('alice'), 4n * E]);
  const id = await relayOut(r);
  await assert.rejects(r.syn.send('attacker', 'pause'), /NotGuardian/);
  await r.syn.send('guardian', 'pause');
  c.advance(DELAY);
  await assert.rejects(r.syn.send('relayer', 'claim', [id]), /IsPaused/);
  await r.vault.send('alice', 'lock', [a('alice'), E]);                                   // the message still arrives while paused
  const id2 = await relayOut(r);
  await assert.rejects(r.syn.send('guardian', 'unpause'), /NotGovernance/);
  await r.syn.send('gov', 'unpause');
  await r.syn.send('relayer', 'claim', [id]);
  await r.syn.send('guardian', 'veto', [id2]);
  c.advance(DELAY);
  await assert.rejects(r.syn.send('relayer', 'claim', [id2]), /IsVetoed/);
  await assert.rejects(r.syn.send('guardian', 'liftVeto', [id2]), /NotGovernance/);
  await assert.rejects(r.syn.send('guardian', 'veto', [keccak256('0x01')]), /NoMessage/);
  await assert.rejects(r.syn.send('guardian', 'veto', [id]), /AlreadyDone/);
  await r.syn.send('gov', 'liftVeto', [id2]);
  await r.syn.send('relayer', 'claim', [id2]);
  // the vault: pause stops locks and releases
  await r.syn.send('alice', 'sendBack', [a('bob'), E]);
  const rid = await relayIn(r);
  await r.vault.send('guardian', 'pause');
  await assert.rejects(r.vault.send('alice', 'lock', [a('alice'), E]), /IsPaused/);
  c.advance(DELAY);
  await assert.rejects(r.vault.send('relayer', 'claim', [rid]), /IsPaused/);
  await r.syn.send('guardian', 'pause');
  await assert.rejects(r.syn.send('alice', 'sendBack', [a('alice'), E]), /IsPaused/);
  await r.vault.send('gov', 'unpause');
  await r.vault.send('guardian', 'veto', [rid]);
  await assert.rejects(r.vault.send('relayer', 'claim', [rid]), /IsVetoed/);
  assert.equal(await tbal(T, 'bob'), 0n);
  assert.equal(await r.vault.call('locked'), 5n * E);
});

test('ISM: the synthetic trusts only our validators (threshold, order), the vault only the destination\'s; never zero, set only by governance', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE);
  await T.send('alice', 'approve', [r.vault.address, 1000n * E]);
  await r.vault.send('alice', 'lock', [a('alice'), E]);
  const m = await lastMessage(zMailbox);
  for (const signers of [[OURS[0]], [OURS[1], OURS[0]], [HYP[BASE], OURS[0]], [OURS[0], OURS[0]], [HYP[BASE]]]) {
    await assert.rejects(relayOut(r, signers, m));
  }
  await relayOut(r, [OURS[0], OURS[2]], m);                                              // any 2 of our 3, in order
  await out(r, 2n * E);
  await r.syn.send('alice', 'sendBack', [a('alice'), E]);
  const mb = await lastMessage(r.mailbox);
  for (const signers of [[OURS[0]], [HYP[ARB]], []]) await assert.rejects(relayIn(r, signers, mb));
  const refusing = await c.deployRaw(kit.KitRefusingIsm, [], 'gov');
  await assert.rejects(r.vault.send('attacker', 'setInterchainSecurityModule', [refusing.address]), /NotGovernance/);
  await assert.rejects(r.vault.send('gov', 'setInterchainSecurityModule', [ZERO]));
  await r.vault.send('gov', 'setInterchainSecurityModule', [refusing.address]);
  await assert.rejects(relayIn(r, undefined, mb));
  await assert.rejects(c.deploy('ZetaphyTokenVault', [cfg({ mailbox: zMailbox.address, remoteDomain: BASE, remote: r.syn.address, originToken: T.address,
    ism: ZERO, dailyLimit: E }), 18, E, ZERO], 'gov'));                                   // no ISM: no vault
  await assert.rejects(c.deploy('SaphanSyntheticToken', ['x', 'x', 18, cfg({ mailbox: r.mailbox.address, remoteDomain: ZETAPHY, remote: r.vault.address,
    originToken: T.address, ism: ZERO, dailyLimit: E }), E], 'gov'));
});

test('decimals: a 6-decimal token goes out and back 1:1; a vault refuses a token whose decimals differ from the table or are missing', async () => {
  const T = await newToken('tSIX', 6);
  const U = 10n ** 6n;
  const r = await tokenRoute(T, BASE, { decimals: 6, lockCap: 1000n * U, releaseLimit: 1000n * U, mintLimit: 1000n * U, supplyCap: 1000n * U });
  assert.equal(await r.syn.call('decimals'), 6n);
  assert.equal(await r.vault.call('decimals'), 6n);
  await out(r, 123_456_789n);
  assert.equal(await tbal(r.syn, 'alice'), 123_456_789n);
  await back(r, 23_456_789n);
  assert.equal(await tbal(T, 'alice'), 1000n * U - 100_000_000n);
  await assert.rejects(c.deploy('ZetaphyTokenVault', [cfg({ mailbox: zMailbox.address, remoteDomain: BASE, remote: r.syn.address, originToken: T.address,
    ism: r.hypIsm.address, dailyLimit: E }), 18, E, ZERO], 'gov'));                       // the table says 18, the token 6
  const nod = await c.deployRaw(tk.KitNoDecimalsToken, [], 'gov');
  await assert.rejects(c.deploy('ZetaphyTokenVault', [cfg({ mailbox: zMailbox.address, remoteDomain: BASE, remote: r.syn.address, originToken: nod.address,
    ism: r.hypIsm.address, dailyLimit: E }), 18, E, ZERO], 'gov'));
  await assert.rejects(c.deploy('ZetaphyTokenVault', [cfg({ mailbox: zMailbox.address, remoteDomain: BASE, remote: r.syn.address, originToken: a('bob'),
    ism: r.hypIsm.address, dailyLimit: E }), 18, E, ZERO], 'gov'));                       // not a contract
});

test('odd ERC-20s: fee-on-transfer and false-returning tokens are refused; no-return (USDT-style) tokens work; re-entry is blocked', async () => {
  const fee = await newToken('FEE', 18, tk.KitFeeToken);
  const rf = await tokenRoute(fee, BASE);
  await fee.send('alice', 'approve', [rf.vault.address, 10n * E]);
  await assert.rejects(rf.vault.send('alice', 'lock', [a('alice'), 10n * E]), /OddToken/);
  assert.equal(await rf.vault.call('locked'), 0n);
  const no = await newToken('NO', 18, tk.KitFalseToken);
  const rn = await tokenRoute(no, BASE, { deployer: 'ddeploy2' });
  await no.send('alice', 'approve', [rn.vault.address, 10n * E]);
  await assert.rejects(rn.vault.send('alice', 'lock', [a('alice'), E]), /TransferFailed/);
  // USDT-style: no return value
  const usdt = await c.deployRaw(tk.KitNoReturnToken, [], 'gov');
  await usdt.send('gov', 'mint', [a('alice'), 1000n * 10n ** 6n]);
  const ru = await tokenRoute(usdt, ARB, { decimals: 6 });
  await out(ru, 5_000_000n);
  await back(ru, 2_000_000n);
  assert.equal(await usdt.call('balanceOf', [a('alice')]), 1000n * 10n ** 6n - 3_000_000n);
  assert.equal(await ru.vault.call('locked'), 3_000_000n);
  // a token that calls back into the vault during a transfer: the vault is not re-entered
  const hook = await newToken('HOOK', 18, tk.KitHookToken);
  const rh = await tokenRoute(hook, ARB, { deployer: 'ddeploy2' });
  await hook.send('alice', 'approve', [rh.vault.address, 10n * E]);
  const reenter = rh.vault.iface.encodeFunctionData('lock', [a('alice'), E]);
  await hook.send('alice', 'arm', [rh.vault.address, reenter]);
  await rh.vault.send('alice', 'lock', [a('alice'), E]);
  assert.equal(await hook.call('reentered'), false);
  assert.equal(await rh.vault.call('locked'), E);
  assert.equal(await rh.vault.call('nonce'), 1n);
});

test('vaccine: a sender the ThreatRegistry holds cannot lock; a release to a held receiver waits until the hold ends', async () => {
  const T = await newToken();
  const threats = await c.deployRaw(tk.KitThreats, [], 'gov');
  const r = await tokenRoute(T, BASE, { threats: threats.address });
  await out(r, 5n * E);
  await threats.send('gov', 'setHeld', [a('alice'), true]);
  await assert.rejects(r.vault.send('alice', 'lock', [a('alice'), E]), /Held/);
  await r.syn.send('alice', 'sendBack', [a('alice'), E]);
  const id = await relayIn(r);
  c.advance(DELAY);
  await assert.rejects(r.vault.send('relayer', 'claim', [id]), /Held/);
  await threats.send('gov', 'setHeld', [a('alice'), false]);
  await r.vault.send('relayer', 'claim', [id]);
  assert.equal(await r.vault.call('locked'), 4n * E);
  await assert.rejects(r.vault.send('attacker', 'setThreats', [ZERO]), /NotGovernance/);
});

test('tokens sent to a vault without lock() are not backing; governance can send only that excess on', async () => {
  const T = await newToken();
  const r = await tokenRoute(T, BASE);
  await out(r, 5n * E);
  await T.send('alice', 'transfer', [r.vault.address, 2n * E]);
  assert.equal(await r.vault.call('locked'), 5n * E);
  await assert.rejects(r.vault.send('attacker', 'recoverExcess', [a('attacker')]), /NotGovernance/);
  await r.vault.send('gov', 'recoverExcess', [a('bob')]);
  assert.equal(await tbal(T, 'bob'), 2n * E);
  assert.equal(await T.call('balanceOf', [r.vault.address]), 5n * E);
  await assert.rejects(r.vault.send('gov', 'recoverExcess', [a('bob')]));
  // a fee is paid through, anything above it comes back
  await r.mailbox.send('gov', 'setFee', [1000n]);
  assert.equal(await r.syn.call('quote', [a('alice'), E]), 1000n);
  await assert.rejects(r.syn.send('alice', 'sendBack', [a('alice'), E], 999n), /Fee/);
  const before = await c.balance('alice');
  await r.syn.send('alice', 'sendBack', [a('alice'), E], 5000n);
  assert.equal(before - (await c.balance('alice')), 1000n);
});
