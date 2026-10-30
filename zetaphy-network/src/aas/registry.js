// Audit-as-a-Service: the public registry of certificates (docs/future/audit-as-a-service.md), built from
// ZETAPHY's own state by a scheduled GitHub Action (.github/workflows/audit-registry.yml): no server, no key.
//   audit-registry.json  every certificate ever issued, its current state, level, expiry, report link and the
//                        request's findings (open / valid by severity / post-certificate / fixes confirmed);
//   badges/<ref>.svg     one static badge per certificate (the hub serves them; any site embeds them as <img>).
// The registry is an index: the hub's certificate page (audit.html) re-reads ZETAPHY and the target chain live.
import { keccak256 } from '../../../zetaphy-neuro/src/keccak.js';
import * as aas from '../../../zetaphy-hub/aas-core.js';
import * as core from '../../../zetaphy-hub/audit-core.js';

const k = keccak256;
const topic = (sig) => core.keccakHex(k, new TextEncoder().encode(sig));
export const T_ISSUED = topic('CertificateIssued(uint256,uint64,address,bytes32,bytes32,uint8,uint64)');
export const T_URI = topic('RequestUri(uint256,string)');
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

/** eth_getLogs over [from, to] in chunks (public RPCs cap the range). */
async function logs(rpc, filter, from, to, chunk) {
  const out = [];
  for (let a = from; a <= to; a += chunk) {
    const b = Math.min(to, a + chunk - 1);
    out.push(...await rpc('eth_getLogs', [{ ...filter, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }]));
  }
  return out;
}

/**
 * rpc: JSON-RPC on ZETAPHY; certificate / network: AuditCertificate / AuditNetwork addresses; fromBlock: their
 * deployment block. Returns the registry object (aas-core cleanRegistry's schema) and the badges { file: svg }.
 */
export async function buildRegistry({ rpc, certificate, network, fromBlock = 0, chunk = 10_000, now = Math.floor(Date.now() / 1000) }) {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const issued = await logs(rpc, { address: certificate, topics: [T_ISSUED] }, fromBlock, latest, chunk);
  const call = (to, sig, args = []) => rpc('eth_call', [{ to, data: core.calldata(k, sig, args) }, 'latest']);
  const seen = new Set();
  const entries = [];
  for (const l of issued) {
    const chainId = BigInt(l.topics[2]);
    const target = `0x${l.topics[3].slice(-40)}`.toLowerCase();
    const key = `${chainId}:${target}`;
    if (seen.has(key)) continue; // the newest certificate of each (chainId, target) is what certificate() returns
    seen.add(key);
    const { cert } = core.decodeCertificate(await call(certificate, core.SIG.certificate, [chainId, target]));
    if (cert.issuedAt === 0n) continue;
    const chain = aas.chainOf(String(chainId));
    if (!chain) continue; // a chain this registry does not know (yet)
    const id = cert.requestId;
    const uriLogs = await logs(rpc, { address: network, topics: [T_URI, word(id)] }, fromBlock, latest, chunk);
    const uri = uriLogs.length ? core.decodeArgs(['string'], uriLogs[uriLogs.length - 1].data)[0] : '';
    const order = aas.parseOrderUri(uri);
    const native = order && order.chain === chain.key ? order.native : chain.kind === 'evm' ? target : null;
    if (!native || aas.targetOf(k, chain, native) !== target) continue; // a non-EVM target needs its native address from the order
    const fids = core.decodeArgs(['uint256[]'], await call(network, core.SIG.findingsOf, [id]))[0];
    const findings = { open: 0, valid: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, late: 0, fixed: 0 };
    for (const fid of fids) {
      const f = core.decodeFinding(await call(network, core.SIG.getFinding, [fid]));
      if (f.status === 1 || f.status === 2) findings.open += 1;
      if (f.status === 3) findings.valid[core.SEVERITIES[f.sev]] += 1;
      if (f.late) findings.late += 1;
    }
    findings.fixed = core.decodeArgs(['uint64[]'], await call(network, core.SIG.carriedOf, [id]))[0].length; // all confirmed fixed (else no certificate)
    entries.push({
      chain: chain.key, chainId: String(chainId), address: native, target, codeHash: cert.codeHash.toLowerCase(), role: order?.role ?? 'contract', name: '',
      level: cert.level, requestId: String(id), issuedAt: String(cert.issuedAt), expiresAt: String(cert.expiresAt),
      // revoked: this certificate, or the same code under another request (AuditCertificate.revokedCode)
      revoked: cert.revokedAt !== 0n || cert.revokedBy !== 0n || BigInt(await call(certificate, 'revokedCode(bytes32)', [cert.codeHash])) !== 0n,
      report: order?.link ?? '', reportHash: cert.reportHash.toLowerCase(), findings, implementation: null,
    });
  }
  // a proxy and its implementation are two certificates: link them when both are here
  for (const e of entries.filter((x) => x.role === 'proxy')) {
    const impl = entries.find((x) => x.role === 'implementation' && x.chain === e.chain && x.report && x.report === e.report);
    if (impl) e.implementation = impl.address;
  }
  const registry = aas.cleanRegistry({ version: 1, generatedAt: new Date(now * 1000).toISOString(), certificate, entries });
  return { registry, badges: badgesFor(registry, now) };
}

/** One static badge per entry: badges/<chain key>-<address>.svg (the state as of the build; the page re-checks live). */
export function badgesFor(registry, now) {
  const out = {};
  for (const e of registry.entries) out[aas.badgeFile(e)] = aas.badgeSvg({ status: aas.registryState(e, now), level: e.level });
  return out;
}
export const { badgeFile } = aas;
