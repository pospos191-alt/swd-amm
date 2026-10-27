// ZETAPHY web apps' pure code: the hub's wallet bar and chain lib, and the
// explorer's decoders and formatters, against ethers and round trips.

import { cleanId, balanceOfData, decodeString as hubDecodeString, formatUnits as hubFormatUnits } from '../../zetaphy-hub/walletbar.js';
import * as hub from '../../zetaphy-hub/chainlib.js';
import * as fmt from '../../zetaphy-explorer/src/format.js';
import * as evm from '../../zetaphy-explorer/src/evm.js';
import { Wallet, Transaction, AbiCoder, Interface, encodeRlp, formatUnits as ethersFormatUnits, getAddress, zeroPadValue, toBeHex } from '../../zetaphy-dex/node_modules/ethers/lib.esm/index.js';
import { ok, eq } from '../lib/harness.mjs';
import { junkText, toHex } from '../lib/rng.mjs';

const coder = AbiCoder.defaultAbiCoder();
const ERC20 = new Interface(['function balanceOf(address)']);
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-';
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ------------------------------------------------------------------ Z7
export const walletbar = {
  group: 'ZETAPHY', name: 'zetaphy/hub-walletbar', count: 600,
  what: 'hub wallet bar: cleanId accepts every id the site writes (plain or JSON) and rejects any mutation outside the id grammar; balanceOfData = ethers; decodeString never throws, returns only letters/digits/space/._- (max 12, no broken surrogate pairs) and round-trips plain symbols; formatUnits = ethers (4 decimals, grouped)',
  gen(R) {
    const kind = R.pick(['id', 'id', 'addr', 'str', 'str', 'junk', 'units']);
    const id = R.bool() ? `6963:${R.str(R.range(1, 120), ID_CHARS)}` : `injected:${R.str(R.range(1, 20), 'abcdefghijklmnopqrstuvwxyz0123456789')}`;
    return {
      kind, id, mut: R.pick(['char', 'long', 'prefix', 'case', 'quote']), at: R.u32(), bad: R.pick(['<', '>', ' ', '"', '/', 'é', '\n', '\u202e', '(', "'", '%', '😀']),
      addr: '0x' + R.hex(20), sym: R.str(R.range(0, 12), 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'), text: junkText(R, 40), b32: R.bool(0.3),
      junk: R.pick(['0x', '', 'x']) + R.hex(R.int(140)) + R.pick(['', 'zz', 'g']), v: R.big(R.int(220)), dec: R.range(0, 36),
    };
  },
  check(c) {
    if (c.kind === 'id') {
      eq(cleanId(c.id), c.id, 'plain id kept'); eq(cleanId(JSON.stringify(c.id)), c.id, 'JSON id kept');
      let m;
      const [pre, rest] = [c.id.slice(0, c.id.indexOf(':') + 1), c.id.slice(c.id.indexOf(':') + 1)];
      if (c.mut === 'char') { const i = c.at % (rest.length + 1); m = pre + rest.slice(0, i) + c.bad + rest.slice(i); }
      else if (c.mut === 'long') m = pre + rest + 'a'.repeat(pre === 'injected:' ? 21 : 121);
      else if (c.mut === 'prefix') m = (pre === 'injected:' ? '6964:' : 'injected2:') + rest;
      else if (c.mut === 'case') m = pre === 'injected:' ? pre + rest.toUpperCase() + 'X' : pre.toUpperCase().replace('6963', '6963x') + rest;
      else m = '"' + c.id;
      eq(cleanId(m), null, `mutated id ${JSON.stringify(m)} rejected`);
      eq(cleanId(JSON.stringify(m)), null, 'mutated JSON id rejected');
      return;
    }
    if (c.kind === 'addr') { eq(balanceOfData(c.addr), ERC20.encodeFunctionData('balanceOf', [c.addr]), 'balanceOf calldata'); return; }
    const okOut = (s) => {
      ok(typeof s === 'string', 'string');
      ok(/^[\p{L}\p{N} ._-]*$/u.test(s), `only letters/digits/space/._- : ${JSON.stringify(s)}`);
      ok(s.length <= 12, 'at most 12');
      ok(!lone.test(s), `no broken surrogate pair: ${JSON.stringify(s)}`);
    };
    if (c.kind === 'str') {
      const enc = c.b32 ? '0x' + Buffer.from(c.sym).toString('hex').padEnd(64, '0') : coder.encode(['string'], [c.sym]);
      if (!c.b32 || c.sym.length) eq(hubDecodeString(enc), c.sym, `symbol ${c.sym} round trip`);
      const text = c.text.replace(new RegExp(lone.source, 'g'), ''); // ethers refuses lone surrogates (pairs stay)
      if (Buffer.from(text).length <= 64) okOut(hubDecodeString(coder.encode(['string'], [text])));
      return;
    }
    if (c.kind === 'junk') { okOut(hubDecodeString(c.junk)); return; }
    const e = ethersFormatUnits(c.v, c.dec);
    const [i, f = ''] = e.split('.');
    const frac = f.slice(0, 4).replace(/0+$/, '');
    eq(hubFormatUnits(c.v, c.dec), group(i) + (frac ? '.' + frac : ''), `formatUnits(${c.v}, ${c.dec})`);
  },
};

// ------------------------------------------------------------------ Z8
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
export const chainlib = {
  group: 'ZETAPHY', name: 'zetaphy/hub-chainlib-bech32', count: 300,
  what: 'hub chainlib: toEvm(toBech32(a)) = a, hub and explorer bech32 agree (two implementations), any single-character change of a bech32 address is rejected; parseUnits/formatUnits and parseZeta/formatZeta round trips',
  gen(R) {
    const dec = R.range(0, 18);
    const w = R.str(R.range(1, 12), '0123456789'), f = dec ? R.str(R.range(1, dec), '0123456789') : '';
    return { addr: '0x' + R.hex(20), hrp: R.pick(['zetaphy', 'zetaphyvaloper', 'cosmos']), pos: R.u32(), ch: R.int(32), dec, amount: f ? `${w}.${f}` : w, upper: R.bool(0.2) };
  },
  check({ addr, hrp, pos, ch, dec, amount, upper }) {
    const b = hub.toBech32(addr, hrp);
    eq(hub.toEvm(upper ? b.toUpperCase() : b), addr.toLowerCase(), 'bech32 round trip');
    if (hrp === 'zetaphy') eq(fmt.toAddress(addr)?.bech32, b, 'hub and explorer give the same bech32');
    const i = hrp.length + 1 + (pos % (b.length - hrp.length - 1));
    const repl = B32[ch] === b[i] ? B32[(ch + 1) % 32] : B32[ch];
    const bad = b.slice(0, i) + repl + b.slice(i + 1);
    let threw = false; try { hub.toEvm(bad); } catch { threw = true; }
    ok(threw, `one changed character is caught by the checksum: ${bad}`);
    eq(fmt.toAddress(bad), null, 'explorer rejects it too');
    const v = hub.parseUnits(amount, dec);
    const [w, f = ''] = amount.split('.');
    const want = group(BigInt(w).toString()) + (f.replace(/0+$/, '') ? '.' + f.replace(/0+$/, '') : '');
    eq(hub.formatUnits(v, dec, 18), want, `parseUnits/formatUnits round trip of ${amount}`);
    // amount has <= 12 whole digits and <= 18 decimals: always a valid ZETAPHY amount
    eq(hub.formatZeta(hub.parseZeta(amount), 18), want, 'parseZeta/formatZeta round trip');
  },
};

// ------------------------------------------------------------------ Z9
const WALLET = new Wallet('0x' + '11'.repeat(32));
const T = evm.TOPICS;
const pad = (a) => zeroPadValue(a, 32).toLowerCase();
const randRlp = (R, depth = 0) => (depth < 3 && R.bool(0.35) ? Array.from({ length: R.int(5) }, () => randRlp(R, depth + 1)) : '0x' + R.hex(R.pick([0, 1, 1, 2, 20, 55, 56, 60])));
const sameRlp = (a, b) => (Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((x, i) => sameRlp(x, b[i])) : b instanceof Uint8Array && '0x' + toHex(b) === a);

export const explorer = {
  group: 'ZETAPHY', name: 'zetaphy/explorer-decoders', count: 600,
  what: 'explorer: decodeRawEvmTx = ethers-signed legacy/2930/1559 txs; rlpDecode round-trips ethers RLP and only throws "rlp:" errors on junk; decodeTransfer reads ethers-encoded ERC-20/721/1155 logs and returns null for wrong shapes; decodeAbiString; safeText strips control/bidi chars; formatUnits = ethers; parseQuery classifies heights/hashes/addresses',
  gen(R) {
    const kind = R.pick(['tx', 'tx', 'rlp', 'rlpjunk', 'log', 'log', 'str', 'units', 'query']);
    return {
      kind,
      tx: { type: R.pick([0, 1, 2]), nonce: R.int(1e6), gasLimit: 21000 + R.int(1e7), to: R.bool(0.9) ? getAddress('0x' + R.hex(20)) : null, value: R.big(R.int(120)), data: '0x' + R.hex(R.pick([0, 3, 4, 36, 68, 200])), chainId: R.pick([1, 56, 77390, 8453]), gasPrice: R.big(40), maxFeePerGas: R.big(40) + 1n, maxPriorityFeePerGas: R.big(30) },
      rlp: randRlp(R), junk: R.bytes(R.int(80)),
      std: R.pick(['erc20', 'erc721', 'single', 'batch', 'bad']), token: '0x' + R.hex(20), from: R.bool(0.2) ? '0x' + '00'.repeat(20) : '0x' + R.hex(20), to: '0x' + R.hex(20), op: '0x' + R.hex(20), amt: R.big(R.int(257)), ids: Array.from({ length: R.int(5) }, () => R.big(R.int(257))),
      text: junkText(R, 80), max: R.range(1, 60), v: R.bool(0.1) ? -R.big(R.int(200)) : R.big(R.int(200)), dec: R.range(0, 40),
      q: R.pick([() => String(R.range(1, 1e9)), () => '#' + R.range(1, 1e6), () => '0x' + R.hex(32), () => R.hex(32).toUpperCase(), () => '0x' + R.hex(20), () => '0', () => junkText(R, 20)])(),
    };
  },
  async check(c) {
    if (c.kind === 'tx') {
      const t = { ...c.tx };
      if (t.type === 2) delete t.gasPrice; else { delete t.maxFeePerGas; delete t.maxPriorityFeePerGas; }
      if (t.type === 1) t.accessList = [];
      const raw = await WALLET.signTransaction(t);
      const d = evm.decodeRawEvmTx(Uint8Array.from(Buffer.from(raw.slice(2), 'hex')));
      const e = Transaction.from(raw);
      ok(d, 'decoded');
      eq(d.type, e.type, 'type'); eq(d.nonce, BigInt(e.nonce), 'nonce'); eq(d.gas, e.gasLimit, 'gas'); eq(d.value, e.value, 'value');
      eq(d.to, e.to, 'to (EIP-55 or null)');
      eq(d.selector, e.data.length >= 10 ? e.data.slice(0, 10) : '', 'selector');
      eq(d.dataLength, (e.data.length - 2) / 2, 'data length');
      return;
    }
    if (c.kind === 'rlp') {
      const enc = Uint8Array.from(Buffer.from(encodeRlp(c.rlp).slice(2), 'hex'));
      ok(sameRlp(c.rlp, evm.rlpDecode(enc)), 'RLP round trip');
      return;
    }
    if (c.kind === 'rlpjunk') {
      try { evm.rlpDecode(c.junk); } catch (e) { ok(/^rlp:/.test(e.message), `junk RLP fails with an rlp: error, not ${e.constructor.name}: ${e.message}`); }
      ok(evm.decodeRawEvmTx(c.junk) === null || typeof evm.decodeRawEvmTx(c.junk) === 'object', 'decodeRawEvmTx never throws');
      return;
    }
    if (c.kind === 'log') {
      const ck = (a) => getAddress(a);
      let log, want;
      if (c.std === 'erc20' || c.std === 'bad') {
        log = { address: c.token, topics: [T.transfer, pad(c.from), pad(c.to)], data: coder.encode(['uint256'], [c.amt]) };
        want = { standard: 'erc20', token: ck(c.token), from: ck(c.from), to: ck(c.to), amount: c.amt };
        if (c.std === 'bad') { log.topics.push(pad(c.op)); want = null; } // 4 topics with data: neither ERC-20 nor ERC-721
      } else if (c.std === 'erc721') {
        log = { address: c.token, topics: [T.transfer, pad(c.from), pad(c.to), toBeHex(c.amt, 32)], data: '0x' };
        want = { standard: 'erc721', token: ck(c.token), from: ck(c.from), to: ck(c.to), tokenId: c.amt };
      } else if (c.std === 'single') {
        log = { address: c.token, topics: [T.transferSingle, pad(c.op), pad(c.from), pad(c.to)], data: coder.encode(['uint256', 'uint256'], [c.amt, c.amt / 3n]) };
        want = { standard: 'erc1155', token: ck(c.token), operator: ck(c.op), from: ck(c.from), to: ck(c.to), ids: [c.amt], amounts: [c.amt / 3n] };
      } else {
        const amounts = c.ids.map((x) => x / 7n);
        log = { address: c.token, topics: [T.transferBatch, pad(c.op), pad(c.from), pad(c.to)], data: coder.encode(['uint256[]', 'uint256[]'], [c.ids, amounts]) };
        want = { standard: 'erc1155', token: ck(c.token), operator: ck(c.op), from: ck(c.from), to: ck(c.to), ids: c.ids, amounts };
      }
      const got = evm.decodeTransfer(log);
      if (want) { want.mint = want.from === ck('0x' + '00'.repeat(20)); want.burn = false; }
      const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      eq(j(got), j(want), `decodeTransfer ${c.std}`);
      // a topic that is not an address (high bytes set) is never read as one
      const broken = { ...log, topics: log.topics.map((t, i) => (i === 1 ? '0xff' + t.slice(4) : t)) };
      eq(evm.decodeTransfer(broken), null, 'non-address topic -> null');
      return;
    }
    if (c.kind === 'str') {
      const s = fmt.safeText(c.text, c.max);
      ok(!/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/u.test(s), `safeText removes control/format chars: ${JSON.stringify(s)}`);
      ok([...s].length <= c.max + 1, 'safeText bounded');
      ok(!/\s{2,}/.test(s) && s === s.trim(), 'whitespace collapsed');
      const clean = c.text.replace(/[\ud800-\udfff]/g, '');
      const d = evm.decodeAbiString(coder.encode(['string'], [clean]), c.max);
      eq(d, fmt.tokenText(clean, c.max, '') || null, 'decodeAbiString = tokenText of the string');
      return;
    }
    if (c.kind === 'units') {
      const e = ethersFormatUnits(c.v, Math.min(c.dec, 255));
      const [i, f = ''] = e.replace('-', '').split('.');
      const frac = f.replace(/0+$/, '');
      const want = (c.v < 0n ? '-' : '') + group(i) + (frac ? '.' + frac : '');
      eq(fmt.formatUnits(c.v, c.dec, { maxFrac: null }), want, 'formatUnits (full precision) vs ethers');
      eq(fmt.formatUnits('junk', c.dec), '?', 'junk amount');
      return;
    }
    const r = fmt.parseQuery(c.q);
    const q = c.q.trim();
    if (/^#?\d{1,19}$/.test(q)) eq(r.type, BigInt(q.replace('#', '')) > 0n ? 'block' : 'invalid', `height ${q}`);
    else if (/^(0x)?[0-9a-fA-F]{64}$/.test(q)) { eq(r.type, 'hash', 'hash'); eq(r.hash, q.replace(/^0x/, '').toLowerCase(), 'hash value'); }
    else if (/^0x[0-9a-fA-F]{40}$/.test(q)) { eq(r.type, 'address', 'address'); eq(r.address.lower, q.toLowerCase(), 'address value'); }
    else ok(['invalid', 'address', 'valoper'].includes(r.type), `junk query -> ${r.type}`);
  },
};

export default [walletbar, chainlib, explorer];
