// Build-time tables the explorer loads (npm run build writes them, and they are
// committed so Vercel serves them with no build step):
//   labels.json      known ZETAPHY addresses -> [name, kind], from this repository's
//                    own deployment records (launch state, DEX / NFT deployments,
//                    rewards, Hyperlane), plus module accounts, precompiles and 0x…dEaD
//   crosschain.json  the Hyperlane (Saphan) chain table: domain, mailbox, https RPCs and
//                    explorer of each chain, from zetaphy-chain/hyperlane/saphan-chains.json
// Pure functions over file contents (readJson is injected), so the unit tests run
// them on the same files and check the committed output is current.
import { sha256 } from '@noble/hashes/sha2.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const WNATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** Files read, relative to the repository root. Missing ones are skipped. */
export const SOURCES = [
  'zetaphy-launch/state/77390.json',
  'zetaphy-dex/web/deployments.json',
  'zetaphy-nft/web/deployments.json',
  'zetaphy-network/deployments/77390.json',
  'zetaphy-chain/rewards/points-testnet.json',
  'zetaphy-chain/hyperlane/saphan-chains.json',
  'zetaphy-chain/hyperlane/bridge-testnet.json',
  'zetaphy-chain/hyperlane/saphan-routes.json',
  'zetaphy-chain/hyperlane/neuro-oracle.json',
  'zetaphy-chain/hyperlane/registry/chains/zetaphy/addresses.yaml',
];

// Readable names for the keys the deployment records use; others are split from camelCase.
const NAMES = {
  deployer: 'Launch deployer', threatRegistry: 'Neuro ThreatRegistry', threats: 'Neuro ThreatRegistry', threatReports: 'Neuro ThreatReports',
  neuroJobs: 'NeuroJobs', neuroControl: 'NeuroControl', neuroIdentity: 'Neuro identity registry', neuroValidation: 'Neuro validation registry',
  rewardVault: 'Reward vault', quantumWalletFactory: 'Quantum wallet factory', tUSDC: 'tUSDC (test stablecoin)', tUSDT: 'tUSDT (test stablecoin)',
  stableGateway: 'Stablecoin gateway', computeMarket: 'Compute market', factory: 'DEX factory', router: 'DEX router',
  dlmmFactory: 'DLMM factory', dlmmRouter: 'DLMM router', governance: 'Governance', timelock: 'ZetaphyTimelock', guardian: 'Guardian multisig',
  guardianMultisig: 'Guardian multisig', guardianOwners: 'Guardian owner', proposers: 'Timelock proposer', twapRecorder: 'TWAP recorder',
  pythRelay: 'Pyth relay', oracle: 'Price oracle', zetaPair: 'ZETAPHY price pair', marketplace: 'NFT marketplace', feeRecipient: 'NFT fee recipient',
  points: 'BZTPHY points (ZetaphyPoints)', owner: 'Points owner', minter: 'Points minter', mailbox: 'Hyperlane Mailbox',
  merkleTreeHook: 'Hyperlane MerkleTreeHook', validatorAnnounce: 'Hyperlane ValidatorAnnounce', interchainAccountRouter: 'Hyperlane interchain accounts',
  testRecipient: 'Hyperlane test recipient', proxyAdmin: 'Hyperlane proxy admin', bridgeGuard: 'Saphan bridge guard', bridgedToken: 'Saphan bridged token',
  bridgeAirlock: 'Saphan airlock', neuroLane: 'Neuro lane', hyperlaneLane: 'Saphan Hyperlane lane', validators: 'Saphan Hyperlane validator',
};
const KINDS = {
  threatRegistry: 'neuro', threats: 'neuro', threatReports: 'neuro', neuroJobs: 'neuro', neuroControl: 'neuro', neuroIdentity: 'neuro', neuroValidation: 'neuro',
  tUSDC: 'token', tUSDT: 'token', points: 'token', bridgedToken: 'token', governance: 'governance', timelock: 'governance', guardian: 'governance',
  guardianMultisig: 'governance', guardianOwners: 'governance', proposers: 'governance', owner: 'governance', deployer: 'deployer', minter: 'deployer',
};
const SKIP_KEYS = new Set(['feeTo', 'wnative', 'zetaAsset', 'interchainGasPaymaster', 'skillId', 'handedOver', 'protectedKeys', 'executor']);

const words = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/\bIsm\b/g, 'ISM');
const nameOf = (key, prefix) => {
  const base = NAMES[key] ?? words(key);
  return !prefix || base.toLowerCase().startsWith(prefix.toLowerCase()) ? base : `${prefix} ${base}`;
};
const kindOf = (key, fallback) => KINDS[key] ?? (/hyperlane|mailbox|merkle|lane|bridge|airlock|ism|hook|announce/i.test(key) ? 'bridge' : fallback);

/** Module account address: the first 20 bytes of sha256(name) (Cosmos SDK address.Module). */
export function moduleAddress(name) {
  const h = sha256(new TextEncoder().encode(name)).subarray(0, 20);
  return '0x' + Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const MODULES = [
  ['fee_collector', 'Fee collector (module)'], ['distribution', 'Distribution (module)'], ['bonded_tokens_pool', 'Bonded tokens pool (module)'],
  ['not_bonded_tokens_pool', 'Unbonding tokens pool (module)'], ['gov', 'Governance (module)'], ['mint', 'Mint (module)'],
  ['transfer', 'IBC transfer (module)'], ['evm', 'EVM (module, burns 0x…dEaD)'], ['erc20', 'ERC-20 (module)'], ['feemarket', 'Fee market (module)'],
  ['precisebank', 'Precise bank (module)'],
];

export const FIXED = [
  ['0x000000000000000000000000000000000000dEaD', 'Burn address (0x…dEaD)', 'burn'],
  ['0x0000000000000000000000000000000000000100', 'P256 verify (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000400', 'Bech32 (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000800', 'Staking (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000801', 'Distribution (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000802', 'ICS-20 transfer (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000804', 'Bank (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000805', 'Governance (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000806', 'Slashing (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000900', 'ML-DSA verify (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000901', 'Security / consent (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000000902', 'AI model (precompile)', 'precompile'],
  ['0x0000000000000000000000000000000000005051', 'Quantum lock (precompile)', 'precompile'],
  [WNATIVE, 'Native ZETAPHY (WNATIVE precompile)', 'precompile'],
];

/** The tiny YAML of a Hyperlane registry addresses file: `key: "0x…"` lines. */
export function parseAddressesYaml(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*"?(0x[0-9a-fA-F]{40})"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Collects { lowerAddress: [name, kind] } from the deployment records.
 * read(path) returns the parsed JSON (or YAML object), or null when the file is missing.
 * The first source to name an address wins (SOURCES order), so the output is deterministic.
 */
export function buildLabels(read) {
  const labels = new Map();
  const used = [];
  const add = (addr, name, kind) => {
    if (typeof addr !== 'string' || !ADDR.test(addr)) return;
    const k = addr.toLowerCase();
    if (k === ZERO || labels.has(k)) return;
    labels.set(k, [String(name).slice(0, 60), kind]);
  };
  // walk an object: every address-valued key (arrays too), skipping hashes and settings
  const walk = (o, { prefix = '', kind = 'contract', depth = 0 } = {}) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [key, v] of Object.entries(o)) {
      if (SKIP_KEYS.has(key) || key === 'about') continue;
      if (typeof v === 'string') add(v, nameOf(key, prefix), kindOf(key, kind));
      else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'string' ? add(x, `${nameOf(key, prefix)}${v.length > 1 ? ` ${i + 1}` : ''}`, kindOf(key, kind)) : null));
      else if (key !== 'tokens') walk(v, { prefix, kind, depth: depth + 1 });
    }
  };
  for (const [addr, name, kind] of FIXED) add(addr, name, kind);
  for (const [m, name] of MODULES) add(moduleAddress(m), name, 'module');

  const launch = read(SOURCES[0]);
  if (launch) {
    used.push(SOURCES[0]);
    add(launch.deployer, NAMES.deployer, 'deployer');
    const steps = launch.steps ?? {};
    // the DEX / NFT step outputs are the deployments files themselves: read below with their tokens
    for (const [step, s] of Object.entries(steps)) if (!['dex', 'dlmm', 'nft', 'configs', 'protect', 'snap'].includes(step)) walk(s?.out);
    walk(steps.dlmm?.out?.dlmm?.contracts);
    const n = steps.nft?.out?.nft;
    if (n) { add(n.factory, 'NFT collection factory', 'contract'); add(n.marketplace, NAMES.marketplace, 'contract'); }
  }
  const dex = read(SOURCES[1]);
  if (dex) {
    used.push(SOURCES[1]);
    walk(dex.contracts);
    for (const tk of dex.tokens ?? []) add(tk.address, `${String(tk.symbol ?? 'token').slice(0, 16)} (DEX token)`, 'token');
    add(dex.governance, NAMES.governance, 'governance');
  }
  const nft = read(SOURCES[2]);
  if (nft) {
    used.push(SOURCES[2]);
    add(nft.factory, 'NFT collection factory', 'contract'); add(nft.marketplace, NAMES.marketplace, 'contract'); add(nft.feeRecipient, NAMES.feeRecipient, 'contract');
  }
  const net = read(SOURCES[3]);
  if (net) { used.push(SOURCES[3]); walk(net); }
  const points = read(SOURCES[4]);
  if (points) { used.push(SOURCES[4]); walk({ points: points.points, owner: points.owner, minter: points.minter }); }
  const chains = read(SOURCES[5]);
  if (chains) {
    used.push(SOURCES[5]);
    walk(chains.zetaphy, { prefix: 'Hyperlane', kind: 'bridge' });
    for (const v of chains.zetaphyValidators?.validators ?? []) add(v, NAMES.validators, 'bridge');
    for (const [key, tk] of Object.entries(chains.tokens ?? {})) if (key !== 'about' && tk?.address) add(tk.address, `${String(tk.symbol ?? key).slice(0, 16)} (Saphan token)`, 'token');
  }
  const bridge = read(SOURCES[6]);
  if (bridge?.zetaphy) { used.push(SOURCES[6]); walk(bridge.zetaphy, { kind: 'bridge' }); }
  const routes = read(SOURCES[7]);
  if (routes) {
    used.push(SOURCES[7]);
    for (const r of Object.values(routes.routes ?? {})) walk(r?.zetaphy ?? r, { prefix: 'Saphan', kind: 'bridge' });
  }
  const oracle = read(SOURCES[8]);
  if (oracle) { used.push(SOURCES[8]); if (typeof oracle.sender === 'string') add(oracle.sender, 'Neuro oracle sender', 'neuro'); walk(oracle.zetaphy, { prefix: 'Neuro oracle', kind: 'neuro' }); }
  const hl = read(SOURCES[9]);
  if (hl) { used.push(SOURCES[9]); walk(hl, { prefix: 'Hyperlane', kind: 'bridge' }); }

  const sorted = [...labels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { version: 1, about: 'Known ZETAPHY addresses, generated by `npm run build` (scripts/known.js) from this repository. Do not edit by hand.', sources: used, labels: Object.fromEntries(sorted) };
}

const httpsOnly = (list) => (Array.isArray(list) ? list : []).filter((u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } }).slice(0, 4);

/** The Hyperlane chain table for cross-chain traces (https RPC URLs only, from saphan-chains.json). */
export function buildCrossChain(read) {
  const c = read(SOURCES[5]);
  const z = c?.zetaphy ?? {};
  const chains = {};
  for (const [name, v] of Object.entries(c?.chains ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!v || !Number.isInteger(v.domain) || !ADDR.test(v.mailbox ?? '')) continue;
    chains[name] = { name: String(v.displayName ?? name).slice(0, 40), domain: v.domain, chainId: v.chainId, mailbox: v.mailbox, rpc: httpsOnly(v.rpc),
      explorer: httpsOnly([v.explorer])[0] ?? '', blockTime: Number(v.estimateBlockTime) || 12 };
  }
  return {
    version: 1,
    about: 'Hyperlane (Saphan) chain table, generated by `npm run build` (scripts/known.js) from zetaphy-chain/hyperlane/saphan-chains.json. Do not edit by hand.',
    zetaphy: { name: String(z.displayName ?? 'ZETAPHY'), domain: z.domain ?? 77390, mailbox: z.mailbox ?? null },
    chains,
  };
}

/** The https origins the cross-chain trace talks to (for the CSP's connect-src). */
export const crossChainOrigins = (cc) => [...new Set(Object.values(cc.chains).flatMap((c) => c.rpc.map((u) => new URL(u).origin)))].sort();

/**
 * connect-src must allow the destination chains' RPCs. The default policy allows any
 * https host ("https:"); a deployment that locked connect-src to its own node gets
 * the chain table's origins appended. Returns the new CSP string.
 */
export function cspWithOrigins(csp, origins) {
  return csp.replace(/connect-src([^;]*)/, (m, list) => {
    const have = list.trim().split(/\s+/);
    if (have.includes('https:')) return m;
    const extra = origins.filter((o) => !have.includes(o));
    return extra.length ? `connect-src ${[...have, ...extra].join(' ')}` : m;
  });
}

/** labels.json text: one address per line (small diffs when a deployment changes). */
export function labelsJson(l) {
  const rows = Object.entries(l.labels).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n "version": ${l.version},\n "about": ${JSON.stringify(l.about)},\n "sources": ${JSON.stringify(l.sources)},\n "labels": {\n${rows.join(',\n')}\n }\n}\n`;
}
