// Neuro ZETAPHY tier 1: reads one contract and produces a report.
// Read-only: it only calls eth_getCode, eth_getStorageAt and eth_call.

import { CHAINS, isChainAddress } from './chains.js';
import { createRpc, createSolanaRpc } from './rpc.js';
import { readSolanaAccount, analyzeSolana } from './solana.js';
import { scanBytecode, minimalProxyTarget, hexToBytes } from './bytecode.js';
import { decodeAddress, decodeUint, decodeString, cleanText } from './abi.js';
import { analyze } from './analyze.js';
import { codeFingerprint } from './fingerprint.js';
import { TEMPLATES } from './templates.js';
import { knownToken, lookalikeOf } from './known-tokens.js';

export const REPORT_VERSION = 1;

const ZERO = '0x0000000000000000000000000000000000000000';
// EIP-1967 storage slots
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const SEL = {
  name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd',
  owner: '0x8da5cb5b', getOwner: '0x893d20e8', implementation: '0x5c60da1b',
};

const isTokenContract = (functions) => functions.some((f) => f.cat === 'erc20');

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// JSON with sorted keys, so the same report always hashes the same.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * @param {string} chainKey  'bsc' | 'base' | 'arbitrum'
 * @param {string} address
 * @param {{rpc?: {call: Function}, fetchImpl?: Function, templates?: Array}} [opts]
 *   rpc/fetchImpl: inject for tests; templates: defaults to src/templates.js
 */
export async function readContract(chainKey, address, opts = {}) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain: ${chainKey}`);
  if (!isChainAddress(chainKey, address)) throw new Error('invalid address');
  if (chain.kind === 'solana') return readSolana(chainKey, chain, address, opts);
  const addr = address.toLowerCase();
  const rpc = opts.rpc ?? createRpc(chain.rpcs, chain.id, { fetchImpl: opts.fetchImpl });

  const getCode = (a) => rpc.call('eth_getCode', [a, 'latest']);
  const slot = async (s) => {
    const a = decodeAddress(await rpc.call('eth_getStorageAt', [addr, s, 'latest']));
    return a && a !== ZERO ? a : null;
  };
  const tryCall = async (to, data) => {
    try {
      const r = await rpc.call('eth_call', [{ to, data }, 'latest']);
      return r && r !== '0x' ? r : null;
    } catch {
      return null; // a revert just means "this contract has no such function"
    }
  };

  const code = await getCode(addr);
  const hasCode = !!code && code !== '0x';
  const report = { version: REPORT_VERSION, chain: chainKey, chainId: chain.id, address: addr };

  if (!hasCode) {
    report.analysis = analyze({ hasCode: false });
    report.reportHash = await sha256Hex(canonical({ ...report }));
    return report;
  }

  // Proxy detection
  let proxy = { kind: null };
  const clone = minimalProxyTarget(hexToBytes(code));
  if (clone) {
    proxy = { kind: 'eip1167', implementation: clone };
  } else {
    const [impl, admin, beacon] = await Promise.all([slot(SLOT_IMPL), slot(SLOT_ADMIN), slot(SLOT_BEACON)]);
    if (impl) proxy = { kind: 'eip1967', implementation: impl, admin: admin ?? undefined };
    else if (beacon) {
      const beaconImpl = decodeAddress(await tryCall(beacon, SEL.implementation));
      proxy = { kind: 'beacon', beacon, implementation: beaconImpl ?? undefined, admin: admin ?? undefined };
    }
  }

  const own = scanBytecode(code);
  let logic = own;
  let logicCode = null;
  if (proxy.implementation) {
    logicCode = await getCode(proxy.implementation);
    if (logicCode && logicCode !== '0x') logic = scanBytecode(logicCode);
  }
  const functions = [...new Map([...own.functions, ...logic.functions].map((f) => [f.selector, f])).values()];
  const unknownSelectors = [...new Set([...own.unknownSelectors, ...logic.unknownSelectors])].sort();
  const has = (sig) => functions.some((f) => f.sig === sig);

  // Token details (calls go to the address itself; a proxy forwards them)
  const [nameR, symbolR, decR, supplyR, ownerR, getOwnerR] = await Promise.all([
    tryCall(addr, SEL.name), tryCall(addr, SEL.symbol), tryCall(addr, SEL.decimals), tryCall(addr, SEL.totalSupply),
    has('owner()') ? tryCall(addr, SEL.owner) : null,
    has('getOwner()') ? tryCall(addr, SEL.getOwner) : null,
  ]);
  const dec = decodeUint(decR);
  const token = {
    name: cleanText(decodeString(nameR)) ?? undefined,
    symbol: cleanText(decodeString(symbolR), 24) ?? undefined,
    decimals: dec != null && dec <= 255n ? Number(dec) : undefined,
    totalSupply: decodeUint(supplyR)?.toString(),
  };
  const ownerWord = ownerR ?? getOwnerR;
  const owner = ownerWord ? decodeAddress(ownerWord) : undefined;

  report.proxy = proxy;
  report.token = token;
  report.owner = owner;
  report.codeHash = await sha256Hex(code.toLowerCase());
  if (logicCode) report.logicCodeHash = await sha256Hex(logicCode.toLowerCase());
  // Template match uses the code that actually runs (the implementation behind a proxy).
  report.fingerprint = await codeFingerprint(logicCode && logicCode !== '0x' ? logicCode : code);
  const template = (opts.templates ?? TEMPLATES).find((t) => t.fingerprint === report.fingerprint
    && (!t.chains || t.chains.includes(chainKey))) ?? null;
  const known = knownToken(chainKey, addr);
  const lookalike = isTokenContract(functions) ? lookalikeOf(chainKey, addr, token.symbol) : null;
  report.analysis = analyze({ hasCode, functions, opcodes: logic.opcodes, proxy, token, owner, template, known, lookalike, unknownSelectors });
  report.functions = functions.map((f) => f.sig).sort();
  if (unknownSelectors.length) report.unknownSelectors = unknownSelectors;
  report.reportHash = await sha256Hex(canonical(report));
  return report;
}

async function readSolana(chainKey, chain, address, opts) {
  const rpc = opts.rpc ?? createSolanaRpc(chain.rpcs, chain.genesisHash, { fetchImpl: opts.fetchImpl });
  const m = await readSolanaAccount(rpc, address);
  const report = { version: REPORT_VERSION, chain: chainKey, address };
  if (m.kind === 'mint') {
    report.token = m.token;
    report.solana = {
      program: m.program2022 ? 'Token-2022' : 'SPL Token',
      mintAuthority: m.mintAuthority,
      freezeAuthority: m.freezeAuthority,
      extensions: Object.keys(m.extensions).sort(),
    };
  } else if (m.kind === 'program') {
    report.solana = { program: 'upgradeable-loader', upgradeAuthority: m.upgradeAuthority };
  }
  const known = m.kind === 'mint' ? knownToken(chainKey, address) : null;
  const lookalike = m.kind === 'mint' ? lookalikeOf(chainKey, address, m.token.symbol) : null;
  report.analysis = analyzeSolana(m, { known, lookalike });
  report.reportHash = await sha256Hex(canonical(report));
  return report;
}
