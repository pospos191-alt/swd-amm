// Small pure helpers for the hub: no dependencies, tested in test/chainlib.test.js.
//  - bech32: 0x… <-> zetaphy1… (the same 20 bytes; the REST API wants zetaphy1…)
//  - ABI calldata for the Cosmos EVM staking / distribution / gov precompiles
//  - azetaphy (10^18) <-> ZETAPHY text

export const PRECOMPILES = {
  staking: '0x0000000000000000000000000000000000000800',
  distribution: '0x0000000000000000000000000000000000000801',
  gov: '0x0000000000000000000000000000000000000805',
  ics20: '0x0000000000000000000000000000000000000802', // IBC transfer (ZETAPHY Saphan)
};

// keccak256 selectors (computed with ethers' id(), checked in the test)
export const SELECTORS = {
  delegate: '0x53266bbb', // delegate(address,string,uint256)
  undelegate: '0x3edab33c', // undelegate(address,string,uint256)
  claimRewards: '0x2efe8a5f', // claimRewards(address,uint32)
  vote: '0x9ec4d363', // vote(address,uint64,uint8,string)
  ibcTransfer: '0x632535b9', // transfer(string,string,string,uint256,address,string,(uint64,uint64),uint64,string)
};
/** The ICS-20 precompile's IBCTransfer(address,string,string,string,string,uint256,string) event: proof a packet left. */
export const IBC_TRANSFER_TOPIC = '0xc01eca5e742fe6641c4be501c2bebf224472f69176a0552e87e30147a6411303';
/** True when a receipt carries the precompile's IBCTransfer event (a call to an inactive precompile succeeds and does nothing). */
export const sentIbcTransfer = (receipt) => Boolean(receipt?.logs?.some((l) =>
  String(l.address).toLowerCase() === PRECOMPILES.ics20 && String(l.topics?.[0]).toLowerCase() === IBC_TRANSFER_TOPIC));

// ---------------------------------------------------------------- bech32
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('bad data');
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('bad padding');
  return out;
}

export function bech32Encode(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...chk].map((d) => CHARSET[d]).join('')}`;
}

export function bech32Decode(str) {
  const s = String(str).toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length || s.length > 90) throw new Error('not bech32');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('not bech32'); return i; });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('bad checksum');
  return { hrp, bytes: convertBits(data.slice(0, -6), 5, 8, false) };
}

const hexBytes = (hex) => { const h = hex.replace(/^0x/, ''); return h.match(/../g).map((b) => parseInt(b, 16)); };
export const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));

/** 0x… -> zetaphy1… (same account). */
export function toBech32(evm, hrp = 'zetaphy') {
  if (!isEvmAddress(evm)) throw new Error('not a 0x address');
  return bech32Encode(hrp, hexBytes(evm));
}

/** zetaphy1… / zetaphyvaloper1… -> 0x… (lower case). */
export function toEvm(b32) {
  const { bytes } = bech32Decode(b32);
  if (bytes.length !== 20) throw new Error('not a 20-byte address');
  return `0x${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------- ABI
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const uint = (n) => { const v = BigInt(n); if (v < 0n || v >= 2n ** 256n) throw new Error('uint out of range'); return word(v.toString(16)); };
const addr = (a) => { if (!isEvmAddress(a)) throw new Error('not a 0x address'); return word(a.slice(2).toLowerCase()); };
function str(s) {
  const bytes = new TextEncoder().encode(String(s));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return uint(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}

/** Encode (static…, one string) where the string is the argument at index `si`. */
function encode(selector, args, si) {
  const heads = [], tail = str(args[si].value);
  for (let i = 0; i < args.length; i++) heads.push(i === si ? uint(32 * args.length) : args[i].enc(args[i].value));
  return selector + heads.join('') + tail;
}

export const encodeDelegate = (delegator, validator, amount) =>
  encode(SELECTORS.delegate, [{ enc: addr, value: delegator }, { value: validator }, { enc: uint, value: amount }], 1);
export const encodeUndelegate = (delegator, validator, amount) =>
  encode(SELECTORS.undelegate, [{ enc: addr, value: delegator }, { value: validator }, { enc: uint, value: amount }], 1);
export const encodeClaimRewards = (delegator, maxRetrieve = 50) => {
  if (!Number.isInteger(maxRetrieve) || maxRetrieve < 1 || maxRetrieve > 0xffffffff) throw new Error('maxRetrieve');
  return SELECTORS.claimRewards + addr(delegator) + uint(maxRetrieve);
};
/** option: 1 yes, 2 abstain, 3 no, 4 no with veto (Cosmos gov). */
export const encodeVote = (voter, proposalId, option, metadata = '') => {
  if (![1, 2, 3, 4].includes(option)) throw new Error('vote option 1-4');
  return encode(SELECTORS.vote, [{ enc: addr, value: voter }, { enc: uint, value: proposalId }, { enc: uint, value: option }, { value: metadata }], 3);
};

/**
 * ICS-20 transfer through the precompile (ZETAPHY Saphan): `amount` of `denom`
 * (azetaphy or ibc/…) from `sender` (0x…, the MetaMask account) to `receiver`
 * (a bech32 address on the other chain) over transfer/`channel`. It times out
 * at `timeoutNs` (unix time in nanoseconds); no height timeout.
 */
export function encodeIbcTransfer({ channel, denom, amount, sender, receiver, timeoutNs, memo = '' }) {
  if (!/^channel-\d{1,6}$/.test(String(channel))) throw new Error('channel');
  if (!/^(azetaphy|ibc\/[0-9A-F]{64}|[a-z][a-z0-9/:._-]{1,127})$/.test(String(denom))) throw new Error('denom');
  if (BigInt(amount) <= 0n) throw new Error('amount');
  bech32Decode(receiver);
  const t = BigInt(timeoutNs);
  if (t <= 0n || t >= 2n ** 64n) throw new Error('timeout');
  // head: 9 arguments, the Height tuple (static) takes two words
  const parts = [
    { s: 'transfer' }, { s: channel }, { s: denom }, { w: uint(amount) }, { w: addr(sender) }, { s: receiver },
    { w: uint(0) + uint(0) }, { w: uint(t) }, { s: memo },
  ];
  let off = 32 * 10, tail = '';
  const head = parts.map((p) => {
    if (p.w) return p.w;
    const enc = str(p.s); const o = uint(off); off += enc.length / 2; tail += enc; return o;
  });
  return SELECTORS.ibcTransfer + head.join('') + tail;
}

// ---------------------------------------------------------------- amounts
const ONE = 10n ** 18n;

/** "12.5" -> 12500000000000000000n; refuses more than 18 decimals or junk. */
export function parseZeta(text) {
  const t = String(text).trim();
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(t)) throw new Error('amount');
  const [w, f = ''] = t.split('.');
  return BigInt(w) * ONE + BigInt(f.padEnd(18, '0'));
}

/** "1.5" with `dec` decimals -> base units (bigint); refuses more decimals than the coin has. */
export function parseUnits(text, dec) {
  const t = String(text).trim();
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) throw new Error('decimals');
  const re = dec ? new RegExp(`^\\d{1,15}(\\.\\d{1,${dec}})?$`) : /^\d{1,24}$/;
  if (!re.test(t)) throw new Error('amount');
  const [w, f = ''] = t.split('.');
  return BigInt(w) * 10n ** BigInt(dec) + BigInt(f.padEnd(dec, '0') || '0');
}
/** base units -> "1,234.5" with `dec` decimals (at most `dp` shown, rounded down). */
export function formatUnits(a, dec, dp = 6) {
  let v;
  try { v = BigInt(String(a).split('.')[0]); } catch { return '–'; }
  const one = 10n ** BigInt(dec);
  const f = dec ? (v % one).toString().padStart(dec, '0').slice(0, dp).replace(/0+$/, '') : '';
  return `${(v / one).toLocaleString('en-US')}${f ? `.${f}` : ''}`;
}

/** azetaphy (string|bigint) -> "1,234.5678" (at most `dp` decimals, rounded down). */
export function formatZeta(a, dp = 4) {
  let v;
  try { v = BigInt(String(a).split('.')[0]); } catch { return '–'; }
  const neg = v < 0n; if (neg) v = -v;
  const w = v / ONE;
  const f = (v % ONE).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${w.toLocaleString('en-US')}${f ? `.${f}` : ''}`;
}

/** A short 0x…/zetaphy1… for tables. */
export const short = (s, head = 8, tail = 6) => (String(s).length > head + tail + 1 ? `${String(s).slice(0, head)}…${String(s).slice(-tail)}` : String(s));
