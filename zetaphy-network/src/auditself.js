// The audit network audits itself (docs/future/immune-score.md, SS8): AuditNetwork, AuditRunners, AuditJudges and
// AuditCertificate go through the same open audit as anyone's code (requests on their own addresses, the contest,
// the runners, the judges, a certificate), and a CI check fails when one of them lacks a live certificate.
//
// The record of the self-audit (deployments/audit-self-77390.json, written by `node scripts/audit-self.js record` once
// the certificates exist on chain) lists, per contract: its address, its deployed code hash, the hash of the artifact
// it was built from, and the certificate. The check is OFF while that file does not exist.
import { readFileSync, existsSync } from 'node:fs';
import { Interface, keccak256, isAddress } from 'ethers';

export const SELF = [
  { key: 'auditNetwork', name: 'AuditNetwork' },
  { key: 'auditRunners', name: 'AuditRunners' },
  { key: 'auditJudges', name: 'AuditJudges' },
  { key: 'auditCertificate', name: 'AuditCertificate' },
];
export const SELF_FILE = new URL('../deployments/audit-self-77390.json', import.meta.url);
export const DEPLOY_FILE = new URL('../deployments/audit-77390.json', import.meta.url);
const ARTIFACTS = new URL('../artifacts/', import.meta.url);
const certIface = new Interface(JSON.parse(readFileSync(new URL('AuditCertificate.json', ARTIFACTS), 'utf8')).abi);

/** keccak256 of the committed artifact's runtime bytecode (immutables still zero: it identifies the BUILD). */
export function artifactHash(name, artifacts = ARTIFACTS) {
  const a = JSON.parse(readFileSync(new URL(`${name}.json`, artifacts), 'utf8'));
  return keccak256(a.deployedBytecode);
}

/** The four self-audit targets of a deployment file ({ chainId, contracts: { auditNetwork: 0x…, … } }), with their live code hashes. */
export async function selfTargets(send, deployment) {
  const out = [];
  for (const { key, name } of SELF) {
    const address = deployment.contracts?.[key];
    if (!isAddress(address ?? '')) throw new Error(`${key}: no address in the deployment file`);
    const code = await send('eth_getCode', [address, 'latest']);
    if (!code || code === '0x') throw new Error(`${name} at ${address}: no code`);
    out.push({ key, name, address, codeHash: keccak256(code) });
  }
  return out;
}

/** AuditCertificate.certificate(chainId, address) -> { cert, valid } (cert fields as numbers / hex). */
export async function readCertificate(send, certificate, chainId, address) {
  const raw = await send('eth_call', [{ to: certificate, data: certIface.encodeFunctionData('certificate', [chainId, address]) }, 'latest']);
  const [c, valid] = certIface.decodeFunctionResult('certificate', raw);
  return { valid, cert: { requestId: Number(c.requestId), codeHash: c.codeHash.toLowerCase(), level: Number(c.level), issuedAt: Number(c.issuedAt),
    expiresAt: Number(c.expiresAt), revoked: c.revokedAt !== 0n } };
}

/** The self-audit record after the certificates exist on chain (what `record` writes). */
export async function buildRecord(send, deployment, { artifacts = ARTIFACTS } = {}) {
  const chainId = Number(deployment.chainId ?? 77390);
  const targets = await selfTargets(send, deployment);
  const contracts = {};
  for (const t of targets) {
    const { cert } = await readCertificate(send, deployment.contracts.auditCertificate, chainId, t.address);
    contracts[t.key] = { name: t.name, address: t.address, codeHash: t.codeHash.toLowerCase(), artifactHash: artifactHash(t.name, artifacts), certificate: cert };
  }
  return { format: 'zetaphy.audit.self.v1', chainId, auditCertificate: deployment.contracts.auditCertificate, contracts };
}

/**
 * Offline check of a self-audit record: every audit contract has a certificate that is issued, unrevoked, unexpired at
 * `now`, for exactly the recorded code hash, and the recorded artifact hash is the committed artifact's (a change to
 * a contract's source makes a new artifact: its certificate no longer covers what this repository builds).
 * -> problems: [string] (empty: ok)
 */
export function checkRecord(record, { now = Math.floor(Date.now() / 1000), artifacts = ARTIFACTS } = {}) {
  const problems = [];
  if (record?.format !== 'zetaphy.audit.self.v1') return ['not a self-audit record (format zetaphy.audit.self.v1)'];
  for (const { key, name } of SELF) {
    const c = record.contracts?.[key];
    if (!c) { problems.push(`${name}: missing`); continue; }
    const cert = c.certificate ?? {};
    if (!cert.issuedAt) problems.push(`${name}: no certificate`);
    else {
      if (cert.revoked) problems.push(`${name}: certificate revoked`);
      if (!(cert.expiresAt > now)) problems.push(`${name}: certificate expired (${new Date(cert.expiresAt * 1000).toISOString().slice(0, 10)})`);
      if (String(cert.codeHash).toLowerCase() !== String(c.codeHash).toLowerCase()) problems.push(`${name}: the certificate is for another code hash`);
    }
    const now_ = artifactHash(name, artifacts);
    if (String(c.artifactHash).toLowerCase() !== now_.toLowerCase()) problems.push(`${name}: the artifact changed since its self-audit (${String(c.artifactHash).slice(0, 10)}… -> ${now_.slice(0, 10)}…): a new version needs a new request`);
  }
  return problems;
}

/** Live check against the chain: the deployed code is still the recorded one and isCertified holds. */
export async function checkLive(send, record) {
  const problems = [];
  for (const { key, name } of SELF) {
    const c = record.contracts?.[key];
    if (!c) continue;
    const code = await send('eth_getCode', [c.address, 'latest']);
    if (keccak256(code).toLowerCase() !== String(c.codeHash).toLowerCase()) problems.push(`${name}: the deployed code changed`);
    const { valid } = await readCertificate(send, record.auditCertificate, record.chainId, c.address);
    if (!valid) problems.push(`${name}: AuditCertificate.isCertified is false on chain`);
  }
  return problems;
}

/** -> { status: 'off' | 'ok' | 'fail', problems } (OFF when there is no self-audit record yet). */
export async function selfCheck({ file = SELF_FILE, send = null, now, artifacts = ARTIFACTS } = {}) {
  if (!existsSync(file)) return { status: 'off', problems: [] };
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { status: 'fail', problems: [`unreadable: ${e.message}`] }; }
  const problems = checkRecord(record, { now, artifacts });
  if (send) problems.push(...await checkLive(send, record));
  return { status: problems.length ? 'fail' : 'ok', problems };
}

/** The `zetaphy audit request` commands that file the self-audit (one per contract, its own address and code). */
export function planCommands(targets, { chainId = 77390, source = '<git commit>', days = 7, auditors = 3, pool = 100 } = {}) {
  return targets.map((t) => `zetaphy audit request ${chainId} ${t.address} --source ${source} --days ${days} --auditors ${auditors} --pool ${pool}   # ${t.name}, code ${t.codeHash.slice(0, 12)}…`);
}
