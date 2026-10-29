// Bug hunting in the browser: a coverage-guided fuzzer for one contract in an in-memory EVM (EthereumJS,
// the EVM the contract tests use; the page loads the bundle vendor/evm.js, Node passes @ethereumjs/*).
// Shared by the page's Web Worker (work-worker.js), the runners' verifier (`zetaphy bounty check`,
// `zetaphy work verify-finding`), the research CLI (`zetaphy work fuzz`) and the tests, so a finding
// replays the same everywhere.
//
// How it searches (deterministic for a seed: the same seed, spec and options give the same run):
//   - stateful call sequences (1..MAX_STEPS calls) by the attacker, directly or through the attacker's
//     own contract (FuzzHook, fuzz-hook.js), which can re-enter the target from its receive/fallback;
//   - coverage: every JUMP/JUMPI edge executed in the target is recorded (EVM `step` events); a sequence
//     that reaches a new edge joins the corpus, and most new sequences are mutations of corpus entries
//     (change an argument or value, insert / drop / swap / repeat a step, splice two entries, route a
//     step through the hook, arm a re-entry);
//   - arguments from a dictionary: the actors, the hook and the target, edge numbers, the target's
//     balance, the numbers the spec's setup uses and the constants PUSHed by the target's own code;
//   - every sequence is checked against the spec's invariants (below); a violation is shrunk to the
//     fewest, simplest steps that still break the same invariant;
//   - the corpus can be minimised (greedy set cover of the edges) and exported, and resumed from.
//
// A bounty SPEC (bounties/*.json; its keccak256 is the bounty's specHash on-chain):
//   version     1 (original: one invariant, `invariant: 'attacker-profit'`) or 2
//   initcode    the contract's creation code (deployed by `deployer`)
//   functions   [{ sig: 'withdraw(uint256)', payable?: true }] the calls a finding may make
//   setup       [{ from: 'victim', sig: 'deposit()', args?, value? }] what happens before the attacker;
//               an argument 'victim' | 'attacker' | 'deployer' | 'target' stands for that address
//   balances    { deployer, victim, attacker } starting ZETAPHY (wei, decimal strings)
//   invariants  (v2) any of INVARIANTS; a finding is valid when the replay breaks at least one:
//     attacker-profit              the attacker (+ its hook) ends with >= minProfit more coins
//     victim-can-exit              after the attack the victim runs `exit` and gets >= exitMin back
//     balance-conservation         the target's coins >= sum of `solvency(actor)` over the actors
//     privileged-unchanged         every `watch` view (e.g. owner()) returns what it did before
//     no-selfdestruct              the target never runs SELFDESTRUCT
//     no-delegatecall-to-attacker  the target never DELEGATECALLs / CALLCODEs the attacker or its hook
//     token-drain                  for each of `tokens` ('target' or 0x…): the attacker (+ hook) gains
//                                  >= minTokenProfit, or the victim loses any
//   hook        (v2, default true) the attacker may use FuzzHook (reentrancy)
// A FINDING is { v: 1|2, steps: [{ sig, args, value, via?: 'hook', reenter?: { sig, args, value, times } }] }
// sent by the attacker, as UTF-8 JSON bytes (v1: no via / reenter).

import { calldata, parseType, keccakHex, toHex, fromHex } from './work-core.js';
import { HOOK_INITCODE } from './fuzz-hook.js';

export const FUZZ_VERSION = 2;
export const MAX_STEPS = 8;
export const MAX_REENTER = 16;
export const ACTORS = {
  deployer: '0x00000000000000000000000000000000000d0d01',
  victim: '0x00000000000000000000000000000000000b1c71',
  attacker: '0x00000000000000000000000000000000000a77a1',
};
export const INVARIANTS = ['attacker-profit', 'victim-can-exit', 'balance-conservation', 'privileged-unchanged', 'no-selfdestruct', 'no-delegatecall-to-attacker', 'token-drain'];
/** The fixed block every call runs in (a pinned environment: replays do not depend on the clock). */
export const BLOCK = { number: 1_000_000n, timestamp: 1_800_000_000n };
const MAX_U256 = (1n << 256n) - 1n;
const HOOK_GO = 'go(address,bytes,uint256)';
const HOOK_ARM = 'arm(address,bytes,uint256,uint256)';

/** keccak256 of a spec as stored (the exact file bytes): the bounty's specHash. */
export const specHash = (k, text) => keccakHex(k, new TextEncoder().encode(text));
/** A finding as the bytes revealed on-chain (canonical JSON). */
export const findingBytes = (finding) => new TextEncoder().encode(JSON.stringify(finding));
export const findingHash = (k, finding) => keccakHex(k, findingBytes(finding));

function checkFinding(f) {
  if ((f?.v !== 1 && f?.v !== 2) || !Array.isArray(f.steps) || f.steps.length === 0 || f.steps.length > MAX_STEPS) throw new Error('finding: bad shape');
  for (const s of f.steps) {
    if (typeof s?.sig !== 'string') throw new Error('finding: bad shape');
    if (f.v === 1 && (s.via || s.reenter)) throw new Error('finding: v1 steps have no via / reenter');
    if (s.via != null && s.via !== 'hook') throw new Error('finding: via must be "hook"');
    if (s.reenter != null) {
      if (s.via !== 'hook') throw new Error('finding: reenter needs via "hook"');
      const t = Number(s.reenter.times);
      if (!Number.isInteger(t) || t < 1 || t > MAX_REENTER || typeof s.reenter.sig !== 'string') throw new Error('finding: bad reenter');
    }
  }
  return f;
}
export function parseFinding(bytesOrText) {
  const text = typeof bytesOrText === 'string' ? bytesOrText : new TextDecoder().decode(bytesOrText);
  return checkFinding(JSON.parse(text));
}

const argTypes = (sig) => {
  const inner = sig.slice(sig.indexOf('(') + 1, -1);
  if (!inner) return [];
  const out = []; let depth = 0, cur = '';
  for (const ch of inner) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out;
};
const invariantsOf = (spec) => (spec.version === 1 ? ['attacker-profit'] : (spec.invariants ?? ['attacker-profit']));
const big = (h) => (h && h !== '0x' ? BigInt(h.length > 66 ? h.slice(0, 66) : h) : 0n);

/** Constants PUSHed by runtime code (PUSH1..PUSH32), skipping tiny ones: the code's own magic numbers. */
export function codeConstants(code, max = 48) {
  const out = new Set();
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const bytes = code.subarray(i + 1, i + 1 + n);
      i += n;
      if (n === 4 || n === 20) continue; // selectors and addresses are not interesting numbers
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      if (v > 16n && v < MAX_U256 - 16n) out.add(v);
      if (out.size >= max) break;
    }
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/** JUMPDEST offsets of runtime code (not inside PUSH data). */
export function jumpdests(code) {
  const out = [];
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op === 0x5b) out.push(i);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return out;
}

/** keccak256 remembered for short inputs (the function signatures hashed for every call's selector). */
function memoKeccak(k) {
  const memo = new Map();
  return (bytes) => {
    if (bytes.length > 96) return k(bytes);
    const key = String.fromCharCode(...bytes);
    let h = memo.get(key);
    if (!h) { h = k(bytes); memo.set(key, h); }
    return h;
  };
}

/**
 * A world: the contract deployed and set up, the hook deployed, a checkpoint to go back to.
 * lib = { EVM, Common, Chain, Hardfork, Address, Account, hexToBytes, keccak256 }.
 */
export async function createWorld(lib, spec) {
  if (spec?.version === 1) { if (spec.invariant !== 'attacker-profit') throw new Error('spec: unsupported'); }
  else if (spec?.version !== 2) throw new Error('spec: unsupported');
  for (const inv of invariantsOf(spec)) if (!INVARIANTS.includes(inv)) throw new Error(`spec: unknown invariant ${inv}`);
  const evm = await lib.EVM.create({ common: new lib.Common({ chain: lib.Chain.Mainnet, hardfork: lib.Hardfork.Cancun }) });
  const sm = evm.stateManager;
  const zero = lib.Address.fromString(`0x${'00'.repeat(20)}`);
  const block = { header: { number: BLOCK.number, timestamp: BLOCK.timestamp, coinbase: zero, difficulty: 0n, prevRandao: new Uint8Array(32), gasLimit: 30_000_000n, baseFeePerGas: 0n, getBlobGasPrice: () => 0n } };
  const A = Object.fromEntries(Object.entries(ACTORS).map(([n, a]) => [n, lib.Address.fromString(a)]));
  for (const [n, a] of Object.entries(A)) await sm.putAccount(a, new lib.Account(0n, BigInt(spec.balances?.[n] ?? 0)));
  const run = (caller, to, data, value = 0n) => evm.runCall({ caller, to, data: lib.hexToBytes(data), value, gasLimit: 10_000_000n, block });
  const dep = await run(A.deployer, undefined, spec.initcode);
  if (dep.execResult.exceptionError || !dep.createdAddress) throw new Error('spec: the init code does not deploy');
  const target = dep.createdAddress;
  const targetHex = target.toString().toLowerCase();
  const useHook = spec.version === 2 && spec.hook !== false;
  let hook = null;
  if (useHook) {
    const h = await run(A.attacker, undefined, HOOK_INITCODE);
    if (h.execResult.exceptionError || !h.createdAddress) throw new Error('fuzz: the hook does not deploy');
    hook = h.createdAddress;
  }
  const hookHex = hook ? hook.toString().toLowerCase() : null;
  const names = { victim: ACTORS.victim, attacker: ACTORS.attacker, deployer: ACTORS.deployer, target: targetHex, ...(hookHex ? { hook: hookHex } : {}) };
  const resolve = (a) => (typeof a === 'string' && names[a] ? names[a] : a);
  const k = memoKeccak(lib.keccak256);
  const call = async (from, sig, args, value = 0n, to = target) => {
    const r = await run(from, to, calldata(k, sig, args.map(resolve)), value);
    return { ok: !r.execResult.exceptionError, ret: toHex(r.execResult.returnValue) };
  };
  for (const s of spec.setup ?? []) {
    if (!(await call(A[s.from], s.sig, s.args ?? [], BigInt(s.value ?? 0))).ok) throw new Error(`spec: setup ${s.sig} failed`);
  }
  const balance = async (a) => (await sm.getAccount(a))?.balance ?? 0n;
  const view = async (sig, args = []) => (await call(A.deployer, sig, args)).ret;
  const tokens = (spec.tokens ?? []).map((t) => (t === 'target' ? target : lib.Address.fromString(t)));
  const code = await sm.getContractCode(target);

  // ---- tracing: one `step` listener, active only while a sequence runs
  const attackerBig = BigInt(ACTORS.attacker);
  const hookBig = hook ? BigInt(hookHex) : -1n;
  // (the listener is attached only while an attack sequence runs: the EVM skips step events without one)
  let trace = null;
  const onStep = (ev, next) => {
    try {
      const t = trace;
      const op = ev.opcode.name;
      // the target's own code (a DELEGATECALL from it runs other code in its context)
      const isT = (ev.codeAddress ?? ev.address).equals(target);
      const d = ev.depth;
      // frames: is the target's code running at each depth? (reentrancy = entered while it still runs)
      if (t.frames.length > d + 1) t.frames.length = d + 1;
      if (t.frames[d] !== isT) {
        if (isT && t.frames.slice(0, d).includes(true)) t.reentered = true;
        t.frames[d] = isT;
        t.last[d] = null;
      }
      if (op === 'SELFDESTRUCT' && ev.address.equals(target)) t.selfdestruct = true; // in its context, whoever's code
      else if (op === 'SSTORE' && ev.address.equals(target)) t.wrote = true;
      // a callback: the hook's code runs while the target is running below it (where reentrancy starts)
      if (!isT && hook && t.frames.slice(0, d).includes(true) && (ev.codeAddress ?? ev.address).equals(hook)) t.callback = true;
      if (isT) {
        const prev = t.last[d];
        if (prev != null && (prev.op === 'JUMP' || prev.op === 'JUMPI')) t.edges.add(`${prev.pc}>${ev.pc}`);
        if (op === 'DELEGATECALL' || op === 'CALLCODE') {
          const to = BigInt(ev.stack[ev.stack.length - 2]) & ((1n << 160n) - 1n);
          if (to === attackerBig || to === hookBig) t.delegate = true;
        }
        t.last[d] = { pc: ev.pc, op };
      } else t.last[d] = null;
    } finally {
      if (typeof next === 'function') next();
    }
  };
  const begin = () => { trace = { frames: [], last: [], edges: new Set(), reentered: false, selfdestruct: false, delegate: false, callback: false }; evm.events.on('step', onStep); return trace; };
  const end = () => { evm.events.removeListener('step', onStep); const t = trace; trace = null; return t; };

  const dict = {
    numbers: [...new Set([0n, 1n, 2n, 3n, 10n, 100n, 10n ** 17n, 10n ** 18n, 5n * 10n ** 18n, 10n ** 21n, MAX_U256, MAX_U256 - 1n, 1n << 255n,
      ...(spec.setup ?? []).flatMap((s) => [s.value, ...(s.args ?? [])]).filter((x) => /^\d+$/.test(String(x ?? ''))).map(BigInt),
      ...codeConstants(code)])],
    addresses: [ACTORS.attacker, ...(hookHex ? [hookHex] : []), ACTORS.victim, ACTORS.deployer, targetHex, `0x${'00'.repeat(20)}`],
    selectors: [...(spec.functions ?? []).map((f) => f.sig), HOOK_GO, HOOK_ARM].map((s) => calldata(k, s, argTypes(s).map(zeroOf))),
  };
  return {
    evm, sm, A, lib, k, spec, target, targetHex, hook, hookHex, call, run, balance, view, tokens, code, dict, begin, end,
    allowed: new Map((spec.functions ?? []).map((f) => [f.sig, f])),
    invariants: invariantsOf(spec),
    minProfit: BigInt(spec.minProfit ?? 1),
    jumpdests: jumpdests(code),
  };
}

function zeroOf(t) {
  const ty = parseType(t);
  switch (ty.kind) {
    case 'address': return `0x${'00'.repeat(20)}`;
    case 'bool': return false;
    case 'bytesN': return `0x${'00'.repeat(ty.n)}`;
    case 'bytes': return '0x';
    case 'string': return '';
    case 'array': return [];
    case 'tuple': return ty.of.map(() => 0n);
    default: return 0n;
  }
}

function checkStep(world, s) {
  const f = world.allowed.get(s.sig);
  if (!f) throw new Error(`finding: ${s.sig} is not in the spec`);
  const value = BigInt(s.value ?? 0);
  if (value > 0n && !f.payable) throw new Error(`finding: ${s.sig} is not payable`);
  const types = argTypes(s.sig);
  if (!Array.isArray(s.args) || s.args.length !== types.length) throw new Error(`finding: ${s.sig} wants ${types.length} arguments`);
  types.forEach((t) => parseType(t));
  if ((s.via || s.reenter) && !world.hook) throw new Error('finding: this spec has no hook');
  if (s.reenter) {
    const r = world.allowed.get(s.reenter.sig);
    if (!r) throw new Error(`finding: ${s.reenter.sig} is not in the spec`);
    if (BigInt(s.reenter.value ?? 0) > 0n && !r.payable) throw new Error(`finding: ${s.reenter.sig} is not payable`);
    if (!Array.isArray(s.reenter.args) || s.reenter.args.length !== argTypes(s.reenter.sig).length) throw new Error(`finding: ${s.reenter.sig} wants ${argTypes(s.reenter.sig).length} arguments`);
  }
  return value;
}

/** One attacker step: direct, or through the hook (optionally armed to re-enter). Returns ok. */
async function doStep(world, s) {
  const value = checkStep(world, s);
  const { A } = world;
  if (!s.via) return (await world.call(A.attacker, s.sig, s.args, value)).ok;
  const k = world.k;
  if (s.reenter) {
    const re = calldata(k, s.reenter.sig, s.reenter.args);
    const armed = await world.call(A.attacker, HOOK_ARM, [world.targetHex, re, BigInt(s.reenter.value ?? 0), BigInt(s.reenter.times)], 0n, world.hook);
    if (!armed.ok) return false;
  }
  const data = calldata(k, s.sig, s.args);
  const r = await world.call(A.attacker, HOOK_GO, [world.targetHex, data, value], value, world.hook);
  if (s.reenter) await world.call(A.attacker, HOOK_ARM, [world.targetHex, '0x', 0n, 0n], 0n, world.hook); // disarm
  return r.ok;
}

async function attackerWealth(world) {
  return (await world.balance(world.A.attacker)) + (world.hook ? await world.balance(world.hook) : 0n);
}
async function tokenOf(world, token, who) {
  const r = await world.call(world.A.deployer, 'balanceOf(address)', [who], 0n, token);
  return r.ok ? big(r.ret) : 0n;
}
const ACTOR_LIST = (w) => [ACTORS.victim, ACTORS.attacker, ACTORS.deployer, ...(w.hookHex ? [w.hookHex] : [])];

async function baseline(world, inv) {
  const before = await attackerWealth(world);
  const watched = inv.has('privileged-unchanged') ? await Promise.all((world.spec.watch ?? []).map((s) => world.view(s))) : [];
  const tokBefore = [];
  if (inv.has('token-drain')) {
    for (const t of world.tokens) tokBefore.push({ att: (await tokenOf(world, t, ACTORS.attacker)) + (world.hookHex ? await tokenOf(world, t, world.hookHex) : 0n), vic: await tokenOf(world, t, ACTORS.victim) });
  }
  return { before, watched, tokBefore, targetWei: await world.balance(world.target) };
}

/**
 * Runs a sequence of attacker steps from the checkpoint, checks the invariants, rolls back.
 * Returns { valid, profit, ok: [per step], violations: [{ kind, detail }], kinds, reentered, edges }.
 */
export async function runSteps(world, steps) {
  const { sm, A } = world;
  const inv = new Set(world.invariants);
  await sm.checkpoint();
  try {
    // every sequence starts from the same checkpoint, so what it is compared with is read once per world
    world.base ??= await baseline(world, inv);
    const { before, watched, tokBefore } = world.base;
    const tr = world.begin();
    const ok = [];
    const cb = [];
    try {
      for (const [i, s] of steps.entries()) {
        tr.callback = false;
        ok.push(await doStep(world, s));
        // a step that made the target call back into the hook is new behaviour (a pseudo-edge) and a re-entry candidate
        if (tr.callback) { tr.edges.add(`cb:${s.sig}`); cb.push(i); }
      }
    } finally { world.end(); }
    const violations = [];
    // every step reverted: nothing changed but the attacker's nonce, so no invariant can be broken
    if (!ok.some(Boolean) && !tr.selfdestruct && !tr.delegate) return { valid: false, profit: 0n, ok, violations, kinds: [], reentered: tr.reentered, edges: tr.edges, cb };
    const profit = (await attackerWealth(world)) - before;
    // the other invariants read the target's state: when it neither wrote storage nor moved coins (and the
    // tokens are its own), they hold as at the start, so they are not read again
    const touched = tr.wrote || tr.selfdestruct || (await world.balance(world.target)) !== world.base.targetWei || world.tokens.some((t) => !t.equals(world.target));
    if (inv.has('attacker-profit') && profit >= world.minProfit) violations.push({ kind: 'attacker-profit', detail: `attacker gains ${profit} wei` });
    if (inv.has('no-selfdestruct') && tr.selfdestruct) violations.push({ kind: 'no-selfdestruct', detail: 'the target ran SELFDESTRUCT' });
    if (inv.has('no-delegatecall-to-attacker') && tr.delegate) violations.push({ kind: 'no-delegatecall-to-attacker', detail: 'the target delegatecalled attacker code' });
    if (touched && inv.has('privileged-unchanged')) {
      const now = await Promise.all((world.spec.watch ?? []).map((s) => world.view(s)));
      (world.spec.watch ?? []).forEach((s, i) => { if (now[i] !== watched[i]) violations.push({ kind: 'privileged-unchanged', detail: `${s}: ${watched[i]} -> ${now[i]}` }); });
    }
    if (touched && inv.has('token-drain')) {
      for (const [i, t] of world.tokens.entries()) {
        const att = (await tokenOf(world, t, ACTORS.attacker)) + (world.hookHex ? await tokenOf(world, t, world.hookHex) : 0n);
        const vic = await tokenOf(world, t, ACTORS.victim);
        const gain = att - tokBefore[i].att;
        if (gain >= BigInt(world.spec.minTokenProfit ?? 1)) violations.push({ kind: 'token-drain', detail: `attacker gains ${gain} token units of ${t.toString()}` });
        else if (vic < tokBefore[i].vic) violations.push({ kind: 'token-drain', detail: `victim loses ${tokBefore[i].vic - vic} token units of ${t.toString()}` });
      }
    }
    if (touched && inv.has('balance-conservation') && world.spec.solvency) {
      let owed = 0n;
      for (const a of ACTOR_LIST(world)) owed += big(await world.view(world.spec.solvency, [a]));
      const held = await world.balance(world.target);
      if (held < owed) violations.push({ kind: 'balance-conservation', detail: `the target holds ${held} wei but owes ${owed}` });
    }
    if (touched && inv.has('victim-can-exit') && world.spec.exit?.length) {
      const vb = await world.balance(A.victim);
      let exitOk = true;
      for (const e of world.spec.exit) exitOk = (await world.call(A.victim, e.sig, e.args ?? [], BigInt(e.value ?? 0))).ok && exitOk;
      const got = (await world.balance(A.victim)) - vb;
      if (!exitOk || got < BigInt(world.spec.exitMin ?? 0)) violations.push({ kind: 'victim-can-exit', detail: exitOk ? `the victim gets ${got} wei back` : 'the victim cannot withdraw' });
    }
    if (violations.length && tr.reentered) violations.push({ kind: 'reentrancy', detail: 'the target was re-entered during the attack' });
    const kinds = [...new Set(violations.map((v) => v.kind))];
    return { valid: violations.some((v) => v.kind !== 'reentrancy'), profit, ok, violations, kinds, reentered: tr.reentered, edges: tr.edges, cb };
  } finally {
    await sm.revert();
  }
}

/** The runners' check: does this finding (bytes, text or object) break one of the spec's invariants? */
export async function replay(lib, spec, finding) {
  const f = typeof finding === 'object' && !(finding instanceof Uint8Array) ? checkFinding(finding) : parseFinding(finding);
  if (spec.version === 1 && f.v !== 1) throw new Error('finding: a v1 spec takes v1 findings');
  const world = await createWorld(lib, spec);
  const r = await runSteps(world, f.steps);
  return { valid: r.valid, profit: r.profit, ok: r.ok, violations: r.violations, kinds: r.kinds, reentered: r.reentered };
}

// ------------------------------------------------------------------ the fuzzer
/** xorshift32: a small seeded generator, so a run can be repeated. */
export function rng(seed) {
  let x = (Number(seed) >>> 0) || 0x9e3779b9;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  return { next, int: (n) => next() % n, pick: (a) => a[next() % a.length], chance: (p) => next() / 0x100000000 < p };
}

async function randomArg(r, t, world, depth = 0) {
  const ty = parseType(t);
  const { dict } = world;
  switch (ty.kind) {
    case 'address': return r.chance(0.4) ? ACTORS.attacker : r.pick(dict.addresses);
    case 'bool': return r.int(2) === 1;
    case 'bytesN': return toHex(Uint8Array.from({ length: ty.n }, () => (r.chance(0.5) ? 0 : r.chance(0.5) ? 0xff : r.int(256))));
    case 'bytes': {
      const c = r.int(4);
      if (c === 0) return '0x';
      if (c === 1) return r.pick(dict.selectors);
      return toHex(Uint8Array.from({ length: r.pick([4, 32, 36]) }, () => r.int(256)));
    }
    case 'string': return r.pick(['', 'a', 'x'.repeat(40)]);
    case 'array': return depth > 1 ? [] : Promise.all(Array.from({ length: r.int(4) }, () => randomArg(r, t.slice(0, -2), world, depth + 1)));
    case 'tuple': return Promise.all(ty.of.map((_, i) => randomArg(r, t.slice(1, -1).split(',')[i], world, depth + 1)));
    case 'uint': case 'int': {
      const max = ty.bits === 256 ? MAX_U256 : (1n << BigInt(ty.bits)) - 1n;
      let v;
      const c = r.int(10);
      if (c < 6) v = r.pick(dict.numbers);
      else if (c < 8) { const bal = await world.balance(world.target); v = r.pick([bal, bal / 2n, bal + 1n]); }
      else v = BigInt(r.next()) * (r.chance(0.5) ? 1n : 10n ** 12n);
      return String(v > max ? max : v);
    }
    default: throw new Error(`fuzz: argument type ${t} is not fuzzed`);
  }
}

const VALUES = [1n, 10n ** 17n, 10n ** 18n, 2n * 10n ** 18n];
async function randomCall(r, world) {
  const f = r.pick(world.spec.functions);
  const args = [];
  for (const t of argTypes(f.sig)) args.push(await randomArg(r, t, world));
  const value = f.payable && r.chance(0.5) ? String(r.pick(VALUES)) : '0';
  return { sig: f.sig, args, value };
}
async function randomStep(r, world) {
  const s = await randomCall(r, world);
  if (world.hook && r.chance(0.3)) {
    s.via = 'hook';
    if (r.chance(0.5)) { const re = await randomCall(r, world); s.reenter = { sig: re.sig, args: re.args, value: re.value, times: r.pick([1, 2, 3, 5, 8]) }; }
  }
  return s;
}
/** A random call sequence of 1..maxSteps steps over the spec's functions. */
export async function randomSteps(r, spec, world, maxSteps = 4) {
  const n = 1 + r.int(maxSteps);
  const steps = [];
  for (let i = 0; i < n; i++) steps.push(await randomStep(r, world));
  return steps;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
/** One mutation of a corpus sequence (see the header). */
export async function mutateSteps(r, world, entry, corpus, maxSteps) {
  let s = clone(entry.steps);
  const cb0 = entry.cb ?? [];
  const n = 1 + r.int(3);
  for (let m = 0; m < n; m++) {
    const cbs = cb0.filter((i) => i < s.length);
    // steps that called back into the hook get a re-entry armed more often
    const op = cbs.length && r.chance(0.3) ? 8 : r.int(9);
    const i = op === 8 && cbs.length && r.chance(0.8) ? r.pick(cbs) : r.int(s.length);
    if (op === 0 && s[i].args.length) { const types = argTypes(s[i].sig); const j = r.int(types.length); s[i].args[j] = await randomArg(r, types[j], world); }
    else if (op === 1 && world.allowed.get(s[i].sig)?.payable) s[i].value = String(r.chance(0.3) ? 0n : r.pick(VALUES));
    else if (op === 2 && s.length < maxSteps) s.splice(r.int(s.length + 1), 0, await randomStep(r, world));
    else if (op === 3 && s.length > 1) s.splice(i, 1);
    else if (op === 4 && s.length > 1) { const j = r.int(s.length); [s[i], s[j]] = [s[j], s[i]]; }
    else if (op === 5 && s.length < maxSteps) s.splice(i, 0, clone(s[i]));
    else if (op === 6 && corpus.length) { const o = r.pick(corpus).steps; s = [...s.slice(0, 1 + r.int(s.length)), ...clone(o.slice(r.int(o.length)))].slice(0, maxSteps); }
    else if (op === 7 && world.hook) { if (s[i].via) { delete s[i].via; delete s[i].reenter; } else s[i].via = 'hook'; }
    else if (op === 8 && world.hook) {
      s[i].via = 'hook';
      if (s[i].reenter && r.chance(0.5)) s[i].reenter.times = r.pick([1, 2, 3, 5, 8, 12]);
      else if (cbs.includes(i) && r.chance(0.5)) s[i].reenter = { sig: s[i].sig, args: clone(s[i].args), value: '0', times: r.pick([1, 2, 3, 5, 8]) }; // the same function again
      else { const re = await randomCall(r, world); s[i].reenter = { sig: re.sig, args: re.args, value: re.value, times: r.pick([1, 2, 3, 5, 8]) }; }
    } else s[i] = await randomStep(r, world);
  }
  return s;
}

const breaks = (res, kind) => res.kinds.includes(kind);
/** Shrinks a violating sequence: fewer steps, fewer re-entries, smaller values, direct calls; same violation kind. */
export async function minimize(world, steps, kind) {
  let cur = clone(steps);
  const still = async (cand) => breaks(await runSteps(world, cand), kind);
  for (let i = cur.length - 1; i >= 0 && cur.length > 1; i--) {
    const fewer = cur.filter((_, j) => j !== i);
    if (await still(fewer)) cur = fewer;
  }
  // all steps direct at once (the attacker contract may hold a role the next step needs)
  if (cur.some((s) => s.via)) {
    const direct = cur.map((s) => { const c = clone(s); delete c.via; delete c.reenter; return c; });
    if (await still(direct)) cur = direct;
  }
  for (let i = 0; i < cur.length; i++) {
    const s = cur[i];
    if (s.via) {
      const direct = clone(cur); delete direct[i].via; delete direct[i].reenter;
      if (await still(direct)) { cur = direct; continue; }
      if (s.reenter) {
        const plain = clone(cur); delete plain[i].reenter;
        if (await still(plain)) { cur = plain; continue; }
        for (const t of [1, 2, 3, 5, 8]) {
          if (t >= s.reenter.times) break;
          const fewer = clone(cur); fewer[i].reenter.times = t;
          if (await still(fewer)) { cur = fewer; break; }
        }
      }
    }
    if (BigInt(cur[i].value ?? 0) > 0n) {
      for (const v of [0n, ...VALUES]) {
        if (v >= BigInt(cur[i].value)) break;
        const less = clone(cur); less[i].value = String(v);
        if (await still(less)) { cur = less; break; }
      }
    }
  }
  return cur;
}

const findingOf = (spec, steps) => ({ v: spec.version === 1 ? 1 : 2, steps: steps.map((s) => (spec.version === 1 ? { sig: s.sig, args: s.args, value: s.value } : s)) });

/** Greedy set cover: the fewest corpus entries that keep every edge the corpus reached. */
export function minimizeCorpus(corpus) {
  const left = new Set(corpus.flatMap((c) => c.edges));
  const out = [];
  const pool = [...corpus];
  while (left.size && pool.length) {
    let best = -1, gain = 0;
    pool.forEach((c, i) => { const g = c.edges.filter((e) => left.has(e)).length; if (g > gain) { gain = g; best = i; } });
    if (best < 0) break;
    const [c] = pool.splice(best, 1);
    for (const e of c.edges) left.delete(e);
    out.push(c);
  }
  return out;
}

/**
 * Fuzzes until a finding (or, with stopOnFirst false, until `runs`), or until `shouldStop()` says so.
 * opts: seed, runs, maxSteps, stopOnFirst (true), want (with stopOnFirst false: stop once these kinds are
 *       found; default every invariant of the spec), corpus (sequences to start from: [{ steps }]),
 *       onFinding(finding) as each new kind is found, onProgress({ runs, edges, corpus, coverage }) every 50 runs.
 * Returns { finding, profit, runs, seed, findings: [{ kinds, violations, finding, profit, run }],
 *           coverage: { edges, jumpdests, hit, pct }, corpus: [{ steps, edges }] (minimised) }.
 */
export async function fuzz(lib, spec, { seed = 1, runs = 10_000, maxSteps = 4, stopOnFirst = true, want = null, corpus: start = [], shouldStop = () => false, onProgress = () => {}, onFinding = () => {} } = {}) {
  const world = await createWorld(lib, spec);
  maxSteps = Math.min(MAX_STEPS, maxSteps);
  const r = rng(seed);
  const seen = new Set();
  const hitPcs = new Set();
  const corpus = [];
  const findings = [];
  const found = new Set();
  const note = (steps, res, run) => {
    const fresh = [...res.edges].filter((e) => !seen.has(e));
    for (const e of res.edges) { seen.add(e); hitPcs.add(Number(e.split('>')[1])); }
    if (fresh.length) corpus.push({ steps, edges: [...res.edges], cb: res.cb, run });
  };
  const coverage = () => {
    const jd = new Set(world.jumpdests);
    const hit = [...hitPcs].filter((p) => jd.has(p)).length;
    return { edges: seen.size, jumpdests: jd.size, hit, pct: jd.size ? Math.round((hit / jd.size) * 1000) / 10 : 0 };
  };
  const consider = async (steps, res, run) => {
    for (const kind of res.kinds) {
      if (kind === 'reentrancy' || found.has(kind)) continue;
      const min = await minimize(world, steps, kind);
      const again = await runSteps(world, min);
      found.add(kind);
      for (const k2 of again.kinds) found.add(k2);
      const f = { kinds: again.kinds, violations: again.violations, finding: findingOf(spec, min), profit: again.profit, run };
      findings.push(f);
      await onFinding({ ...f, coverage: coverage() });
      if (stopOnFirst) return true;
    }
    return (want ?? world.invariants).every((x) => found.has(x));
  };
  const result = (n) => {
    const first = findings[0] ?? null;
    return { finding: first?.finding ?? null, profit: first?.profit ?? 0n, runs: n, seed, findings, coverage: coverage(), corpus: minimizeCorpus(corpus).map(({ steps, edges }) => ({ steps, edges })) };
  };
  let n = 0;
  for (const c of start) {
    if (!Array.isArray(c?.steps) || !c.steps.length) continue;
    let res;
    try { res = await runSteps(world, c.steps.slice(0, maxSteps)); } catch { continue; }
    note(c.steps.slice(0, maxSteps), res, 0);
    if (res.valid && await consider(c.steps.slice(0, maxSteps), res, 0)) return result(0);
  }
  for (n = 1; n <= runs; n++) {
    const steps = corpus.length && r.chance(0.75) ? await mutateSteps(r, world, r.pick(corpus), corpus, maxSteps) : await randomSteps(r, spec, world, maxSteps);
    let res;
    try { res = await runSteps(world, steps); } catch { continue; }
    note(steps, res, n);
    if (res.valid && await consider(steps, res, n)) return result(n);
    if (n % 50 === 0) {
      onProgress({ runs: n, edges: seen.size, corpus: corpus.length, coverage: coverage() });
      if (await shouldStop()) return result(n);
    }
  }
  return result(runs);
}

/**
 * A reproducer: everything needed to see the bug again and to submit it. `zetaphy work verify-finding
 * <spec> <reproducer.json>` replays it; `finding` is the exact JSON to reveal on BugBounty.
 */
export async function reproducer(lib, spec, specText, res, { k = lib.keccak256 } = {}) {
  const f = res.finding;
  if (!f) throw new Error('no finding');
  const world = await createWorld(lib, spec);
  const steps = [];
  await world.sm.checkpoint();
  try {
    for (const s of f.steps) {
      const ok = await doStep(world, s);
      steps.push({ ...s, ok, attackerWei: String(await attackerWealth(world)), targetWei: String(await world.balance(world.target)) });
    }
  } finally { await world.sm.revert(); }
  const check = await runSteps(world, f.steps);
  return {
    format: 'zetaphy-fuzz-repro/1',
    spec: { name: spec.name, specHash: specText ? specHash(k, specText) : null },
    seed: res.seed ?? null, runs: res.runs ?? null,
    environment: { evm: 'EthereumJS (Cancun)', block: { number: String(BLOCK.number), timestamp: String(BLOCK.timestamp) }, actors: ACTORS, target: world.targetHex, hook: world.hookHex },
    violations: check.violations, valid: check.valid, profit: String(check.profit),
    trace: steps,
    finding: f,
    findingHash: findingHash(k, f),
    replay: 'zetaphy work verify-finding <spec.json> <this file>',
  };
}

export { fromHex };
