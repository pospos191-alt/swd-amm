// `zetaphy aas …`: Audit-as-a-Service from any chain (docs/future/audit-as-a-service.md). TESTNET ONLY: orders are
// AuditNetwork requests on ZETAPHY paid in testnet ZETAPHY, which has no value.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keccak256 } from '../../zetaphy-neuro/src/keccak.js';
import * as aas from '../../zetaphy-hub/aas-core.js';
import * as core from '../../zetaphy-hub/audit-core.js';
import { intake } from './aas/intake.js';
import { planOrder, paymentPlan } from './aas/order.js';
import { compiledRuntimes } from './aas/repo.js';
import { jsonRpc, restGet, sha256 } from './aas/net.js';
import { buildRegistry } from './aas/registry.js';
import { AUDIT_DEPLOY_FILE } from './auditnetcli.js';

const k = keccak256;
export const AAS_USAGE = `usage (TESTNET ONLY; docs/future/audit-as-a-service.md):
  zetaphy aas chains                                   the chains a project can order from, and how each one's code hash is read
  zetaphy aas intake <chain> <address|program id> [--repo owner/name --commit <40 hex> --pipeline-out <dir>
                      --code-id <n> --checksums artifacts/checksums.txt --wasm my_contract.wasm --json]
                      what would be audited: code hash on that chain now, verified source, proxy + implementation
  zetaphy aas order <chain> <address> --tier basic|standard|deep --pool 100 [--days 10 --auditors 4 --repo … --commit … --send]
                      the AuditNetwork request(s) on ZETAPHY (a proxy: two); --send signs them with this wallet
  zetaphy aas pay --from <chain>                       how to pay from another chain
  zetaphy aas verify <chain> <address>                 VALID / EXPIRED / REVOKED / CODE CHANGED, reading ZETAPHY and that chain live
  zetaphy aas badge --summary <report.js --json file> --out badge.svg     the automated-only (SCANNED) badge
  zetaphy aas registry --out <dir> [--rpc https://… --from-block N]       audit-registry.json + badges/ (the scheduled Action)`;

function deployed(opt) {
  const d = (() => { try { return JSON.parse(readFileSync(AUDIT_DEPLOY_FILE, 'utf8')); } catch { return null; } })();
  return { network: String(opt['audit-network'] ?? d?.contracts?.auditNetwork ?? ''), certificate: String(opt['audit-certificate'] ?? d?.contracts?.auditCertificate ?? ''), block: Number(opt['from-block'] ?? d?.block ?? 0) };
}
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
const fmt = (wei) => `${(Number(wei) / 1e18).toLocaleString('en', { maximumFractionDigits: 4 })} ZETAPHY`;

function intakeOpts(rest, opt) {
  const [chain, address] = rest;
  if (!chain) throw new Error(AAS_USAGE);
  return {
    chain, address, programId: address, codeId: opt['code-id'] ?? null, repo: opt.repo ?? null, commit: opt.commit ?? null,
    checksumsTxt: opt.checksums ? readFileSync(String(opt.checksums), 'utf8') : null, wasmFile: opt.wasm ?? null,
    runtimes: opt['pipeline-out'] ? compiledRuntimes(resolve(String(opt['pipeline-out']))) : null, link: opt.link ?? undefined,
  };
}

function printIntake(r, write) {
  write(`${r.chain.name} (${r.chain.caip2}) ${r.native ?? ''}`);
  for (const t of r.targets) {
    write(`  ${t.role.padEnd(14)} ${t.native}\n    code hash  ${t.codeHash}\n    source     ${t.source.origin} (${t.source.match}) ${t.sourceRef}`);
    write(`    ordered as chainId ${t.chainId}, target ${t.target}`);
  }
  for (const w of r.warnings) write(`  ! ${w}`);
  write(r.ready ? '  ready to order' : '  NOT ready to order: bind the deployed code to its source first');
}

export async function aasCommand({ cmd, rest, opt, write, s, connect, connectRpc, fetchImpl = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) }) {
  if (cmd === 'chains') {
    for (const c of aas.AAS_CHAINS) write(`${c.key.padEnd(18)} ${c.caip2.padEnd(48)} ${c.kind.padEnd(9)} ${c.kind === 'evm' ? 'EXTCODEHASH' : c.kind === 'cosmwasm' ? 'wasm checksum' : 'program hash'}${c.testnet ? '  testnet' : ''}`);
    return 0;
  }
  if (cmd === 'intake') {
    const r = await intake({ ...intakeOpts(rest, opt), fetchImpl });
    if (opt.json) write(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? String(v) : v), 1)); else printIntake(r, write);
    return r.ready ? 0 : 1;
  }
  if (cmd === 'pay') {
    const p = paymentPlan(opt.from ?? rest[0]);
    p.steps.forEach((x, i) => write(`${i + 1}. ${x}`));
    return 0;
  }
  if (cmd === 'order') {
    const C = deployed(opt);
    if (!isAddr(C.network)) throw new Error('AuditNetwork is not deployed on the testnet yet (zetaphy deploy-audit; or pass --audit-network 0x…)');
    const r = await intake({ ...intakeOpts(rest, opt), fetchImpl });
    printIntake(r, write);
    const provider = await connectRpc(s);
    const params = core.decodeParams(await provider.call({ to: C.network, data: core.calldata(k, core.SIG.getParams) }));
    const pool = BigInt(Math.round(Number(opt.pool ?? 100) * 1e6)) * 10n ** 12n;
    const plan = planOrder({ intake: r, tier: String(opt.tier ?? 'basic'), params, pool, contestDays: opt.days ?? null, auditors: opt.auditors != null ? Number(opt.auditors) : null, auditNetwork: C.network });
    for (const q of plan.requests) write(`request (${q.role}) ${q.native}: contest ${q.terms.contest / 86400} days, ≥ ${q.terms.minAuditors} auditors, value ${fmt(q.value)} (pool ${fmt(q.terms.pool)}, fee ${fmt(q.terms.fee)})\n  to ${q.to}\n  data ${q.data}`);
    write(`total ${fmt(plan.total)} (testnet coins, no value)`);
    if (!opt.send) { write('dry run: add --send to sign these with this wallet on ZETAPHY'); return 0; }
    const c = await connect(s);
    for (const q of plan.requests) {
      const tx = await c.signer.sendTransaction({ to: q.to, data: q.data, value: q.value });
      await tx.wait();
      write(`sent ${tx.hash} (${q.role})`);
    }
    return 0;
  }
  if (cmd === 'verify') {
    const [ref, address] = rest;
    const chain = aas.chainOf(ref);
    if (!chain || !aas.isNativeAddress(chain, address ?? '')) throw new Error(AAS_USAGE);
    const C = deployed(opt);
    if (!isAddr(C.certificate)) throw new Error('AuditCertificate is not deployed on the testnet yet (or pass --audit-certificate 0x…)');
    const provider = await connectRpc(s);
    const urls = opt['chain-rpc'] ? [String(opt['chain-rpc'])] : chain.rpcs;
    const v = await aas.verifyCertificate({
      k, sha256, chain, address: chain.kind === 'evm' ? address.toLowerCase() : address, certificate: C.certificate, now: now(),
      zcall: (to, data) => provider.call({ to, data }),
      rpc: chain.kind === 'cosmwasm' ? null : jsonRpc(urls, { fetchImpl, chainId: chain.kind === 'evm' ? chain.chainId : null }),
      rest: chain.kind === 'cosmwasm' ? restGet(urls, { fetchImpl }) : null,
    });
    write(`${v.status.toUpperCase().replace('_', ' ')}${v.level ? ` (${core.LEVELS[v.level]})` : ''}: ${chain.name} ${address}  [${v.reason}]`);
    if (v.cert.issuedAt !== 0n) write(`  certified code ${v.cert.codeHash}\n  running now    ${v.live?.codeHash ?? `unreadable (${v.live?.error})`}\n  expires ${new Date(Number(v.cert.expiresAt) * 1000).toISOString()}, request ${v.cert.requestId}`);
    if (v.impl) write(`  proxy → implementation ${v.impl.address ?? '?'}: ${v.impl.cert?.issuedAt ? 'certified' : 'NOT certified'}`);
    return v.status === 'valid' ? 0 : 1;
  }
  if (cmd === 'badge') {
    const summary = JSON.parse(readFileSync(String(opt.summary), 'utf8'));
    const b = aas.scanBadge(summary);
    const out = resolve(String(opt.out ?? 'zetaphy-audit-badge.svg'));
    writeFileSync(out, b.svg);
    write(JSON.stringify({ status: b.status, critical: b.critical, high: b.high, badge: out }));
    return 0;
  }
  if (cmd === 'registry') {
    const C = deployed(opt);
    const dir = resolve(String(opt.out ?? 'registry'));
    mkdirSync(join(dir, 'badges'), { recursive: true });
    if (!isAddr(C.certificate) || !isAddr(C.network)) {
      writeFileSync(join(dir, 'audit-registry.json'), `${JSON.stringify(aas.cleanRegistry({ entries: [], generatedAt: new Date(now() * 1000).toISOString() }), null, 1)}\n`);
      write('the audit network is not deployed on the testnet yet: an empty registry was written');
      return 0;
    }
    const rpc = jsonRpc([String(opt.rpc ?? aas.ZETAPHY_RPC)], { fetchImpl, chainId: aas.ZETAPHY_CHAIN_ID });
    const { registry, badges } = await buildRegistry({ rpc, certificate: C.certificate, network: C.network, fromBlock: C.block, now: now() });
    writeFileSync(join(dir, 'audit-registry.json'), `${JSON.stringify(registry, null, 1)}\n`);
    for (const [f, svg] of Object.entries(badges)) writeFileSync(join(dir, 'badges', f), svg);
    write(`${registry.entries.length} certificate(s), ${Object.keys(badges).length} badge(s) in ${dir}`);
    return 0;
  }
  write(AAS_USAGE);
  return 2;
}

