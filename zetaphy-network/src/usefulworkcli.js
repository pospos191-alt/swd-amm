// `zetaphy work …` and `zetaphy bounty …` (called from cli.js, which hands over its RPC/key helpers).
// Runners check what browsers did (docs/future/useful-work.md): the same code-only scan, the same
// finding replay, then (bounty check --attest) their attestation on BugBounty.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Contract, isAddress, getBytes, toUtf8String, keccak256, parseEther } from 'ethers';
import { CHAINS } from '../../zetaphy-neuro/src/chains.js';
import { createRpc } from '../../zetaphy-neuro/src/rpc.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));

export const WORK_USAGE = `usage:
  zetaphy work verdict <chain> <address>              the code-only verdict a browser computes for a scan job (and the codeHash to post)
  zetaphy work verify-finding <spec.json> <finding.json | reproducer.json | 0x…bytes>   replay a bug finding against a bounty spec (offline)
  zetaphy work fuzz <spec.json> [--seed 1 --runs 10000 --steps 4 --all --corpus in.json --save-corpus out.json --out repro.json]
                                                     the browser's coverage-guided fuzzer in Node: same seed, same run. --all: keep
                                                     hunting after the first bug (one finding per invariant). --out: a reproducer
                                                     (steps, seed, per-step trace) for the first finding
  zetaphy work feed [--useful-work 0x…] [--targets t.json] [--new-blocks 200] [--max-jobs 5 --fee 0.01 --canary-every 3 --subsidized --dry-run]
                                                     the job feeder (a scheduled Action): reveal due canaries, settle, post new scan jobs
                                                     (targets: the file [{chain, address}], contracts created in the last blocks, the launch
                                                     state's contracts). The key must be a feeder (setFeeder, through the timelock)
  zetaphy deploy-useful-work [--timelock 0x… --jobs 0x… --identity 0x… --guardian 0x… --overflow 0x… --feeder 0x…
                              --no-issuance --stamp-bits 22 --out deployments/useful-work-77390.json --devnet]
                                                     WorkerReputation + UsefulIssuance + UsefulWork + BugBounty, PAUSED, governed by the
                                                     timelock (defaults from zetaphy-launch/state/77390.json); writes the deployment file the
                                                     hub reads and the timelock proposals that open them
  zetaphy bounty check <findingId> --bounty 0x<BugBounty> --spec <spec.json> [--attest]
                                                     read a revealed finding, check spec hash + replay; --attest votes on-chain`;

const readFinding = (arg, uw) => (/^0x[0-9a-fA-F]*$/.test(arg) ? getBytes(arg) : uw.findingFromText(readFileSync(arg, 'utf8')));

export const DEPLOY_FILE = new URL('../deployments/useful-work-77390.json', import.meta.url);

export async function usefulWorkCommand({ group, cmd, rest, opt, write, s, connect, connectRpc }) {
  const uw = await import('./usefulwork.js');
  if (group === 'deploy-useful-work') {
    const ops = await import('./usefulworkops.js');
    const { devnetOf } = await import('./bridgegate.js');
    const devnet = devnetOf(s.rpc, opt);
    const d = ops.launchDefaults();
    const c = await connect(s, { needJobs: false });
    const pick = (k, dk = k) => (opt[k] != null && opt[k] !== true ? String(opt[k]) : d[dk]);
    const res = await ops.deployUsefulWork({
      signer: c.signer, devnet, timelock: pick('timelock'), jobs: pick('jobs') ?? s.jobs, identity: pick('identity'), guardian: pick('guardian'),
      overflow: pick('overflow', 'rewardVault'), feeder: opt.feeder ? String(opt.feeder) : null, issuance: !opt['no-issuance'],
      params: opt['stamp-bits'] ? { stampBits: Number(opt['stamp-bits']) } : {}, log: write,
    });
    const out = opt.out ? String(opt.out) : (devnet ? 'useful-work-devnet.json' : DEPLOY_FILE);
    mkdirSync(dirname(out instanceof URL ? out.pathname : out), { recursive: true });
    writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
    write(`deployed PAUSED and handed to the timelock ${res.timelock}; written ${out instanceof URL ? out.pathname : out}`);
    write(`to open them, the timelock's proposers schedule (then, after ${res.timelockDelay} s, execute) these ${res.proposals.length} operations:`);
    for (const p of res.proposals) write(`  ${p.what}\n    zetaphy timelock schedule --to ${p.target} --data ${p.data} --salt ${p.salt}`);
    return 0;
  }
  if (group === 'work' && cmd === 'feed') {
    const ops = await import('./usefulworkops.js');
    const { loadOrCreateKey } = await import('./keys.js');
    const dep = (() => { try { return JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')); } catch { return null; } })();
    const at = opt['useful-work'] ? String(opt['useful-work']) : dep?.contracts?.usefulWork;
    if (!at) { write('UsefulWork is not deployed yet (no --useful-work and no deployments/useful-work-77390.json): nothing to feed'); return 0; }
    const c = await connect(s, { needJobs: false });
    const contract = new Contract(at, art('UsefulWork').abi, c.signer);
    const targets = [];
    if (opt.targets) targets.push(...JSON.parse(readFileSync(String(opt.targets), 'utf8')));
    if (opt['new-blocks'] !== 0 && opt['new-blocks'] !== '0') targets.push(...(await ops.newContracts(c.provider, { blocks: Number(opt['new-blocks'] ?? 200) })));
    const d = ops.launchDefaults();
    for (const a of [d.jobs, d.rewardVault, d.identity].filter(Boolean)) targets.push({ chain: 'zetaphy', address: a });
    const codeOf = async (chain, target) => {
      if (chain === 'zetaphy') return c.provider.getCode(target);
      const cc = CHAINS[chain];
      if (cc?.kind !== 'evm') throw new Error(`${chain}: not an EVM chain`);
      return createRpc(cc.rpcs, cc.id).call('eth_getCode', [target, 'latest']);
    };
    const res = await ops.feedRound({
      usefulWork: contract, privateKey: loadOrCreateKey().wallet.privateKey, targets, codeOf,
      verdictOf: async (job) => (await uw.scanVerdict(job)).verdict,
      maxJobs: Number(opt['max-jobs'] ?? 5), fee: parseEther(String(opt.fee ?? '0.01')), canaryEvery: Number(opt['canary-every'] ?? 3),
      subsidized: !!opt.subsidized, dryRun: !!opt['dry-run'], log: write,
    });
    write(JSON.stringify({ paused: res.paused, feeder: res.feeder, revealed: res.revealed.length, settled: res.settled.length, posted: res.posted.length, skipped: res.skipped.length }));
    return 0;
  }
  if (group === 'work' && cmd === 'verdict') {
    const [chain, target] = rest;
    if (!chain || !isAddress(target ?? '')) { write(WORK_USAGE); return 2; }
    let code;
    if (chain === 'zetaphy') code = await (await connectRpc(s)).getCode(target);
    else {
      const c = CHAINS[chain];
      if (c?.kind !== 'evm') throw new Error(`${chain}: not an EVM chain`);
      code = await createRpc(c.rpcs, c.id).call('eth_getCode', [target, 'latest']);
    }
    const codeHash = keccak256(code);
    const { verdict, report } = await uw.scanVerdict({ chain, target, code, codeHash });
    write(`codeHash ${codeHash}\nverdict  ${verdict}\nlevel    ${report.analysis?.rulesLevel ?? report.analysis?.level}`);
    return 0;
  }
  if (group === 'work' && cmd === 'verify-finding') {
    const [specFile, findingArg] = rest;
    if (!specFile || !findingArg) { write(WORK_USAGE); return 2; }
    const r = await uw.verifyFinding({ specText: readFileSync(specFile, 'utf8'), finding: readFinding(findingArg, uw) });
    write(`${r.valid ? 'VALID' : 'NOT VALID'}: ${r.reason}${r.profit != null ? ` (attacker profit ${r.profit} wei)` : ''}`);
    return r.valid ? 0 : 1;
  }
  if (group === 'work' && cmd === 'fuzz') {
    const [specFile] = rest;
    if (!specFile) { write(WORK_USAGE); return 2; }
    const specText = readFileSync(specFile, 'utf8');
    const seed = Number(opt.seed ?? 1);
    const corpus = opt.corpus ? JSON.parse(readFileSync(String(opt.corpus), 'utf8')) : [];
    const t0 = Date.now();
    const res = await uw.hunt(specText, { seed, runs: Number(opt.runs ?? 10_000), maxSteps: Number(opt.steps ?? 4), stopOnFirst: !opt.all, corpus,
      onFinding: (f) => write(`found at sequence ${f.run}: ${f.kinds.join(' + ')}\n  ${f.violations.map((v) => `${v.kind}: ${v.detail}`).join('\n  ')}\n  ${JSON.stringify(f.finding)}`) });
    write(`${res.runs} sequences in ${((Date.now() - t0) / 1000).toFixed(1)} s, seed ${seed}; coverage ${res.coverage.pct}% of jump targets (${res.coverage.hit}/${res.coverage.jumpdests}), ${res.coverage.edges} edges; corpus ${res.corpus.length} (minimised)`);
    if (opt['save-corpus']) writeFileSync(String(opt['save-corpus']), JSON.stringify(res.corpus.map((c) => ({ steps: c.steps })), null, 1) + '\n');
    if (opt.out && res.finding) {
      writeFileSync(String(opt.out), JSON.stringify(await uw.reproducerOf(specText, res), null, 1) + '\n');
      write(`reproducer written to ${opt.out}`);
    }
    return res.finding ? 0 : 1;
  }
  if (group === 'bounty' && cmd === 'check') {
    const fid = BigInt(rest[0] ?? -1);
    if (fid < 0n || !isAddress(String(opt.bounty ?? '')) || !opt.spec) { write(WORK_USAGE); return 2; }
    const c = opt.attest ? await connect(s, { needJobs: false }) : { provider: await connectRpc(s) };
    const bb = new Contract(opt.bounty, art('BugBounty').abi, c.signer ?? c.provider);
    const f = await bb.getFinding(fid);
    const b = await bb.getBounty(f.bounty);
    const logs = await bb.queryFilter(bb.filters.FindingRevealed(fid));
    if (!logs.length) throw new Error(`finding ${fid}: not revealed (state ${f.state})`);
    const bytes = getBytes(logs[logs.length - 1].args.finding);
    const r = await uw.verifyFinding({ specText: readFileSync(opt.spec, 'utf8'), finding: bytes, expectSpecHash: b.specHash, expectFindingHash: f.findingHash });
    write(`finding ${fid} on bounty ${f.bounty}: ${r.valid ? 'VALID' : 'NOT VALID'} (${r.reason})\n${toUtf8String(bytes)}`);
    if (opt.attest) {
      const tx = await bb.attest(fid, r.valid);
      await tx.wait();
      write(`attested ${r.valid} in ${tx.hash}`);
    }
    return 0;
  }
  write(WORK_USAGE);
  return 2;
}
