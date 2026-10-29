// Bug hunting in the browser: a small fuzzer for one contract in an in-memory EVM (EthereumJS, the
// EVM the contract tests use; the page loads the bundle vendor/evm.js, Node passes @ethereumjs/*).
// Shared by the page's Web Worker (work-worker.js), the runners' verifier (`zetaphy bounty verify`)
// and the tests, so a finding replays the same everywhere.
//
// A bounty SPEC (bounties/*.json; its keccak256 is the bounty's specHash on-chain) says:
//   initcode   the contract's creation code (deployed by `deployer`)
//   functions  [{ sig: 'withdraw(uint256)', payable?: true }] the calls a finding may make
//   setup      [{ from: 'victim', sig: 'deposit()', value: '5000…' }] what happens before the attacker
//   balances   { deployer, victim, attacker } starting ZETAPHY (wei, decimal strings)
//   invariant  'attacker-profit': a finding is valid when the attacker ends with at least
//              `minProfit` more than it started (gas costs nothing here, so this is exact)
// A FINDING is { v: 1, steps: [{ sig, args, value }] } sent by the attacker, as UTF-8 JSON bytes.

import { calldata, parseType, keccakHex } from './work-core.js';

export const FUZZ_VERSION = 1;
export const MAX_STEPS = 8;
export const ACTORS = {
  deployer: '0x00000000000000000000000000000000000d0d01',
  victim: '0x00000000000000000000000000000000000b1c71',
  attacker: '0x00000000000000000000000000000000000a77a1',
};
const MAX_U256 = (1n << 256n) - 1n;

/** keccak256 of a spec as stored (the exact file bytes): the bounty's specHash. */
export const specHash = (k, text) => keccakHex(k, new TextEncoder().encode(text));
/** A finding as the bytes revealed on-chain (canonical JSON). */
export const findingBytes = (finding) => new TextEncoder().encode(JSON.stringify(finding));
export const findingHash = (k, finding) => keccakHex(k, findingBytes(finding));
export function parseFinding(bytesOrText) {
  const text = typeof bytesOrText === 'string' ? bytesOrText : new TextDecoder().decode(bytesOrText);
  const f = JSON.parse(text);
  if (f?.v !== FUZZ_VERSION || !Array.isArray(f.steps) || f.steps.length === 0 || f.steps.length > MAX_STEPS) throw new Error('finding: bad shape');
  return f;
}

const argTypes = (sig) => {
  const inner = sig.slice(sig.indexOf('(') + 1, -1);
  return inner ? inner.split(',') : [];
};

/**
 * A world: the contract deployed and set up, with a checkpoint to go back to.
 * lib = { EVM, Common, Chain, Hardfork, Address, Account, hexToBytes, keccak256 }.
 */
export async function createWorld(lib, spec) {
  if (spec?.version !== FUZZ_VERSION || spec.invariant !== 'attacker-profit') throw new Error('spec: unsupported');
  const evm = await lib.EVM.create({ common: new lib.Common({ chain: lib.Chain.Mainnet, hardfork: lib.Hardfork.Cancun }) });
  const sm = evm.stateManager;
  const A = Object.fromEntries(Object.entries(ACTORS).map(([n, a]) => [n, lib.Address.fromString(a)]));
  for (const [n, a] of Object.entries(A)) await sm.putAccount(a, new lib.Account(0n, BigInt(spec.balances?.[n] ?? 0)));
  const dep = await evm.runCall({ caller: A.deployer, data: lib.hexToBytes(spec.initcode), gasLimit: 15_000_000n });
  if (dep.execResult.exceptionError || !dep.createdAddress) throw new Error('spec: the init code does not deploy');
  const target = dep.createdAddress;
  const call = async (from, sig, args, value = 0n) => {
    const r = await evm.runCall({ caller: from, to: target, data: lib.hexToBytes(calldata(lib.keccak256, sig, args)), value, gasLimit: 5_000_000n });
    return !r.execResult.exceptionError;
  };
  for (const s of spec.setup ?? []) {
    if (!(await call(A[s.from], s.sig, s.args ?? [], BigInt(s.value ?? 0)))) throw new Error(`spec: setup ${s.sig} failed`);
  }
  const balance = async (a) => (await sm.getAccount(a))?.balance ?? 0n;
  const world = {
    evm, sm, A, target, targetHex: target.toString(), call, balance,
    allowed: new Map((spec.functions ?? []).map((f) => [f.sig, f])),
    minProfit: BigInt(spec.minProfit ?? 1),
  };
  return world;
}

/** Runs a finding's steps from a fresh checkpoint; returns { valid, profit, ok: [per step] } and rolls back. */
export async function runSteps(world, steps) {
  const { sm, A } = world;
  await sm.checkpoint();
  try {
    const before = await world.balance(A.attacker);
    const ok = [];
    for (const s of steps) {
      const f = world.allowed.get(s.sig);
      if (!f) throw new Error(`finding: ${s.sig} is not in the spec`);
      const value = BigInt(s.value ?? 0);
      if (value > 0n && !f.payable) throw new Error(`finding: ${s.sig} is not payable`);
      const types = argTypes(s.sig);
      if (!Array.isArray(s.args) || s.args.length !== types.length) throw new Error(`finding: ${s.sig} wants ${types.length} arguments`);
      types.forEach((t) => parseType(t));
      ok.push(await world.call(A.attacker, s.sig, s.args, value));
    }
    const profit = (await world.balance(A.attacker)) - before;
    return { valid: profit >= world.minProfit, profit, ok };
  } finally {
    await sm.revert();
  }
}

/** The runners' check: does this finding (bytes or text) break the spec's invariant? */
export async function replay(lib, spec, finding) {
  const f = typeof finding === 'object' && !(finding instanceof Uint8Array) ? finding : parseFinding(finding);
  if (f.v !== FUZZ_VERSION || !Array.isArray(f.steps) || f.steps.length === 0 || f.steps.length > MAX_STEPS) throw new Error('finding: bad shape');
  const world = await createWorld(lib, spec);
  return runSteps(world, f.steps);
}

// ------------------------------------------------------------------ the fuzzer
/** xorshift32: a small seeded generator, so a run can be repeated. */
export function rng(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  return { next, int: (n) => next() % n, pick: (a) => a[next() % a.length] };
}

async function randomArg(r, t, world) {
  const ty = parseType(t);
  switch (ty.kind) {
    case 'address': return r.pick([ACTORS.attacker, ACTORS.attacker, ACTORS.victim, ACTORS.deployer, world.targetHex, `0x${'0'.repeat(40)}`]);
    case 'bool': return r.int(2) === 1;
    case 'bytesN': return `0x${(r.int(2) ? '00' : 'ff').repeat(ty.n)}`;
    case 'uint': case 'int': {
      const bal = await world.balance(world.target);
      const max = ty.bits === 256 ? MAX_U256 : (1n << BigInt(ty.bits)) - 1n;
      const v = r.pick([0n, 1n, 2n, 10n ** 18n, bal, bal / 2n, max, BigInt(r.next())]);
      return String(v > max ? max : v);
    }
    default: throw new Error(`fuzz: argument type ${t} is not fuzzed`);
  }
}

/** A random call sequence of 1..maxSteps steps over the spec's functions. */
export async function randomSteps(r, spec, world, maxSteps = 4) {
  const n = 1 + r.int(maxSteps);
  const steps = [];
  for (let i = 0; i < n; i++) {
    const f = r.pick(spec.functions);
    const args = [];
    for (const t of argTypes(f.sig)) args.push(await randomArg(r, t, world));
    const value = f.payable && r.int(3) === 0 ? String(r.pick([1n, 10n ** 17n])) : '0';
    steps.push({ sig: f.sig, args, value });
  }
  return steps;
}

/** Drops steps that are not needed (the finding stays valid). */
async function minimize(world, steps) {
  let cur = steps;
  for (let i = cur.length - 1; i >= 0 && cur.length > 1; i--) {
    const fewer = cur.filter((_, k) => k !== i);
    if ((await runSteps(world, fewer)).valid) cur = fewer;
  }
  return cur;
}

/**
 * Fuzzes until a finding, `runs` sequences, or `shouldStop()` says so.
 * Returns { finding: { v, steps } | null, profit, runs }. onProgress(runs) every 50 runs.
 */
export async function fuzz(lib, spec, { seed = 1, runs = 10_000, maxSteps = 4, shouldStop = () => false, onProgress = () => {} } = {}) {
  const world = await createWorld(lib, spec);
  const r = rng(seed);
  for (let i = 1; i <= runs; i++) {
    const steps = await randomSteps(r, spec, world, maxSteps);
    const res = await runSteps(world, steps);
    if (res.valid) {
      const min = await minimize(world, steps);
      const again = await runSteps(world, min);
      return { finding: { v: FUZZ_VERSION, steps: min }, profit: again.profit, runs: i };
    }
    if (i % 50 === 0) { onProgress(i); if (await shouldStop()) return { finding: null, profit: 0n, runs: i }; }
  }
  return { finding: null, profit: 0n, runs };
}
