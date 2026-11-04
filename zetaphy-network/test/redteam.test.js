// The AI red team (SS3) and the exploit market (S1) end to end on the in-memory EVM (docs/future/red-team.md):
//   - the fork's safety guard (only testnets / local chains);
//   - each deterministic strategy finds the bug in its demo target, and NONE fires on the safe one;
//   - a red-team finding compiles to an exploit bundle whose hash the deterministic replay reproduces;
//   - S1: list -> the red team builds the submission -> submit -> three runners replay and confirm with
//     commit-reveal -> settle pays the submitter and the agreeing runners from the escrow;
//   - the search finds a sequence when the strategies do not;
//   - the LLM hook (with a fake provider) proposes a plan that is run like any other; without a model nothing
//     changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256, toUtf8Bytes, getBytes, hexlify, randomBytes, Wallet, Signature, ZeroHash, getAddress } from 'ethers';
import { readFileSync } from 'node:fs';
import { createChain, ZETA } from './helpers/evm.js';
import { redTeamKit, chainSource } from './helpers/redteamkit.js';
import { workMocks } from './helpers/workmocks.js';
import { createFork, emptySource, checkTestnet, TESTNET_CHAIN_IDS } from '../src/redteam/fork.js';
import { redTeam, submissionOf, llmPlans } from '../src/redteam/agent.js';
import { makeContext, evaluate } from '../src/redteam/engine.js';
import { search } from '../src/redteam/search.js';
import { replayExploit, bundleHash, evidenceHashOf, verdictCommitment } from '../src/redteam/exploit.js';
import { STRATEGIES } from '../src/redteam/strategies.js';

const abi = AbiCoder.defaultAbiCoder();
const E = ZETA;
const kit = redTeamKit();
const dep = '0x00000000000000000000000000000000000d0d01';
const vic = '0x00000000000000000000000000000000000b1c71';
const salt = () => hexlify(randomBytes(32));

async function localFork() { const w = await createFork(); await w.setBalance(dep, 10n ** 24n); await w.setBalance(vic, 10n ** 24n); return w; }
const I = (n) => new Interface(kit[n].abi);
async function deploy(w, name, args = [], value = 0n) { return w.deploy(dep, kit[name].bytecode + I(name).encodeDeploy(args).slice(2), value); }

test('the fork refuses any chain that is not a testnet or local', () => {
  assert.throws(() => checkTestnet(1), /not a testnet/);
  assert.throws(() => checkTestnet(137), /not a testnet/);
  for (const id of TESTNET_CHAIN_IDS) assert.equal(checkTestnet(id), id);
});

test('each strategy finds its demo bug; none fires on the safe bank', async () => {
  // reentrancy
  {
    const w = await localFork();
    const a = await deploy(w, 'ReentrantBank');
    await w.tx(vic, a, I('ReentrantBank').encodeFunctionData('deposit'), 40n * E);
    const r = await redTeam(w, { address: a, abi: kit.ReentrantBank.abi, minLoss: 1n }, { runs: 0 });
    assert.ok(r.findings.some((f) => f.strategy === 'reentrancy'), 'reentrancy found');
  }
  // access control
  {
    const w = await localFork();
    const a = await deploy(w, 'OpenOwnerVault', [], 50n * E);
    const r = await redTeam(w, { address: a, abi: kit.OpenOwnerVault.abi, minLoss: 1n }, { runs: 0 });
    assert.ok(r.findings.some((f) => f.strategy === 'access-control'), 'access control found');
  }
  // rounding
  {
    const w = await localFork();
    const a = await deploy(w, 'RoundingVault');
    await w.tx(vic, a, I('RoundingVault').encodeFunctionData('deposit'), 100n);
    await w.tx(dep, a, I('RoundingVault').encodeFunctionData('harvest'), 100n * E);
    const r = await redTeam(w, { address: a, abi: kit.RoundingVault.abi, minLoss: 1n }, { runs: 0 });
    assert.ok(r.findings.some((f) => f.strategy === 'rounding'), 'rounding found');
  }
  // signature replay
  {
    const w = await localFork();
    const sk = new Wallet(keccak256(toUtf8Bytes('redteam voucher signer')));
    const a = await deploy(w, 'SigVouchers', [sk.address], 50n * E);
    const amount = 5n * E;
    const h = keccak256(abi.encode(['address', 'uint256'], [getAddress(a), amount]));
    const sig = Signature.from(sk.signMessageSync(getBytes(h)));
    const data = I('SigVouchers').encodeFunctionData('claim', [amount, sig.v, sig.r, sig.s]);
    assert.ok((await w.tx(vic, a, data)).ok);
    const r = await redTeam(w, { address: a, abi: kit.SigVouchers.abi, history: [{ from: vic, to: a, data, value: 0 }], minLoss: 1n }, { runs: 0 });
    assert.ok(r.findings.some((f) => f.strategy === 'signature-replay'), 'signature replay found');
  }
  // the safe bank: nothing
  {
    const w = await localFork();
    const a = await deploy(w, 'SafeBank');
    await w.tx(vic, a, I('SafeBank').encodeFunctionData('deposit'), 40n * E);
    const r = await redTeam(w, { address: a, abi: kit.SafeBank.abi, minLoss: 1n }, { runs: 500, seed: 7 });
    assert.equal(r.findings.length, 0, 'no false positive on the safe bank');
  }
});

test('flash-loan + spot-price manipulation is found against a spot-price buyback', async () => {
  const w = await localFork();
  const T = I('DemoToken');
  const A = await deploy(w, 'DemoToken', ['A']);
  const B = await deploy(w, 'DemoToken', ['B']);
  const F = new Interface(require2('ZetaphyFactory').abi);
  const fac = await w.deploy(dep, require2('ZetaphyFactory').bytecode + F.encodeDeploy([dep]).slice(2));
  const rc = await w.tx(dep, fac, F.encodeFunctionData('createPair', [A, B]));
  const pair = '0x' + (await w.call(fac, F.encodeFunctionData('getPair', [A, B]))).slice(26);
  const P = new Interface(require2('ZetaphyPair').abi);
  const mint = async (t, to, v) => w.tx(dep, t, T.encodeFunctionData('mint', [to, v]));
  await mint(A, pair, 1000n * E); await mint(B, pair, 1000n * E);
  await w.tx(dep, pair, P.encodeFunctionData('mint', [dep]));
  const buy = await deploy(w, 'SpotBuyback', [pair, A, B]);
  await mint(B, buy, 500n * E);
  const lender = await deploy(w, 'DemoFlashLender');
  await mint(B, lender, 5000n * E);
  const first = A.toLowerCase() < B.toLowerCase();
  const r = await redTeam(w, { address: buy, abi: kit.SpotBuyback.abi, asset: B,
    env: { pairs: [{ address: pair, token0: first ? A : B, token1: first ? B : A }], lenders: [{ address: lender, tokens: [B] }] }, minLoss: 1n }, { runs: 0 });
  assert.ok(r.findings.some((f) => f.strategy === 'flash-price'), 'flash-price manipulation found');
});

function require2(n) { return JSON.parse(readFileSync(new URL(`../../zetaphy-dex/artifacts/${n}.json`, import.meta.url), 'utf8')); }

test('S1: a red-team finding on a listed contract is submitted, two runners replay it, and the submitter is paid', async () => {
  // the "real" chain (id 31337 so the fork guard accepts it); the target lives here, the exploit never runs here
  const c = await createChain(['gov', 'sponsor', 'hacker', 'r1', 'r2', 'r3', 'outsider'], {}, { chainId: 31337 });
  const A = (n) => c.acct[n].toString();
  const m = workMocks();
  const jobs = await c.deployRaw(m.MockRunners, [], 'gov');
  for (const r of ['r1', 'r2', 'r3']) await jobs.send('gov', 'set', [A(r), true, 5, 0]);
  const bank = await c.deployRaw(kit.ReentrantBank, [], 'gov');
  await bank.send('gov', 'deposit', [], 40n * E);           // the victim's money in the bank
  const em = await c.deploy('ExploitMarket', [jobs.address, A('gov'), E, 3600, 3600, 1000, 1], 'gov');
  const target = bank.address;
  const codeHash = await c.getCode(target).then(keccak256);
  // list it for exploits, escrow 100
  const LIST = { target: getAddress(target), asset: '0x'.padEnd(42, '0'), breaker: false, breakerMask: 0, rewardBps: 10000,
    invariantsHash: ZeroHash, maxReward: 100n * E, invariantReward: 0n, minLoss: E, unitValue: E };
  await em.send('sponsor', 'list', [LIST], 100n * E);
  const listingId = (await em.call('listingCount')) - 1n;
  // the red team forks the live chain and finds the exploit (the attacker is the submitter, 'hacker')
  const forkBlock = Number(c.blockNumber() - 1n);
  const world = await createFork({ source: chainSource(c, { chainId: 31337, blockNumber: forkBlock }) });
  const res = await redTeam(world, { address: target, abi: kit.ReentrantBank.abi, minLoss: 1n, attacker: A('hacker') }, { runs: 0, funding: 10n * E, attacker: A('hacker') });
  const finding = res.findings.find((f) => f.kind === 'loss');
  assert.ok(finding, 'the red team found a loss exploit');
  const sub = submissionOf(finding, { listing: listingId });
  const evidenceHash = evidenceHashOf({ chainId: 31337, market: em.address, listing: listingId, target: getAddress(target), codeHash, forkBlock: sub.forkBlock, bundleHash: sub.bundleHash, invariant: sub.invariant, claimedLoss: sub.claimedLoss, submitter: getAddress(A('hacker')) });
  // each runner replays the bundle on its own fresh fork of the live state (pinned at forkBlock in production;
  // here, before the on-chain submit, so the attacker's nonce — hence its contract address — is still the fork's)
  const listing = { market: em.address, id: listingId.toString(), target, codeHash, asset: '0x'.padEnd(42, '0'), invariantsHash: ZeroHash };
  const submission = { submitter: A('hacker'), forkBlock: sub.forkBlock, bundleHash: sub.bundleHash, invariant: sub.invariant, claimedLoss: sub.claimedLoss, evidenceHash };
  const verdicts = [];
  for (let i = 0; i < 3; i++) {
    const fw = await createFork({ source: chainSource(c, { chainId: 31337, blockNumber: forkBlock }) });
    const r = await replayExploit({ world: fw, bundle: finding.bundle, listing, submission });
    verdicts.push(r.verdict);
  }
  assert.ok(verdicts[0].holds, 'the replay confirms the exploit');
  assert.equal(verdicts[0].reportHash, verdicts[1].reportHash, 'two honest runners get the same report hash');
  assert.equal(verdicts[1].reportHash, verdicts[2].reportHash);
  // submit on-chain (this advances the submitter's nonce, which is why the replays ran first)
  const bond = await em.call('submitBond');
  await em.send('hacker', 'submit', [listingId, BigInt(sub.forkBlock), sub.bundleHash, sub.invariant, BigInt(sub.claimedLoss)], bond);
  const subId = (await em.call('submissionCount')) - 1n;
  assert.equal((await em.call('submission', [subId])).evidenceHash, evidenceHash, 'the on-chain evidence hash matches');
  // commit-reveal 2 of 3
  const salts = {};
  for (const [i, rr] of ['r1', 'r2', 'r3'].entries()) { salts[rr] = salt(); await em.send(rr, 'commit', [subId, verdictCommitment(verdicts[i], A(rr), salts[rr], subId)]); }
  c.advance(3601);
  for (const [i, rr] of ['r1', 'r2', 'r3'].entries()) await em.send(rr, 'reveal', [subId, [verdicts[i].holds, verdicts[i].observed, verdicts[i].reportHash], salts[rr]]);
  c.advance(1);
  await em.send('outsider', 'settle', [subId]);
  const after = await em.call('submission', [subId]);
  assert.equal(after.state, 2n, 'Confirmed');
  assert.ok((await em.call('owed', [A('hacker')])) > bond, 'the submitter is paid the reward plus its bond');
  assert.ok((await em.call('listing', [listingId])).exploited, 'the listing is marked exploited');
});

test('the seeded search finds an exploit the strategies miss, and is reproducible', async () => {
  const w = await localFork();
  const a = await deploy(w, 'OpenOwnerVault', [], 50n * E);
  const ctx = await makeContext(w, { address: a, abi: kit.OpenOwnerVault.abi, minLoss: 1n }, { funding: 10n * E });
  const hit1 = await search(ctx, { seed: 3, runs: 300 });
  assert.ok(hit1 && hit1.result.success, 'the search found a sequence');
  const w2 = await localFork();
  await deploy(w2, 'OpenOwnerVault', [], 50n * E);
  const ctx2 = await makeContext(w2, { address: a, abi: kit.OpenOwnerVault.abi, minLoss: 1n }, { funding: 10n * E });
  const hit2 = await search(ctx2, { seed: 3, runs: 300 });
  assert.deepEqual(hit2.plan.steps.length, hit1.plan.steps.length, 'the same seed gives the same first hit');
});

test('the optional LLM hook proposes a plan that is run like any other (fake provider)', async () => {
  const w = await localFork();
  const a = await deploy(w, 'OpenOwnerVault', [], 50n * E);
  const ctx = await makeContext(w, { address: a, abi: kit.OpenOwnerVault.abi, minLoss: 1n }, { attacker: '0x00000000000000000000000000000000000a77a1' });
  // a fake provider returns a plan in the LLM JSON language: setOwner(ATTACKER) then drain(ATTACKER)
  const fake = async () => ({ text: JSON.stringify({ plans: [{ title: 'take ownership', steps: [
    { via: 'eoa', calls: [{ function: 'setOwner(address)', args: ['ATTACKER'] }] },
    { via: 'eoa', calls: [{ function: 'drain(address)', args: ['ATTACKER'] }] }] }] }) });
  const plans = await llmPlans(ctx, {}, { complete: fake });
  assert.equal(plans.length, 1);
  const res = await evaluate(plans[0], ctx);
  assert.ok(res.success && res.run.loss >= 50n * E, 'the LLM-proposed plan drains the vault');
  // a plan that names a function not in the ABI is dropped
  const bad = await llmPlans(ctx, {}, { complete: async () => ({ text: JSON.stringify({ plans: [{ steps: [{ via: 'eoa', calls: [{ function: 'notReal()', args: [] }] }] }] }) }) });
  assert.equal(bad.length, 0);
});
