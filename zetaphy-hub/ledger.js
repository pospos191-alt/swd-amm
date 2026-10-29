// A Ledger over USB (WebHID) as an EIP-1193 provider, so the sites' wallet code works unchanged.
//  - Transport: Ledger's own @ledgerhq/hw-transport-webhid, bundled in vendor/ledger-hid.js
//    (same origin, loaded only when the user picks "Ledger (USB)"; npm run build:ledger).
//  - The Ethereum app's APDUs are here: GET ADDRESS (m/44'/60'/0'/0/i), SIGN TRANSACTION
//    (EIP-1559, type 2), SIGN PERSONAL MESSAGE. No Ledger metadata services are called.
//  - eth_sendTransaction: nonce, gas and fees from the site's node, signed on the device,
//    sent with eth_sendRawTransaction. Reads go to the node. Typed-data signing is refused (4200).
//  - The device is opened for each operation and closed after it, one operation at a time for
//    the whole origin (Web Locks), so the hub and the apps in its frames can share one Ledger.
// Never holds a key: only the account index and its address. Canonical copy: zetaphy-hub/.
export const LEDGER_ID_RE = /^ledger:(\d{1,3})$/;
export const ledgerId = (i) => `ledger:${i}`;
export const ledgerPath = (i) => `44'/60'/0'/0/${i}`;
export const hidSupported = (win) => !!win?.navigator?.hid && win.isSecureContext !== false;

const HARDENED = 0x80000000;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => {
  const s = String(h).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw rpcError(-32602, 'bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
};
const concat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
function rpcError(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

/** BIP-32 path as the Ethereum app wants it: count, then each index as uint32 big-endian. */
export function pathBytes(path) {
  const parts = path.split('/').map((p) => { const h = p.endsWith("'"); const n = Number(h ? p.slice(0, -1) : p); if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error('bad path'); return h ? n + HARDENED : n; });
  const out = new Uint8Array(1 + parts.length * 4);
  const v = new DataView(out.buffer);
  out[0] = parts.length;
  parts.forEach((p, i) => v.setUint32(1 + i * 4, p));
  return out;
}

// ------------------------------------------------------------------ RLP
/** An unsigned integer as minimal big-endian bytes (0 → empty). */
export function intBytes(v) {
  let n = BigInt(v);
  if (n < 0n) throw new Error('negative');
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Uint8Array.from(out);
}
function rlpLen(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = intBytes(len);
  return concat(Uint8Array.of(offset + 55 + l.length), l);
}
/** RLP of bytes (Uint8Array) and lists of them. */
export function rlp(x) {
  if (Array.isArray(x)) { const body = concat(...x.map(rlp)); return concat(rlpLen(body.length, 0xc0), body); }
  if (x.length === 1 && x[0] < 0x80) return x;
  return concat(rlpLen(x.length, 0x80), x);
}

/** The EIP-1559 fields, in order, as RLP items. */
function txFields(tx) {
  return [intBytes(tx.chainId), intBytes(tx.nonce), intBytes(tx.maxPriorityFeePerGas), intBytes(tx.maxFeePerGas), intBytes(tx.gas),
    tx.to ? fromHex(tx.to) : new Uint8Array(0), intBytes(tx.value ?? 0n), fromHex(tx.data ?? '0x'), []];
}
/** 0x02 || rlp([...]): what the device signs. */
export const unsignedTx = (tx) => concat(Uint8Array.of(2), rlp(txFields(tx)));
/** 0x02 || rlp([..., yParity, r, s]): what eth_sendRawTransaction takes. */
export const signedTx = (tx, { yParity, r, s }) => concat(Uint8Array.of(2), rlp([...txFields(tx), intBytes(yParity), intBytes(BigInt(`0x${r}`)), intBytes(BigInt(`0x${s}`))]));

// ------------------------------------------------------------------ the Ethereum app's APDUs
const CLA = 0xe0;
const strip = (res) => { const r = res instanceof Uint8Array ? res : Uint8Array.from(res); return r.subarray(0, Math.max(0, r.length - 2)); }; // drop the status word

export async function getAddress(transport, path, display = false) {
  const r = strip(await transport.send(CLA, 0x02, display ? 1 : 0, 0, pathBytes(path)));
  const pkLen = r[0];
  const aLen = r[1 + pkLen];
  const a = new TextDecoder().decode(r.subarray(2 + pkLen, 2 + pkLen + aLen));
  if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error('the device returned no address');
  return `0x${a}`;
}

/** Signs a type-2 transaction: returns { yParity, r, s } (r, s as 64 hex digits). */
export async function signTransaction(transport, path, unsigned) {
  const payload = concat(pathBytes(path), unsigned);
  let r;
  for (let o = 0; o < payload.length; o += 255) {
    r = strip(await transport.send(CLA, 0x04, o === 0 ? 0x00 : 0x80, 0x00, payload.subarray(o, o + 255)));
  }
  const v = r[0];
  const yParity = v >= 27 ? v - 27 : v; // type-2: the app answers 0 / 1
  if (yParity !== 0 && yParity !== 1) throw new Error('bad v from the device');
  return { yParity, r: hex(r.subarray(1, 33)), s: hex(r.subarray(33, 65)) };
}

/** personal_sign of `message` bytes: returns the 65-byte signature as 0x hex (v = 27/28). */
export async function signPersonalMessage(transport, path, message) {
  const p = pathBytes(path);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, message.length);
  const first = concat(p, len);
  let r;
  let o = 0;
  do {
    const room = o === 0 ? 150 - first.length : 150;
    const chunk = message.subarray(o, o + room);
    r = strip(await transport.send(CLA, 0x08, o === 0 ? 0x00 : 0x80, 0x00, o === 0 ? concat(first, chunk) : chunk));
    o += chunk.length;
  } while (o < message.length);
  const v = r[0] < 27 ? r[0] + 27 : r[0];
  return `0x${hex(r.subarray(1, 65))}${v.toString(16).padStart(2, '0')}`;
}

/** Opens the bundled WebHID transport: `prompt` asks the browser to pick a device (needs a click). */
export async function webHidTransport({ prompt }) {
  const { TransportWebHID } = await import('./vendor/ledger-hid.js');
  const t = prompt ? await TransportWebHID.create() : await TransportWebHID.openConnected();
  if (!t) throw rpcError(4100, 'no Ledger connected');
  return t;
}
/** Starts loading the transport (so a click can open the device without waiting for the download). */
export const preloadTransport = () => import('./vendor/ledger-hid.js').catch(() => {});

/**
 * @param {object} o
 * @param {Window} o.win
 * @param {(method: string, params: any[]) => Promise<any>} o.rpc   the site's node (JSON-RPC)
 * @param {number} o.chainId
 * @param {number|null} [o.index]          the account index, when already chosen (reconnect)
 * @param {(o: {load: (i: number) => Promise<string>}) => Promise<number|null>} [o.chooseAccount]
 * @param {() => (() => void)} [o.onDevice] shows "confirm on your Ledger"; returns its remover
 * @param {(o: {prompt: boolean}) => Promise<{send: Function, close: Function}>} [o.openTransport]
 * @param {(i: number) => void} [o.onIndex] the chosen index (the site stores ledgerId(i))
 */
export function ledgerProvider({ win, rpc, chainId, index = null, chooseAccount, onDevice = () => () => {}, openTransport = webHidTransport, onIndex = () => {} }) {
  const listeners = new Map();
  const emit = (ev, v) => { for (const f of listeners.get(ev) ?? []) { try { f(v); } catch { /* listener */ } } };
  let idx = Number.isInteger(index) ? index : null;
  let account = null;
  let queue = Promise.resolve();
  const chainHex = `0x${chainId.toString(16)}`;

  /** Runs fn(transport) with the device open, one at a time across the origin. */
  function withDevice(fn, { prompt = false } = {}) {
    const run = async () => {
      const t = await openTransport({ prompt });
      try { return await fn(t); } finally { try { await t.close(); } catch { /* already closed */ } }
    };
    const locks = win?.navigator?.locks;
    const job = queue.then(() => (locks ? locks.request('zetaphy-ledger', run) : run()));
    queue = job.catch(() => {});
    return job;
  }

  async function requestAccounts() {
    if (account) return [account];
    if (idx == null) {
      // the first click opens the browser's device picker; then the user picks an account
      await withDevice(async () => {}, { prompt: true });
      const cache = new Map();
      const load = (i) => withDevice((t) => getAddress(t, ledgerPath(i))).then((a) => { cache.set(i, a); return a; });
      const i = chooseAccount ? await chooseAccount({ load }) : 0;
      if (i == null) throw rpcError(4001, 'cancelled');
      idx = i;
      account = cache.get(i) ?? await load(i);
      onIndex(i);
    } else {
      account = await withDevice((t) => getAddress(t, ledgerPath(idx)), { prompt: true });
    }
    emit('accountsChanged', [account]);
    return [account];
  }

  async function silentAccounts() {
    if (account) return [account];
    if (idx == null) return [];
    try { account = await withDevice((t) => getAddress(t, ledgerPath(idx))); } catch { return []; }
    return [account];
  }

  const big = (v, d) => (v == null ? d : BigInt(v));
  async function fill(tx) {
    if (!account) throw rpcError(4100, 'not connected');
    if (tx.from && tx.from.toLowerCase() !== account.toLowerCase()) throw rpcError(4100, 'from is not the Ledger account');
    if (tx.chainId != null && BigInt(tx.chainId) !== BigInt(chainId)) throw rpcError(4901, 'wrong chain', { chainId });
    const base = { from: account, to: tx.to, data: tx.data ?? tx.input ?? '0x', value: `0x${big(tx.value, 0n).toString(16)}` };
    const [nonce, gas, block, tip] = await Promise.all([
      tx.nonce != null ? BigInt(tx.nonce) : rpc('eth_getTransactionCount', [account, 'pending']).then(BigInt),
      tx.gas ?? tx.gasLimit ? BigInt(tx.gas ?? tx.gasLimit) : rpc('eth_estimateGas', [base]).then((g) => (BigInt(g) * 12n) / 10n + 1000n),
      rpc('eth_getBlockByNumber', ['latest', false]).catch(() => null),
      tx.maxPriorityFeePerGas != null ? BigInt(tx.maxPriorityFeePerGas) : rpc('eth_maxPriorityFeePerGas', []).then(BigInt).catch(() => null),
    ]);
    let maxFee = big(tx.maxFeePerGas, null);
    let prio = tip;
    if (maxFee == null || prio == null) {
      const baseFee = block?.baseFeePerGas != null ? BigInt(block.baseFeePerGas) : null;
      if (baseFee == null) {
        const gp = BigInt(tx.gasPrice ?? await rpc('eth_gasPrice', []));
        prio ??= gp;
        maxFee ??= gp;
      } else {
        prio ??= 1_000_000_000n;
        maxFee ??= baseFee * 2n + prio;
      }
    }
    if (prio > maxFee) prio = maxFee;
    return { chainId: BigInt(chainId), nonce, maxPriorityFeePerGas: prio, maxFeePerGas: maxFee, gas, to: tx.to ?? null, value: big(tx.value, 0n), data: base.data };
  }

  async function sign(tx) {
    const full = await fill(tx);
    const done = onDevice();
    try {
      const sig = await withDevice((t) => signTransaction(t, ledgerPath(idx), unsignedTx(full)));
      return `0x${hex(signedTx(full, sig))}`;
    } finally { done(); }
  }

  async function request({ method, params = [] }) {
    switch (method) {
      case 'eth_requestAccounts': return requestAccounts();
      case 'eth_accounts': return silentAccounts();
      case 'eth_chainId': return chainHex;
      case 'net_version': return String(chainId);
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        if (BigInt(params?.[0]?.chainId ?? -1) === BigInt(chainId)) return null;
        throw rpcError(4902, 'this Ledger connection is set up for one network only', { chainId });
      case 'wallet_requestPermissions': await requestAccounts(); return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_revokePermissions': forget(); return null;
      case 'eth_signTransaction': return sign(params[0] ?? {});
      case 'eth_sendTransaction': {
        const raw = await sign(params[0] ?? {});
        return rpc('eth_sendRawTransaction', [raw]);
      }
      case 'personal_sign': {
        if (!account) throw rpcError(4100, 'not connected');
        const [m, who] = params;
        if (who && String(who).toLowerCase() !== account.toLowerCase()) throw rpcError(4100, 'address is not the Ledger account');
        const bytes = /^0x([0-9a-fA-F]{2})*$/.test(m) ? fromHex(m) : new TextEncoder().encode(String(m));
        const done = onDevice();
        try { return await withDevice((t) => signPersonalMessage(t, ledgerPath(idx), bytes)); } finally { done(); }
      }
      case 'eth_sign': case 'eth_signTypedData': case 'eth_signTypedData_v3': case 'eth_signTypedData_v4':
        throw rpcError(4200, `${method} is not supported by this Ledger connection`);
      default:
        if (/^(eth_|net_|web3_)/.test(method)) return rpc(method, params);
        throw rpcError(4200, `${method} is not supported`);
    }
  }

  /** Forgets the account (idle, disconnect): the next use asks the device again. */
  function forget() {
    const had = account;
    account = null;
    if (had) emit('accountsChanged', []);
  }

  return {
    isLedger: true, isHardware: true,
    request,
    on: (ev, f) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(f); },
    removeListener: (ev, f) => listeners.get(ev)?.delete(f),
    forget,
    index: () => idx,
  };
}
