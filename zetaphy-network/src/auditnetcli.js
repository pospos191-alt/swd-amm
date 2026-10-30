// `zetaphy audit …` and `zetaphy deploy-audit` (called from cli.js, which hands over its RPC/key helpers):
// the open audit network (docs/future/audit-network.md). Salts of commitments stay on this machine
// (~/.zetaphy/audit/salts.json) until the reveal. TESTNET ONLY.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Contract, isAddress, keccak256, parseEther, formatEther, toUtf8Bytes, getAddress } from 'ethers';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
export const AUDIT_DEPLOY_FILE = new URL('../deployments/audit-77390.json', import.meta.url);
const ZETAPHY_CHAIN_ID = 77390;

export const AUDIT_USAGE = `usage (TESTNET ONLY; docs/future/audit-network.md):
  zetaphy audit request <chainId> <0x address> --source <git commit | 0x hash> [--code 0x<runtime> (other chains) --tier 0|1|2
                        --days 7 --auditors 3 --pool 100 --fixes <request id> --uri ipfs://…]   ask for an audit (deposit = pool + fee)
  zetaphy audit status <id>                       the request, its findings, the automated tier and why it is (not) certifiable
  zetaphy audit cert <chainId> <0x address>       the certificate: level, expiry, report hash, valid now?
  zetaphy audit bond [--amount 10] | unbond | withdraw-bond      auditor bond
  zetaphy audit commit-report <id> --report <file>    commit your participation report (hash; the salt stays here)
  zetaphy audit reveal-report <id>                    after the contest
  zetaphy audit submit <id> --finding <file> --severity critical|high|medium|low|info [--poc <test file>]   commit a finding
  zetaphy audit reveal <findingId> [--uri ipfs://…]   after the contest (post-certificate findings: from the next block)
  zetaphy audit judge-bond [--amount 100]             join the judging committee (WorkerReputation score needed)
  zetaphy audit judge <findingId> --valid --severity high [--dup <findingId>] | --invalid
  zetaphy audit judge-report <id> <auditor> --accept|--reject     zetaphy audit judge-na <id> --accept|--reject
  zetaphy audit judge-fix <id> <carriedFindingId> --fixed|--not-fixed
  zetaphy audit appeal <findingId>                    (appeal bond; governance decides)
  zetaphy audit settle <id> | certify <id> | claim <findingId> | claim-report <id> | claim-judge <id> | withdraw
  zetaphy audit run <id> [--repo . --out audit-out --llm-model qwen2.5-coder:7b --llm-url http://localhost:11434/v1 --reveal]
                        runners: fetch the code (and Sourcify source), run audit/report.js + Neuro (+ optional LLM, advisory),
                        commit the canonical result hash to AuditRunners; --reveal reveals the committed result
  zetaphy deploy-audit --timelock 0x… --treasury 0x… --jobs 0x<NeuroJobs> [--reputation 0x<WorkerReputation> --out deployments/audit-77390.json]`;

const SEV = ['', 'info', 'low', 'medium', 'high', 'critical'];

function addresses(opt) {
  const dep = (() => { try { return JSON.parse(readFileSync(AUDIT_DEPLOY_FILE, 'utf8')); } catch { return null; } })();
  const c = dep?.contracts ?? {};
  return {
    network: String(opt['audit-network'] ?? c.auditNetwork ?? ''), runners: String(opt['audit-runners'] ?? c.auditRunners ?? ''),
    judges: String(opt['audit-judges'] ?? c.auditJudges ?? ''), certificate: String(opt['audit-certificate'] ?? c.auditCertificate ?? ''),
  };
}

const sevOf = (s) => {
  const i = SEV.indexOf(String(s ?? '').toLowerCase());
  if (i < 1) throw new Error('--severity: critical, high, medium, low or info');
  return i;
};
const fileHash = (f) => keccak256(readFileSync(f));
const hash32 = (v) => (/^0x[0-9a-fA-F]{64}$/.test(String(v)) ? String(v) : keccak256(toUtf8Bytes(String(v))));

/**
 * @param {object} p  { cmd, rest, opt, write, s, connect, connectRpc, home, ops? }
 *   connect(s, {needJobs}) -> { provider, signer, me }, connectRpc(s) -> provider (cli.js helpers)
 */
export async function auditCommand({ group, cmd, rest = [], opt = {}, write, s, connect, connectRpc, home }) {
  const an = await import('./auditnet.js');
  const { core, k } = an;
  if (group === 'deploy-audit') {
    const { deployAuditNetwork } = await import('./auditnetops.js');
    for (const key of ['timelock', 'treasury', 'jobs']) if (!isAddress(String(opt[key] ?? ''))) { write(AUDIT_USAGE); return 2; }
    const c = await connect(s, { needJobs: false });
    const res = await deployAuditNetwork({ signer: c.signer, governance: String(opt.timelock), treasury: String(opt.treasury), jobs: String(opt.jobs),
      reputation: opt.reputation ? String(opt.reputation) : undefined, log: write });
    const out = opt.out ? resolve(String(opt.out)) : AUDIT_DEPLOY_FILE.pathname;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
    write(`written ${out}; governance is the timelock ${res.governance} (no key keeps a role)`);
    for (const p of res.proposals) write(`  timelock proposal: ${p.what}\n    zetaphy timelock schedule --to ${p.target} --data ${p.data}`);
    return 0;
  }
  const KNOWN = ['request', 'status', 'cert', 'bond', 'unbond', 'withdraw-bond', 'judge-bond', 'commit-report', 'reveal-report', 'submit', 'reveal', 'judge',
    'judge-report', 'judge-na', 'judge-fix', 'appeal', 'settle', 'certify', 'claim', 'claim-report', 'claim-judge', 'withdraw', 'run'];
  if (!KNOWN.includes(cmd)) { write(AUDIT_USAGE); return 2; }
  const A = addresses(opt);
  const salts = an.saltStore(join(home, 'audit'));
  const read = async () => (await connectRpc(s));
  const contract = (name, at, runner) => {
    if (!isAddress(at)) throw new Error(`no ${name} address: deploy it (zetaphy deploy-audit) or pass --${name.replace(/^Audit/, 'audit-').toLowerCase()} 0x…`);
    return new Contract(at, art(name).abi, runner);
  };
  const net = (r) => contract('AuditNetwork', A.network, r);
  const jud = (r) => contract('AuditJudges', A.judges, r);
  const run = (r) => contract('AuditRunners', A.runners, r);
  const cert = (r) => contract('AuditCertificate', A.certificate, r);
  const tx = async (p, what) => { const t = await p; await t.wait(); write(`${what}: ${t.hash}`); return t; };
  const id = () => { if (!/^\d+$/.test(String(rest[0] ?? ''))) throw new Error(AUDIT_USAGE); return BigInt(rest[0]); };

  if (cmd === 'request') {
    const [chainId, target] = rest;
    if (!/^\d+$/.test(String(chainId ?? '')) || !isAddress(target ?? '') || !opt.source) { write(AUDIT_USAGE); return 2; }
    const c = await connect(s, { needJobs: false });
    let codeHash;
    if (Number(chainId) === ZETAPHY_CHAIN_ID) codeHash = keccak256(await c.provider.getCode(target));
    else if (opt.code) codeHash = keccak256(String(opt.code));
    else {
      const key = an.chainKeyOf(chainId);
      if (!key) throw new Error(`chain ${chainId}: give its runtime bytecode with --code 0x…`);
      const { CHAINS } = await import('../../zetaphy-neuro/src/chains.js');
      const { createRpc } = await import('../../zetaphy-neuro/src/rpc.js');
      codeHash = keccak256(await createRpc(CHAINS[key].rpcs, CHAINS[key].id).call('eth_getCode', [target, 'latest']));
    }
    if (codeHash === keccak256('0x')) throw new Error('no code at that address');
    const value = parseEther(String(opt.pool ?? '100'));
    const prev = opt.fixes != null ? BigInt(opt.fixes) + 1n : 0n;
    await tx(net(c.signer).request({ chainId: BigInt(chainId), target, codeHash, sourceHash: hash32(opt.source) }, Number(opt.tier ?? 0),
      Number(opt.days ?? 7) * 86400, Number(opt.auditors ?? 3), prev, String(opt.uri ?? ''), { value }), `requested an audit of ${target} (codeHash ${codeHash})`);
    write(`request id ${(await net(c.provider).requestCount()) - 1n}`);
    return 0;
  }
  if (cmd === 'status') {
    const p = await read();
    const r = await net(p).getRequest(id());
    const fids = await net(p).findingsOf(id());
    const [agreed, res] = await run(p).result(id());
    const why = Number(await cert(p).check(id()));
    write(`request ${rest[0]}: chain ${r.chainId} ${r.target} codeHash ${r.codeHash}\n  sponsor ${r.sponsor} tier ${core.TIERS[Number(r.tier)]} pool ${formatEther(r.pool)} ZETAPHY` +
      `\n  contest until ${new Date(Number(r.contestEnd) * 1000).toISOString()} · reports ${r.reports} (rejected ${r.rejected}, need ${r.minAuditors})` +
      `\n  findings ${fids.length}: undecided ${r.undecided}, valid critical/high ${r.critHigh}, open appeals ${r.openAppeals}, settled ${r.settled}` +
      `\n  automated tier: ${agreed ? `agreed ${res.resultHash} (critical/high ${res.critHigh}, invariants failed ${res.invFailed}, not run ${res.invNotRun}, mutation ${Number(res.mutationBps) / 100}%)` : 'no agreement (yet)'}` +
      `\n  certificate: ${why === 0 ? 'certifiable now (zetaphy audit certify)' : `not certifiable: ${core.REASONS[why]}`}`);
    return 0;
  }
  if (cmd === 'cert') {
    const [chainId, target] = rest;
    if (!/^\d+$/.test(String(chainId ?? '')) || !isAddress(target ?? '')) { write(AUDIT_USAGE); return 2; }
    const [c, valid] = await cert(await read()).certificate(BigInt(chainId), target);
    if (c.issuedAt === 0n) { write(`no ZETAPHY audit certificate for ${target} on chain ${chainId}`); return 1; }
    write(`${valid ? 'CERTIFIED' : 'NOT VALID NOW'} · ${core.LEVELS[Number(c.level)]} · request ${c.requestId} · codeHash ${c.codeHash}\n  report ${c.reportHash} · auditors ${c.auditors}` +
      ` · mutation ${Number(c.mutationBps) / 100}%\n  issued ${new Date(Number(c.issuedAt) * 1000).toISOString()} · expires ${new Date(Number(c.expiresAt) * 1000).toISOString()}` +
      `${c.revokedAt ? ` · REVOKED by finding ${c.revokedBy - 1n}` : ''}\n  "passed the ZETAPHY audit process at this codeHash on this date": not a guarantee`);
    return valid ? 0 : 1;
  }

  const c = await connect(s, { needJobs: false });
  switch (cmd) {
    case 'bond': await tx(net(c.signer).bond({ value: parseEther(String(opt.amount ?? '10')) }), 'auditor bond'); return 0;
    case 'unbond': await tx(net(c.signer).requestUnbond(), 'unbond requested'); return 0;
    case 'withdraw-bond': await tx(net(c.signer).withdrawBond(), 'bond withdrawn'); return 0;
    case 'judge-bond': await tx(jud(c.signer).bond({ value: parseEther(String(opt.amount ?? '100')) }), 'judge bond'); return 0;
    case 'commit-report': {
      if (!opt.report) throw new Error(AUDIT_USAGE);
      const h = fileHash(String(opt.report));
      const salt = core.keccakHex(k, globalThis.crypto.getRandomValues(new Uint8Array(32)));
      salts.put(`report:${A.network}:${id()}:${c.me}`, { hash: h, salt });
      await tx(net(c.signer).commitReport(id(), core.reportCommitment(k, h, c.me, salt, id())), `report committed (hash ${h})`);
      return 0;
    }
    case 'reveal-report': {
      const x = salts.get(`report:${A.network}:${id()}:${c.me}`);
      if (!x) throw new Error('no committed report from this machine');
      await tx(net(c.signer).revealReport(id(), x.hash, x.salt), 'report revealed');
      return 0;
    }
    case 'submit': {
      if (!opt.finding) throw new Error(AUDIT_USAGE);
      const sev = sevOf(opt.severity);
      const fh = fileHash(String(opt.finding));
      const ev = opt.poc ? fileHash(String(opt.poc)) : `0x${'00'.repeat(32)}`;
      const salt = core.keccakHex(k, globalThis.crypto.getRandomValues(new Uint8Array(32)));
      const n = net(c.signer);
      const fid = await n.findingCount();
      await tx(n.commitFinding(id(), core.findingCommitment(k, fh, sev, ev, c.me, salt, id())), `finding committed (${SEV[sev]}, hash ${fh})`);
      salts.put(`finding:${A.network}:${fid}`, { req: String(id()), hash: fh, sev, evidence: ev, salt });
      write(`finding id ${fid} (keep ${opt.finding}${opt.poc ? ` and ${opt.poc}` : ''} until you reveal; publish them with the reveal)`);
      return 0;
    }
    case 'reveal': {
      const x = salts.get(`finding:${A.network}:${id()}`);
      if (!x) throw new Error('no committed finding with that id from this machine');
      await tx(net(c.signer).revealFinding(id(), x.hash, x.sev, x.evidence, x.salt, String(opt.uri ?? '')), 'finding revealed');
      return 0;
    }
    case 'judge': {
      if (!opt.valid && !opt.invalid) throw new Error(AUDIT_USAGE);
      const valid = !!opt.valid;
      const sev = valid ? sevOf(opt.severity) : 0;
      const group = opt.dup != null ? BigInt(opt.dup) : id();
      await tx(jud(c.signer).voteFinding(id(), valid, sev, group), `voted ${valid ? `valid ${SEV[sev]}${opt.dup != null ? ` (duplicate of ${opt.dup})` : ''}` : 'invalid'}`);
      return 0;
    }
    case 'judge-report': {
      if (!isAddress(rest[1] ?? '') || (!opt.accept && !opt.reject)) throw new Error(AUDIT_USAGE);
      await tx(jud(c.signer).voteReport(id(), rest[1], !!opt.accept), 'voted');
      return 0;
    }
    case 'judge-na': await tx(jud(c.signer).voteNotApplicable(id(), !!opt.accept), 'voted'); return 0;
    case 'judge-fix': await tx(jud(c.signer).voteFixed(id(), BigInt(rest[1]), !!opt.fixed), 'voted'); return 0;
    case 'appeal': await tx(jud(c.signer).appeal(id(), { value: (await jud(c.provider).params()).appealBond }), 'appealed'); return 0;
    case 'settle': {
      const tier = await run(c.provider).tiers(id());
      if (!tier.settled) await tx(run(c.signer).settle(id()), 'automated tier settled').catch((e) => write(`automated tier: ${e.shortMessage ?? e.message}`));
      await tx(net(c.signer).settle(id()), 'request settled');
      return 0;
    }
    case 'certify': {
      const why = Number(await cert(c.provider).check(id()));
      if (why !== 0) { write(`not certifiable: ${core.REASONS[why]}`); return 1; }
      await tx(cert(c.signer).certify(id()), 'CERTIFIED');
      return 0;
    }
    case 'claim': await tx(net(c.signer).claimFinding(id()), 'claimed'); return 0;
    case 'claim-report': await tx(net(c.signer).claimReport(id()), 'claimed'); return 0;
    case 'claim-judge': {
      const items = (await jud(c.provider).queryFilter(jud(c.provider).filters.Decided(null, id()))).map((l) => l.args.item);
      const mine = [];
      for (const it of items) if ((await jud(c.provider).votedFor(it, c.me)) === (await jud(c.provider).decided(it)) && !(await jud(c.provider).judgeClaimed(it, c.me))) mine.push(it);
      await tx(jud(c.signer).claim(id(), mine), `claimed ${mine.length} decisions`);
      return 0;
    }
    case 'withdraw': {
      for (const [name, ct] of [['AuditNetwork', net], ['AuditJudges', jud], ['AuditRunners', run]]) {
        if (isAddress(A[{ AuditNetwork: 'network', AuditJudges: 'judges', AuditRunners: 'runners' }[name]]) && (await ct(c.provider).owed(c.me)) > 0n) await tx(ct(c.signer).withdraw(), `${name}: withdrawn`);
      }
      return 0;
    }
    case 'run': return runnerJob({ an, core, k, opt, write, c, net, run, salts, id: id(), A, tx });
    default: write(AUDIT_USAGE); return 2;
  }
}

/** The runner's automated tier for one request (see src/auditnet.js). */
async function runnerJob({ an, core, k, opt, write, c, net, run, salts, id, A, tx }) {
  const key = `run:${A.runners}:${id}:${c.me}`;
  if (opt.reveal) {
    const x = salts.get(key);
    if (!x) throw new Error('no committed result from this machine for that request');
    await tx(run(c.signer).reveal(id, x.tuple, x.salt), `result revealed (${x.tuple.resultHash})`);
    return 0;
  }
  const r = await net(c.provider).getRequest(id);
  const req = { chainId: Number(r.chainId), target: r.target, codeHash: r.codeHash, sourceHash: r.sourceHash };
  const getCode = async (chainKey, addr) => {
    if (chainKey === 'zetaphy') return c.provider.getCode(addr);
    const { CHAINS } = await import('../../zetaphy-neuro/src/chains.js');
    const { createRpc } = await import('../../zetaphy-neuro/src/rpc.js');
    return createRpc(CHAINS[chainKey].rpcs, CHAINS[chainKey].id).call('eth_getCode', [addr, 'latest']);
  };
  const { key: chainKey, code } = await an.codeFor(req, getCode);
  write(`code at ${req.target} on ${chainKey} matches the request (${req.codeHash})`);
  const src = opt['no-sourcify'] ? null : await an.fetchSourcify({ chainId: req.chainId, address: req.target });
  write(src ? `Sourcify: verified source (${Object.keys(src.files).length} files, source hash ${src.sourceHash})` : 'Sourcify: no verified source; the repo commit is what the pipeline audits');
  const repo = resolve(String(opt.repo ?? '.'));
  const outDir = resolve(String(opt.out ?? 'audit-out'));
  const pipeline = opt.pipeline ? core.validatePipeline(JSON.parse(readFileSync(String(opt.pipeline), 'utf8'))) : await an.runPipeline({ repoDir: repo, outDir });
  const neuro = await an.neuroScan(chainKey, req.target, code).catch((e) => { write(`Neuro: skipped (${e.message})`); return null; });
  const { body, tuple } = an.automatedResult(req, { pipeline, neuro });
  let ai = [];
  if (opt['llm-model']) {
    ai = await an.aiFindings(neuro?.report ?? {}, { model: String(opt['llm-model']), baseUrl: opt['llm-url'] ? String(opt['llm-url']) : undefined }).catch((e) => { write(`LLM review skipped (${e.message})`); return []; });
    write(`LLM review: ${ai.length} AI findings (advisory; not in the result hash; submit them with zetaphy audit submit for the judges)`);
  }
  const file = an.saveRun(outDir, id, { body, tuple, ai });
  write(`result ${tuple.resultHash}: critical/high ${tuple.critHigh}, invariants failed ${tuple.invFailed}, not run ${tuple.invNotRun}, mutation ${tuple.mutationBps / 100}% → ${file}`);
  if (opt['dry-run']) return 0;
  const salt = core.keccakHex(k, globalThis.crypto.getRandomValues(new Uint8Array(32)));
  salts.put(key, { tuple, salt });
  await tx(run(c.signer).commit(id, core.runCommitment(k, tuple, c.me, salt, id)), 'result committed (reveal after the contest: zetaphy audit run <id> --reveal)');
  return 0;
}

export const auditDeployed = () => existsSync(AUDIT_DEPLOY_FILE);
export { getAddress };
