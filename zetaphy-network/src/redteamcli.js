// zetaphy redteam / exploit / econ: the AI red team (SS3), the exploit market (S1) and the economic-security
// simulation (SS4). Everything runs on a LOCAL fork or the in-memory EVM; it never attacks a live chain.
//
//   zetaphy redteam scan --target 0x… [--abi <artifact|file> --source-rpc URL --fork-block N | --local] [--runs 300]
//        [--seed 1] [--asset 0x… --min-loss <wei>] [--llm-model qwen2.5-coder:7b --llm-provider ollama] [--out dir]
//      fork the chain, run every strategy + the search against the target, print findings and write each working
//      exploit as an ExploitMarket submission bundle (redteam-<n>.json)
//   zetaphy redteam targets --certificate 0x<AuditCertificate> [--source-rpc URL]   list certified contracts (SS3 sweep)
//   zetaphy redteam replay --market 0x… --submission <id> --bundle <file> [--suite <file>] [--source-rpc URL]
//      a runner: recompute the verdict of a submission from its bundle on a fork, print holds / loss / reportHash
//   zetaphy exploit list --market 0x… --target 0x… --pool <ZTPHY> [--asset 0x… --reward-bps 1000 --max-reward …
//        --min-loss … --unit-value … --breaker --invariants <suite.json>]   list a contract for exploits (escrow)
//   zetaphy exploit submit --market 0x… --listing <id> --bundle <file> [--invariant <id> --suite <file>]  (bond)
//   zetaphy exploit commit|reveal|settle|withdraw --market 0x… …                 a runner's commit-reveal, settle, payout
//   zetaphy econ sim [--scenarios <file> --seeds 1,2,3] [--out report.json]       the economic-security bound
//   zetaphy econ attach --bounds 0x<EconomicBounds> --request <id> --report <report.json> [--fee <ZTPHY>]
//   zetaphy econ commit|reveal|settle|withdraw --bounds 0x… …                     runners confirm the bound
//   zetaphy deploy-redteam --jobs 0x<NeuroJobs> [--governance 0x<timelock>] [--network 0x<AuditNetwork> --certificate 0x…]
//      deploys ExploitMarket (and EconomicBounds when --network/--certificate are given); prints the addresses
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Contract, Interface, getAddress, parseEther, formatEther, ZeroAddress, ZeroHash } from 'ethers';
import { createFork, rpcSource, anvilWorld } from './redteam/fork.js';
import { redTeam, certifiedTargets, abiFromArtifacts, submissionOf } from './redteam/agent.js';
import { replayExploit, bundleHash, suiteHash, invariantKey, randomSalt, verdictCommitment, reportHashOf, canonicalJson } from './redteam/exploit.js';
import { simulate, DEFAULT_SCENARIOS, DEFAULT_SEEDS, econReportHash } from './redteam/economic.js';

const EM = JSON.parse(readFileSync(new URL('../artifacts/ExploitMarket.json', import.meta.url), 'utf8'));
const EB = JSON.parse(readFileSync(new URL('../artifacts/EconomicBounds.json', import.meta.url), 'utf8'));
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const need = (v, what) => { if (!ADDR.test(String(v ?? ''))) throw new Error(`${what} 0x… is needed`); return getAddress(String(v)); };
const num = (v, what) => { if (!/^\d+$/.test(String(v ?? ''))) throw new Error(`${what} <whole number>`); return BigInt(v); };
const readJson = (f, what) => { if (!f) throw new Error(`${what} <file>`); return JSON.parse(readFileSync(f, 'utf8')); };
const abiLoad = (v) => {
  if (!v) return null;
  try { const a = JSON.parse(readFileSync(v, 'utf8')); return a.abi ?? a; } catch {}
  try { return JSON.parse(readFileSync(new URL(`../artifacts/${v}.json`, import.meta.url), 'utf8')).abi; } catch {}
  throw new Error(`--abi: not a file or a known artifact name (${v})`);
};

/** A world forked at the target's chain (anvil, a source RPC, or the in-memory EVM over a source RPC). */
async function worldFor(opt, write) {
  if (opt.anvil || opt['anvil-url']) return anvilWorld({ url: String(opt['anvil-url'] ?? 'http://127.0.0.1:8545') });
  if (opt.local) return createFork();
  const url = String(opt['source-rpc'] ?? opt.rpc ?? '');
  if (!url) throw new Error('--source-rpc <the chain\'s RPC> (a testnet), or --anvil, or --local');
  const source = await rpcSource(url, { block: opt['fork-block'] != null ? Number(opt['fork-block']) : 'latest' });
  write(`forking chain ${source.chainId} at block ${source.blockNumber}`);
  return createFork({ source });
}

export async function redteamCommand({ group, cmd, rest, opt, write, s, connect, connectRpc }) {
  // ---------------------------------------------------------------- SS3: the red team
  if (group === 'redteam') {
    if (cmd === 'targets') {
      const p = await connectRpc(s);
      const chainId = Number(BigInt(await p.send('eth_chainId', [])));
      const ts = await certifiedTargets(p, need(opt.certificate, '--certificate'), { chainId, fromBlock: opt['from-block'] != null ? Number(opt['from-block']) : 0 });
      write(ts.length ? ts.map((t) => `${t.address}  codeHash ${t.codeHash}  request ${t.requestId}`).join('\n') : 'no certified contracts');
      return 0;
    }
    if (cmd === 'scan') {
      const target = need(opt.target, '--target');
      const world = await worldFor(opt, write);
      let abi = abiLoad(opt.abi);
      if (!abi) { const found = await abiFromArtifacts(world, target); if (found) { abi = found.abi; write(`ABI from artifact ${found.name}`); } }
      if (!abi) throw new Error('--abi <artifact name | file>: the target\'s ABI (no matching repo artifact found)');
      const llm = opt['llm-model'] ? { provider: String(opt['llm-provider'] ?? 'ollama'), model: String(opt['llm-model']), ...(opt['llm-url'] ? { baseUrl: String(opt['llm-url']) } : {}), ...(opt['llm-key'] ? { key: String(opt['llm-key']) } : {}) } : null;
      const res = await redTeam(world, { address: target, abi, asset: opt.asset ? need(opt.asset, '--asset') : undefined, minLoss: opt['min-loss'] != null ? num(opt['min-loss'], '--min-loss') : 1n },
        { runs: opt.runs != null ? Number(opt.runs) : 300, seed: opt.seed != null ? Number(opt.seed) : 1, llm, log: write });
      write(`\n${res.findings.length} working exploit(s), ${res.stats.runs} fork runs`);
      const outDir = opt.out ? String(opt.out) : null;
      if (outDir) mkdirSync(outDir, { recursive: true });
      res.findings.forEach((f, i) => {
        write(`#${i}: [${f.strategy}] ${f.title} — ${f.kind === 'loss' ? `loss ${formatEther(BigInt(f.loss))} of ${f.asset}` : `invariant ${f.invariant}`}`);
        if (outDir) { const file = `${outDir}/redteam-${i}.json`; writeFileSync(file, canonicalJson({ finding: { strategy: f.strategy, title: f.title, kind: f.kind, loss: f.loss, invariant: f.invariant }, bundle: f.bundle, bundleHash: f.bundleHash })); write(`   bundle ${file}  bundleHash ${f.bundleHash}`); }
      });
      return res.findings.length ? 0 : 1;
    }
    if (cmd === 'replay') {
      const market = need(opt.market, '--market');
      const world = await worldFor(opt, write);
      const em = new Contract(market, EM.abi, world === null ? null : undefined);
      const p = await connectRpc(s);
      const emr = new Contract(market, EM.abi, p);
      const sub = await emr.submission(num(opt.submission, '--submission'));
      const l = await emr.listing(sub.listing);
      const bundle = readJson(opt.bundle, '--bundle');
      const suite = opt.suite ? readJson(opt.suite, '--suite') : null;
      const r = await replayExploit({ world, bundle, suite,
        listing: { market, id: sub.listing.toString(), target: l.target, codeHash: l.codeHash, asset: l.asset, invariantsHash: l.invariantsHash },
        submission: { id: opt.submission, submitter: sub.submitter, forkBlock: Number(sub.forkBlock), bundleHash: sub.bundleHash, invariant: sub.invariant, claimedLoss: sub.claimedLoss, evidenceHash: sub.evidenceHash } });
      write(`holds ${r.verdict.holds}  observed ${r.verdict.observed}  reportHash ${r.verdict.reportHash}`);
      if (r.report.problems.length) write(`problems: ${r.report.problems.join('; ')}`);
      if (opt.out) writeFileSync(String(opt.out), canonicalJson(r.report));
      return r.verdict.holds ? 0 : 1;
    }
  }

  // ---------------------------------------------------------------- S1: the exploit market
  if (group === 'exploit') {
    const market = () => need(opt.market, '--market');
    if (cmd === 'list') {
      const c = await connect(s, { needJobs: false });
      const em = new Contract(market(), EM.abi, c.signer);
      const invariants = opt.invariants ? readJson(opt.invariants, '--invariants') : null;
      const p = {
        target: need(opt.target, '--target'), asset: opt.asset ? need(opt.asset, '--asset') : ZeroAddress,
        breaker: !!opt.breaker, breakerMask: Number(opt['breaker-mask'] ?? 0), rewardBps: Number(opt['reward-bps'] ?? 1000),
        invariantsHash: invariants ? suiteHash(invariants) : ZeroHash,
        maxReward: parseEther(String(opt['max-reward'] ?? '0')), invariantReward: parseEther(String(opt['invariant-reward'] ?? (invariants ? '1' : '0'))),
        minLoss: parseEther(String(opt['min-loss'] ?? '0.01')), unitValue: parseEther(String(opt['unit-value'] ?? '1')),
      };
      const rc = await (await em.list(p, { value: parseEther(String(opt.pool ?? '0')) })).wait();
      const ev = rc.logs.map((l) => { try { return em.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Listed');
      write(`listed ${ev?.args.listing}: target ${p.target}, escrow ${opt.pool} ZTPHY${invariants ? `, invariantsHash ${p.invariantsHash}` : ''}`);
      return 0;
    }
    if (cmd === 'submit') {
      const c = await connect(s, { needJobs: false });
      const em = new Contract(market(), EM.abi, c.signer);
      const bundle = readJson(opt.bundle, '--bundle');
      const bh = bundleHash(bundle);
      const inv = opt.invariant ? invariantKey(String(opt.invariant)) : ZeroHash;
      const forkBlock = BigInt(bundle.forkBlock);
      const claimedLoss = inv === ZeroHash ? parseEther(String(opt.loss ?? bundle.claimedLoss ?? '0')) : 0n;
      const bond = await em.submitBond();
      const rc = await (await em.submit(num(opt.listing, '--listing'), forkBlock, bh, inv, claimedLoss, { value: bond })).wait();
      const ev = rc.logs.map((l) => { try { return em.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Submitted');
      write(`submitted ${ev?.args.id}: bundleHash ${bh}, evidenceHash ${ev?.args.evidenceHash}, bond ${formatEther(bond)} ZTPHY`);
      return 0;
    }
    if (['commit', 'reveal', 'settle', 'withdraw'].includes(cmd)) return marketRunnerCmd({ cmd, opt, write, connect, s, market: market(), kind: 'exploit' });
  }

  // ---------------------------------------------------------------- SS4: economic security
  if (group === 'econ') {
    if (cmd === 'sim') {
      const scenarios = opt.scenarios ? readJson(opt.scenarios, '--scenarios') : DEFAULT_SCENARIOS;
      const seeds = opt.seeds ? String(opt.seeds).split(',').map(Number) : DEFAULT_SEEDS;
      write(`simulating ${scenarios.length} scenario(s) x ${seeds.length} seed(s) on the in-memory DEX`);
      const { report, reportHash, bound, scenariosHash } = await simulate({ scenarios, seeds, log: write });
      const out = String(opt.out ?? `econ-report.json`);
      writeFileSync(out, canonicalJson(report));
      write(`\nmax extractable loss <= ${formatEther(bound)} (${bound} wei)\nreport ${out}\nreportHash ${reportHash}\nscenariosHash ${scenariosHash}`);
      return 0;
    }
    if (cmd === 'attach') {
      const c = await connect(s, { needJobs: false });
      const eb = new Contract(need(opt.bounds, '--bounds'), EB.abi, c.signer);
      const report = readJson(opt.report, '--report');
      const claim = { reportHash: econReportHash(report), bound: BigInt(report.maxExtractableLoss), scenariosHash: report.scenariosHash };
      await (await eb.attach(num(opt.request, '--request'), claim, { value: parseEther(String(opt.fee ?? '0')) })).wait();
      write(`attached to request ${opt.request}: bound ${formatEther(claim.bound)}, reportHash ${claim.reportHash}`);
      return 0;
    }
    if (['commit', 'reveal', 'settle', 'withdraw'].includes(cmd)) return marketRunnerCmd({ cmd, opt, write, connect, s, market: need(opt.bounds, '--bounds'), kind: 'econ' });
  }

  // ---------------------------------------------------------------- deploy
  if (group === 'deploy-redteam') {
    const c = await connect(s, { needJobs: false });
    const gov = opt.governance ? need(opt.governance, '--governance') : c.me;
    const jobs = need(opt.jobs, '--jobs');
    const minAgreed = Number(opt['min-agreed'] ?? 1);
    const emF = new (await import('ethers')).ContractFactory(EM.abi, EM.bytecode, c.signer);
    const em = await (await emF.deploy(jobs, gov, parseEther(String(opt['submit-bond'] ?? '1')), Number(opt['commit-window'] ?? 3600), Number(opt['reveal-window'] ?? 3600), Number(opt['runner-bps'] ?? 1000), minAgreed)).waitForDeployment();
    write(`ExploitMarket ${await em.getAddress()}`);
    if (opt.network && opt.certificate) {
      const ebF = new (await import('ethers')).ContractFactory(EB.abi, EB.bytecode, c.signer);
      const eb = await (await ebF.deploy(need(opt.network, '--network'), need(opt.certificate, '--certificate'), jobs, minAgreed)).waitForDeployment();
      write(`EconomicBounds ${await eb.getAddress()}`);
    }
    write(`governance ${gov}`);
    return 0;
  }

  throw new Error('usage: zetaphy redteam scan|targets|replay | exploit list|submit|commit|reveal|settle|withdraw | econ sim|attach|commit|reveal|settle|withdraw | deploy-redteam (see zetaphy help)');
}

/** The shared runner commit-reveal-settle for ExploitMarket and EconomicBounds (both: id + commit-reveal, 2-of-3). */
async function marketRunnerCmd({ cmd, opt, write, connect, s, market, kind }) {
  const c = await connect(s, { needJobs: false });
  const art = kind === 'exploit' ? EM : EB;
  const con = new Contract(market, art.abi, c.signer);
  const id = num(opt.id ?? opt.submission ?? opt.request, '--id');
  const saltFile = new URL(`../.redteam-salt-${kind}-${id}.json`, import.meta.url);
  if (cmd === 'withdraw') { await (await con.withdraw()).wait(); write('withdrawn'); return 0; }
  if (cmd === 'settle') { await (await con.settle(id)).wait(); write(`settled ${id}`); return 0; }
  if (cmd === 'commit') {
    const salt = randomSalt();
    let commitment;
    if (kind === 'exploit') {
      const r = readJson(opt.verdict, '--verdict (the replay report, from `zetaphy redteam replay --out`)');
      const isInvariant = r.claim?.invariant && r.claim.invariant !== ZeroHash;
      const v = { holds: r.holds, observed: isInvariant ? 0n : BigInt(r.loss ?? 0), reportHash: reportHashOf(r) };
      commitment = verdictCommitment(v, c.me, salt, id);
      writeFileSync(saltFile, JSON.stringify({ salt, verdict: { holds: v.holds, observed: v.observed.toString(), reportHash: v.reportHash } }));
    } else {
      const report = readJson(opt.report, '--report');
      commitment = await con.commitmentOf(econReportHash(report), BigInt(report.maxExtractableLoss), c.me, salt, id);
      writeFileSync(saltFile, JSON.stringify({ salt, reportHash: econReportHash(report), bound: report.maxExtractableLoss }));
    }
    await (await con.commit(id, commitment)).wait();
    write(`committed on ${id}; salt saved to ${saltFile.pathname} (needed to reveal)`);
    return 0;
  }
  if (cmd === 'reveal') {
    const saved = JSON.parse(readFileSync(saltFile, 'utf8'));
    if (kind === 'exploit') await (await con.reveal(id, [saved.verdict.holds, BigInt(saved.verdict.observed), saved.verdict.reportHash], saved.salt)).wait();
    else await (await con.reveal(id, saved.reportHash, BigInt(saved.bound), saved.salt)).wait();
    write(`revealed on ${id}`);
    return 0;
  }
}
