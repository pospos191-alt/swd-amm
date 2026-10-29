// zetaphy insurance: the deterministic forensic replay behind HackInsurance claims (testnet only;
// docs/future/crosschain-assist.md, item 32; src/replay.js).
//   zetaphy insurance replay --target 0x… --tx 0x…[,0x…] --from-block N --to-block M [--chain-id 77390 --source-rpc URL]
//        [--tokens 0x…,…] [--price 0x<token>=<native per token>,…] [--price-oracle 0x<ZetaphyOracle> --native-asset 0x<WZETAPHY>]
//        [--hardfork cancun] [--confirmations 12] [--anvil anvil] [--out report.json]
//      fork at fromBlock-1 with anvil (foundry v1.2.3), replay the transactions, write the canonical report; prints its
//      hash (HackInsurance's reportHash) and the loss in wei
//   zetaphy insurance hash <report.json>          recompute a report's hash and check its evidence fields
//   zetaphy insurance claim --insurance 0x… --cover <id> --report <report.json> [--uri <where the report is>]
//      the cover holder files the claim (pays the claim bond)
//   zetaphy insurance vote --insurance 0x… --claim <id> [--target 0x…] [--report <claimant's report.json>]
//        [--accept-explicit-prices] [pricing flags as replay] [--dry-run] [--out mine.json]
//      a runner: recompute the replay from the claim's own evidence and vote: approve (restating the hash and loss)
//      only if the recomputed report is identical and every check passes, else reject
import { readFileSync, writeFileSync } from 'node:fs';
import { Contract, getAddress, parseEther, formatEther } from 'ethers';
import { runReplay, rpcSource, anvilEngine, canonicalJson, checkReport, requestOf, targetKeyOf, voteDecision } from './replay.js';

const ART = JSON.parse(readFileSync(new URL('../artifacts/HackInsurance.json', import.meta.url), 'utf8'));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const need = (v, what) => { if (!ADDR_RE.test(String(v ?? ''))) throw new Error(`${what} 0x… is needed`); return getAddress(String(v)); };
const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const STATES = ['None', 'Voting', 'Approved', 'Rejected', 'Expired', 'Disputed', 'Paid', 'Overturned'];

/** --price 0x<token>=<native coins per whole token, e.g. 1.5> -> { token: wei }. */
export function parsePrices(v) {
  const out = {};
  for (const p of list(v)) {
    const m = /^(0x[0-9a-fA-F]{40})=([0-9]{1,30}(\.[0-9]{1,18})?)$/.exec(p);
    if (!m) throw new Error(`--price 0x<token>=<native coins per whole token>, not ${p}`);
    out[m[1].toLowerCase()] = parseEther(m[2]).toString();
  }
  return out;
}

/** The pricing and token inputs given on the command line (null when none given). */
function pricingOf(opt) {
  const given = opt.tokens || opt.price || opt['price-oracle'] || opt.hardfork;
  if (!given) return null;
  if (!!opt['price-oracle'] !== !!opt['native-asset']) throw new Error('--price-oracle 0x<ZetaphyOracle> needs --native-asset 0x<the native coin\'s asset id, e.g. WZETAPHY>');
  return {
    tokens: list(opt.tokens), prices: parsePrices(opt.price),
    oracle: opt['price-oracle'] ? { address: need(opt['price-oracle'], '--price-oracle'), nativeAsset: need(opt['native-asset'], '--native-asset') } : null,
    hardfork: opt.hardfork ?? null,
  };
}

function engineOf(opt, url, write) {
  return anvilEngine({ forkUrl: url, anvil: String(opt.anvil ?? process.env.ANVIL ?? 'anvil'), log: (m) => write(`  ${m}`) });
}

function writeReport(file, report) {
  writeFileSync(file, canonicalJson(report)); // exactly the canonical bytes: keccak256(file) = the report hash
}

export async function insuranceCommand({ cmd, rest, opt, write, s, connect, connectRpc }) {
  const confirmations = opt.confirmations != null ? Number(opt.confirmations) : 12;
  if (!Number.isInteger(confirmations) || confirmations < 0) throw new Error('--confirmations: a whole number');

  if (cmd === 'replay') {
    const url = String(opt['source-rpc'] ?? s.rpc ?? '');
    if (!url) throw new Error('--source-rpc <the chain\'s RPC> (or --rpc for ZETAPHY)');
    const req = { chainId: opt['chain-id'] ?? '77390', target: need(opt.target, '--target'), txHashes: list(opt.tx), fromBlock: opt['from-block'], toBlock: opt['to-block'],
      ...(pricingOf(opt) ?? {}) };
    write(`replaying ${req.txHashes.length} transaction(s) of chain ${req.chainId} in blocks ${req.fromBlock}..${req.toBlock} against ${req.target}`);
    const { report, hash, loss } = await runReplay(req, { source: rpcSource(url), engine: engineOf(opt, url, write), confirmations });
    const out = String(opt.out ?? `replay-${report.evidenceHash.slice(2, 10)}.json`);
    writeReport(out, report);
    for (const a of report.assets) write(`  ${a.asset}: ${a.delta}${a.valueDelta != null ? ` (${formatEther(BigInt(a.valueDelta))} native, ${a.price.source} price)` : a.delta !== '0' ? ' (unpriced: counts zero)' : ''}`);
    if (!report.matchesOriginal) write('  WARNING: a replayed transaction ended differently from the original (see txs[].status / replay)');
    write(`report ${out}\nreportHash ${hash}\nloss ${loss} wei (${formatEther(loss)})`);
    return 0;
  }

  if (cmd === 'hash') {
    if (!rest[0]) throw new Error('usage: zetaphy insurance hash <report.json>');
    const r = checkReport(JSON.parse(readFileSync(rest[0], 'utf8')));
    write(r.ok ? `reportHash ${r.hash}` : `NOT VALID${r.hash ? ` (hash ${r.hash})` : ''}:\n  - ${r.problems.join('\n  - ')}`);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'claim') {
    const report = JSON.parse(readFileSync(String(opt.report ?? ''), 'utf8'));
    const chk = checkReport(report);
    if (!chk.ok) throw new Error(`the report is not valid: ${chk.problems.join('; ')}`);
    const c = await connect(s, { needJobs: false });
    const ins = new Contract(need(opt.insurance, '--insurance'), ART.abi, c.signer);
    if (!/^\d+$/.test(String(opt.cover ?? ''))) throw new Error('--cover <id>');
    const cover = await ins.covers(BigInt(opt.cover));
    if (cover.target.toLowerCase() !== report.targetKey) throw new Error('the report is about another target than this cover');
    const bond = await ins.claimBond();
    const rc = await (await ins.fileClaim(BigInt(opt.cover), report.txHashes, BigInt(report.fromBlock), BigInt(report.toBlock), chk.hash, BigInt(report.loss),
      String(opt.uri ?? `neuro-forensic:${chk.hash}`).slice(0, 200), { value: bond })).wait();
    const ev = rc.logs.map((l) => { try { return ins.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'ClaimFiled');
    write(`claim ${ev?.args.id ?? '?'} filed: reportHash ${chk.hash}, loss ${report.loss} wei, bond ${formatEther(bond)}`);
    return 0;
  }

  if (cmd === 'vote') {
    const id = String(opt.claim ?? '');
    if (!/^\d+$/.test(id)) throw new Error('--claim <id>');
    const p = await connectRpc(s);
    const insAddr = need(opt.insurance, '--insurance');
    const ins = new Contract(insAddr, ART.abi, p);
    const chainId = BigInt(await p.send('eth_chainId', []));
    const claim = await ins.claims(BigInt(id));
    if (STATES[Number(claim.state)] !== 'Voting') throw new Error(`claim ${id} is ${STATES[Number(claim.state)]}, not open for votes`);
    const cover = await ins.covers(claim.coverId);
    const evs = await ins.queryFilter(ins.filters.ClaimEvidence(BigInt(id)), Number(cover.startBlock));
    if (evs.length !== 1) throw new Error(`claim ${id}: ${evs.length} ClaimEvidence events found (expected 1)`);
    const { txHashes, fromBlock, toBlock, uri } = evs[0].args;
    // the inputs: the runner's own flags, else the claimant's report (its tokens and pricing; explicit prices only when accepted)
    const theirs = opt.report ? JSON.parse(readFileSync(String(opt.report), 'utf8')) : null;
    let pricing = pricingOf(opt);
    if (!pricing && theirs) {
      pricing = requestOf(theirs);
      if (Object.keys(pricing.prices ?? {}).length && !opt['accept-explicit-prices']) {
        throw new Error(`the claimant's report prices ${Object.keys(pricing.prices).join(', ')} by hand: check those prices, then vote with --accept-explicit-prices (or give your own --price / --price-oracle, which rejects if they differ). No vote sent.`);
      }
    }
    const target = need(opt.target ?? theirs?.target, '--target (the covered contract)');
    if (targetKeyOf(chainId, target) !== cover.target.toLowerCase()) throw new Error(`${target} is not the target of cover ${claim.coverId}`);
    write(`claim ${id}: ${txHashes.length} transaction(s) in blocks ${fromBlock}..${toBlock}${uri ? ` (${uri})` : ''}; recomputing the replay`);
    const { report, hash } = await runReplay({ chainId, target, txHashes: [...txHashes], fromBlock, toBlock, ...(pricing ? { tokens: pricing.tokens, prices: pricing.prices, oracle: pricing.oracle, hardfork: pricing.hardfork } : {}) },
      { source: rpcSource(s.rpc), engine: engineOf(opt, s.rpc, write), confirmations });
    if (opt.out) writeReport(String(opt.out), report);
    const d = voteDecision({ claim, cover, insuranceChainId: chainId, report, hash });
    write(d.approve ? `APPROVE: the same report ${hash} and loss ${d.loss}` : `REJECT: ${d.reasons.join('; ')}`);
    if (opt['dry-run']) { write('dry run: no vote sent'); return 0; }
    const c = await connect(s, { needJobs: false });
    await (await new Contract(insAddr, ART.abi, c.signer).vote(BigInt(id), d.approve, d.reportHash, d.loss)).wait();
    const k = await ins.claims(BigInt(id));
    write(`voted on claim ${id}: now ${STATES[Number(k.state)]} (${k.approvals} approve, ${k.rejections} reject)`);
    return 0;
  }

  throw new Error('usage: zetaphy insurance replay | hash <report.json> | claim | vote (see zetaphy help)');
}
