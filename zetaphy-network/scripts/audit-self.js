#!/usr/bin/env node
// The audit network audits itself (docs/future/immune-score.md, SS8). TESTNET ONLY. No keys: it only reads.
//   node scripts/audit-self.js check  [--file deployments/audit-self-77390.json] [--rpc https://…]
//        CI: OFF (exit 0) while the self-audit record does not exist; otherwise fails (exit 1) when AuditNetwork,
//        AuditRunners, AuditJudges or AuditCertificate lacks an issued, unrevoked, unexpired certificate for its
//        recorded code, or its committed artifact changed since (a new version needs a new request). With --rpc it also
//        checks the chain: the deployed code is the recorded one and AuditCertificate.isCertified is true.
//   node scripts/audit-self.js plan   --rpc https://… [--deployment deployments/audit-77390.json] [--source <commit>]
//        prints the four `zetaphy audit request` commands (each contract on its own address and code)
//   node scripts/audit-self.js record --rpc https://… [--deployment …] [--out deployments/audit-self-77390.json]
//        once the four certificates exist: writes the record the check reads
// test/audit-self.test.js runs the whole self-audit end to end (requests, contest, runners with the pipeline adapter
// and Neuro's scan of the contracts' own code, judges, certificates) and this check against its record.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfCheck, selfTargets, buildRecord, planCommands, SELF_FILE, DEPLOY_FILE } from '../src/auditself.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

function rpcSend(url) {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
}

async function main() {
  const cmd = args[0] ?? 'check';
  const rpc = opt('--rpc');
  const send = rpc ? rpcSend(rpc) : null;
  if (cmd === 'check') {
    const file = opt('--file') ? resolve(opt('--file')) : fileURLToPath(SELF_FILE);
    const r = await selfCheck({ file, send });
    if (r.status === 'off') { console.log(`self-audit check: OFF (no ${file}: the audit contracts' self-audit is not recorded yet)`); return; }
    if (r.status === 'ok') { console.log(`self-audit check: OK (AuditNetwork, AuditRunners, AuditJudges, AuditCertificate hold live certificates${send ? ', checked on chain' : ''})`); return; }
    console.error(`self-audit check: FAILED\n${r.problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const depFile = opt('--deployment') ? resolve(opt('--deployment')) : fileURLToPath(DEPLOY_FILE);
  if (!existsSync(depFile)) throw new Error(`${depFile}: no deployment (zetaphy deploy-audit writes it)`);
  if (!send) throw new Error(`${cmd} needs --rpc`);
  const deployment = JSON.parse(readFileSync(depFile, 'utf8'));
  if (cmd === 'plan') {
    const targets = await selfTargets(send, deployment);
    console.log(planCommands(targets, { chainId: deployment.chainId ?? 77390, source: opt('--source', '<git commit>') }).join('\n'));
    return;
  }
  if (cmd === 'record') {
    const record = await buildRecord(send, deployment);
    const out = opt('--out') ? resolve(opt('--out')) : fileURLToPath(SELF_FILE);
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    console.log(`${out}: written`);
    return;
  }
  throw new Error('usage: audit-self.js check|plan|record [--rpc url] [--file f] [--deployment f] [--out f]');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
