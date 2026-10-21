// DLMM helpers for the DEX page (UNAUDITED contracts in zetaphy-dex/contracts/dlmm/),
// no third-party code: the ABI encoding the DLMM calls need (signed ints,
// arrays, tuples), selectors (checked against ethers in
// zetaphy-dex/test/dlmm.web-lib.test.js), bin <-> price conversions for
// display, and the liquidity shapes the page offers (the contracts take
// explicit per-bin amounts; the shape is the page's choice).

export const DSEL = {
  'getPair(address,address,uint16)': '0x09175fa7',
  'presetSteps()': '0x72e2c8b6',
  'presets(uint16)': '0x68998608',
  'threatRegistry()': '0x0d728240',
  'getActiveId()': '0xdbe65edc',
  'getBin(int24)': '0x50257a6d',
  'getPriceFromId(int24)': '0x3ee08863',
  'balanceOf(address,int24)': '0x074e624e',
  'totalSupply(int24)': '0x79d7b0ac',
  'getNextNonEmptyBin(bool,int24)': '0xb397e222',
  'tokenX()': '0x16dc165b',
  'tokenY()': '0xb7d19fc4',
  'binStep()': '0xc5bf3832',
  'baseFeeBps()': '0xbf5a5940',
  'isApprovedForAll(address,address)': '0xe985e9c5',
  'setApprovalForAll(address,bool)': '0xa22cb465',
  'reserveX()': '0x08eabdda',
  'reserveY()': '0xfadfa65b',
  'getSwapOut(uint256,bool)': '0x253845c8',
  'getAmountsOut(uint256,(uint16[],address[]))': '0x266987b6',
  'getAmountsIn(uint256,(uint16[],address[]))': '0xacf2c97b',
  'addLiquidity((address,address,uint16,int24,uint24,int24[],uint256[],uint256[],uint256,uint256,address,uint256))': '0x9c171376',
  'addLiquidityNATIVE((address,address,uint16,int24,uint24,int24[],uint256[],uint256[],uint256,uint256,address,uint256))': '0xc6660b81',
  'removeLiquidity(address,address,uint16,int24[],uint256[],uint256,uint256,address,uint256)': '0xab65b593',
  'removeLiquidityNATIVE(address,uint16,int24[],uint256[],uint256,uint256,address,uint256)': '0xb5af46bd',
  'swapExactTokensForTokens(uint256,uint256,(uint16[],address[]),address,uint256)': '0x4e1652a2',
  'swapExactNATIVEForTokens(uint256,(uint16[],address[]),address,uint256)': '0x18a6ede5',
  'swapExactTokensForNATIVE(uint256,uint256,(uint16[],address[]),address,uint256)': '0x66e243bf',
  'approve(address,uint256)': '0x095ea7b3',
  'allowance(address,address)': '0xdd62ed3e',
  'WNATIVE()': '0xb381cf40',
};

/** DLMM custom errors by selector (pair, router, factory). */
export const DLMM_ERRORS = {
  '0x6b9697ac': 'BalanceBelowReserves', '0xe1b0da4f': 'ExcessiveInputAmount', '0x203d82d8': 'Expired',
  '0x9bfa3c17': 'FeeOnTransferNotSupported', '0x14e49ede': 'IdSlippage', '0x5bee5a2c': 'IdsNotSorted',
  '0xdf5b2ee6': 'InsufficientAmountIn', '0xe52970aa': 'InsufficientAmountOut', '0xbb55fd27': 'InsufficientLiquidity',
  '0x42301c23': 'InsufficientOutputAmount', '0x52374aff': 'InsufficientShares', '0x3485a179': 'InsufficientXAmount',
  '0xfab7bc8c': 'InsufficientYAmount', '0x947d5a84': 'InvalidLength', '0x20db8267': 'InvalidPath',
  '0x0f2e5b6c': 'Locked', '0xc19f17a9': 'NotApproved', '0x725128bd': 'OutOfLiquidity', '0x35278d12': 'Overflow',
  '0xd719ab69': 'PairNotFound', '0x58059e81': 'PresetNotEnabled', '0xdd407666': 'PriceOutOfRange',
  '0x39486dbc': 'RegistryUnavailable', '0x090aa206': 'SingleSidedViolation', '0x3eb792d8': 'TokenEnforced',
  '0x2dedf167': 'TooManyBinsCrossed', '0x90b8ec18': 'TransferFailed', '0x8c8854ea': 'UnsortedTokens',
  '0xe66e49f3': 'WrongNativeAmount', '0x1f2a2005': 'ZeroAmount', '0xc2374b77': 'ZeroShares',
};

const MASK256 = (1n << 256n) - 1n;
const word = (v) => (BigInt.asUintN(256, BigInt(v))).toString(16).padStart(64, '0');

function isAddr(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

/**
 * ABI-encodes `values` as `types`. Types: 'address', 'bool', 'uintN', 'intN',
 * 'T[]' (T static), and tuples as arrays of types. Throws on anything else
 * or a value out of range.
 */
export function encodeArgs(types, values) {
  if (types.length !== values.length) throw new Error('arity');
  const heads = [];
  const tails = [];
  let tailLen = 0;
  const headLen = types.reduce((n, t) => n + headSize(t), 0);
  types.forEach((t, i) => {
    if (isDynamic(t)) {
      heads.push(word(headLen + tailLen));
      const enc = encodeOne(t, values[i]);
      tails.push(enc);
      tailLen += enc.length / 2;
    } else {
      heads.push(encodeOne(t, values[i]));
    }
  });
  return heads.join('') + tails.join('');
}

function isDynamic(t) {
  if (Array.isArray(t)) return t.some(isDynamic);
  return t.endsWith('[]') || t === 'string' || t === 'bytes';
}

function headSize(t) {
  if (isDynamic(t)) return 32;
  if (Array.isArray(t)) return t.reduce((n, x) => n + headSize(x), 0);
  return 32;
}

function encodeOne(t, v) {
  if (Array.isArray(t)) {
    if (!Array.isArray(v)) throw new Error('tuple value');
    return encodeArgs(t, v);
  }
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2);
    if (!Array.isArray(v)) throw new Error('array value');
    return word(v.length) + encodeArgs(v.map(() => inner), v);
  }
  if (t === 'address') {
    if (!isAddr(v)) throw new Error(`bad address ${v}`);
    return v.slice(2).toLowerCase().padStart(64, '0');
  }
  if (t === 'bool') return word(v ? 1 : 0);
  const m = /^(u?)int(\d+)$/.exec(t);
  if (!m) throw new Error(`type ${t}`);
  const bits = BigInt(m[2]);
  const x = BigInt(v);
  if (m[1] === 'u') {
    if (x < 0n || x >= 1n << bits) throw new Error(`${t} out of range`);
    return word(x);
  }
  const half = 1n << (bits - 1n);
  if (x < -half || x >= half) throw new Error(`${t} out of range`);
  return word(x & MASK256);
}

/** selector + encoded arguments. */
export function encodeDlmmCall(sig, types, values) {
  const sel = DSEL[sig];
  if (!sel) throw new Error(`unknown function ${sig}`);
  return sel + encodeArgs(types, values);
}

/** Decodes static words ('uintN', 'intN', 'address', 'bool') and 'uint256[]' / 'int24[]'. */
export function decodeWords(types, hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const at = (i) => BigInt('0x' + (h.slice(i * 64, i * 64 + 64) || '0'));
  return types.map((t, i) => {
    if (t.endsWith('[]')) {
      const off = Number(at(i)) / 32;
      const n = Number(at(off));
      return Array.from({ length: n }, (_, k) => one(t.slice(0, -2), at(off + 1 + k)));
    }
    return one(t, at(i));
  });
}

function one(t, w) {
  if (t === 'address') return '0x' + w.toString(16).padStart(40, '0').slice(-40);
  if (t === 'bool') return w !== 0n;
  const m = /^(u?)int(\d+)$/.exec(t);
  if (!m) throw new Error(`type ${t}`);
  return m[1] === 'u' ? w : BigInt.asIntN(256, w);
}

/** The DLMM error name in revert data, or null. */
export function dlmmErrorName(data) {
  if (typeof data !== 'string' || data.length < 10) return null;
  return DLMM_ERRORS[data.slice(0, 10).toLowerCase()] ?? null;
}

// ---------------------------------------------------------------- prices

/** Raw price (Y units per X unit) of bin `id`: (1 + binStep/10^4)^id, as a float (display only). */
export function rawPrice(id, binStep) {
  return Math.exp(id * Math.log1p(binStep / 10_000));
}

/** Price of one whole X in whole Y (adjusted for decimals), as a float (display only). */
export function displayPrice(id, binStep, decX, decY) {
  return rawPrice(id, binStep) * 10 ** (decX - decY);
}

/** The bin whose price is closest to `price` (whole Y per whole X). */
export function idFromPrice(price, binStep, decX, decY) {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('price');
  const raw = price * 10 ** (decY - decX);
  return Math.round(Math.log(raw) / Math.log1p(binStep / 10_000));
}

// ---------------------------------------------------------------- shapes

/**
 * Per-bin amounts for a range of `below` bins under the active bin and
 * `above` bins over it (the active bin included), spending at most
 * `totalX` (above and in the active bin) and `totalY` (below and in the
 * active bin). shape: 'spot' (flat), 'curve' (more near the price),
 * 'bidask' (more away from the price). `activeRatio` = { x, y } is the
 * active bin's current reserves (both 0 for an empty bin): the active bin
 * then gets X and Y in that ratio, so nothing is refunded.
 * Returns { deltas, ax, ay } (strictly increasing deltas, zero bins left out).
 */
export function distribute({ below, above, totalX, totalY, shape = 'spot', activeRatio = { x: 0n, y: 0n } }) {
  if (!Number.isInteger(below) || !Number.isInteger(above) || below < 0 || above < 0 || below + above + 1 > 100) throw new Error('range');
  const weight = (d, n) => {
    if (shape === 'curve') return BigInt(Math.max(1, Math.round(1000 * Math.exp(-((d / Math.max(1, n / 2)) ** 2)))));
    if (shape === 'bidask') return BigInt(1 + Math.round(1000 * (d / Math.max(1, n))));
    return 1000n;
  };
  // X: active bin (weight of d = 0) and bins 1..above; Y: active bin and -1..-below.
  const xs = [];
  const ys = [];
  for (let d = 0; d <= above; d++) xs.push([d, weight(d, above)]);
  for (let d = 0; d <= below; d++) ys.push([-d, weight(d, below)]);
  const split = (total, list) => {
    const sum = list.reduce((s, [, w]) => s + w, 0n);
    return new Map(list.map(([d, w]) => [d, sum === 0n ? 0n : (total * w) / sum]));
  };
  const mx = split(totalX, xs);
  const my = split(totalY, ys);
  // The active bin must match its own ratio when it holds liquidity.
  let x0 = mx.get(0) ?? 0n;
  let y0 = my.get(0) ?? 0n;
  const { x: rx, y: ry } = activeRatio;
  if (rx > 0n && ry > 0n) {
    if (x0 * ry > y0 * rx) x0 = (y0 * rx) / ry; else y0 = (x0 * ry) / rx;
  } else if (rx > 0n) y0 = 0n;
  else if (ry > 0n) x0 = 0n;
  mx.set(0, x0);
  my.set(0, y0);
  const deltas = [];
  const ax = [];
  const ay = [];
  for (let d = -below; d <= above; d++) {
    const x = d >= 0 ? mx.get(d) ?? 0n : 0n;
    const y = d <= 0 ? my.get(d) ?? 0n : 0n;
    if (x === 0n && y === 0n) continue;
    deltas.push(d);
    ax.push(x);
    ay.push(y);
  }
  return { deltas, ax, ay };
}

/** Lowest amount after slippage (bps), rounded down. */
export const minAfter = (v, bps) => (v * BigInt(10_000 - bps)) / 10_000n;
