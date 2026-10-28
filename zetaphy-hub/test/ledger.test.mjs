// ledger.js, the Ledger-over-USB EIP-1193 shim, against a mocked transport that answers like the
// Ethereum app (GET ADDRESS / SIGN TX / SIGN PERSONAL MESSAGE) with keys from a test mnemonic, so
// every signature is checked with ethers: the signed transaction recovers to the Ledger account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HDNodeWallet, Transaction, keccak256, hashMessage, verifyMessage, getBytes, hexlify, decodeRlp, Signature } from 'ethers';
import { ledgerProvider, pathBytes, rlp, intBytes, unsignedTx, LEDGER_ID_RE, ledgerId, ledgerPath, getAddress } from '../ledger.js';
import { ledgerReason, SAFETY_TEXT } from '../wallet-safety.js';

const MN = 'test test test test test test test test test test test junk';
const CHAIN = 77390;
const wallet = (i) => HDNodeWallet.fromPhrase(MN, undefined, `m/44'/60'/0'/0/${i}`);
const u8 = (...xs) => Uint8Array.from(xs.flatMap((x) => (x instanceof Uint8Array ? [...x] : Array.isArray(x) ? x : [x])));
const OK = [0x90, 0x00];

function parsePath(b) {
  const n = b[0];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(dv.getUint32(1 + i * 4));
  return { index: parts[4], rest: b.subarray(1 + n * 4), parts };
}
/** Byte length of the RLP item at the start of b. */
function rlpTotal(b) {
  const p = b[0];
  if (p < 0x80) return 1;
  if (p < 0xb8) return 1 + p - 0x80;
  if (p < 0xc0) { const l = p - 0xb7; return 1 + l + Number(BigInt(hexlify(b.subarray(1, 1 + l)))); }
  if (p < 0xf8) return 1 + p - 0xc0;
  const l = p - 0xf7; return 1 + l + Number(BigInt(hexlify(b.subarray(1, 1 + l))));
}

/** A fake Ledger running the Ethereum app. `reject`: the user presses reject (SW 0x6985). */
function mockLedger({ reject = false } = {}) {
  const log = { opens: 0, closes: 0, open: 0, maxOpen: 0, apdus: [] };
  let txBuf = null; let txIndex = null; let msg = null;
  const transport = () => ({
    async send(cla, ins, p1, p2, data) {
      assert.equal(cla, 0xe0);
      log.apdus.push({ ins, p1, len: data.length });
      assert.ok(data.length <= 255, 'an APDU carries at most 255 bytes');
      if (ins === 0x02) {
        const { index, parts } = parsePath(data);
        assert.deepEqual(parts.slice(0, 4), [0x8000002c, 0x8000003c, 0x80000000, 0]);
        const w = wallet(index);
        const pub = getBytes(w.signingKey.publicKey);
        const addr = new TextEncoder().encode(w.address.slice(2));
        return u8(pub.length, pub, addr.length, addr, OK);
      }
      if (ins === 0x04) {
        if (p1 === 0x00) { const { index, rest } = parsePath(data); txIndex = index; txBuf = rest; } else txBuf = u8(txBuf, data);
        assert.equal(txBuf[0], 2, 'an EIP-1559 (type 2) transaction');
        if (txBuf.length < 1 + rlpTotal(txBuf.subarray(1))) return u8(OK);
        if (reject) throw Object.assign(new Error('Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)'), { statusCode: 0x6985 });
        const sig = wallet(txIndex).signingKey.sign(keccak256(txBuf));
        return u8(sig.yParity, getBytes(sig.r), getBytes(sig.s), OK);
      }
      if (ins === 0x08) {
        if (p1 === 0x00) { const { index, rest } = parsePath(data); const len = new DataView(rest.buffer, rest.byteOffset).getUint32(0); msg = { index, len, buf: rest.subarray(4) }; } else msg.buf = u8(msg.buf, data);
        if (msg.buf.length < msg.len) return u8(OK);
        if (reject) throw Object.assign(new Error('denied'), { statusCode: 0x6985 });
        const sig = wallet(msg.index).signingKey.sign(hashMessage(msg.buf));
        return u8(sig.v, getBytes(sig.r), getBytes(sig.s), OK);
      }
      throw Object.assign(new Error('INS not supported'), { statusCode: 0x6d00 });
    },
    async close() { log.closes++; log.open--; },
  });
  const openTransport = async ({ prompt }) => {
    log.opens++; log.open++; log.maxOpen = Math.max(log.maxOpen, log.open); log.lastPrompt = prompt;
    await new Promise((r) => setTimeout(r, 1));
    return transport();
  };
  return { openTransport, log };
}

function mockNode() {
  const sent = [];
  const rpc = async (method, params) => {
    switch (method) {
      case 'eth_getTransactionCount': return '0x7';
      case 'eth_estimateGas': return '0x5208';
      case 'eth_getBlockByNumber': return { baseFeePerGas: '0x3b9aca00' };
      case 'eth_maxPriorityFeePerGas': return '0x77359400';
      case 'eth_sendRawTransaction': sent.push(params[0]); return keccak256(params[0]);
      case 'eth_getBalance': return '0x10';
      default: throw new Error(`not mocked: ${method}`);
    }
  };
  return { rpc, sent };
}

test('ids, paths and encodings', () => {
  assert.equal(ledgerId(3), 'ledger:3');
  assert.ok(LEDGER_ID_RE.test('ledger:0') && LEDGER_ID_RE.test('ledger:999'));
  for (const bad of ['ledger:', 'ledger:1000', 'ledger:-1', 'ledger:a', 'Ledger:1']) assert.ok(!LEDGER_ID_RE.test(bad), bad);
  assert.equal(ledgerPath(4), "44'/60'/0'/0/4");
  assert.equal(hexlify(pathBytes("44'/60'/0'/0/4")), '0x058000002c8000003c800000000000000000000004');
  assert.throws(() => pathBytes("44'/x/0"));
  // RLP agrees with ethers
  const item = [intBytes(0), intBytes(1), intBytes(1024), getBytes('0x' + 'ab'.repeat(60)), [intBytes(77390)]];
  const dec = decodeRlp(rlp(item));
  assert.deepEqual(dec, ['0x', '0x01', '0x0400', '0x' + 'ab'.repeat(60), ['0x012e4e']]);
  // the unsigned type-2 payload is what ethers serializes
  const tx = { chainId: 77390n, nonce: 7n, maxPriorityFeePerGas: 2n, maxFeePerGas: 3n, gas: 21000n, to: '0x' + '11'.repeat(20), value: 5n, data: '0x1234' };
  assert.equal(hexlify(unsignedTx(tx)), Transaction.from({ type: 2, ...tx, gasLimit: tx.gas }).unsignedSerialized);
});

test('connect: the device picker once, then an account chosen from the list (m/44\'/60\'/0\'/0/i)', async () => {
  const { openTransport, log } = mockLedger();
  const { rpc } = mockNode();
  const seen = [];
  let stored = null;
  const p = ledgerProvider({ win: {}, rpc, chainId: CHAIN, openTransport, onIndex: (i) => { stored = ledgerId(i); },
    chooseAccount: async ({ load }) => { for (let i = 0; i < 3; i++) seen.push(await load(i)); return 2; } });
  assert.equal(p.isLedger, true);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [], 'nothing before connecting');
  const changed = [];
  p.on('accountsChanged', (a) => changed.push(a));
  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), [wallet(2).address]);
  assert.deepEqual(seen, [0, 1, 2].map((i) => wallet(i).address));
  assert.equal(stored, 'ledger:2');
  assert.deepEqual(changed, [[wallet(2).address]]);
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x12e4e');
  assert.equal(await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x12e4e' }] }), null);
  await assert.rejects(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), (e) => e.code === 4902);
  assert.equal(log.opens, log.closes, 'the device is closed after each use');
  assert.equal(log.maxOpen, 1, 'one operation at a time');
  // a reconnect (the stored id): no picker, the address is read again silently
  const again = ledgerProvider({ win: {}, rpc, chainId: CHAIN, openTransport, index: 2 });
  assert.deepEqual(await again.request({ method: 'eth_accounts' }), [wallet(2).address]);
  assert.equal(log.lastPrompt, false, 'eth_accounts never prompts');
  const cancelled = ledgerProvider({ win: {}, rpc, chainId: CHAIN, openTransport, chooseAccount: async () => null });
  await assert.rejects(cancelled.request({ method: 'eth_requestAccounts' }), (e) => e.code === 4001);
});

test('eth_sendTransaction: filled from the node, signed on the device (chunked), recovers to the account', async () => {
  const { openTransport, log } = mockLedger();
  const { rpc, sent } = mockNode();
  const toasts = [];
  const p = ledgerProvider({ win: {}, rpc, chainId: CHAIN, openTransport, index: 1, onDevice: () => { toasts.push('on'); return () => toasts.push('off'); } });
  const [acc] = await p.request({ method: 'eth_requestAccounts' });
  assert.equal(acc, wallet(1).address);
  const data = '0x095ea7b3' + '22'.repeat(32) + 'ff'.repeat(32) + 'ab'.repeat(300); // longer than one APDU
  const hash = await p.request({ method: 'eth_sendTransaction', params: [{ from: acc.toLowerCase(), to: '0x' + '33'.repeat(20), data, value: '0x2a', chainId: '0x12e4e' }] });
  assert.equal(sent.length, 1);
  assert.equal(hash, keccak256(sent[0]));
  const tx = Transaction.from(sent[0]);
  assert.equal(tx.type, 2);
  assert.equal(tx.chainId, 77390n);
  assert.equal(tx.from, acc, 'signed by the Ledger account');
  assert.equal(tx.nonce, 7);
  assert.equal(tx.gasLimit, (21000n * 12n) / 10n + 1000n, 'estimate + 20 %');
  assert.equal(tx.maxPriorityFeePerGas, 2_000_000_000n);
  assert.equal(tx.maxFeePerGas, 2n * 1_000_000_000n + 2_000_000_000n);
  assert.equal(tx.value, 42n);
  assert.equal(tx.data, data);
  assert.ok(log.apdus.filter((a) => a.ins === 0x04).length >= 2, 'sent in several chunks');
  assert.deepEqual(toasts, ['on', 'off'], '"confirm on your Ledger" while it signs');
  // eth_signTransaction: the raw signed transaction, nothing sent
  const raw = await p.request({ method: 'eth_signTransaction', params: [{ to: '0x' + '44'.repeat(20), gas: '0x5208', maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x1', nonce: '0x0' }] });
  assert.equal(Transaction.from(raw).from, acc);
  assert.equal(Transaction.from(raw).gasLimit, 21000n);
  assert.equal(sent.length, 1);
  // refused: another sender, another chain, typed data
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ from: '0x' + '55'.repeat(20), to: acc }] }), (e) => e.code === 4100);
  await assert.rejects(p.request({ method: 'eth_sendTransaction', params: [{ to: acc, chainId: '0x1' }] }), (e) => e.code === 4901);
  await assert.rejects(p.request({ method: 'eth_signTypedData_v4', params: [acc, '{}'] }), (e) => e.code === 4200);
  // reads go to the node
  assert.equal(await p.request({ method: 'eth_getBalance', params: [acc, 'latest'] }), '0x10');
  assert.equal(log.opens, log.closes);
});

test('personal_sign (hex and text), rejection on the device, forget', async () => {
  const { openTransport } = mockLedger();
  const { rpc } = mockNode();
  const p = ledgerProvider({ win: {}, rpc, chainId: CHAIN, openTransport, index: 0 });
  const [acc] = await p.request({ method: 'eth_requestAccounts' });
  const long = 'Sign in to ZETAPHY '.repeat(20);
  const sig = await p.request({ method: 'personal_sign', params: [hexlify(new TextEncoder().encode(long)), acc] });
  assert.equal(verifyMessage(long, sig), acc);
  assert.equal(Signature.from(sig).v >= 27, true);
  assert.equal(verifyMessage('hello', await p.request({ method: 'personal_sign', params: ['hello', acc] })), acc);
  const changed = [];
  p.on('accountsChanged', (a) => changed.push(a));
  p.forget();
  assert.deepEqual(changed, [[]], 'forget tells the page');
  await assert.rejects(p.request({ method: 'personal_sign', params: ['0x00', acc] }), (e) => e.code === 4100, 'nothing is signed after forget');

  const r = mockLedger({ reject: true });
  const q = ledgerProvider({ win: {}, rpc, chainId: CHAIN, openTransport: r.openTransport, index: 0 });
  await q.request({ method: 'eth_requestAccounts' });
  const err = await q.request({ method: 'eth_sendTransaction', params: [{ to: acc, value: '0x1' }] }).catch((e) => e);
  assert.equal(err.statusCode, 0x6985);
  const t = (k, v = {}) => SAFETY_TEXT.en[k].replace(/\{(\w+)\}/g, (_, x) => v[x]);
  assert.equal(ledgerReason(err, t), 'rejected on the device');
  assert.equal(ledgerReason({ statusCode: 0x6a80 }, t), SAFETY_TEXT.en.ldBlind);
  assert.equal(ledgerReason({ statusCode: 0x6e00 }, t), SAFETY_TEXT.en.ldLocked);
  assert.equal(r.log.opens, r.log.closes, 'closed after a rejection too');
});

test('getAddress reads the app answer (public key, then the address as text)', async () => {
  const { openTransport } = mockLedger();
  assert.equal(await getAddress(await openTransport({ prompt: false }), ledgerPath(5)), wallet(5).address);
});
