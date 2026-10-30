// Audit-as-a-Service (docs/future/audit-as-a-service.md): the logic shared by the hub's certificate page
// (audit.html, aas-verify.js), the Audit Directory (audits.html, aas-directory.js), the intake / order / registry
// code in zetaphy-network/src/aas/ and the GitHub Action's badge step. No DOM, no network, no npm imports:
// Keccak (Neuro's keccak256(bytes) -> bytes) and SHA-256 (async bytes -> bytes) are passed in, so this runs the
// same in a browser, in Node and in a GitHub Actions runner without `npm ci`.
//
//   - the chains a project can order from (EVM mainnets and testnets, CosmWasm, Solana), their free public
//     endpoints and how each one's "code hash" is measured;
//   - how a target on any chain becomes an AuditNetwork Target {chainId, target, codeHash, sourceHash};
//   - reading the code hash a chain runs NOW (EVM EXTCODEHASH, proxies, CosmWasm checksums, Solana program hash);
//   - the certificate's state against that live code: VALID / EXPIRED / REVOKED / CODE CHANGED;
//   - the embeddable SVG badge, the fee tiers, the order terms and the public registry's schema.
import { keccakHex, encodeArgs, decodeArgs, calldata, toHex, fromHex } from './work-core.js';
import { decodeCertificate, LEVELS } from './audit-core.js';

export { decodeCertificate, LEVELS, calldata, decodeArgs };

export const ZETAPHY_CHAIN_ID = 77390;
export const ZETAPHY_RPC = 'https://rpc.sawasdeecoin.com';

// ------------------------------------------------------------------ chains
// rpcs: free, keyless public endpoints (first that answers wins). sourcify: Sourcify v2 covers it.
// hyperlane: a Hyperlane domain ZETAPHY's routes already reach (zetaphy-chain/hyperlane/saphan-chains.json).
// aasId: the uint64 AuditNetwork records for a chain that has no EVM chain id (reserved range 9e18+, far
// above any EVM chain id), so a CosmWasm or Solana target fits the same Target tuple.
const evm = (key, name, chainId, testnet, rpcs, explorer, extra = {}) => ({ key, name, kind: 'evm', chainId, caip2: `eip155:${chainId}`, testnet, rpcs, explorer, sourcify: true, ...extra });
export const AAS_CHAINS = [
  evm('zetaphy', 'ZETAPHY testnet', ZETAPHY_CHAIN_ID, true, [ZETAPHY_RPC], 'https://explorer.sawasdeecoin.com/address/', { sourcify: false, hyperlane: 77390 }),
  evm('ethereum', 'Ethereum', 1, false, ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'], 'https://etherscan.io/address/'),
  evm('sepolia', 'Ethereum Sepolia', 11155111, true, ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'], 'https://sepolia.etherscan.io/address/', { hyperlane: 11155111 }),
  evm('bsc', 'BNB Smart Chain', 56, false, ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], 'https://bscscan.com/address/'),
  evm('bsc-testnet', 'BNB Smart Chain testnet', 97, true, ['https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://bsc-testnet-rpc.publicnode.com'], 'https://testnet.bscscan.com/address/'),
  evm('base', 'Base', 8453, false, ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], 'https://basescan.org/address/'),
  evm('base-sepolia', 'Base Sepolia', 84532, true, ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'], 'https://sepolia.basescan.org/address/', { hyperlane: 84532 }),
  evm('arbitrum', 'Arbitrum One', 42161, false, ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], 'https://arbiscan.io/address/'),
  evm('arbitrum-sepolia', 'Arbitrum Sepolia', 421614, true, ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'], 'https://sepolia.arbiscan.io/address/', { hyperlane: 421614 }),
  evm('optimism', 'OP Mainnet', 10, false, ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], 'https://optimistic.etherscan.io/address/'),
  evm('optimism-sepolia', 'OP Sepolia', 11155420, true, ['https://sepolia.optimism.io', 'https://optimism-sepolia-rpc.publicnode.com'], 'https://sepolia-optimism.etherscan.io/address/'),
  evm('polygon', 'Polygon PoS', 137, false, ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'], 'https://polygonscan.com/address/'),
  evm('polygon-amoy', 'Polygon Amoy', 80002, true, ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy-bor-rpc.publicnode.com'], 'https://amoy.polygonscan.com/address/'),
  evm('avalanche', 'Avalanche C-Chain', 43114, false, ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], 'https://snowtrace.io/address/'),
  evm('avalanche-fuji', 'Avalanche Fuji', 43113, true, ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'], 'https://testnet.snowtrace.io/address/'),
  { key: 'osmosis', name: 'Osmosis', kind: 'cosmwasm', cosmosChainId: 'osmosis-1', caip2: 'cosmos:osmosis-1', aasId: '9000000000000000001', testnet: false, prefix: 'osmo',
    rpcs: ['https://lcd.osmosis.zone', 'https://rest.cosmos.directory/osmosis'], explorer: 'https://www.mintscan.io/osmosis/address/' },
  { key: 'osmo-test-5', name: 'Osmosis testnet', kind: 'cosmwasm', cosmosChainId: 'osmo-test-5', caip2: 'cosmos:osmo-test-5', aasId: '9000000000000000002', testnet: true, prefix: 'osmo',
    rpcs: ['https://lcd.osmotest5.osmosis.zone', 'https://rest.testcosmos.directory/osmosistestnet'], explorer: 'https://www.mintscan.io/osmosis-testnet/address/' },
  { key: 'solana', name: 'Solana', kind: 'solana', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', aasId: '9000000000000000101', testnet: false,
    rpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'], explorer: 'https://explorer.solana.com/address/' },
  { key: 'solana-devnet', name: 'Solana devnet', kind: 'solana', caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', aasId: '9000000000000000102', testnet: true,
    rpcs: ['https://api.devnet.solana.com'], explorer: 'https://explorer.solana.com/address/', explorerSuffix: '?cluster=devnet' },
];

/** A chain by key ("base"), EVM chain id (8453 / "8453"), CAIP-2 ("eip155:8453", "cosmos:osmosis-1"), Cosmos chain id or aasId; else null. */
export function chainOf(ref) {
  const s = String(ref ?? '').trim().toLowerCase();
  if (!s) return null;
  return AAS_CHAINS.find((c) => c.key === s || c.caip2.toLowerCase() === s || (c.kind === 'evm' && String(c.chainId) === s)
    || (c.cosmosChainId && c.cosmosChainId === s) || (c.aasId && c.aasId === s)) ?? null;
}

/** The uint64 chain id AuditNetwork / AuditCertificate record for this chain (BigInt). */
export const aasChainId = (chain) => (chain.kind === 'evm' ? BigInt(chain.chainId) : BigInt(chain.aasId));

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Whether `native` is a well-formed address (EVM 0x…, CosmWasm bech32 contract with the chain's prefix, Solana base58). */
export function isNativeAddress(chain, native) {
  const a = String(native ?? '').trim();
  if (chain.kind === 'evm') return EVM_ADDR.test(a);
  if (chain.kind === 'cosmwasm') return new RegExp(`^${chain.prefix}1[02-9ac-hj-np-z]{38,90}$`).test(a);
  if (chain.kind === 'solana') return B58.test(a);
  return false;
}

/**
 * The 20-byte `target` AuditNetwork records. EVM: the address itself (lowercase). Elsewhere a stand-in that cannot
 * collide with a real EVM account on any chain: the last 20 bytes of keccak256("zetaphy.aas.target", caip2, native).
 */
export function targetOf(k, chain, native) {
  if (chain.kind === 'evm') return String(native).toLowerCase();
  const h = keccakHex(k, encodeArgs(['string', 'string', 'string'], ['zetaphy.aas.target', chain.caip2, String(native)]));
  return `0x${h.slice(-40)}`;
}

/** A source reference as bytes32: a 0x 32-byte hash as is, anything else (repo@commit, ipfs://…) hashed. */
export const sourceRefHash = (k, ref) => (/^0x[0-9a-fA-F]{64}$/.test(String(ref).trim()) ? String(ref).trim().toLowerCase() : keccakHex(k, new TextEncoder().encode(String(ref).trim())));

/**
 * The request `uri` AaaS writes (AuditNetwork caps it at 200 bytes): `zaas1|<chain key>|<native address>|<role>|<link>`.
 * It names the native address of a non-EVM target (AuditNetwork only stores its 20-byte stand-in) and, for a
 * proxy's two requests, which one is which. The registry and the directory read it back with parseOrderUri.
 */
export function orderUri({ chain, native, role = 'contract', link = '' }) {
  const u = ['zaas1', chain.key, String(native), role, String(link).replace(/\|/g, '')].join('|');
  if (new TextEncoder().encode(u).length > 200) throw new Error('order uri: over 200 bytes (shorten the link)');
  return u;
}
export const ROLES = ['contract', 'proxy', 'implementation', 'program'];
export function parseOrderUri(u) {
  const p = String(u ?? '').split('|');
  if (p.length < 4 || p[0] !== 'zaas1') return null;
  const chain = chainOf(p[1]);
  if (!chain || !isNativeAddress(chain, p[2]) || !ROLES.includes(p[3])) return null;
  const link = /^(https:\/\/|ipfs:\/\/)[^\s"<>]{1,180}$/.test(p[4] ?? '') ? p[4] : '';
  return { chain: chain.key, native: p[2], role: p[3], link };
}

// ------------------------------------------------------------------ endpoints (fetch only: browser, Node, Actions)
async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { ...init, credentials: 'omit', signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
export { fetchJson };

/**
 * JSON-RPC over the chain's URLs in order (the first that answers wins). With `chainId` (EVM) each URL is
 * asked eth_chainId once and refused if it serves another chain: a wrong endpoint must not certify the wrong code.
 * Returns rpc(method, params) -> result.
 */
export function rpcClient(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, chainId = null } = {}) {
  const checked = new Set();
  let id = 0;
  const post = async (url, method, params) => {
    const j = await fetchJson(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }, timeoutMs);
    if (!j) throw new Error(`no answer from ${url}`);
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message ?? 'error'}`), { rpcError: j.error });
    return j.result;
  };
  return async (method, params = []) => {
    let last;
    for (const url of urls) {
      try {
        if (chainId != null && !checked.has(url)) {
          const got = Number(BigInt(await post(url, 'eth_chainId', [])));
          if (got !== Number(chainId)) throw new Error(`${url} serves chain ${got}, not ${chainId}`);
          checked.add(url);
        }
        return await post(url, method, params);
      } catch (e) {
        if (e.rpcError) throw e; // the node answered: an error of the call itself, not of the endpoint
        last = e;
      }
    }
    throw new Error(`all endpoints failed (${last?.message ?? 'none'})`);
  };
}

/** Cosmos REST (LCD), GET only, failover over URLs; get(path) -> json | null (404). */
export function restClient(urls, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  return async (path) => {
    let last;
    for (const url of urls) {
      try { return await fetchJson(fetchImpl, url.replace(/\/$/, '') + path, { method: 'GET', headers: { accept: 'application/json' } }, timeoutMs); } catch (e) { last = e; }
    }
    throw new Error(`all endpoints failed (${last?.message ?? 'none'})`);
  };
}

// ------------------------------------------------------------------ live code hashes (what the chain runs NOW)
export const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export const ZOS_IMPL = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const IMPLEMENTATION_SEL = '0x5c60da1b'; // implementation() (a beacon's)
export const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

/** EIP-1167 minimal proxy (also the 0x3d602d80… creation-free runtime form): its implementation, else null. */
export function minimalProxyTarget(code) {
  const m = /^(?:0x)?363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(String(code));
  return m ? `0x${m[1].toLowerCase()}` : null;
}
const slotAddress = (word) => {
  const h = String(word ?? '').replace(/^0x/i, '').padStart(64, '0');
  if (!/^[0-9a-fA-F]{64}$/.test(h) || !/^0{24}/.test(h)) return null;
  const a = `0x${h.slice(24).toLowerCase()}`;
  return /^0x0{40}$/.test(a) ? null : a;
};

/**
 * Reads an EVM target as the chain runs it now. `rpc(method, params)` is a JSON-RPC call on THAT chain.
 * Returns { code, codeHash, proxy: null | { kind: 'eip1967'|'zos'|'beacon'|'eip1167', implementation, beacon?, admin? } }.
 * codeHash is keccak256(runtime code) = EXTCODEHASH (zero-length code: the empty hash, i.e. "nothing there").
 */
export async function readEvmCode(k, rpc, address) {
  const code = String(await rpc('eth_getCode', [address, 'latest']) ?? '0x');
  if (!/^0x([0-9a-fA-F]{2})*$/.test(code)) throw new Error('eth_getCode: not hex');
  const codeHash = keccakHex(k, code);
  if (code === '0x') return { code, codeHash, proxy: null };
  const clone = minimalProxyTarget(code);
  if (clone) return { code, codeHash, proxy: { kind: 'eip1167', implementation: clone } };
  const slot = async (s) => slotAddress(await rpc('eth_getStorageAt', [address, s, 'latest']).catch(() => null));
  const [impl, beacon, zos, admin] = await Promise.all([slot(EIP1967_IMPL), slot(EIP1967_BEACON), slot(ZOS_IMPL), slot(EIP1967_ADMIN)]);
  if (impl) return { code, codeHash, proxy: { kind: 'eip1967', implementation: impl, ...(admin ? { admin } : {}) } };
  if (beacon) {
    const r = await rpc('eth_call', [{ to: beacon, data: IMPLEMENTATION_SEL }, 'latest']).catch(() => null);
    return { code, codeHash, proxy: { kind: 'beacon', beacon, implementation: slotAddress(r), ...(admin ? { admin } : {}) } };
  }
  if (zos) return { code, codeHash, proxy: { kind: 'zos', implementation: zos } };
  return { code, codeHash, proxy: null };
}

/** A checksum the chain reports (hex, any case, or base64 of 32 bytes) as 0x lowercase hex, else null. */
export function normalizeChecksum(v) {
  const s = String(v ?? '').trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return `0x${s.replace(/^0x/i, '').toLowerCase()}`;
  try {
    const bin = atob(s);
    if (bin.length === 32) return toHex(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch { /* not base64 */ }
  return null;
}

/**
 * Reads a CosmWasm contract (or a bare code id) through a Cosmos REST (LCD) `get(path) -> json|null`.
 * The "code hash" of CosmWasm is the code's checksum: sha256 of the wasm, which the chain itself stores and
 * cosmwasm/optimizer prints in artifacts/checksums.txt. A contract with an `admin` can be migrated to other code
 * (the CosmWasm form of an upgradeable proxy): a migration changes its code id and therefore its checksum.
 * Returns { codeId, codeHash, admin, creator, label }.
 */
export async function readCosmwasm(get, { address = null, codeId = null }) {
  let info = null;
  if (address) {
    const c = await get(`/cosmwasm/wasm/v1/contract/${encodeURIComponent(address)}`);
    info = c?.contract_info;
    if (!info) throw new Error(`no CosmWasm contract ${address}`);
    codeId = info.code_id;
  }
  if (!/^\d{1,12}$/.test(String(codeId ?? ''))) throw new Error('a CosmWasm code id is a number');
  // wasmd ≥ 0.50 serves code-info without the wasm; older nodes only /code/{id} (the wasm comes along, unread)
  const ci = await get(`/cosmwasm/wasm/v1/code-info/${codeId}`).catch(() => null);
  const sum = ci?.checksum ?? ci?.code_info?.data_hash ?? (await get(`/cosmwasm/wasm/v1/code/${codeId}`))?.code_info?.data_hash;
  const codeHash = normalizeChecksum(sum);
  if (!codeHash) throw new Error(`code ${codeId}: no checksum`);
  return { codeId: String(codeId), codeHash, admin: info?.admin || null, creator: info?.creator ?? ci?.creator ?? null, label: info?.label ?? null };
}

/** The line of a cosmwasm/optimizer checksums.txt for `file` (e.g. my_contract.wasm), as 0x hex, else null. */
export function checksumFromTxt(text, file) {
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && (m[2] === file || m[2].endsWith(`/${file}`))) return `0x${m[1].toLowerCase()}`;
  }
  return null;
}

// Solana BPF upgradeable loader accounts (UpgradeableLoaderState, bincode): Program = tag 2 + programdata pubkey;
// ProgramData = tag 3 + slot (u64) + Option<authority pubkey> = 45 bytes of header, then the ELF.
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58_ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}
const b64 = (s) => Uint8Array.from(atob(String(s)), (ch) => ch.charCodeAt(0));
/** The program-data header: { slot, authority } (authority null: immutable). */
export function parseProgramData(bytes) {
  if (bytes.length < 45 || bytes[0] !== 3 || bytes[1] || bytes[2] || bytes[3]) throw new Error('not a ProgramData account');
  let slot = 0n;
  for (let i = 11; i >= 4; i--) slot = slot * 256n + BigInt(bytes[i]);
  return { slot, authority: bytes[12] === 1 ? base58Encode(bytes.slice(13, 45)) : null };
}
/**
 * solana-verify's program hash: sha256 of the deployed ELF (the program-data account after its 45-byte header)
 * with trailing zero bytes removed. The same number `solana-verify get-program-hash` and `get-executable-hash` print.
 */
export async function solanaProgramHash(sha256, programData) {
  let end = programData.length;
  while (end > 45 && programData[end - 1] === 0) end--;
  return toHex(await sha256(programData.slice(45, end)));
}
/**
 * Reads a Solana program: `rpc(method, params)` on that cluster. Upgradeable programs: the program account
 * points at its program-data account, whose authority can replace the code at any time (like a proxy admin);
 * the hash binds the certificate to the exact ELF. Returns { programData, authority, slot, codeHash, loader }.
 */
export async function readSolanaProgram(sha256, rpc, programId) {
  const acc = await rpc('getAccountInfo', [programId, { encoding: 'base64' }]);
  const v = acc?.value;
  if (!v) throw new Error(`no account ${programId}`);
  if (!v.executable) throw new Error(`${programId} is not a program`);
  const data = b64(v.data?.[0] ?? '');
  if (v.owner !== BPF_UPGRADEABLE_LOADER) {
    // a non-upgradeable (BPF loader 2) program keeps its ELF in the program account itself
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    return { programData: null, authority: null, slot: null, codeHash: toHex(await sha256(data.slice(0, end))), loader: v.owner };
  }
  if (data.length < 36 || data[0] !== 2) throw new Error('not an upgradeable Program account');
  const pda = base58Encode(data.slice(4, 36));
  const pd = await rpc('getAccountInfo', [pda, { encoding: 'base64' }]);
  const bytes = b64(pd?.value?.data?.[0] ?? '');
  const { slot, authority } = parseProgramData(bytes);
  return { programData: pda, authority, slot: String(slot), codeHash: await solanaProgramHash(sha256, bytes), loader: v.owner };
}

// ------------------------------------------------------------------ certificate state against the live code
export const STATUSES = ['valid', 'expired', 'revoked', 'code_changed', 'none', 'unverifiable'];
const big = (v) => BigInt(v ?? 0);

/**
 * What a certificate means right now, for a reader on any chain.
 *   cert, valid: AuditCertificate.certificate(chainId, target) on ZETAPHY (decodeCertificate);
 *   live: { codeHash } the target chain's code hash now, or { error } when its RPC could not be read;
 *   impl (proxies): { address, live: {codeHash}|{error}, cert, valid } for the implementation the proxy points at now;
 *   now: seconds.
 * Order: revoked > expired > code changed > unverifiable > valid. The contract's own `valid` already covers
 * expiry, revocation (also of the same codeHash elsewhere) and, on ZETAPHY, EXTCODEHASH; for other chains the
 * code check is the reader's job, done here with `live`.
 */
export function certificateStatus({ cert, valid, live = null, impl = null, now }) {
  if (!cert || big(cert.issuedAt) === 0n) return { status: 'none', reason: 'none', level: 0 };
  const level = Number(cert.level) || 0;
  const t = BigInt(Math.floor(now));
  const codeDiffers = live?.codeHash && String(live.codeHash).toLowerCase() !== String(cert.codeHash).toLowerCase();
  if (big(cert.revokedAt) !== 0n || big(cert.revokedBy) !== 0n) return { status: 'revoked', reason: 'finding', level };
  if (t >= big(cert.expiresAt)) return { status: 'expired', reason: 'expired', level };
  if (!valid && !codeDiffers) {
    // on ZETAPHY the contract's `valid` also checks EXTCODEHASH: without the live code we cannot tell which one failed
    if (Number(cert.chainId) === ZETAPHY_CHAIN_ID && !live?.codeHash) return { status: 'unverifiable', reason: 'rpc', level };
    return { status: 'revoked', reason: 'codeRevoked', level }; // the same codeHash was revoked under another request
  }
  if (codeDiffers) return { status: 'code_changed', reason: 'code', level };
  if (impl) {
    if (!impl.address) return { status: 'unverifiable', reason: 'implementationUnknown', level };
    const s = certificateStatus({ cert: impl.cert, valid: impl.valid, live: impl.live, now });
    if (s.status === 'none') return { status: 'code_changed', reason: 'implementationUncertified', level };
    if (s.status !== 'valid' && s.status !== 'unverifiable') return { status: 'code_changed', reason: `implementation_${s.status}`, level };
    if (s.status === 'unverifiable') return { status: 'unverifiable', reason: 'implementationUnreadable', level };
  }
  if (!live || live.error || !live.codeHash) return { status: 'unverifiable', reason: 'rpc', level };
  return { status: 'valid', reason: 'ok', level };
}

// ------------------------------------------------------------------ the badge (SVG, embeddable anywhere)
export const BADGE_COLORS = { valid: '#1d7a3a', expired: '#9a5b00', revoked: '#a3322b', code_changed: '#a3322b', none: '#56627a', unverifiable: '#56627a', scanned: '#0b5fa5', issues: '#a3322b' };
const BADGE_TEXT = { valid: 'VALID', expired: 'EXPIRED', revoked: 'REVOKED', code_changed: 'CODE CHANGED', none: 'NOT CERTIFIED', unverifiable: 'UNVERIFIED', scanned: 'SCANNED', issues: 'ISSUES' };
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const textWidth = (s) => Math.ceil([...String(s)].reduce((w, ch) => w + (/[A-Z0-9 ]/.test(ch) ? 7.2 : /[il.·:|]/.test(ch) ? 3.4 : 6.4), 0)) + 12;

/**
 * A flat two-part badge, "ZETAPHY audit | VALID · GOLD", as a standalone SVG (no scripts, no external refs,
 * so it is safe as an <img> on any site and in a README). status: one of STATUSES or 'scanned' / 'issues'
 * (the automated-only GitHub Action); detail: an extra word (the level, "0 high", an expiry date).
 */
export function badgeSvg({ status, level = 0, detail = '', label = 'ZETAPHY audit' }) {
  const st = BADGE_TEXT[status] ? status : 'none';
  const right = [BADGE_TEXT[st], st === 'valid' && LEVELS[level] ? LEVELS[level].toUpperCase() : '', detail].filter(Boolean).join(' · ');
  const lw = textWidth(label), rw = textWidth(right), w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${xml(`${label}: ${right}`)}">`
    + `<title>${xml(`${label}: ${right}`)}</title>`
    + `<rect width="${lw}" height="20" fill="#14203a"/><rect x="${lw}" width="${rw}" height="20" fill="${BADGE_COLORS[st]}"/>`
    + `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`
    + `<text x="${lw / 2}" y="14">${xml(label)}</text><text x="${lw + rw / 2}" y="14">${xml(right)}</text></g></svg>`;
}

/** The badge of an automated-only run (the GitHub Action): open critical/high from `report.js --json`. */
export function scanBadge(summary) {
  const open = (summary?.findings ?? []).filter((f) => f.status === 'open' || f.status === 'accepted');
  const crit = open.filter((f) => f.severity === 'critical').length, high = open.filter((f) => f.severity === 'high').length;
  const status = crit + high ? 'issues' : 'scanned';
  return { status, critical: crit, high, svg: badgeSvg({ status, detail: crit + high ? `${crit} critical, ${high} high` : 'no open high', label: 'ZETAPHY scan' }) };
}

// ------------------------------------------------------------------ tiers and orders
/**
 * What each tier gets. `fast` is the automated pipeline only (free, self-serve: the GitHub Action or one
 * `zetaphy audit run`): a report and a SCANNED badge, never a certificate. The other three are AuditNetwork
 * requests (tier 0/1/2): automated tier by 3 runners (2 must agree) + an open contest of bonded auditors +
 * bonded judges, and a certificate only if everything passes (AuditCertificate.check).
 * contestExtraDays/auditorsExtra are AuditNetwork's own rule: each tier adds 7 days and 2 auditors to the minimums.
 */
export const TIERS = {
  fast: { network: null, automated: true, ai: 'advisory', contest: false, judges: false, certificate: false, contestExtraDays: 0, auditorsExtra: 0 },
  basic: { network: 0, automated: true, ai: 'advisory', contest: true, judges: true, certificate: true, contestExtraDays: 0, auditorsExtra: 0 },
  standard: { network: 1, automated: true, ai: 'advisory', contest: true, judges: true, certificate: true, contestExtraDays: 7, auditorsExtra: 2 },
  deep: { network: 2, automated: true, ai: 'advisory', contest: true, judges: true, certificate: true, contestExtraDays: 14, auditorsExtra: 4 },
};
export const TIER_KEYS = Object.keys(TIERS);

/**
 * The AuditNetwork.request terms for a tier, checked as the contract checks them (AuditNetwork._terms), from
 * the live getParams(). pool: the bounty pool wanted (wei); value = pool + fee so that value - fee = pool.
 * Returns { tier, contest (s), minAuditors, value, fee, pool, runnersFee, judgesFee }.
 */
export function orderTerms(params, tierKey, { pool, contestDays = null, auditors = null }) {
  const t = TIERS[tierKey];
  if (!t || t.network == null) throw new Error(`tier ${tierKey}: one of basic, standard, deep (fast is the free automated run: no order)`);
  const need = Number(params.minContest) + t.network * 7 * 86400;
  const contest = contestDays == null ? need : Math.round(Number(contestDays) * 86400);
  if (contest < need) throw new Error(`the ${tierKey} tier needs a contest of at least ${need / 86400} days`);
  if (contest > Number(params.maxContest)) throw new Error(`a contest is at most ${Number(params.maxContest) / 86400} days`);
  const minA = Number(params.minAuditorsFloor) + 2 * t.network;
  const minAuditors = auditors == null ? minA : Number(auditors);
  if (!Number.isInteger(minAuditors) || minAuditors < minA || minAuditors > 65535) throw new Error(`the ${tierKey} tier needs at least ${minA} auditors`);
  const p = big(pool);
  if (p < big(params.minPool)) throw new Error(`the bounty pool must be at least ${params.minPool} wei`);
  const bps = big(params.feeBps);
  let value = (p * 10000n + (10000n - bps) - 1n) / (10000n - bps);
  while (value - (value * bps) / 10000n < p) value += 1n;
  const fee = (value * bps) / 10000n;
  const runnersFee = (fee * big(params.runnerBps)) / 10000n;
  return { tier: t.network, tierKey, contest, minAuditors, value, fee, pool: value - fee, runnersFee, judgesFee: fee - runnersFee };
}

/** AuditNetwork.request calldata for a Target ({chainId, target, codeHash, sourceHash}) and order terms. */
export const REQUEST_SIG = 'request((uint64,address,bytes32,bytes32),uint8,uint32,uint16,uint64,string)';
export function requestCalldata(k, target, terms, uri, prev = 0n) {
  return calldata(k, REQUEST_SIG, [[BigInt(target.chainId), target.target, target.codeHash, target.sourceHash], terms.tier, terms.contest, terms.minAuditors, BigInt(prev), uri]);
}

// ------------------------------------------------------------------ reads on ZETAPHY / the mirrors
export const CERTIFICATE_SIG = 'certificate(uint64,address)';
export const certificateCall = (k, chainId, target) => calldata(k, CERTIFICATE_SIG, [BigInt(chainId), target]);
export const MIRROR_SIG = 'isCertified(uint64,address)';
export const mirrorCall = (k, chainId, target) => calldata(k, MIRROR_SIG, [BigInt(chainId), target]);

/**
 * The whole check a reader does, shared by the hub's certificate page and `zetaphy aas verify`:
 *   zcall(to, data) -> hex: eth_call on ZETAPHY; certificate: AuditCertificate's address;
 *   rpc(method, params): JSON-RPC on the target chain (EVM, Solana); rest(path): its REST API (CosmWasm);
 *   mirror: optional { oracle, call(to, data) } the NeuroOracle mirror on the target chain (EVM).
 * Returns { chain, address, target, chainId, cert, valid, live, impl, mirror, status, reason, level }.
 */
export async function verifyCertificate({ k, sha256, chain, address, certificate, zcall, rpc = null, rest = null, mirror = null, now }) {
  const chainId = aasChainId(chain);
  const target = targetOf(k, chain, address);
  const readCert = async (t) => decodeCertificate(await zcall(certificate, certificateCall(k, chainId, t)));
  const { cert, valid } = await readCert(target);
  let live = null;
  let impl = null;
  try {
    if (chain.kind === 'evm') {
      const r = await readEvmCode(k, rpc, address);
      live = { codeHash: r.codeHash, proxy: r.proxy };
      if (r.proxy && cert.issuedAt !== 0n) {
        impl = { address: r.proxy.implementation ?? null, live: null, cert: null, valid: false };
        if (impl.address) {
          const c = await readCert(impl.address);
          impl.cert = c.cert;
          impl.valid = c.valid;
          try { impl.live = { codeHash: (await readEvmCode(k, rpc, impl.address)).codeHash }; } catch (e) { impl.live = { error: String(e?.message ?? e) }; }
        }
      }
    } else if (chain.kind === 'cosmwasm') {
      const r = await readCosmwasm(rest, { address });
      live = { codeHash: r.codeHash, codeId: r.codeId, admin: r.admin };
    } else if (chain.kind === 'solana') {
      const r = await readSolanaProgram(sha256, rpc, address);
      live = { codeHash: r.codeHash, authority: r.authority };
    }
  } catch (e) {
    live = { error: String(e?.message ?? e).slice(0, 200) };
  }
  let mirrored = null;
  if (mirror?.oracle && chain.kind === 'evm' && cert.issuedAt !== 0n) {
    try { mirrored = decodeArgs(['bool'], await mirror.call(mirror.oracle, mirrorCall(k, chainId, target)))[0]; } catch { mirrored = null; }
  }
  const s = certificateStatus({ cert, valid, live, impl, now });
  return { chain: chain.key, address, target, chainId: String(chainId), cert, valid, live, impl, mirror: mirrored, ...s };
}

// ------------------------------------------------------------------ the public registry (audit-registry.json)
const HASH32 = /^0x[0-9a-f]{64}$/;
const N = (v, max = 1e6) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);
const sevCounts = (o) => Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((s) => [s, N(o?.[s])]));

/**
 * The registry the scheduled GitHub Action writes (zetaphy-network/scripts/aas-registry.js) and the hub reads.
 * It is UNTRUSTED input for the pages (anyone can fork the hub): every field is checked and anything malformed
 * dropped. The registry is only an index: the certificate page always re-reads ZETAPHY and the target chain.
 */
export function cleanRegistry(j) {
  const out = { version: 1, generatedAt: '', zetaphyChainId: ZETAPHY_CHAIN_ID, certificate: null, entries: [] };
  if (!j || typeof j !== 'object' || !Array.isArray(j.entries)) return out;
  if (typeof j.generatedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(j.generatedAt)) out.generatedAt = j.generatedAt;
  if (EVM_ADDR.test(j.certificate ?? '')) out.certificate = j.certificate.toLowerCase();
  for (const e of j.entries.slice(0, 5000)) {
    const chain = chainOf(e?.chain);
    if (!chain || !isNativeAddress(chain, e.address) || !EVM_ADDR.test(e.target ?? '') || !HASH32.test(String(e.codeHash ?? '').toLowerCase())) continue;
    if (String(aasChainId(chain)) !== String(e.chainId)) continue;
    const num = (v) => (/^\d{1,20}$/.test(String(v ?? '')) ? String(v) : '0');
    out.entries.push({
      chain: chain.key, chainId: String(e.chainId), address: String(e.address), target: e.target.toLowerCase(), codeHash: e.codeHash.toLowerCase(),
      role: ROLES.includes(e.role) ? e.role : 'contract', name: typeof e.name === 'string' ? e.name.replace(/[\u0000-\u001f<>]/g, '').slice(0, 60) : '',
      level: N(e.level, 3), requestId: num(e.requestId), issuedAt: num(e.issuedAt), expiresAt: num(e.expiresAt), revoked: e.revoked === true,
      report: typeof e.report === 'string' && /^(https:\/\/|ipfs:\/\/)[^\s"<>]{1,180}$/.test(e.report) ? e.report : '',
      reportHash: HASH32.test(String(e.reportHash ?? '').toLowerCase()) ? e.reportHash.toLowerCase() : '',
      findings: { open: N(e.findings?.open), valid: sevCounts(e.findings?.valid), late: N(e.findings?.late), fixed: N(e.findings?.fixed) },
      implementation: e.implementation && isNativeAddress(chain, e.implementation) ? String(e.implementation) : null,
    });
  }
  return out;
}

/** The state an entry shows in the directory without any RPC (the page then re-checks live): valid | expired | revoked. */
export function registryState(e, now) {
  if (e.revoked) return 'revoked';
  return BigInt(Math.floor(now)) >= BigInt(e.expiresAt || 0) ? 'expired' : 'valid';
}

/** `#<chain>:<address>` (chain: key, EVM chain id or CAIP-2's reference) → { chain, address } or null. */
export function parseRef(hash) {
  const s = decodeURIComponent(String(hash ?? '').replace(/^#/, '')).trim();
  const i = s.lastIndexOf(':');
  if (i < 1) return null;
  const chain = chainOf(s.slice(0, i));
  const address = s.slice(i + 1);
  if (!chain || !isNativeAddress(chain, address)) return null;
  return { chain, address: chain.kind === 'evm' ? address.toLowerCase() : address };
}
export const refOf = (chain, address) => `${chain.kind === 'evm' ? chain.chainId : chain.key}:${address}`;

/** The keccak of a certificate key (AuditCertificate.keyOf / NeuroOracle certs key): keccak256(abi.encode(chainId, target)). */
export const certKey = (k, chainId, target) => keccakHex(k, encodeArgs(['uint64', 'address'], [BigInt(chainId), target]));

// ------------------------------------------------------------------ where things are published (no server)
// The scheduled Action (.github/workflows/audit-registry.yml) force-pushes audit-registry.json and badges/ to the
// orphan branch `audit-registry`. raw.githubusercontent.com serves the JSON with CORS; jsDelivr serves the badges
// as image/svg+xml (raw.githubusercontent.com sends text/plain, which <img> refuses). The hub ships its own copy
// (aas-registry.json, empty until a build has one) as the fallback.
export const HUB_ORIGIN = 'https://app.sawasdeecoin.com';
export const REPO = 'pospos191-alt/swd-amm';
export const REGISTRY_BRANCH = 'audit-registry';
export const REGISTRY_URLS = [`https://raw.githubusercontent.com/${REPO}/${REGISTRY_BRANCH}/audit-registry.json`, './aas-registry.json'];
/** badges/<chain key>-<native address>.svg, the file name the registry writes for an entry. */
export const badgeFile = (e) => `${e.chain}-${e.address}.svg`.replace(/[^A-Za-z0-9._-]/g, '_');
export const badgeUrl = (e) => `https://cdn.jsdelivr.net/gh/${REPO}@${REGISTRY_BRANCH}/badges/${badgeFile(e)}`;
export const verifyUrl = (chain, address) => `${HUB_ORIGIN}/audit.html#${refOf(chain, address)}`;
/** The snippet a project pastes on its site / README: a link to the live check around the static badge. */
export function embedSnippets(chain, address) {
  const e = { chain: chain.key, address };
  const href = verifyUrl(chain, address), img = badgeUrl(e);
  return { html: `<a href="${href}"><img src="${img}" alt="ZETAPHY audit certificate" height="20"></a>`, markdown: `[![ZETAPHY audit](${img})](${href})`, href, img };
}

export { fromHex, toHex };
