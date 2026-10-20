// Neuro ZETAPHY tier 1: reads one contract and produces a report.
// Read-only: it only calls eth_getCode, eth_getStorageAt and eth_call.

import { CHAINS, isChainAddress } from './chains.js';
import { createRpc, createSolanaRpc, createSuiGraphql, createAptosRest, createTonApi } from './rpc.js';
import { readSolanaAccount, analyzeSolana } from './solana.js';
import { readSuiAccount, analyzeSui } from './sui.js';
import { readAptosAccount, analyzeAptos } from './aptos.js';
import { readTonAccount, analyzeTon, parseTonAddress } from './ton.js';
import { normalizeType, longAddress } from './move.js';
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
 * @param {{rpc?: {call: Function}, fetchImpl?: Function, templates?: Array, chainConfig?: object}} [opts]
 *   rpc/fetchImpl: inject for tests; templates: defaults to src/templates.js;
 *   chainConfig: {kind:'evm', id, name, rpcs} for a chain not in CHAINS;
 *   threatLookup: async (fingerprint) => ({flagged, reason}) from the ZETAPHY ThreatRegistry
 */
export async function readContract(chainKey, address, opts = {}) {
  // opts.chainConfig lets a caller read a chain the website does not list
  // (e.g. a node runner reading the ZETAPHY testnet itself).
  const chain = opts.chainConfig ?? CHAINS[chainKey];
  if (!chain) throw new Error(`unknown chain: ${chainKey}`);
  const validAddress = opts.chainConfig
    ? (chain.kind === 'evm' && isAddress(address))
    : isChainAddress(chainKey, address);
  if (!validAddress) throw new Error('invalid address');
  if (chain.kind === 'solana') return readSolana(chainKey, chain, address, opts);
  if (chain.kind === 'sui') return readSui(chainKey, chain, address, opts);
  if (chain.kind === 'aptos') return readAptos(chainKey, chain, address, opts);
  if (chain.kind === 'ton') return readTon(chainKey, chain, address, opts);
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
  // Immune system: ask the ZETAPHY ThreatRegistry about this exact code, if
  // the caller wired a lookup. A registry that cannot be reached is skipped.
  let threat = null;
  if (opts.threatLookup) {
    try { threat = await opts.threatLookup(report.fingerprint); } catch { threat = null; }
  }
  report.analysis = analyze({ hasCode, functions, opcodes: logic.opcodes, proxy, token, owner, template, known, lookalike, unknownSelectors, threat });
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

// ------------------------------------------------------------- Move + TON
const finish = async (report) => {
  report.reportHash = await sha256Hex(canonical(report));
  return report;
};

// Move addresses are compared in their 64-digit form.
const moveId = (a) => (a.includes('::') ? normalizeType(a) : longAddress(a));

async function readSui(chainKey, chain, address, opts) {
  const api = opts.api ?? createSuiGraphql(chain.rpcs, chain.chainIdentifier, { fetchImpl: opts.fetchImpl });
  const m = await readSuiAccount((q, v) => api.query(q, v), address);
  const id = moveId(address);
  const report = { version: REPORT_VERSION, chain: chainKey, address: id };
  if (m.kind === 'coin') {
    report.token = m.token;
    report.move = {
      package: m.package,
      supplyState: m.supplyState ?? undefined,
      regulated: m.regulated ?? undefined,
      treasury: m.treasury ?? undefined,
      upgrade: m.upgrade ?? undefined,
    };
  } else if (m.kind === 'package') {
    report.move = { package: m.package, upgrade: m.upgrade ?? undefined };
  }
  const known = m.kind === 'coin' ? knownToken(chainKey, id) : null;
  const lookalike = m.kind === 'coin' ? lookalikeOf(chainKey, id, m.token.symbol) : null;
  report.analysis = analyzeSui(m, { known, lookalike });
  return finish(report);
}

async function readAptos(chainKey, chain, address, opts) {
  const api = opts.api ?? createAptosRest(chain.rpcs, chain.id, { fetchImpl: opts.fetchImpl });
  const m = await readAptosAccount(api, address);
  const id = moveId(address);
  const report = { version: REPORT_VERSION, chain: chainKey, address: id };
  const isToken = m.kind === 'coin' || m.kind === 'fa';
  if (isToken) report.token = m.token;
  if (m.kind !== 'missing' && m.kind !== 'other') {
    report.move = {
      standard: m.kind === 'coin' ? 'Coin' : m.kind === 'fa' ? 'Fungible Asset' : 'package',
      owner: m.owner ?? undefined,
      packages: m.packages,
    };
  }
  const known = isToken ? knownToken(chainKey, id) : null;
  const lookalike = isToken ? lookalikeOf(chainKey, id, m.token.symbol) : null;
  report.analysis = analyzeAptos(m, { known, lookalike });
  return finish(report);
}

async function readTon(chainKey, chain, address, opts) {
  const api = opts.api ?? createTonApi(chain.rpcs, { fetchImpl: opts.fetchImpl });
  const m = await readTonAccount(api, address);
  const { raw } = parseTonAddress(address);
  const report = { version: REPORT_VERSION, chain: chainKey, address, raw };
  if (m.kind === 'jetton') {
    report.token = m.token;
    report.ton = { admin: m.admin, mintable: m.mintable, verification: m.verification };
  }
  const known = m.kind === 'jetton' ? knownToken(chainKey, raw) : null;
  const lookalike = m.kind === 'jetton' ? lookalikeOf(chainKey, raw, m.token.symbol) : null;
  report.analysis = analyzeTon(m, { known, lookalike });
  return finish(report);
}
