// Audit-as-a-Service intake (docs/future/audit-as-a-service.md): from "this contract on that chain" (or a GitHub
// repo + commit) to the AuditNetwork Target(s) to order, with the code hash the target chain runs NOW.
//
//   EVM (Ethereum, BNB, Base, Arbitrum, Optimism, Polygon, Avalanche + testnets, ZETAPHY):
//     code hash = keccak256(runtime code) = EXTCODEHASH (eth_getCode on a public RPC, chain id checked);
//     source    = Sourcify v2 (verified: Sourcify recompiled it to these bytes), else a repo + full commit that the
//                 pipeline compiles and matches byte for byte (repo.js matchCompiled);
//     proxies   = EIP-1967 (implementation / beacon slots), EIP-1167 clones, ZeppelinOS: the proxy AND its current
//                 implementation are both ordered; a later implementation swap shows as CODE CHANGED.
//   CosmWasm (Osmosis, osmo-test-5): code hash = the code's checksum (sha256 of the wasm) from the chain's REST API;
//     source = repo + commit built with cosmwasm/optimizer (its checksums.txt must list the same checksum);
//     a contract with an admin can be migrated (shown as a warning; a migration changes the checksum).
//   Solana (mainnet, devnet): code hash = solana-verify's program hash (sha256 of the ELF in the program-data account,
//     trailing zeros trimmed); source = repo + commit, verified with `solana-verify` (OtterSec's public API if it
//     already knows the program); an upgrade authority can replace the program (warning).
import { keccak256 } from '../../../zetaphy-neuro/src/keccak.js';
import * as aas from '../../../zetaphy-hub/aas-core.js';
import { sourceHashOf } from '../auditnet.js';
import { jsonRpc, restGet, sourcifyV2, solanaVerifyStatus, sha256 } from './net.js';
import { parseRepo, parseCommit, repoRef, matchCompiled } from './repo.js';

const k = keccak256;
export const codeHashOf = (code) => aas.toHex(k(aas.fromHex(code)));

function entry(chain, { role, native, codeHash, sourceRef, source, link }) {
  return {
    role, native, codeHash,
    chainId: String(aas.aasChainId(chain)),
    target: aas.targetOf(k, chain, native),
    sourceRef,
    sourceHash: aas.sourceRefHash(k, sourceRef),
    source,
    uri: aas.orderUri({ chain, native, role, link }),
  };
}

/**
 * opts: { chain, address | codeId | programId, repo?, commit?, link?, checksumsTxt?, wasmFile?, runtimes?,
 *         fetchImpl?, rpcs? (override the public endpoints) }
 *   runtimes: { "file:Name": 0x… } the pipeline compiled from repo@commit (repo.js compiledRuntimes) to bind an
 *             unverified EVM contract to its source now; without it the binding is left to the runners.
 * Returns { chain, native, targets: [entry], proxy, warnings: [], ready } — ready: every target has a bound source.
 */
export async function intake(opts) {
  const chain = aas.chainOf(opts.chain);
  if (!chain) throw new Error(`chain ${opts.chain}: not supported (${aas.AAS_CHAINS.map((c) => c.key).join(', ')})`);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const urls = opts.rpcs?.length ? opts.rpcs : chain.rpcs;
  const repo = opts.repo ? parseRepo(opts.repo) : null;
  const commit = opts.commit ? parseCommit(opts.commit) : null;
  if (!!repo !== !!commit) throw new Error('give both --repo and --commit');
  const link = opts.link ?? (repo ? `${repo.url}/tree/${commit}` : '');
  const out = { chain: { key: chain.key, name: chain.name, kind: chain.kind, caip2: chain.caip2 }, native: null, targets: [], proxy: null, warnings: [], ready: false };

  if (chain.kind === 'evm') {
    const address = String(opts.address ?? '').trim();
    if (!aas.isNativeAddress(chain, address)) throw new Error('address: 0x followed by 40 hex characters');
    out.native = address.toLowerCase();
    const rpc = jsonRpc(urls, { fetchImpl, chainId: chain.chainId });
    const live = await aas.readEvmCode(k, rpc, out.native);
    if (live.code === '0x') throw new Error(`no contract at ${out.native} on ${chain.name}`);
    const one = async (native, role, code) => {
      const sf = chain.sourcify ? await sourcifyV2({ chainId: chain.chainId, address: native, fetchImpl }) : null;
      if (sf) return entry(chain, { role, native, codeHash: codeHashOf(code), link, sourceRef: sourceHashOf(sf.files), source: { origin: 'sourcify', match: sf.match, compiler: sf.compiler, files: Object.keys(sf.files).length } });
      if (!repo) {
        out.warnings.push(`${native}: not verified on Sourcify; give --repo and --commit (the pipeline compiles it and must reproduce the bytecode)`);
        return entry(chain, { role, native, codeHash: codeHashOf(code), link, sourceRef: `unverified:${chain.caip2}:${native}`, source: { origin: 'none', match: 'none' } });
      }
      const m = opts.runtimes ? matchCompiled(opts.runtimes, code, codeHashOf) : { match: 'pending', contract: null };
      if (m.match === 'none') out.warnings.push(`${native}: no contract compiled from ${repoRef(repo, commit)} has this bytecode (immutables? verify on Sourcify first)`);
      return entry(chain, { role, native, codeHash: codeHashOf(code), link, sourceRef: repoRef(repo, commit), source: { origin: 'repo', match: m.match, contract: m.contract } });
    };
    if (live.proxy) {
      out.proxy = live.proxy;
      out.targets.push(await one(out.native, 'proxy', live.code));
      if (live.proxy.implementation) {
        const impl = await aas.readEvmCode(k, rpc, live.proxy.implementation);
        if (impl.code === '0x') out.warnings.push(`the proxy points at ${live.proxy.implementation}, which has no code`);
        else out.targets.push(await one(live.proxy.implementation, 'implementation', impl.code));
      } else out.warnings.push('a beacon proxy whose beacon did not answer implementation(): order the implementation separately');
      if (live.proxy.admin || live.proxy.kind !== 'eip1167') out.warnings.push(`upgradeable (${live.proxy.kind}): the certificate covers this implementation only; an upgrade shows as CODE CHANGED`);
    } else out.targets.push(await one(out.native, 'contract', live.code));
  } else if (chain.kind === 'cosmwasm') {
    const get = restGet(urls, { fetchImpl });
    const address = opts.address ? String(opts.address).trim() : null;
    if (address && !aas.isNativeAddress(chain, address)) throw new Error(`address: a ${chain.prefix}1… contract address`);
    const r = await aas.readCosmwasm(get, { address, codeId: opts.codeId ?? null });
    out.native = address;
    out.cosmwasm = { codeId: r.codeId, admin: r.admin, creator: r.creator, label: r.label };
    if (r.admin) out.warnings.push(`migratable: admin ${r.admin} can move the contract to other code (that changes the checksum: CODE CHANGED)`);
    let match = 'pending';
    if (opts.checksumsTxt) {
      const built = aas.checksumFromTxt(opts.checksumsTxt, opts.wasmFile ?? '');
      match = built && built === r.codeHash ? 'exact' : 'none';
      if (match === 'none') out.warnings.push(`checksums.txt has ${built ?? 'no line'} for ${opts.wasmFile}, the chain has ${r.codeHash}: not the deployed code`);
    }
    if (!repo) out.warnings.push('CosmWasm has no Sourcify: give --repo and --commit (built with cosmwasm/optimizer, which must reproduce the checksum)');
    if (!address) out.warnings.push(`code id ${r.codeId} read (checksum ${r.codeHash}); a certificate is per contract: give the contract address to order`);
    else out.targets.push(entry(chain, { role: 'contract', native: address, codeHash: r.codeHash, link, sourceRef: repo ? repoRef(repo, commit) : `unverified:${chain.caip2}:code:${r.codeId}`,
      source: { origin: repo ? 'repo' : 'none', match: repo ? match : 'none', codeId: r.codeId } }));
  } else if (chain.kind === 'solana') {
    const programId = String(opts.programId ?? opts.address ?? '').trim();
    if (!aas.isNativeAddress(chain, programId)) throw new Error('program id: a base58 Solana address');
    out.native = programId;
    const rpc = jsonRpc(urls, { fetchImpl });
    const genesis = await rpc('getGenesisHash', []).catch(() => null);
    if (genesis && !chain.caip2.endsWith(`:${String(genesis).slice(0, 32)}`)) throw new Error(`${urls[0]} serves another cluster (genesis ${genesis})`);
    const p = await aas.readSolanaProgram(sha256, rpc, programId);
    out.solana = { programData: p.programData, authority: p.authority, slot: p.slot, loader: p.loader };
    if (p.authority) out.warnings.push(`upgradeable: ${p.authority} can replace the program (that changes the program hash: CODE CHANGED)`);
    const v = chain.testnet ? null : await solanaVerifyStatus(programId, { fetchImpl });
    let source;
    let ref;
    if (v?.verified && v.onChainHash === p.codeHash && v.repo && v.commit) {
      source = { origin: 'solana-verify', match: 'exact', repo: v.repo, commit: v.commit };
      ref = `${String(v.repo).replace(/^https:\/\//, '')}@${v.commit}`;
    } else if (repo) {
      source = { origin: 'repo', match: 'pending' }; // runners rebuild with `solana-verify build` and compare get-executable-hash
      ref = repoRef(repo, commit);
    } else {
      out.warnings.push('not in the verified-builds registry: give --repo and --commit (rebuilt with solana-verify, which must reproduce the program hash)');
      source = { origin: 'none', match: 'none' };
      ref = `unverified:${chain.caip2}:${programId}`;
    }
    out.targets.push(entry(chain, { role: 'program', native: programId, codeHash: p.codeHash, link, sourceRef: ref, source }));
  }
  out.ready = out.targets.length > 0 && out.targets.every((t) => ['exact', 'match', 'exact_match', 'metadata', 'pending'].includes(t.source.match) && t.source.origin !== 'none');
  return out;
}
