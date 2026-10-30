// The self-healing demo on the in-memory chain (rpcchain.js): a vault with a reentrancy bug, opted in
// to CircuitBreaker, used by normal users (and a whale, and a smart-contract wallet), then drained by
// an attacker contract one block at a time. Run with self-healing OFF (breaker address 0) or ON
// (runner trips and/or the invariant cap). Used by test/selfheal-e2e.test.js and
// scripts/selfheal-demo.js. Testnet prototype; every key here is a throwaway test key.
import { ContractFactory, Contract, Interface, ZeroAddress, id as topicId, parseEther, formatEther } from 'ethers';
import { createRpcChain, ZETA } from './rpcchain.js';
import { selfHealKit } from './selfhealkit.js';
import { createPeer } from '../../src/selfheal/peers.js';
import { createSelfHealLoop, policyTuple, breakerAbi } from '../../src/selfheal/loop.js';
import { watchConfig } from '../../src/selfheal/detect.js';

export const SEL = { deposit: '0xd0e30db0', withdraw: '0x2e1a7d4d', withdrawAll: '0x853828b6' };
export const BIT = { deposit: 1, withdraw: 2, withdrawAll: 4 };

function rng(seed) {
  let s = BigInt(seed) || 1n;
  return () => { s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return Number(s >> 11n) / 2 ** 53; };
}

/**
 * Builds the world. o: { selfHealing (true), mode: 'runners' | 'invariant' | 'both', quorum (3), runners (5),
 *   colluders (0: runner peers that sign anything), cap (ZETA per window), window (s), seed }
 */
export async function setupWorld(o = {}) {
  const selfHealing = o.selfHealing ?? true;
  const mode = o.mode ?? 'runners';
  const nRunners = o.runners ?? 5;
  const chain = await createRpcChain({ accounts: 24 });
  const S = chain.signers;
  const gov = S[0];           // stands in for the ZetaphyTimelock (chain governance)
  const protoGov = S[1];      // the vault's own governance
  const attacker = S[2];
  const runnerSigners = S.slice(3, 3 + nRunners);
  const users = S.slice(10, 20);
  const whale = S[20];
  const kit = selfHealKit();
  const deployKit = async (name, args = [], signer = gov, value = 0n) => {
    const c = await new ContractFactory(kit[name].abi, kit[name].bytecode, signer).deploy(...args, { value });
    await c.waitForDeployment();
    return c;
  };

  const jobs = await chain.deploy('NeuroJobs', [ZETA, ZETA / 10n, ZETA / 100n, 120, 600, 3600, 1000n * ZETA]);
  const breaker = await chain.deploy('CircuitBreaker', [await jobs.getAddress(), gov.address, 10n * ZETA, 5n * ZETA, 3, 0]);
  const breakerAddr = await breaker.getAddress();
  for (const r of runnerSigners) {
    await (await jobs.connect(r).register({ value: ZETA })).wait();
    await (await breaker.connect(r).joinGuardians({ value: 10n * ZETA })).wait();
  }
  const vault = await deployKit('HealVault', [selfHealing ? breakerAddr : ZeroAddress]);
  const vaultAddr = await vault.getAddress();
  const cap = parseEther(String(o.cap ?? (mode === "runners" ? 100_000 : 2000)));
  const policy = {
    governance: protoGov.address, selectors: [SEL.deposit, SEL.withdraw, SEL.withdrawAll], assets: [ZeroAddress], caps: [cap],
    window: o.window ?? 600, maxPause: 6 * 3600, quorum: o.quorum ?? 3, invariantMask: o.invariantMask ?? BIT.withdrawAll,
    tripCapBps: 1000, holdAbove: parseEther('50'), holdReview: 3600,
  };
  if (selfHealing) {
    const data = new Interface(breakerAbi()).encodeFunctionData('register', [policyTuple(policy)]);
    await (await vault.optIn(data)).wait();
  }
  const vaultIface = new Interface(kit.HealVault.abi);
  const watch = watchConfig({
    address: vaultAddr, selectors: policy.selectors,
    outflowEvents: [
      { topic0: vaultIface.getEvent('Withdrawn').topicHash, toTopic: 1, amountWord: 0, selector: SEL.withdraw },
      { topic0: vaultIface.getEvent('WithdrawnAll').topicHash, toTopic: 1, amountWord: 0, selector: SEL.withdrawAll },
    ],
    thresholds: { minVolume: parseEther('50'), lookback: 40 },
  });
  const configs = { [vaultAddr]: watch };
  const colluders = o.colluders ?? 0;
  const peers = runnerSigners.map((w, i) => createPeer({ wallet: w, provider: chain.provider, breaker: breakerAddr, configs, behavior: i < colluders ? 'colluding' : 'honest' }));
  const useRunners = selfHealing && mode !== 'invariant';
  const loop = useRunners ? createSelfHealLoop({ provider: chain.provider, breaker: breakerAddr, submitter: runnerSigners[nRunners - 1], peers, protocols: [watch], log: o.log }) : null;
  return { chain, S, gov, protoGov, attacker, runnerSigners, users, whale, jobs, breaker, breakerAddr, vault, vaultAddr, policy, watch, peers, loop, deployKit, kit };
}

/** Normal traffic: deposits and withdrawals of 1-20 ZETA, a smart wallet, and a whale's large withdrawal now and then. */
export async function benign(w, blocks, { seed = 7, onBlock = async () => {} } = {}) {
  const r = rng(seed);
  const wallet = w.smart ??= await w.deployKit('HealSmartWallet', [w.vaultAddr]);
  if (!w.seeded) {
    w.seeded = true;
    for (const u of w.users) await (await w.vault.connect(u).deposit({ value: parseEther(String(100 + Math.floor(r() * 200))) })).wait();
    await (await w.vault.connect(w.whale).deposit({ value: parseEther('1500') })).wait();
    await (await wallet.save({ value: parseEther('200') })).wait();
  }
  let failed = 0;
  for (let i = 0; i < blocks; i++) {
    const x = r();
    const u = w.users[Math.floor(r() * w.users.length)];
    const amt = parseEther(String(1 + Math.floor(r() * 20)));
    let tx;
    try {
      if (x < 0.45) tx = await w.vault.connect(u).deposit({ value: amt });
      else if (x < 0.85) tx = await w.vault.connect(u).withdraw(amt);
      else if (x < 0.95) tx = await wallet.take(parseEther(String(1 + Math.floor(r() * 10))));
      else if (x < 0.98) tx = await w.vault.connect(w.whale).withdraw(parseEther('120'));
      else tx = await w.vault.connect(w.whale).deposit({ value: parseEther('120') });
      await tx.wait();
    } catch { failed += 1; w.chain.mine(1); }
    await onBlock(i);
  }
  return { failed };
}

/**
 * The attack: the attacker deploys HealAttacker and calls attack(depth) once per block (10 ZETA each,
 * paid back depth+1 times), with a normal user's tx in between, for `attempts` blocks or until
 * the vault is empty. The loop (if any) ticks after every block.
 */
export async function attack(w, { attempts = 12, depth = 9, stake = 10n * ZETA, tick = async () => {} } = {}) {
  const atk = await w.deployKit('HealAttacker', [w.vaultAddr], w.attacker);
  const atkAddr = await atk.getAddress();
  const before = await w.chain.provider.getBalance(w.vaultAddr);
  let firstAttackBlock = null; let lastOk = null; let ok = 0; let reverted = 0;
  const honest = { ok: 0, failed: 0 };
  for (let i = 0; i < attempts; i++) {
    if ((await w.chain.provider.getBalance(w.vaultAddr)) < stake) break;
    try {
      const tx = await atk.attack(depth, { value: stake, gasLimit: 6_000_000n });
      const rc = await tx.wait();
      if (rc.status === 1) { ok += 1; lastOk = rc.blockNumber; firstAttackBlock ??= rc.blockNumber; } else reverted += 1;
    } catch { reverted += 1; firstAttackBlock ??= Number(w.chain.blockNumber()); }
    await tick();
    // an honest user keeps using the vault (narrow pause: withdraw() is not paused by a runner trip)
    try { await (await w.vault.connect(w.users[i % w.users.length]).withdraw(parseEther('2'))).wait(); honest.ok += 1; } catch { honest.failed += 1; w.chain.mine(1); }
    await tick();
  }
  const after = await w.chain.provider.getBalance(w.vaultAddr);
  const stolen = (await w.chain.provider.getBalance(atkAddr)) ; // what the attacker contract holds (stakes included)
  const invested = stake * BigInt(ok);
  return { atk, atkAddr, before, after, stolen, profit: stolen - invested, ok, reverted, firstAttackBlock, lastOk, honest };
}

/** One full run with numbers. */
export async function runDemo(o = {}) {
  const w = await setupWorld(o);
  const benignBlocks = o.benignBlocks ?? 80;
  if (w.loop) await w.loop.tick(); // start reading at the current head
  const b = await benign(w, benignBlocks, { seed: o.seed ?? 7, onBlock: async () => { if (w.loop) await w.loop.tick(); } });
  const falseTrips = Number(await w.breaker.tripCount()); // any trip (runners or invariant) during the benign phase is a false positive
  const benignAnomalies = w.loop ? w.loop.stats.anomalies.length : 0;
  const evaluatedBenign = w.loop ? w.loop.stats.evaluated : 0;
  const benignOutliers = w.loop ? w.loop.stats.outliers.length : 0;
  const a = await attack(w, { attempts: o.attempts ?? 60, tick: async () => { if (w.loop) await w.loop.tick(); } });
  let tripBlock = null; let tripKind = null;
  const n = Number(await w.breaker.tripCount());
  if (n > 0) {
    const t = await w.breaker.tripOf(n - 1);
    tripKind = Number(t.kind) === 0 ? 'runners' : 'invariant';
    tripBlock = w.loop?.stats.trips.at(-1)?.tripBlock ?? Number(t.toBlock);
  }
  return {
    w, benign: b, attack: a, falseTrips, benignAnomalies, benignOutliers, evaluatedBenign, tripKind, tripBlock,
    latencyBlocks: tripBlock != null && a.firstAttackBlock != null ? tripBlock - a.firstAttackBlock : null,
    lossZeta: Number(formatEther(a.profit > 0n ? a.profit : 0n)),
    vaultBeforeZeta: Number(formatEther(a.before)),
    heldCount: Number(await w.vault.heldCount()),
  };
}

export { ZETA, Contract };
