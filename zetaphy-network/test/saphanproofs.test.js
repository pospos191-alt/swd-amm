// Saphan PR 3: proven releases (ZETAPHY -> source chain on math alone) and proof of reserves.
//   ZETAPHY:  SaphanProvableOutbox sends the usual Hyperlane release AND writes the same body into ZetaphyOutbox.
//   source:   SaphanReleaseVerifier checks that body against ZETAPHY's state at a block the light client finalized
//             (here KitLightClient; StarkLightClient's own STARK / ML-DSA checks are in starkbridge.test.js), then
//             HyperlaneLockBoxV2.queueProven queues it like a message (same id). requireProof: the Hyperlane path
//             releases nothing any more. Heartbeats carry token(X)'s supply: reserves() on the lockbox.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { AbiCoder, encodeBytes32String, zeroPadValue, getCreateAddress, keccak256, hexlify, Interface } from 'ethers';
import { createChain } from './helpers/evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './helpers/hyperlanekit.js';
import { zetaphyBlock } from './helpers/starkbridge.js';
import { messageLeaf, outboxProof } from '../src/starkbridge/index.js';
import { stateProofArgs } from '../src/saphanproofs.js';

const ZETAPHY = 77390;
const SEPOLIA = 11155111;
const CHAIN = 1n;
const Q = 600;
const DELAY = 3600;
const E = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const ROUTE_IN = encodeBytes32String('airlock');
const ROUTE_OUT = encodeBytes32String('out');
const AUDIT = ['https://audits.example/saphan.pdf', '0x' + 'a1'.repeat(32)];
const b32 = (x) => zeroPadValue(x, 32);
const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));
const withErrors = (name, ...more) => { const x = artifact(name); return { abi: [...x.abi, ...errorsOf(...more)], bytecode: x.bytecode }; };
const TOKEN = new Interface(artifact('BridgedToken').abi);
const HYP = validator(1);
const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));

let kitc;
function kit2() {
  if (kitc) return kitc;
  const file = 'SafetyKit.sol';
  const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(new URL(`./helpers/${file}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  kitc = Object.fromEntries(Object.entries(out.contracts[file]).map(([n, x]) => [n, { abi: x.abi, bytecode: '0x' + x.evm.bytecode.object }]));
  return kitc;
}

let c, kit, zMailbox;
const a = (n) => c.acct[n].toString();
const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock')], bytecode: kit.KitMailbox.bytecode });

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
  // proven releases: the Merkle outbox and the provable outbox on ZETAPHY; the light client and verifier on X
  r.merkle = await c.deploy('ZetaphyOutbox', [], 'gov');
  r.provable = await c.deployRaw(withErrors('SaphanProvableOutbox', 'BridgeGuard', 'HyperlaneOutbox'), [r.outbox.address, r.merkle.address, r.token], 'gov');
  r.lc = await c.deployRaw(kit2().KitLightClient, [], 'gov');
  r.proofs = await c.deploy('ZetaphyBridgeInbox', [r.lc.address, CHAIN, r.merkle.address, ZERO, r.token, a('gov'), ZERO, 0n], 'gov');
  r.verifier = await c.deployRaw(withErrors('SaphanReleaseVerifier', 'HyperlaneLockBoxV2'), [r.lc.address, r.proofs.address, CHAIN, r.merkle.address, r.provable.address, r.lockbox.address], 'gov');
  r.cp = await c.deploy('SaphanCheckpointer', [zMailbox.address, SEPOLIA, b32(r.lockbox.address), r.token], 'gov');
  r.leaves = [];
  return r;
}
const lastMessage = (mb) => mb.call('lastMessage');
async function relayIn(r) { const m = await lastMessage(r.mailbox); return zMailbox.send('relayer', 'process', [messageIdMetadata(m, [HYP]), m]); }
async function relayOut(r) { const m = await lastMessage(zMailbox); return r.mailbox.send('relayer', 'process', [messageIdMetadata(m, OURS.slice(0, 2)), m]); }
const tok = (r, from, fn, args) => c.rawTx(from, r.token, TOKEN.encodeFunctionData(fn, args));
const bal = (r, who) => c.callAt(r.token, TOKEN, 'balanceOf', [who]);

async function bridgeIn(r, who, amount) {
  const fee = await r.lockbox.call('quoteLock', [a(who), amount]);
  await r.lockbox.send(who, 'lock', [a(who), amount], amount + fee);
  const n = (await r.lockbox.call('nonce')) - 1n;
  await relayIn(r);
  const t = [CHAIN, r.lockbox.address, n, a(who), a(who), amount];
  await r.airlock.send('lane2', 'attest', t);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
}
/** alice sends `amount` to `to` on X through the provable outbox; the leaf and the body, as an indexer would keep them. */
async function sendOut(r, to, amount) {
  assert.ok((await tok(r, 'alice', 'approve', [r.provable.address, amount])).ok);
  const n = await r.outbox.call('nonce');
  const body = await r.outbox.call('body', [n, r.provable.address, to, amount]);
  const ev = await r.provable.send('alice', 'send', [to, amount]);
  const ps = ev.find((e) => e?.name === 'ProvableSent').args;
  assert.equal(ps.bodyHash, keccak256(body));
  const nonce = Number(ps.merkleNonce);
  r.leaves.push(messageLeaf({ srcChainId: CHAIN, outbox: r.merkle.address, nonce, sender: r.provable.address, dstChainId: CHAIN, receiver: r.lockbox.address, payload: body }));
  return { body, nonce, id: keccak256(body) };
}
/** ZETAPHY block `height` holding the Merkle outbox's current root, final in the light client. */
async function finalBlock(r, height, salt = 'a') {
  const root = await r.merkle.call('root');
  const blk = zetaphyBlock({ chainId: 'zetaphy_77390-1', height, slots: [{ address: r.merkle.address, slot: 0n, value: root }], salt });
  await r.lc.send('gov', 'set', [height, hexlify(blk.appHash)]);
  return blk;
}
const proveArgs = (r, blk, height, m) => {
  const { iavl, storeOps } = blk.prove(r.merkle.address);
  const op = outboxProof(r.leaves, m.nonce);
  return [height, stateProofArgs(iavl, storeOps), m.nonce, m.body, op.siblings, op.count];
};

beforeEach(async () => {
  c = await createChain(['gov', 'guardian', 'alice', 'bob', 'attacker', 'relayer', 'lane2', 'odeploy']);
  kit = kitArtifacts();
  zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
});

test('a release proven from ZETAPHY\'s state is queued like a message; either path, once', async () => {
  const r = await route();
  await r.lockbox.send('gov', 'setProofVerifier', [r.verifier.address, false]);
  await bridgeIn(r, 'alice', 3n * E);
  const m = await sendOut(r, a('bob'), E);
  assert.equal(await bal(r, a('alice')), 2n * E);
  assert.equal(await c.callAt(r.token, TOKEN, 'totalSupply'), 2n * E, 'burned through the guard');
  const blk = await finalBlock(r, 100n);
  // the verifier is the only caller of queueProven
  await assert.rejects(r.lockbox.send('attacker', 'queueProven', [m.body]), /NotVerifier/);
  // an unknown height, a body that is not the leaf, a nonce past the tree
  await assert.rejects(r.verifier.send('relayer', 'prove', proveArgs(r, blk, 101n, m)), /BadStateProof/);
  const forged = await r.outbox.call('body', [0n, r.provable.address, a('attacker'), E]);
  await assert.rejects(r.verifier.send('relayer', 'prove', proveArgs(r, blk, 100n, { ...m, body: forged })), /BadStateProof/);
  await r.verifier.send('relayer', 'prove', proveArgs(r, blk, 100n, m));
  const q = await r.lockbox.call('releases', [m.id]);
  assert.equal(q.to.toLowerCase(), a('bob').toLowerCase());
  assert.equal(q.amount, E);
  // the Hyperlane message of the same send is the same release: refused as a replay
  await assert.rejects(relayOut(r), /Replay/);
  await assert.rejects(r.verifier.send('relayer', 'prove', proveArgs(r, blk, 100n, m)), /Replay/);
  c.advance(DELAY);
  const before = await c.balance('bob');
  await r.lockbox.send('relayer', 'claim', [m.id]);
  assert.equal((await c.balance('bob')) - before, E);
});

test('requireProof: the Hyperlane path releases nothing; only proven releases move money', async () => {
  const r = await route();
  await assert.rejects(r.lockbox.send('gov', 'setProofVerifier', [ZERO, true]));
  await assert.rejects(r.lockbox.send('attacker', 'setProofVerifier', [r.verifier.address, true]), /NotGovernance/);
  await r.lockbox.send('gov', 'setProofVerifier', [r.verifier.address, true]);
  await bridgeIn(r, 'alice', 2n * E);
  const m = await sendOut(r, a('bob'), E);
  await assert.rejects(relayOut(r), /ProofRequired/, 'our validators alone release nothing');
  const blk = await finalBlock(r, 200n, 'z');
  await r.verifier.send('relayer', 'prove', proveArgs(r, blk, 200n, m));
  c.advance(DELAY);
  await r.lockbox.send('relayer', 'claim', [m.id]);
  // a second send, proven at a later block
  const m2 = await sendOut(r, a('bob'), E / 2n);
  const blk2 = await finalBlock(r, 210n, 'y');
  await assert.rejects(r.verifier.send('relayer', 'prove', proveArgs(r, blk, 200n, m2)), /BadStateProof/, 'block 200 does not hold it');
  await r.verifier.send('relayer', 'prove', proveArgs(r, blk2, 210n, m2));
});

test('proof of reserves: every heartbeat records token(X)\'s supply next to what the lockbox holds', async () => {
  const r = await route();
  await r.lockbox.send('gov', 'setCheckpointer', [b32(r.cp.address)]);
  await bridgeIn(r, 'alice', 3n * E);
  await r.cp.send('relayer', 'beat', []);
  await relayOut(r);
  let x = await r.lockbox.call('reserves');
  assert.equal(x.held, 3n * E);
  assert.equal(x.supply, 3n * E);
  assert.equal(x.bps, 10000n, 'fully backed');
  // a burn that has not reached the lockbox yet: supply falls first, still over-backed
  assert.ok((await tok(r, 'alice', 'approve', [r.outbox.address, E])).ok);
  await r.outbox.send('alice', 'send', [a('bob'), E]);
  c.advance(3600);
  await r.cp.send('relayer', 'beat', []);
  const hb = await lastMessage(zMailbox);
  await r.mailbox.send('relayer', 'process', [messageIdMetadata(hb, OURS.slice(0, 2)), hb]);
  x = await r.lockbox.call('reserves');
  assert.equal(x.supply, 2n * E);
  assert.equal(x.bps, 15000n);
});

// ---------------------------------------------------------------- Bitcoin deposits by proof of work

const CUSTODY = '0x0020' + 'ab'.repeat(32);   // a P2WSH scriptPubKey (the custody)
const le = (v, n) => '0x' + BigInt(v).toString(16).padStart(n * 2, '0').match(/../g).reverse().join('');
const strip = (h) => h.replace(/^0x/, '');
/** A non-witness Bitcoin transaction: one input, the given outputs [[sats, scriptHex]]. */
function btcTx(outs) {
  const input = '00'.repeat(32) + '00000000' + '00' + 'ffffffff';
  const o = outs.map(([v, s]) => strip(le(v, 8)) + (strip(s).length / 2).toString(16).padStart(2, '0') + strip(s)).join('');
  return '0x02000000' + '01' + input + outs.length.toString(16).padStart(2, '0') + o + '00000000';
}
const tagScript = (to) => '0x6a19' + Buffer.from('ZTPHY').toString('hex') + strip(to).toLowerCase();

test('BTC deposits: the SPV lane reads the custody output and the tagged recipient, and attests each output once', async () => {
  const r = await route();
  const btc = await c.deployRaw(kit2().KitBtcClient, [], 'gov');
  const lane = await c.deployRaw(withErrors('BtcSpvLane', 'BridgeAirlock'), [btc.address, r.airlock.address, CUSTODY, 6n, 10_000n], 'gov');
  await r.airlock.send('gov', 'setLane', [lane.address, true]);
  const block = '0x' + '11'.repeat(32);
  await btc.send('gov', 'setKnown', [block]);
  const raw = btcTx([[250_000n, CUSTODY], [0n, tagScript(a('alice'))]]);
  assert.deepEqual([...(await lane.call('parse', [raw, 0]))].map((x) => String(x).toLowerCase()), ['250000', a('alice').toLowerCase()]);
  // not in a known block; wrong output; no tag; dust; another payee; trailing bytes
  await assert.rejects(lane.send('relayer', 'attest', [raw, 0, '0x' + '22'.repeat(32), 0n, []]));
  await assert.rejects(lane.send('relayer', 'attest', [raw, 1, block, 0n, []]), /BadTx/);
  await assert.rejects(lane.send('relayer', 'attest', [btcTx([[250_000n, CUSTODY]]), 0, block, 0n, []]), /BadTx/);
  await assert.rejects(lane.send('relayer', 'attest', [btcTx([[9_999n, CUSTODY], [0n, tagScript(a('alice'))]]), 0, block, 0n, []]), /BadTx/);
  await assert.rejects(lane.send('relayer', 'attest', [btcTx([[250_000n, '0x0014' + 'cd'.repeat(20)], [0n, tagScript(a('alice'))]]), 0, block, 0n, []]), /BadTx/);
  await assert.rejects(lane.send('relayer', 'attest', [raw + '00', 0, block, 0n, []]), /BadTx/);
  const ev = await lane.send('relayer', 'attest', [raw, 0, block, 0n, []]);
  const d = ev.find((e) => e?.name === 'Deposit').args;
  assert.equal(d.sats, 250_000n);
  await assert.rejects(lane.send('relayer', 'attest', [raw, 0, block, 0n, []]), /Twice/, 'each output once');
  // the airlock's other lane agrees, the quarantine passes: 0.0025 zBTC (18 decimals) minted to alice
  const t = [await lane.call('BTC_CHAIN_ID'), await lane.call('custodyId'), BigInt(keccak256(new AbiCoder().encode(['bytes32', 'uint32'], [d.txid, 0]))), ZERO, a('alice'), 250_000n * 10n ** 10n];
  await r.airlock.send('lane2', 'attest', t);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
  assert.equal(await bal(r, a('alice')), 250_000n * 10n ** 10n);
});
