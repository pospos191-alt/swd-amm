// pqsnap.js: the ZETAPHY Snap (ML-DSA-44 in MetaMask) as an EIP-1193 provider for the dapps. The address is derived
// from the public key (never the snap's word), eth_sendTransaction becomes one evmCall signed by the snap and sent
// with zetaphy_sendCosmosTx, the result is read from CometBFT and handed to txguard's watch, ECDSA-only requests
// are refused, and every text exists in the 8 hub languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pqs from '../pqsnap.js';
import * as txg from '../txguard.js';
import { pqAddress, bytesToHex } from '../../zetaphy-network/src/pqtx.js';
import { ml_dsa44 } from '../../zetaphy-network/node_modules/@noble/post-quantum/ml-dsa.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const { publicKey } = ml_dsa44.keygen(SEED);
const ME = pqAddress(publicKey);
const TO = '0x' + '22'.repeat(20);
const HASH = 'AB'.repeat(32);

test('the address comes from the public key, as pqtx.js derives it (README vector)', async () => {
  const a = await pqs.pqAddressOf(publicKey);
  assert.equal(a.hex, ME.hex.toLowerCase());
  assert.equal(a.bech32, ME.bech32);
  assert.equal(a.bech32, 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r');
  assert.equal(a.hex, '0x6DA134EbFcb035273E87954f0641bD920ED073Ba'.toLowerCase());
  await assert.rejects(pqs.pqAddressOf(new Uint8Array(32)), /ML-DSA-44 public key/);
});

test('snapHost: only MetaMask (Flask first) runs snaps', () => {
  const mm = { kind: 'metamask', provider: {} }; const fl = { kind: 'flask', provider: {} }; const rb = { kind: 'rabby', provider: {} };
  assert.equal(pqs.snapHost([rb, mm]), mm);
  assert.equal(pqs.snapHost([mm, fl]), fl);
  assert.equal(pqs.snapHost([rb]), null);
  assert.equal(pqs.snapHost(null), null);
});

/** A fake MetaMask with the snap; `opts.lie` returns another address than the key's. */
function metamask(opts = {}) {
  const calls = [];
  const provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (opts.noSnaps && /Snap/.test(method)) throw Object.assign(new Error('Method not supported'), { code: -32601 });
      if (opts.unpublished && method === 'wallet_requestSnaps') throw Object.assign(new Error('Failed to fetch snap "npm:@zetaphy/snap": Failed to fetch NPM registry entry. Status code: 404.'), { code: -32603 });
      if (opts.unpublishedResult && method === 'wallet_requestSnaps') return { [pqs.SNAP_ID]: { error: { message: 'Failed to fetch snap "npm:@zetaphy/snap": Failed to fetch NPM registry entry. Status code: 404.' } } };
      if (method === 'wallet_getSnaps') return opts.installed === false ? {} : { [pqs.SNAP_ID]: { version: '0.1.0' } };
      if (method === 'wallet_requestSnaps') { if (opts.deny) throw Object.assign(new Error('User rejected'), { code: 4001 }); return { [pqs.SNAP_ID]: { version: '0.1.0' } }; }
      if (method === 'wallet_invokeSnap') {
        const r = params.request;
        if (r.method === 'zetaphy_getAccount') return { publicKey: '0x' + bytesToHex(publicKey), address: ME.bech32, hex: opts.lie ? '0x' + '33'.repeat(20) : ME.hex };
        if (r.method === 'zetaphy_signTx') { if (opts.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); return { txHex: '0xdeadbeef', txHash: HASH, signature: '0x00' }; }
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, calls };
}
/** A fake node: JSON-RPC answers and the CometBFT /tx result after `blocks` polls. */
function node(state = {}) {
  const calls = [];
  const rpc = async (m, p) => {
    calls.push({ m, p });
    if (m === 'zetaphy_pqAccount') return state.account ?? { exists: true, accountNumber: '12', sequence: '4', chainId: 'zetaphy_77390-1', address: ME.bech32 };
    if (m === 'eth_gasPrice') return '0x3b9aca00';
    if (m === 'eth_getBalance') return state.balance ?? '0xde0b6b3a7640000';
    if (m === 'eth_estimateGas') { if (state.reverts) throw new Error('execution reverted: no'); return '0x186a0'; }
    if (m === 'zetaphy_sendCosmosTx') return state.send ?? { code: 0, txHash: HASH, log: '' };
    if (m === 'eth_blockNumber') return '0x10';
    return null;
  };
  let polls = 0;
  const fetch = async (url) => {
    calls.push({ m: 'fetch', p: [url] });
    polls++;
    const found = polls > (state.blocks ?? 1);
    return { json: async () => (found ? { result: { height: '77', tx_result: { code: state.code ?? 0, log: state.log ?? '' } } } : { error: { data: 'tx not found' } }) };
  };
  return { rpc, fetch, calls };
}
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const make = (mm, n, extra = {}) => pqs.snapProvider({ host: mm.provider, rpc: n.rpc, fetch: n.fetch, comet: () => 'https://node.example/rpc/', clock: clock(), ...extra });

test('connect: the snap is requested, the account checked against its key; no prompt on eth_accounts', async () => {
  const mm = metamask();
  const p = make(mm, node());
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [ME.hex], 'already permitted: no prompt');
  p.forget();
  assert.deepEqual(await make(metamask({ installed: false }), node()).request({ method: 'eth_accounts' }), []);
  const seen = [];
  p.on('accountsChanged', (a) => seen.push(a));
  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), [ME.hex]);
  assert.deepEqual(seen, [[ME.hex]]);
  assert.ok(mm.calls.some((c) => c.method === 'wallet_requestSnaps' && c.params[pqs.SNAP_ID]));
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x12e4e');
  assert.equal(await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x12e4e' }] }), null);
  await assert.rejects(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), (e) => e.code === 4902);
  await assert.rejects(make(metamask({ lie: true }), node()).request({ method: 'eth_requestAccounts' }), /does not match its public key/);
  await assert.rejects(make(metamask({ noSnaps: true }), node()).request({ method: 'eth_requestAccounts' }), (e) => e.code === 4200 && /Flask/.test(e.message));
  await assert.rejects(make(metamask({ deny: true }), node()).request({ method: 'eth_requestAccounts' }), (e) => e.code === 4001);
  // the snap is not on npm yet: a plain sentence in the page's language, not MetaMask's raw 404
  await assert.rejects(make(metamask({ installed: false, unpublished: true }), node()).request({ method: 'eth_requestAccounts' }), (e) => e.code === 4200 && /not published yet/.test(e.message) && !/404/.test(e.message));
  await assert.rejects(make(metamask({ installed: false, unpublishedResult: true }), node(), { lang: () => 'th' }).request({ method: 'eth_requestAccounts' }), (e) => e.code === 4200 && /ยังไม่ได้เผยแพร่/.test(e.message));
});

test('eth_sendTransaction: one evmCall signed by the snap, sent as a Cosmos tx, settled for the watch', async () => {
  const mm = metamask();
  const n = node({ blocks: 2 });
  const p = make(mm, n, { lang: () => 'th' });
  await p.request({ method: 'eth_requestAccounts' });
  const hash = await p.request({ method: 'eth_sendTransaction', params: [{ from: ME.hex, to: TO, data: '0xA9059CBB', value: '0x5', chainId: '0x12e4e' }] });
  assert.equal(hash, `0x${HASH.toLowerCase()}`);
  const sign = mm.calls.find((c) => c.params?.request?.method === 'zetaphy_signTx').params.request.params;
  assert.equal(sign.chainId, 'zetaphy_77390-1');
  assert.equal(sign.accountNumber, '12');
  assert.equal(sign.sequence, '4');
  assert.equal(sign.lang, 'th');
  assert.deepEqual(sign.messages, [{ type: 'evmCall', to: TO, data: '0xa9059cbb', value: '5', gasLimit: '125000' }], 'estimate 100000 + 25%');
  assert.equal(sign.gasLimit, String(125000n + pqs.EVM_CALL_GAS_OVERHEAD));
  assert.equal(sign.gasPrice, String((1000000000n * 12n + 9n) / 10n));
  assert.ok(n.calls.some((c) => c.m === 'zetaphy_sendCosmosTx' && c.p[0] === '0xdeadbeef'));
  assert.ok(n.calls.some((c) => c.m === 'fetch' && c.p[0] === `https://node.example/rpc/tx?hash=0x${HASH}`));
  // txguard's watch takes the settled result (a Cosmos tx has no EVM receipt)
  const r = await txg.watchTx({ rpc: n.rpc, hash, ...clock() });
  assert.equal(r.status, 'ok');
  assert.equal(r.receipt.cosmosTxHash, HASH);
  assert.equal(r.receipt.blockNumber, '0x4d');
  assert.equal((await p.request({ method: 'eth_getTransactionReceipt', params: [hash] })).status, '0x1');
});

test('eth_sendTransaction: refusals before and after signing say why', async () => {
  const connected = async (mm, n) => { const p = make(mm, n); await p.request({ method: 'eth_requestAccounts' }); return p; };
  const tx = { to: TO, data: '0x', value: '0x0' };
  await assert.rejects((await connected(metamask(), node({ reverts: true }))).request({ method: 'eth_sendTransaction', params: [tx] }), /would fail on the chain/);
  await assert.rejects((await connected(metamask(), node({ account: { exists: false } }))).request({ method: 'eth_sendTransaction', params: [tx] }), new RegExp(`Send some ZETAPHY to ${ME.hex}`));
  await assert.rejects((await connected(metamask(), node({ balance: '0x1' }))).request({ method: 'eth_sendTransaction', params: [tx] }), /Not enough ZETAPHY/);
  await assert.rejects((await connected(metamask({ reject: true }), node())).request({ method: 'eth_sendTransaction', params: [tx] }), (e) => e.code === 4001);
  await assert.rejects((await connected(metamask(), node({ send: { code: 13, log: 'insufficient fee' } }))).request({ method: 'eth_sendTransaction', params: [tx] }), /refused the transaction: insufficient fee/);
  await assert.rejects((await connected(metamask(), node({ code: 5, log: 'evm call reverted' }))).request({ method: 'eth_sendTransaction', params: [tx] }),
    (e) => e.txGuard === 'failed' && /evm call reverted/.test(e.message) && txg.settledTx(e.hash)?.status === '0x0');
  await assert.rejects((await connected(metamask(), node({ blocks: 1e9 }))).request({ method: 'eth_sendTransaction', params: [tx] }), (e) => e.txGuard === 'timeout');
  await assert.rejects((await connected(metamask(), node())).request({ method: 'eth_sendTransaction', params: [{ ...tx, from: TO }] }), (e) => e.code === 4100);
  await assert.rejects((await connected(metamask(), node())).request({ method: 'eth_sendTransaction', params: [{ data: '0x6000' }] }), (e) => e.code === 4200, 'no contract creation here');
  await assert.rejects(make(metamask(), node()).request({ method: 'eth_sendTransaction', params: [tx] }), (e) => e.code === 4100, 'not connected');
});

test('ECDSA-only requests are refused with the reason; reads go to the node', async () => {
  const n = node();
  const p = make(metamask(), n, { lang: () => 'ja' });
  for (const method of ['personal_sign', 'eth_sign', 'eth_signTypedData_v4', 'eth_signTransaction']) {
    await assert.rejects(p.request({ method, params: [] }), (e) => e.code === 4200 && e.message === pqs.pqsText('ja', 'ecdsaOnly'), method);
  }
  assert.equal(await p.request({ method: 'eth_blockNumber' }), '0x10');
  assert.equal(await p.request({ method: 'wallet_watchAsset', params: {} }), false);
  await assert.rejects(p.request({ method: 'wallet_foo' }), (e) => e.code === 4200);
});

test('helpers: gas bounds, CometBFT answers, bech32', () => {
  assert.equal(pqs.evmGasFor(1n), pqs.MIN_EVM_GAS);
  assert.equal(pqs.evmGasFor(10n ** 9n), pqs.MAX_EVM_GAS);
  assert.equal(pqs.evmGasFor(100000n), 125000n);
  assert.equal(pqs.parseCometTx({ error: {} }), null);
  assert.deepEqual(pqs.parseCometTx({ result: { height: '9', tx_result: { code: 0, log: 'a‮b' } } }), { code: 0, log: 'a b', height: '9' });
  assert.equal(pqs.bech32('zetaphy', Uint8Array.from(Buffer.from('6da134ebfcb035273e87954f0641bd920ed073ba', 'hex'))), 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r');
});

test('every text exists in all 8 hub languages', () => {
  for (const l of pqs.PQS_LANGS) for (const k of ['btn', 'note', 'badge', 'noSnaps', 'notPublished', 'badAccount', 'notFunded', 'noFunds', 'ecdsaOnly', 'wouldFail', 'refused']) {
    const m = pqs.pqsText(l, k, 'x');
    assert.ok(typeof m === 'string' && m.trim().length >= 2, `${l}.${k}`);
    if (l !== 'en') assert.notEqual(m, pqs.pqsText('en', k, 'x'), `${l}.${k} translated`);
  }
  assert.deepEqual(pqs.PQS_LANGS, txg.TXG_LANGS);
});

test('the hub, Swap and NFT offer the snap and keep its wallet id', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  for (const [file, imp] of [['zetaphy-hub/walletbar.js', './pqsnap.js'], ['zetaphy-dex/web/app.js', './lib/pqsnap.js'], ['zetaphy-nft/web/app.js', './lib/pqsnap.js']]) {
    const s = read(file);
    assert.ok(s.includes(`from '${imp}'`), `${file} imports pqsnap`);
    assert.match(s, /snapProvider\(/, `${file} builds the provider`);
    assert.match(s, /PQSNAP_ID/, `${file} restores the choice`);
  }
  assert.match(read('zetaphy-dex/web/lib/storage.js'), /zetaphy-snap/);
  assert.match(read('zetaphy-nft/web/app.js'), /\|zetaphy-snap\)\$\//);
});
