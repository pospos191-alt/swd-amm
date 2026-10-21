// EVM helpers: token Transfer events (ERC-20 / ERC-721 / ERC-1155), ABI return
// values (name, symbol, decimals, totalSupply), and token metadata reads.
// Pure decoding functions plus readers that take a JSON-RPC call function.
import { keccak_256, bytesToHex, hexToBytes, toChecksumHex } from '../vendor/zetaphy-lib.js';
import { tokenText } from './format.js';

const enc = new TextEncoder();
const topicOf = (sig) => '0x' + bytesToHex(keccak_256(enc.encode(sig)));
const sel = (sig) => bytesToHex(keccak_256(enc.encode(sig))).slice(0, 8);

export const TOPICS = {
  transfer: topicOf('Transfer(address,address,uint256)'),
  transferSingle: topicOf('TransferSingle(address,address,address,uint256,uint256)'),
  transferBatch: topicOf('TransferBatch(address,address,address,uint256[],uint256[])'),
};
export const SEL = {
  name: sel('name()'), symbol: sel('symbol()'), decimals: sel('decimals()'), totalSupply: sel('totalSupply()'),
  balanceOf: sel('balanceOf(address)'), supportsInterface: sel('supportsInterface(bytes4)'), owner: sel('owner()'),
};
export const IFACE = { erc721: '80ac58cd', erc1155: 'd9b67a26', erc165: '01ffc9a7' };

const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';

/** Bytes of a 0x hex string, or null when it is not one. */
export function hexBytes(h) {
  if (typeof h !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(h)) return null;
  return hexToBytes(h);
}

/** A 32-byte topic holding an address -> EIP-55 address (null if not an address). */
export function topicAddress(t) {
  const b = hexBytes(t);
  if (!b || b.length !== 32 || b.subarray(0, 12).some((x) => x)) return null;
  return toChecksumHex(b.subarray(12));
}

const wordAt = (b, i) => (b.length >= 32 * (i + 1) ? BigInt('0x' + (bytesToHex(b.subarray(32 * i, 32 * i + 32)) || '0')) : null);

/** A uint256 array in ABI data at word offset `at` (bounded). */
function uintArray(b, at) {
  const off = wordAt(b, at);
  if (off == null || off % 32n || off + 32n > BigInt(b.length)) return null;
  const o = Number(off / 32n);
  const n = wordAt(b, o);
  if (n == null || n > 256n || BigInt(b.length) < (BigInt(o) + 1n + n) * 32n) return null;
  return Array.from({ length: Number(n) }, (_, i) => wordAt(b, o + 1 + i));
}

/**
 * A token transfer in a log, or null:
 *   { standard: 'erc20', token, from, to, amount }
 *   { standard: 'erc721', token, from, to, tokenId }
 *   { standard: 'erc1155', token, operator, from, to, ids: [], amounts: [] }
 * mint: from is the zero address; burn: to is.
 */
export function decodeTransfer(log) {
  const topics = Array.isArray(log?.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
  const data = hexBytes(log?.data ?? '0x');
  let token;
  try { token = toChecksumHex(hexToBytes(String(log?.address ?? ''))); } catch { return null; }
  if (!data || hexToBytes(String(log.address)).length !== 20) return null;
  const t0 = topics[0];
  let out = null;
  if (t0 === TOPICS.transfer) {
    if (topics.length === 3 && data.length === 32) {
      const from = topicAddress(topics[1]); const to = topicAddress(topics[2]);
      if (from && to) out = { standard: 'erc20', token, from, to, amount: wordAt(data, 0) };
    } else if (topics.length === 4 && data.length === 0) {
      const from = topicAddress(topics[1]); const to = topicAddress(topics[2]);
      if (from && to) out = { standard: 'erc721', token, from, to, tokenId: BigInt(topics[3]) };
    }
  } else if (t0 === TOPICS.transferSingle && topics.length === 4 && data.length === 64) {
    const [operator, from, to] = topics.slice(1).map(topicAddress);
    if (operator && from && to) out = { standard: 'erc1155', token, operator, from, to, ids: [wordAt(data, 0)], amounts: [wordAt(data, 1)] };
  } else if (t0 === TOPICS.transferBatch && topics.length === 4) {
    const [operator, from, to] = topics.slice(1).map(topicAddress);
    const ids = uintArray(data, 0); const amounts = uintArray(data, 1);
    if (operator && from && to && ids && amounts && ids.length === amounts.length) out = { standard: 'erc1155', token, operator, from, to, ids, amounts };
  }
  if (out) { out.mint = out.from === ZERO; out.burn = out.to === ZERO; }
  return out;
}

/**
 * An ABI-encoded string return value; also the bytes32 form some old tokens use.
 * Sanitised (no control / bidi characters, bounded). null when it is neither.
 */
export function decodeAbiString(hex, max = 48) {
  const b = hexBytes(hex);
  if (!b || b.length < 32) return null;
  if (b.length === 32) { // bytes32 name
    const end = b.indexOf(0);
    const s = new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
    return tokenText(s, max, '') || null;
  }
  const off = wordAt(b, 0);
  if (off == null || off + 32n > BigInt(b.length)) return null;
  const len = wordAt(b.subarray(Number(off)), 0);
  if (len == null || len > 4096n || off + 32n + len > BigInt(b.length)) return null;
  const s = new TextDecoder().decode(b.subarray(Number(off) + 32, Number(off) + 32 + Number(len)));
  return tokenText(s, max, '') || null;
}

/** A uint256 return value (null if not one). */
export function decodeUint(hex) {
  const b = hexBytes(hex);
  return b && b.length >= 32 ? wordAt(b, 0) : null;
}

/** A bool return value (null if not one). */
export function decodeBool(hex) {
  const v = decodeUint(hex);
  return v == null ? null : v !== 0n;
}

export const callData = {
  balanceOf: (addr) => '0x' + SEL.balanceOf + word(BigInt(addr)),
  supportsInterface: (id) => '0x' + SEL.supportsInterface + id.padEnd(64, '0'),
};

/**
 * What a contract says about itself as a token (each read best effort):
 * { standard: 'erc20' | 'erc721' | 'erc1155' | null, name, symbol, decimals, totalSupply }.
 * ethCall(to, data) -> hex result (throws on revert).
 */
export async function readTokenInfo(ethCall, address) {
  const tryCall = async (data) => { try { return await ethCall(address, data); } catch { return null; } };
  const [nameHex, symbolHex, decHex, supplyHex, i721, i1155] = await Promise.all([
    tryCall('0x' + SEL.name), tryCall('0x' + SEL.symbol), tryCall('0x' + SEL.decimals), tryCall('0x' + SEL.totalSupply),
    tryCall(callData.supportsInterface(IFACE.erc721)), tryCall(callData.supportsInterface(IFACE.erc1155)),
  ]);
  const name = decodeAbiString(nameHex); const symbol = decodeAbiString(symbolHex, 16);
  const decimals = decodeUint(decHex); const totalSupply = decodeUint(supplyHex);
  let standard = null;
  if (decodeBool(i721)) standard = 'erc721';
  else if (decodeBool(i1155)) standard = 'erc1155';
  else if (totalSupply != null && decimals != null && decimals <= 255n) standard = 'erc20';
  return { standard, name, symbol, decimals: decimals != null && decimals <= 255n ? Number(decimals) : null, totalSupply };
}

// ---- raw EVM transactions (MsgEthereumTx.raw): enough to list them without asking the node ----

/** Minimal RLP reader: Uint8Array (string) or array (list). Throws on malformed input. */
export function rlpDecode(b) {
  const [item, end] = rlpItem(b, 0);
  if (end !== b.length) throw new Error('rlp: trailing bytes');
  return item;
}

function rlpLen(b, at, n) {
  if (n > 4 || at + n > b.length) throw new Error('rlp: bad length');
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[at + i];
  return v;
}

function rlpItem(b, i) {
  if (i >= b.length) throw new Error('rlp: truncated');
  const p = b[i];
  if (p < 0x80) return [b.subarray(i, i + 1), i + 1];
  if (p < 0xb8) { const n = p - 0x80; if (i + 1 + n > b.length) throw new Error('rlp: truncated'); return [b.subarray(i + 1, i + 1 + n), i + 1 + n]; }
  if (p < 0xc0) { const ll = p - 0xb7; const n = rlpLen(b, i + 1, ll); const s = i + 1 + ll; if (s + n > b.length) throw new Error('rlp: truncated'); return [b.subarray(s, s + n), s + n]; }
  let s, n;
  if (p < 0xf8) { n = p - 0xc0; s = i + 1; } else { const ll = p - 0xf7; n = rlpLen(b, i + 1, ll); s = i + 1 + ll; }
  if (s + n > b.length) throw new Error('rlp: truncated');
  const out = []; let j = s;
  while (j < s + n) { const [it, nx] = rlpItem(b, j); out.push(it); j = nx; }
  if (j !== s + n) throw new Error('rlp: bad list');
  return [out, s + n];
}

const rlpUint = (x) => (x instanceof Uint8Array && x.length ? BigInt('0x' + bytesToHex(x)) : 0n);

/**
 * A signed EVM tx's fields: { type, nonce, gas, to (EIP-55 or null: contract creation), value, selector (first 4 bytes of data, 0x…, or '') , dataBytes }.
 * Legacy, EIP-2930 (1), EIP-1559 (2) and EIP-7702 (4) layouts. null when it cannot be read.
 */
export function decodeRawEvmTx(raw) {
  try {
    const typed = raw.length && raw[0] < 0x7f;
    const type = typed ? raw[0] : 0;
    const f = rlpDecode(typed ? raw.subarray(1) : raw);
    if (!Array.isArray(f)) return null;
    // index of nonce, gas, to, value, data per type
    const idx = { 0: [0, 2, 3, 4, 5], 1: [1, 3, 4, 5, 6], 2: [1, 4, 5, 6, 7], 3: [1, 4, 5, 6, 7], 4: [1, 4, 5, 6, 7] }[type];
    if (!idx) return { type };
    const [n, g, t, v, d] = idx.map((k) => f[k]);
    const to = t instanceof Uint8Array && t.length === 20 ? toChecksumHex(t) : null;
    const data = d instanceof Uint8Array ? d : new Uint8Array();
    return { type, nonce: rlpUint(n), gas: rlpUint(g), to, value: rlpUint(v), selector: data.length >= 4 ? '0x' + bytesToHex(data.subarray(0, 4)) : '', dataLength: data.length };
  } catch { return null; }
}
