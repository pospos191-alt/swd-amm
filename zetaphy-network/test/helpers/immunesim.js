// The immune network end to end, on simulated chains (test/immune-e2e.test.js, scripts/immune-sim.js):
//   - ZETAPHY (77390), Base Sepolia "B" (84532) and Arbitrum Sepolia "C" (421614) are real in-process EVMs running
//     the real contracts: NeuroControl + NeuroJobs (bonded runners, lottery seats, challenges), ImmuneRegistry,
//     ImmuneBroadcaster, a Hyperlane Mailbox + message-id multisig ISM per chain (helpers/HyperlaneKit.sol),
//     ImmuneMirror and ImmuneGuardedRouter on B and C;
//   - what the sentinels SEE (blocks, receipts, code) on Sepolia "A" and on C comes from the mock multi-chain
//     (src/immune/mockchain.js), the same `send` shape as a free public RPC.
// One clock drives everything (seconds); each stage moves it by what that stage costs on the real chains
// (ZETAPHY 5 s blocks, the destination's block time, validator signing and relayer delay), so the latencies it
// reports are simulated seconds, not this machine's speed. Runner re-verification is the real CPU time, rounded up.
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Interface, zeroPadValue, hexlify, randomBytes, keccak256 } from 'ethers';
import { createChain, ZETA } from './evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './hyperlanekit.js';
import { MockEvmChain, log, mockAddress } from '../../src/immune/mockchain.js';
import { EvmSentinel, toReport } from '../../src/immune/sentinel.js';
import { VaccineSet } from '../../src/immune/vaccines.js';
import { runnerVote, findingHash, findingTuple, rejectHash, commitment, chainTag, jobTarget, keysOf, CHAIN_FLAG } from '../../src/immune/agree.js';
import { buildFeed, readRegistry } from '../../src/immune/feed.js';
import { KIND, SEVERITY, TTL, subjectOf } from '../../src/immune/detectors.js';
import { median } from '../../src/immune/propagate.js';

export const IDS = { Z: 77390, A: 11155111, B: 84532, C: 421614 };
export const BLOCK = { Z: 5, A: 12, B: 2, C: 1 };
const HYP = { sign: 1, relay: 3 }; // our validators sign the checkpoint; the relayer sees it and submits
const POLL = 6;                    // a sentinel polls its chain every 6 s
const RPC_S = 0.15;                // per request against a free public endpoint
const BOND = 100n * ZETA, REWARD = ZETA, MIN_FEE = ZETA / 10n, WINDOW = 60, TIMEOUT = 600, UNBOND = 3600, CAP = 1000n * ZETA;
const SKILL = '0x' + 'ab'.repeat(32);
const b32 = (a) => zeroPadValue(a, 32);
const art = (n) => JSON.parse(readFileSync(new URL(`../../artifacts/${n}.json`, import.meta.url), 'utf8'));
const errorsOf = (...names) => names.flatMap((n) => art(n).abi.filter((f) => f.type === 'error'));

let kitCache = null;
/** ImmuneKit.sol: { name: { abi, bytecode, runtime } }. */
export function immuneKit() {
  if (kitCache) return kitCache;
  const f = 'ImmuneKit.sol';
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [f]: { content: readFileSync(new URL(`./${f}`, import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  kitCache = Object.fromEntries(Object.entries(out.contracts[f]).map(([n, c]) => [n, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object }]));
  return kitCache;
}

/** JSON-RPC over an in-process chain (eth_call / eth_getCode / eth_blockNumber): what readRegistry and the SDK use. */
export function chainSend(k) {
  return async (method, params = []) => {
    if (method === 'eth_call') return k.rawCallHex(params[0].to, params[0].data);
    if (method === 'eth_getCode') return k.getCode(params[0]);
    if (method === 'eth_blockNumber') return '0x' + k.blockNumber().toString(16);
    throw new Error(`chainSend: ${method}`);
  };
}

/** The whole network, deployed and wired. */
export async function setupNetwork({ runners = 7 } = {}) {
  const R = Array.from({ length: runners }, (_, i) => `r${i}`);
  const Z = await createChain(['gov', 'fund', 'user', 'sentinel', 'challenger', 'pusher', ...R], {}, { chainId: IDS.Z });
  const kit = kitArtifacts();
  const ctl = await Z.deploy('NeuroControl', [Z.acct.gov.toString(), Z.acct.fund.toString(), 8, 4], 'gov');
  const jobs = await Z.deploy('NeuroJobs', [BOND, REWARD, MIN_FEE, WINDOW, TIMEOUT, UNBOND, CAP], 'gov');
  await jobs.send('gov', 'setControl', [ctl.address]);
  await ctl.send('gov', 'approveSkill', [SKILL]);
  await ctl.send('gov', 'setActiveSkill', [SKILL]);
  await ctl.send('gov', 'approveChains', [[chainTag('immune'), chainTag('immune-clear')]]);
  await ctl.send('gov', 'setChallengeWindow', [3600]);
  await jobs.send('gov', 'fund', [], 1000n * ZETA);
  for (const r of R) await jobs.send(r, 'register', [], BOND);
  Z.advance(1);
  const registry = await Z.deploy('ImmuneRegistry', [jobs.address, '0x' + '00'.repeat(20), 2, Z.acct.gov.toString()], 'gov');
  const mbArt = (k) => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('ImmuneMirror')], bytecode: kit.KitMailbox.bytecode });
  const zMailbox = await Z.deployRaw(mbArt(), [IDS.Z], 'gov');
  const broadcaster = await Z.deploy('ImmuneBroadcaster', [registry.address, zMailbox.address, Z.acct.gov.toString()], 'gov');
  const validators = [validator(11), validator(12), validator(13)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
  const dest = {};
  for (const name of ['B', 'C']) {
    const k = await createChain(['gov', 'guardian', 'relayer', 'user', 'attacker', 'victim'], {}, { chainId: IDS[name] });
    const mailbox = await k.deployRaw(mbArt(), [IDS[name]], 'gov');
    const ism = await k.deployRaw(kit.KitMessageIdMultisigIsm, [validators.map((v) => v.address), 2], 'gov');
    const mirror = await k.deploy('ImmuneMirror', [mailbox.address, IDS.Z, IDS.Z, b32(broadcaster.address), ism.address, k.acct.gov.toString(), k.acct.guardian.toString()], 'gov');
    const router = await k.deploy('ImmuneGuardedRouter', [mirror.address, 3, false], 'gov');
    await router.sendValue('gov', 10n * ZETA);
    await broadcaster.send('gov', 'setReceiver', [IDS[name], b32(mirror.address)]);
    dest[name] = { k, mailbox, ism, mirror, router, id: IDS[name] };
  }
  const mailIface = new Interface(kit.KitMailbox.abi);
  const net = { Z, ctl, jobs, registry, zMailbox, broadcaster, dest, R, validators, mailIface, kit,
    attacker: dest.B.k.acct.attacker.toString().toLowerCase(), user: dest.B.k.acct.user.toString().toLowerCase(),
    runnerVaccines: new VaccineSet(), t: Number(Z.now()) };
  /** Moves the shared clock to `t` (never back). */
  net.at = (t) => { net.t = Math.max(net.t, t); for (const k of [Z, dest.B.k, dest.C.k]) k.setTime(Math.ceil(net.t)); return net.t; };
  net.at(net.t);
  return net;
}

/**
 * NeuroJobs agreement on a report: request (sentinel), then the lottery: runners that are eligible commit (each
 * after re-verifying the evidence itself), the clock moves a third of the window at a time until 3 seats are taken;
 * reveals. `liars`: how many of the first seats reveal `lie` (the fake finding) instead of their own vote.
 * -> { jobId, seats, votes, verdict, status, t: { requested, committed, done } }
 */
export async function agree(net, report, { chain = CHAIN_FLAG, liars = 0, lie = null, fee = MIN_FEE } = {}) {
  const { Z, jobs } = net;
  await jobs.send('sentinel', 'request', [chainTag(chain), jobTarget(report)], fee);
  const id = (await jobs.call('jobCount')) - 1n;
  const requested = net.at(net.t + BLOCK.Z);
  const cpu0 = performance.now();
  const honest = runnerVote(report, { vaccines: net.runnerVaccines }); // every runner computes the same thing; timed once
  const cpu = Math.max(1, Math.ceil((performance.now() - cpu0) / 1000));
  net.at(net.t + cpu);
  const seats = []; const salts = {}; const votes = {};
  for (let round = 0; round < 6 && seats.length < 3; round++) {
    for (const r of net.R) {
      if (seats.length >= 3 || seats.includes(r)) continue;
      if (!(await jobs.call('eligible', [id, Z.acct[r].toString()]))) continue;
      const v = seats.length < liars ? lie : honest.verdict;
      salts[r] = hexlify(randomBytes(32));
      await jobs.send(r, 'commit', [id, commitment(v, Z.acct[r].toString(), salts[r])]);
      seats.push(r); votes[r] = v;
    }
    if (seats.length < 3) net.at(net.t + WINDOW / 3);
  }
  const committed = net.at(net.t + BLOCK.Z);
  if (seats.length < 3) net.at(Number(Z.now()) + WINDOW); // a window that did not fill: reveals open after it
  for (const r of seats) await jobs.send(r, 'reveal', [id, votes[r], salts[r]]).catch(() => {});
  const done = net.at(net.t + BLOCK.Z);
  const j = await jobs.call('getJob', [id]);
  return { jobId: id, seats, votes, honest, verdict: j.result, status: Number(j.status), t: { requested, committed, done } };
}

/** ImmuneRegistry.attest (anyone: the sentinel here). -> { keys, t } */
export async function attest(net, jobId, finding) {
  await net.registry.send('sentinel', 'attest', [jobId, findingTuple(finding)]);
  return { keys: keysOf(finding), t: net.at(net.t + BLOCK.Z) };
}

/**
 * One broadcast + the relayer: every Dispatch of the call is signed by 2 of our 3 validators and processed on its
 * destination. -> { gas, messages: [{ dest, items }], t: { [dest]: seconds } }
 */
export async function broadcast(net, keys) {
  const { Z, broadcaster, zMailbox, mailIface, dest, validators } = net;
  const tx = await Z.rawTx('pusher', broadcaster.address, broadcaster.iface.encodeFunctionData('broadcast', [keys]), 0n);
  if (!tx.ok) throw new Error('broadcast reverted');
  const sent = net.at(net.t + BLOCK.Z);
  const dispatch = mailIface.getEvent('Dispatch').topicHash;
  const out = { gas: tx.gas, messages: [], t: {} };
  for (const l of tx.logs.filter((x) => x.address.toLowerCase() === zMailbox.address.toLowerCase() && x.topics[0] === dispatch)) {
    const m = mailIface.decodeEventLog('Dispatch', l.data, l.topics).message;
    const to = Number(BigInt(l.topics[2]));
    const d = Object.values(dest).find((x) => x.id === to);
    await d.mailbox.send('relayer', 'process', [messageIdMetadata(m, validators.slice(0, 2)), m]);
    const name = Object.keys(dest).find((n) => dest[n] === d);
    out.t[name] = sent + HYP.sign + HYP.relay + BLOCK[name];
    out.messages.push({ dest: name, bytes: (m.length - 2) / 2 });
  }
  return out;
}

/** The feed from ZETAPHY's registry right now, with the vaccines the sentinels shipped. */
export async function feedNow(net, vaccines = []) {
  const items = await readRegistry(chainSend(net.Z), net.registry.address);
  return buildFeed({ items, vaccines, source: { registry: net.registry.address }, now: net.t });
}

/**
 * The scenario of the docs: an exploit on A, flagged, mirrored to B and C; the router on B refuses the attacker;
 * the vaccine catches a clone deployed on C; a false flag is challenged, the liars slashed and the flag lifted.
 * -> a report object (latencies in simulated seconds, gas, who was slashed).
 */
export async function runScenario({ net = null, log: say = () => {} } = {}) {
  net ??= await setupNetwork();
  const kitc = immuneKit();
  const { dest } = net;
  const out = { stages: {}, mirrors: {}, clone: {}, falseFlag: {}, gas: {} };

  // ---- A (Sepolia, mock view): an exploit contract and the attack transaction
  const A = new MockEvmChain({ id: IDS.A, head: 7_000_000, time: net.t - 120, blockTime: BLOCK.A });
  const exploit = mockAddress('A.exploit');
  const token = mockAddress('A.weth'); const pool = mockAddress('A.pair'); const lender = mockAddress('A.aave'); const victim = mockAddress('A.lending');
  A.mine([{ from: net.attacker, deploy: kitc.FlashExploit.runtime, contractAddress: exploit }]);
  A.idle(3);
  const sentinelA = new EvmSentinel({ chain: { key: 'sepolia', id: IDS.A }, rpc: A.rpc(), now: () => net.t });
  await sentinelA.tick(); // baseline: cursor at the head
  A.time = net.t - BLOCK.A;
  const E = 10n ** 18n;
  const attack = A.mine([{ from: net.attacker, to: exploit, logs: [
    log.flash(lender, 'aave-v3', exploit),
    log.transfer(token, lender, exploit, 5000n * E),
    log.sync(pool, 1000n * E, 1000n * E),
    log.sync(pool, 3500n * E, 290n * E),        // the pool price pushed 12x
    log.transfer(token, victim, exploit, 2600n * E), // borrowed against the manipulated price
    log.sync(pool, 1000n * E, 1000n * E),
    log.transfer(token, exploit, lender, 5003n * E),
    log.transfer(token, exploit, net.attacker, 2597n * E),
  ] }]);
  const tAttack = attack.timestamp;
  net.at(tAttack);
  // detect: the next poll, plus the requests it makes
  const rpcA = A.rpc();
  sentinelA.rpc = rpcA;
  const reports = await sentinelA.tick();
  const tDetect = net.at(Math.ceil(tAttack / POLL) * POLL + rpcA.stats.requests * RPC_S);
  say(`detect: ${reports.length} report(s) on A after ${(tDetect - tAttack).toFixed(1)} s`);
  const exploitReport = reports.find((r) => r.finding.kind === KIND.exploit);
  const attackerReport = reports.find((r) => r.finding.kind === KIND.attacker);
  if (!exploitReport || !attackerReport) throw new Error('the sentinel missed the attack');

  // ---- agree (both findings, one job each, the same runners' pool) + attest + broadcast
  const ag1 = await agree(net, exploitReport);
  const ag2 = await agree(net, attackerReport);
  if (ag1.verdict !== findingHash(exploitReport.finding) || ag2.verdict !== findingHash(attackerReport.finding)) throw new Error('no agreement');
  const tAgreed = net.t;
  const k1 = await attest(net, ag1.jobId, exploitReport.finding);
  const k2 = await attest(net, ag2.jobId, attackerReport.finding);
  const tRegistry = net.t;
  const keys = [...k1.keys, ...k2.keys];
  const b1 = await broadcast(net, keys);
  out.gas.broadcast = { gas: b1.gas, items: keys.length, routes: b1.messages.length };
  out.stages = { attack: tAttack, detect: +(tDetect - tAttack).toFixed(1), agree: +(tAgreed - tDetect).toFixed(1), registry: +(tRegistry - tAgreed).toFixed(1) };
  for (const n of ['B', 'C']) out.mirrors[n] = { mirror: +(b1.t[n] - tRegistry).toFixed(1), total: +(b1.t[n] - tAttack).toFixed(1) };
  net.at(Math.max(b1.t.B, b1.t.C));
  say(`mirrored to B and C: ${JSON.stringify(out.mirrors)}`);

  // ---- B: the router refuses the attacker (every EVM chain: same key), pays an honest user
  const refused = await dest.B.router.send('gov', 'send', [net.attacker, ZETA]).then(() => false, (e) => /ImmuneFlagged/.test(e.message));
  const paid = await dest.B.router.send('gov', 'send', [net.user, ZETA]).then(() => true, () => false);
  out.routerB = { refusedAttacker: refused, paidUser: paid };

  // ---- C: the vaccine rides with the flag; a clone deployed on C is caught
  const exploitCodeKey = keysOf(exploitReport.finding).at(-1);
  out.clone.vaccineOnMirror = (await dest.C.mirror.call('vaccineOf', [exploitCodeKey])).toLowerCase() === exploitReport.vaccine.id.toLowerCase();
  const feed1 = await feedNow(net, [exploitReport.vaccine]);
  for (const v of feed1.vaccines) net.runnerVaccines.add(v);
  const Cview = new MockEvmChain({ id: IDS.C, head: 90_000_000, time: net.t - 10, blockTime: BLOCK.C });
  const sentinelC = new EvmSentinel({ chain: { key: 'arbitrumsepolia', id: IDS.C }, rpc: Cview.rpc(), now: () => net.t });
  for (const v of feed1.vaccines) sentinelC.vaccinate(v);
  await sentinelC.tick();
  // the attacker redeploys a modified copy on C (real code on the real EVM C; the sentinel sees its deployment)
  const clone = await dest.C.k.deployRaw({ abi: kitc.FlashExploitClone.abi, bytecode: kitc.FlashExploitClone.bytecode }, [], 'attacker');
  const cloneCode = await dest.C.k.getCode(clone.address);
  Cview.time = net.t - BLOCK.C;
  const dep = Cview.mine([{ from: net.attacker, deploy: cloneCode, contractAddress: clone.address }]);
  const tClone = dep.timestamp;
  const cloneReports = await sentinelC.tick();
  const cr = cloneReports.find((r) => r.finding.kind === KIND.clone);
  if (!cr) throw new Error('the clone was not caught');
  const tCloneDetect = net.at(Math.ceil(tClone / POLL) * POLL + 4 * RPC_S);
  const ag3 = await agree(net, cr);
  if (ag3.verdict !== findingHash(cr.finding)) throw new Error('no agreement on the clone');
  const k3 = await attest(net, ag3.jobId, cr.finding);
  const b3 = await broadcast(net, k3.keys);
  net.at(b3.t.C);
  const flagC = await dest.C.mirror.call('check', [clone.address]);
  const refusedClone = await dest.C.router.send('gov', 'send', [clone.address, ZETA]).then(() => false, (e) => /ImmuneFlagged/.test(e.message));
  out.clone = { ...out.clone, how: cr.bundle.inputs ? cr.label : null, severity: cr.finding.severity, flaggedOnC: flagC[0], routerCRefuses: refusedClone,
    detect: +(tCloneDetect - tClone).toFixed(1), total: +(b3.t.C - tClone).toFixed(1) };
  say(`clone on C: ${JSON.stringify(out.clone)}`);

  // ---- a false flag: two colluding seats agree on a finding the evidence does not support
  const fake = toReport({ detector: 'taint', chainId: IDS.B, address: net.user, subject: subjectOf(net.user), kind: KIND.attacker, severity: SEVERITY.critical,
    everyChain: true, codeHash: '0x' + '00'.repeat(32), label: 'fabricated', ttl: TTL.attacker },
  { detector: 'taint', inputs: { chainId: IDS.B, flagged: { address: mockAddress('nobody'), severity: 1, kind: 2 }, transfer: { to: net.user, value: '1', token: null, tx: '0x' + '01'.repeat(32) }, toCode: '0x' }, observedAt: net.t });
  const agF = await agree(net, fake, { liars: 2, lie: findingHash(fake.finding) });
  const honestSeat = agF.seats[2];
  const kF = await attest(net, agF.jobId, fake.finding);
  await broadcast(net, kF.keys);
  out.falseFlag.flaggedThenOnB = (await dest.B.mirror.call('isFlagged', [IDS.B, net.user]))[0];
  out.falseFlag.honestRunnerRejected = agF.votes[honestSeat] === rejectHash(fake.finding.evidenceHash);
  const tF = net.t;
  // anyone challenges with the reject verdict; a fresh round (never the round-1 seats) re-runs it
  const need = await net.jobs.call('challengeBondOf', [agF.jobId]);
  const liars = agF.seats.slice(0, 2);
  const bondsBefore = await Promise.all(liars.map(async (w) => (await net.jobs.call('workers', [net.Z.acct[w].toString()])).bond));
  await net.jobs.send('challenger', 'challenge', [agF.jobId, rejectHash(fake.finding.evidenceHash)], need);
  net.at(net.t + BLOCK.Z);
  const s2 = {}; const seats2 = [];
  for (let round = 0; round < 6 && seats2.length < 3; round++) {
    for (const r of net.R) {
      if (seats2.length >= 3 || seats2.includes(r) || agF.seats.includes(r)) continue;
      if (!(await net.jobs.call('challengeEligible', [agF.jobId, net.Z.acct[r].toString()]))) continue;
      const v = runnerVote(fake, { vaccines: net.runnerVaccines }).verdict;
      s2[r] = { v, salt: hexlify(randomBytes(32)) };
      await net.jobs.send(r, 'challengeCommit', [agF.jobId, commitment(v, net.Z.acct[r].toString(), s2[r].salt)]);
      seats2.push(r);
    }
    if (seats2.length < 3) net.at(net.t + WINDOW / 3);
  }
  if (seats2.length < 3) net.at(net.t + WINDOW);
  for (const r of seats2) await net.jobs.send(r, 'challengeReveal', [agF.jobId, s2[r].v, s2[r].salt]).catch(() => {});
  net.at(net.t + BLOCK.Z);
  const as = await net.jobs.call('assurance', [agF.jobId]);
  const bondsAfter = await Promise.all(liars.map(async (w) => (await net.jobs.call('workers', [net.Z.acct[w].toString()])).bond));
  for (const key of kF.keys) await net.registry.send('challenger', 'lift', [key]);
  net.at(net.t + BLOCK.Z);
  const bF = await broadcast(net, kF.keys);
  net.at(bF.t.B);
  out.falseFlag = { ...out.falseFlag, challengeState: Number(as.state), slashed: liars.map((w, i) => ({ runner: w, before: bondsBefore[i], after: bondsAfter[i] })),
    clearedOnB: !(await dest.B.mirror.call('isFlagged', [IDS.B, net.user]))[0], secondsToCorrect: +(bF.t.B - tF).toFixed(1),
    routerBPaysUserAgain: await dest.B.router.send('gov', 'send', [net.user, 1n]).then(() => true, () => false) };
  say(`false flag: ${JSON.stringify(out.falseFlag, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);

  out.feed = await feedNow(net, [exploitReport.vaccine]);
  out.reports = { exploit: exploitReport, attacker: attackerReport, clone: cr, fake };
  out.median = median([out.mirrors.B.total, out.mirrors.C.total]);
  out.keys = { exploit: k1.keys, attacker: k2.keys, clone: k3.keys, fake: kF.keys, cloneAddress: clone.address.toLowerCase(), exploitCodeKey };
  out.net = net;
  return out;
}

export { keccak256 };
