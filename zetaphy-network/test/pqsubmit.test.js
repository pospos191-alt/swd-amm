// The PQ submitter (src/pqsubmit.js): services sign on ZETAPHY as native ML-DSA-44 accounts (MsgEVMCall)
// instead of secp256k1 EOAs. Against helpers/pqnode.js, a node stand-in that checks the real ML-DSA-44
// signature, account number and CheckTx sequence, and runs the calls on the in-memory EVM with
// msg.sender = the account's 0x address. Covers sequences for back-to-back txs, the node's refusals
// and lost answers (retries without double-sending), Pyth reporters (oracle push / poke --pq) and a
// Hyperlane delivery to a Mailbox whose ISM is PQMultisigIsm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, encodeBytes32String, solidityPacked, zeroPadValue, keccak256 } from 'ethers';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { createPqNode } from './helpers/pqnode.js';
import { kitArtifacts } from './helpers/hyperlanekit.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';
import { pqSubmitter, expectedSequence, classify, hyperlaneProcessCall, destinationOf, messageIdOf, deliverHyperlane, cometTxResult, MAX_TX_BYTES } from '../src/pqsubmit.js';
import { pqAddress } from '../src/pqtx.js';
import { pqIsmMetadata } from '../src/qsafe/pqism.js';
import { oracleCommand, pqReporter } from '../src/oraclecli.js';
import { encodePriceFeed } from '../src/oracle.js';

const key = (b) => { const k = ml_dsa44.keygen(new Uint8Array(32).fill(b)); return { publicKey: k.publicKey, sign: (m) => ml_dsa44.sign(m, k.secretKey), addr: pqAddress(k.publicKey) }; };
const R1 = key(1); const R2 = key(2); const STRANGER = key(3);
const FEED = encodeBytes32String('ZETAPHY/USD');
const RELAY = new Interface(['function updatePriceFeeds(bytes[] updateData) payable', 'function isRelayer(address) view returns (bool)',
  'function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))', 'function submissions(bytes32) view returns (uint8)']);

async function setup({ threshold = 2 } = {}) {
  const node = await createPqNode({ names: ['gov'], fund: { r1: R1.addr.hex, r2: R2.addr.hex, stranger: STRANGER.addr.hex } });
  const relay = await node.chain.deploy('ZetaphyPythRelay', [node.chain.acct.gov.toString(), [R1.addr.hex, R2.addr.hex], threshold], 'gov');
  const sub = (k, extra = {}) => pqSubmitter({ rpcCall: node.rpcCall, publicKey: k.publicKey, sign: k.sign, sleep: async () => { await node.mine(); }, backoffMs: 1, ...extra });
  return { node, relay, sub };
}
const update = (price, t) => encodePriceFeed({ id: FEED, price, conf: 10n, expo: -8, publishTime: t });
const push = (s, data) => s.callEVM({ to: data.relay, data: RELAY.encodeFunctionData('updatePriceFeeds', [[data.u]]), evmGasLimit: 400_000n });

test('two PQ reporters push a Pyth price: msg.sender is each account\'s 0x address, threshold 2 of 2', async () => {
  const { node, relay, sub } = await setup();
  const t = Number(node.chain.now());
  const u = update(200_000_000n, t);
  const a = sub(R1); const b = sub(R2);
  const ra = await push(a, { relay: relay.address, u });
  await a.confirm(ra);
  assert.equal(await relay.call('submissions', [keccak256(u)]), 1n, 'one relayer so far');
  await assert.rejects(relay.call('getPriceUnsafe', [FEED]), /PriceFeedNotFound/);
  const rb = await push(b, { relay: relay.address, u });
  assert.deepEqual(await b.confirm(rb), { included: true, code: null }, 'without a tx index: the sequence moved on');
  const p = await relay.call('getPriceUnsafe', [FEED]);
  assert.equal(p.price, 200_000_000n);
  // a PQ account that is not a relayer is refused by eth_call before anything is signed
  const before = node.sent.length;
  await assert.rejects(push(sub(STRANGER), { relay: relay.address, u: update(1n, t + 1) }), /the call would fail, so nothing was sent/);
  assert.equal(node.sent.length, before);
});

test('back-to-back txs before a block: the submitter counts sequences on; the node accepts both, in order', async () => {
  const { node, relay, sub } = await setup({ threshold: 1 });
  const a = sub(R1);
  const t = Number(node.chain.now());
  const r1 = await push(a, { relay: relay.address, u: update(100n, t - 2) });
  const r2 = await push(a, { relay: relay.address, u: update(101n, t - 1) });
  const r3 = await push(a, { relay: relay.address, u: update(102n, t) });
  assert.deepEqual([r1.sequence, r2.sequence, r3.sequence], [0n, 1n, 2n], 'zetaphy_pqAccount still says 0: no block yet');
  assert.equal(node.mempool(), 3);
  await node.mine();
  assert.equal((await relay.call('getPriceUnsafe', [FEED])).price, 102n);
  assert.equal(a.nextSequence(), 3n);
  // parallel calls are queued, not raced
  const [x, y] = await Promise.all([push(a, { relay: relay.address, u: update(103n, t + 1) }), push(a, { relay: relay.address, u: update(104n, t + 2) })]);
  assert.deepEqual([x.sequence, y.sequence], [3n, 4n]);
});

test('another process with the same key: "sequence mismatch, expected N" is signed again with N', async () => {
  const { node, relay, sub } = await setup({ threshold: 1 });
  const a = sub(R1);
  const t = Number(node.chain.now());
  await push(a, { relay: relay.address, u: update(100n, t - 1) }); // sequence 0, still in the mempool
  const logs = [];
  const r = await pqSubmitter({ rpcCall: node.rpcCall, publicKey: R1.publicKey, sign: R1.sign, sleep: async () => {}, backoffMs: 1, log: (l) => logs.push(l) })
    .callEVM({ to: relay.address, data: RELAY.encodeFunctionData('updatePriceFeeds', [[update(101n, t)]]), evmGasLimit: 400_000n });
  assert.equal(r.sequence, 1n);
  assert.equal(r.attempts, 2);
  assert.match(logs[0], /code 32: account sequence mismatch, expected 1, got 0/);
  await node.mine();
  assert.equal((await relay.call('getPriceUnsafe', [FEED])).price, 101n);
});

test('a lost answer resends the same signed bytes: the tx runs once', async () => {
  const { node, relay, sub } = await setup({ threshold: 1 });
  const a = sub(R1, { log: () => {} });
  node.dropAnswers(1);
  const t = Number(node.chain.now());
  const r = await push(a, { relay: relay.address, u: update(100n, t) });
  assert.equal(r.attempts, 2);
  assert.equal(node.sent.length, 1, 'the node took one tx');
  await node.mine();
  assert.equal(r.sequence, 0n);
  assert.equal(a.nextSequence(), 1n);
  assert.equal((await node.rpcCall('zetaphy_pqAccount', [R1.addr.bech32])).sequence, '1');
});

test('refusals: a full mempool and a low fee are retried; other codes fail at once; retries run out', async () => {
  const { node, relay, sub } = await setup({ threshold: 1 });
  const t = Number(node.chain.now());
  node.failSends(2, 20, 'mempool is full');
  const r = await push(sub(R1), { relay: relay.address, u: update(100n, t - 3) });
  assert.equal(r.attempts, 3);
  // a node asking a higher fee: the price goes up 20 % per attempt
  node.failSends(1, 13, 'insufficient fee; got: 1azetaphy required: 2azetaphy: insufficient fee');
  const b = sub(R2);
  const r2 = await push(b, { relay: relay.address, u: update(101n, t - 2) });
  assert.equal(r2.gasPrice, (1_200_000_000n * 12n + 9n) / 10n);
  node.failSends(1, 4, 'unauthorized');
  await assert.rejects(push(sub(R1), { relay: relay.address, u: update(102n, t - 1) }), /rejected the transaction \(code 4\): unauthorized/);
  node.failSends(9, 20, 'mempool is full');
  await assert.rejects(push(sub(R1, { retries: 2 }), { relay: relay.address, u: update(103n, t) }), /not accepted after 3 attempts/);
});

test('confirm with a CometBFT tx index: a call that failed in the block throws', async () => {
  const { node, relay, sub } = await setup({ threshold: 1 });
  const a = sub(R1, { txResult: node.txResult });
  const t = Number(node.chain.now());
  const ok = await push(a, { relay: relay.address, u: update(100n, t) });
  assert.deepEqual(await a.confirm(ok), { included: true, code: 0, log: '' });
  // removed as a relayer between eth_call and the block: the tx lands and fails
  const bad = await push(a, { relay: relay.address, u: update(101n, t + 1) });
  await relay.send('gov', 'setRelayer', [R1.addr.hex, false]);
  await assert.rejects(a.confirm(bad), /is in a block but failed \(code 7\)/);
  // the HTTP side of cometTxResult
  const fake = async (url) => ({ json: async () => (url.endsWith('AB') ? { result: { tx_result: { log: 'ok' } } } : { error: 'not found' }) });
  assert.deepEqual(await cometTxResult('http://x/', fake)('AB'), { code: 0, log: 'ok' });
  assert.equal(await cometTxResult('http://x', fake)('CD'), null);
});

test('helpers: refusal parsing, unfunded account, the 64 KB limit', async () => {
  assert.equal(expectedSequence('account sequence mismatch, expected 12, got 9: incorrect account sequence'), 12n);
  assert.equal(expectedSequence('other'), null);
  assert.equal(classify({ code: 19, log: 'tx already exists in cache' }), 'accepted');
  assert.equal(classify({ code: 5, log: 'insufficient funds' }), 'fail');
  const { node, relay, sub } = await setup();
  const nobody = key(9);
  await assert.rejects(sub(nobody).callEVM({ to: relay.address, data: '0x' }), /does not exist on chain yet/);
  await assert.rejects(sub(R1).callEVM({ to: relay.address, data: '0x' + '00'.repeat(MAX_TX_BYTES), check: false }), /over the node's 65536-byte limit/);
  assert.equal(node.sent.length, 0);
  assert.throws(() => pqSubmitter({ rpcCall: node.rpcCall, publicKey: R1.publicKey }), /sign must be a function/);
});

test('zetaphy oracle push / poke --pq: the reporter signs with ML-DSA-44 and never touches the ECDSA key', async () => {
  const { node, relay, sub } = await setup({ threshold: 1 });
  const submitter = sub(R1);
  const connectPq = async () => ({ rpcCall: node.rpcCall, submitter, me: R1.addr.hex });
  const connect = async () => { throw new Error('the ECDSA key was used'); };
  const out = [];
  const run = (cmd, opt, rest = []) => oracleCommand({ group: 'oracle', cmd, rest, opt, env: {}, write: (l) => out.push(l), s: { pythRelay: relay.address }, connect, connectPq });
  assert.equal(await run('push', { pq: true, feed: FEED, price: '250000000' }), 0);
  assert.match(out.at(-1), new RegExp(`pushed ${FEED}: 250000000 x 10\\^-8 at ${node.chain.now()} \\(tx [0-9A-F]{64}, signed with ML-DSA-44 by ${R1.addr.hex}\\)`));
  assert.equal((await relay.call('getPriceUnsafe', [FEED])).price, 250_000_000n);
  // not a relayer: refused before signing
  const p3 = { rpcCall: node.rpcCall, submitter: sub(STRANGER), me: STRANGER.addr.hex };
  const rep = await pqReporter(p3, relay.address);
  assert.equal(await rep.isRelayer(), false);
  await assert.rejects(oracleCommand({ group: 'oracle', cmd: 'push', rest: [], opt: { pq: true, feed: FEED, price: '1' }, env: {}, write: () => {}, s: { pythRelay: relay.address }, connect, connectPq: async () => p3 }), /is not a relayer/);
  // poke --pq on a ZetaphyOracle (mock Pyth + no TWAP: the relay's price is the source)
  const oracle = await node.chain.deploy('ZetaphyOracle', [node.chain.acct.gov.toString(), '0x' + '00'.repeat(19) + '01', relay.address], 'gov');
  const asset = '0x' + '00'.repeat(19) + 'aa';
  await oracle.send('gov', 'setPythFeed', [asset, FEED, 120, 100]);
  await oracle.send('gov', 'setGuards', [asset, 200, 1500, 3000, 3600]);
  assert.equal(await run('poke', { pq: true, oracle: oracle.address }, [asset]), 0);
  assert.match(out.at(-1), /reference moved \(tx [0-9A-F]{64}, signed with ML-DSA-44/);
  assert.equal((await oracle.call('stateOf', [asset])).lastPrice, 25n * 10n ** 17n);
});

test('Hyperlane: a PQ account delivers a message to the Mailbox; the PQ ISM still decides', async () => {
  const V = [mldsaKey(), mldsaKey(), mldsaKey()];
  const node = await createPqNode({ names: ['gov'], fund: { r1: R1.addr.hex }, precompiles: PRECOMPILES });
  const kit = kitArtifacts();
  const mailbox = await node.chain.deployRaw(kit.KitMailbox, [77390], 'gov');
  const ism = await node.chain.deploy('PQMultisigIsm', [node.chain.acct.gov.toString(), V.map((k) => k.keyHash), 2], 'gov');
  await mailbox.send('gov', 'setDefaultIsm', [ism.address]);
  const rec = await node.chain.deployRaw(kit.KitRecorder, [], 'gov');
  const msg = (dest = 77390, nonce = 0) => solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
    [3, nonce, 97, zeroPadValue('0x' + 'bb'.repeat(20), 32), dest, zeroPadValue(rec.address, 32), '0xc0ffee']);
  const message = msg();
  const opts = { merkleTreeHook: '0x' + '99'.repeat(20), root: '0x' + '42'.repeat(32), index: 0 };
  const metadata = pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 2, key: V[2] }], opts);
  const submitter = pqSubmitter({ rpcCall: node.rpcCall, publicKey: R1.publicKey, sign: R1.sign, sleep: async () => { await node.mine(); }, txResult: node.txResult });

  // the calldata is Mailbox.process(metadata, message), as ethers encodes it
  const call = hyperlaneProcessCall({ mailbox: mailbox.address, metadata, message });
  assert.equal(call.data, new Interface(kit.KitMailbox.abi).encodeFunctionData('process', [metadata, message]));
  assert.equal(destinationOf(message), 77390);
  assert.equal(call.messageId, keccak256(message));

  // one validator signature is below the threshold: refused by eth_call, nothing signed
  const weak = pqIsmMetadata(message, [{ index: 1, key: V[1] }], opts);
  await assert.rejects(deliverHyperlane({ submitter, mailbox: mailbox.address, metadata: weak, message }), /the call would fail/);
  assert.equal(node.sent.length, 0);
  // a message for another domain is not sent
  await assert.rejects(deliverHyperlane({ submitter, mailbox: mailbox.address, metadata, message: msg(97) }), /for domain 97, this Mailbox is domain 77390/);

  const r = await deliverHyperlane({ submitter, mailbox: mailbox.address, metadata, message, confirm: true });
  assert.equal(r.alreadyDelivered, false);
  assert.equal(r.confirmed.code, 0);
  assert.equal(r.messageId, messageIdOf(message));
  assert.equal(await rec.call('count'), 1n);
  assert.equal(await rec.call('lastOrigin'), 97n);
  assert.equal(await rec.call('lastBody'), '0xc0ffee');
  assert.equal(await mailbox.call('delivered', [r.messageId]), true);
  const again = await deliverHyperlane({ submitter, mailbox: mailbox.address, metadata, message });
  assert.deepEqual(again, { messageId: r.messageId, alreadyDelivered: true });
  assert.equal(node.sent.length, 1);
});
