// Audit-as-a-Service: the network side of intake (docs/future/audit-as-a-service.md). Free, keyless public
// endpoints only (zetaphy-hub/aas-core.js AAS_CHAINS); every call takes `fetchImpl` so tests replay recorded
// fixtures and nothing here needs an API key.
import { createHash } from 'node:crypto';
import * as aas from '../../../zetaphy-hub/aas-core.js';

export const sha256 = async (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

export const jsonRpc = aas.rpcClient;
export const restGet = aas.restClient;
const { fetchJson } = aas;

export const SOURCIFY = 'https://sourcify.dev/server';

/**
 * Verified source from Sourcify's v2 API (free, no key; covers every EVM chain of AAS_CHAINS but ZETAPHY):
 * GET /v2/contract/{chainId}/{address}?fields=sources,compilation,runtimeMatch,creationMatch,proxyResolution.
 * "exact_match" / "match" means Sourcify recompiled the source and got the bytecode on chain.
 * Returns { match, files: {path: content}, compiler, proxy: {isProxy, type, implementations[]} | null } or null.
 */
export async function sourcifyV2({ chainId, address, fetchImpl = globalThis.fetch, base = SOURCIFY, timeoutMs = 20_000 }) {
  const url = `${base}/v2/contract/${Number(chainId)}/${String(address).toLowerCase()}?fields=sources,compilation,runtimeMatch,creationMatch,proxyResolution`;
  let j;
  try { j = await fetchJson(fetchImpl, url, { method: 'GET', headers: { accept: 'application/json' } }, timeoutMs); } catch { return null; }
  if (!j || !(j.match || j.runtimeMatch)) return null;
  const files = {};
  for (const [path, v] of Object.entries(j.sources ?? {})) if (typeof v?.content === 'string') files[path] = v.content;
  if (!Object.keys(files).length) return null;
  const pr = j.proxyResolution;
  return {
    match: j.runtimeMatch ?? j.match,
    files,
    compiler: j.compilation ? { version: j.compilation.compilerVersion ?? null, name: j.compilation.name ?? null, path: j.compilation.fullyQualifiedName ?? null } : null,
    proxy: pr ? { isProxy: !!pr.isProxy, type: pr.proxyType ?? null, implementations: (pr.implementations ?? []).map((i) => String(i.address ?? '').toLowerCase()).filter(Boolean) } : null,
  };
}

/**
 * The OtterSec verified-builds API (free, no key) for a Solana program: whether a public repo + commit rebuilds
 * (solana-verify, in a pinned Docker image) to the program's on-chain hash. Returns
 * { verified, onChainHash, executableHash, repo, commit } or null when unknown / unreachable.
 */
export async function solanaVerifyStatus(programId, { fetchImpl = globalThis.fetch, base = 'https://verify.osec.io', timeoutMs = 15_000 } = {}) {
  let j;
  try { j = await fetchJson(fetchImpl, `${base}/status/${encodeURIComponent(programId)}`, { method: 'GET' }, timeoutMs); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const hex = (h) => (/^[0-9a-fA-F]{64}$/.test(String(h ?? '')) ? `0x${String(h).toLowerCase()}` : null);
  return { verified: j.is_verified === true, onChainHash: hex(j.on_chain_hash), executableHash: hex(j.executable_hash), repo: typeof j.repo_url === 'string' ? j.repo_url : null, commit: typeof j.commit === 'string' ? j.commit : null };
}
