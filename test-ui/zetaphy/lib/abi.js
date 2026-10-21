// Minimal Ethereum ABI encoding/decoding for the ZETAPHY DEX page, with no
// third-party code: only the types the DEX calls use (address, uint, bool,
// bytes32, address[], string). Selectors are precomputed (keccak-256 is not
// needed in the page); zetaphy-dex/test/web-lib.test.js checks every one
// against ethers.

export const SEL = {
  'balanceOf(address)': '0x70a08231',
  'allowance(address,address)': '0xdd62ed3e',
  'approve(address,uint256)': '0x095ea7b3',
  'decimals()': '0x313ce567',
  'symbol()': '0x95d89b41',
  'name()': '0x06fdde03',
  'totalSupply()': '0x18160ddd',
  'getPair(address,address)': '0xe6a43905',
  'allPairsLength()': '0x574f2ba3',
  'allPairs(uint256)': '0x1e3dd18b',
  'threatRegistry()': '0x0d728240',
  'getReserves()': '0x0902f1ac',
  'token0()': '0x0dfe1681',
  'token1()': '0xd21220a7',
  'getAmountsOut(uint256,address[])': '0xd06ca61f',
  'getAmountsIn(uint256,address[])': '0x1f00ca74',
  'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)': '0x38ed1739',
  'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)': '0x8803dbee',
  'swapExactETHForTokens(uint256,address[],address,uint256)': '0x7ff36ab5',
  'swapTokensForExactETH(uint256,uint256,address[],address,uint256)': '0x4a25d94a',
  'swapExactTokensForETH(uint256,uint256,address[],address,uint256)': '0x18cbafe5',
  'swapETHForExactTokens(uint256,address[],address,uint256)': '0xfb3bdb41',
  'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)': '0x5c11d795',
  'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)': '0xb6f9de95',
  'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)': '0x791ac947',
  'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)': '0xe8e33700',
  'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)': '0xf305d719',
  'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)': '0xbaa2abde',
  'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)': '0x02751cec',
  'removeLiquidityETHSupportingFeeOnTransferTokens(address,uint256,uint256,uint256,address,uint256)': '0xaf2979eb',
  'isContractFlagged(address)': '0x084f55a9',
  'isContractEnforced(address)': '0x8328cef5',
  'isFlagged(bytes32)': '0xbf2dde38',
  'isEnforced(bytes32)': '0x16e2466c',
  'WETH()': '0xad5c4648',
  'factory()': '0xc45a0155',
};

/** Custom errors of the router and pair (and Error(string)), by selector. */
export const ERRORS = {
  '0x3eb792d8': 'TokenEnforced',
  '0x39486dbc': 'RegistryUnavailable',
  '0x203d82d8': 'Expired',
  '0x42301c23': 'InsufficientOutputAmount',
  '0xe1b0da4f': 'ExcessiveInputAmount',
  '0x8dc525d1': 'InsufficientAAmount',
  '0xef71d091': 'InsufficientBAmount',
  '0xbb55fd27': 'InsufficientLiquidity',
  '0x098fb561': 'InsufficientInputAmount',
  '0xa932492f': 'K',
  '0x0f2e5b6c': 'Locked',
  '0x90b8ec18': 'TransferFailed',
  '0xd226f9d4': 'InsufficientLiquidityMinted',
  '0x749383ad': 'InsufficientLiquidityBurned',
  '0x20db8267': 'InvalidPath',
  '0xf4b3b1bc': 'NativeTransferFailed',
  '0x08c379a0': 'Error',
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (a) => typeof a === 'string' && ADDR_RE.test(a);
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const word = (v) => {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error('uint out of range');
  return n.toString(16).padStart(64, '0');
};

function encodeStatic(type, v) {
  if (type === 'address') {
    if (!isAddress(v)) throw new Error('bad address');
    return v.slice(2).toLowerCase().padStart(64, '0');
  }
  if (type === 'bool') return word(v ? 1 : 0);
  if (type === 'bytes32') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error('bad bytes32');
    return v.slice(2).toLowerCase();
  }
  if (/^uint\d*$/.test(type)) return word(v);
  throw new Error(`unsupported type ${type}`);
}

/** abi.encode of `values` with `types` (static types and address[]). */
export function encodeArgs(types, values) {
  if (types.length !== values.length) throw new Error('argument count');
  let head = '';
  let tail = '';
  const headSize = 32 * types.length;
  types.forEach((t, i) => {
    if (t === 'address[]') {
      head += word(headSize + tail.length / 2);
      tail += word(values[i].length) + values[i].map((a) => encodeStatic('address', a)).join('');
    } else head += encodeStatic(t, values[i]);
  });
  return head + tail;
}

/** Calldata: SEL[signature] + encoded arguments. */
export function encodeCall(signature, values = []) {
  const sel = SEL[signature];
  if (!sel) throw new Error(`unknown function ${signature}`);
  const inner = signature.slice(signature.indexOf('(') + 1, -1);
  const types = inner ? inner.split(',') : [];
  return sel + encodeArgs(types, values);
}

function hexBody(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bad hex');
  return hex.slice(2);
}
const at = (h, i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));

/** Decodes return data for these output types: uint*, address, bool, bytes32, string, uint256[]. */
export function decode(types, hex) {
  const h = hexBody(hex);
  if (h.length < 64 * types.length) throw new Error('short return data');
  return types.map((t, i) => {
    if (/^uint\d*$/.test(t)) return at(h, i);
    if (t === 'bool') return at(h, i) !== 0n;
    if (t === 'address') return '0x' + h.slice(i * 64 + 24, i * 64 + 64);
    if (t === 'bytes32') return '0x' + h.slice(i * 64, i * 64 + 64);
    const off = Number(at(h, i)) * 2;
    if (off + 64 > h.length) throw new Error('bad offset');
    const len = Number(BigInt('0x' + h.slice(off, off + 64)));
    if (t === 'string') {
      if (len > 4096 || off + 64 + len * 2 > h.length) throw new Error('bad string');
      const bytes = new Uint8Array(len);
      for (let j = 0; j < len; j++) bytes[j] = parseInt(h.slice(off + 64 + j * 2, off + 66 + j * 2), 16);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    if (t === 'uint256[]') {
      if (len > 64 || off + 64 + len * 64 > h.length) throw new Error('bad array');
      return Array.from({ length: len }, (_, j) => BigInt('0x' + h.slice(off + 64 + j * 64, off + 128 + j * 64)));
    }
    throw new Error(`unsupported type ${t}`);
  });
}

/**
 * A string some older tokens return as bytes32 (e.g. MKR's symbol): the
 * printable prefix. Used when decode(['string']) fails.
 */
export function decodeBytes32String(hex) {
  const h = hexBody(hex).slice(0, 64);
  const bytes = [];
  for (let j = 0; j < h.length; j += 2) { const b = parseInt(h.slice(j, j + 2), 16); if (b === 0) break; bytes.push(b); }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** { name, args } of revert data from the router/pair, or null. */
export function decodeError(hex) {
  if (typeof hex !== 'string' || hex.length < 10) return null;
  const name = ERRORS[hex.slice(0, 10).toLowerCase()];
  if (!name) return null;
  const body = '0x' + hex.slice(10);
  try {
    if (name === 'TokenEnforced') { const [token, reason] = decode(['address', 'uint8'], body); return { name, args: [token, Number(reason)] }; }
    if (name === 'Error') return { name, args: decode(['string'], body) };
  } catch { return { name, args: [] }; }
  return { name, args: [] };
}

// ---- amounts ----

/** "1.5" -> 1500000000000000000n for 18 decimals. Throws on anything else than a plain decimal. */
export function parseUnits(text, decimals) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) throw new Error('bad amount');
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error('too many decimals');
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** 1500000000000000000n -> "1.5" (at most `maxFrac` fraction digits, rounded down). */
export function formatUnits(v, decimals, maxFrac = 6) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const i = a / base;
  let f = (a % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFrac)).replace(/0+$/, '');
  if (f === '' && a % base !== 0n && i === 0n) f = ''; // below the shown precision
  return (neg ? '-' : '') + i.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
}
