// Neuro ML: per-function path features from runtime bytecode ("what each function can reach").
//
// The opcode counts in features.js look at the whole contract at once, so an owner-only function
// that moves anybody's tokens (drain / seize), a renamed mint, or a time check hidden inside
// transfer() all blur into the same averages as honest code. This file walks the code the way the
// EVM would, one dispatched function at a time:
//
//   1. the dispatcher's `PUSH4 <selector> [DUP2] EQ PUSH <dest> JUMPI` gives each function's entry;
//   2. from each entry, a small abstract interpreter follows jumps (jump targets are constants
//      pushed earlier and carried through DUP/SWAP, which is how solc compiles internal calls),
//      tracking for every stack value only a constant (when known) and a "taint": which
//      environment facts it came from (msg.sender, tx.origin, storage, hash, XOR, time, gas price..);
//   3. an "owner check" is a JUMPI on EQ(value from msg.sender / tx.origin, value from storage),
//      one side of which reverts within a few steps: require(msg.sender == owner) and its hidden
//      forms (keccak(msg.sender) == stored hash, msg.sender ^ mask == stored, tx.origin == stored).
//
// Results per function: owner-checked or not, can it emit Transfer (move or create tokens), does
// it write storage, what environment facts does it read. Exploration is bounded (deterministic
// order, fixed budgets), so a huge or obfuscated contract gives fewer facts, never a hang.
// Plain JS, no dependencies beyond src/bytecode.js: same numbers in a browser, a runner and Node.

import { hexToBytes, codeLengthWithoutMetadata } from '../src/bytecode.js';

const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Standard ERC-20 selectors: transfer, transferFrom, approve, balanceOf, allowance, totalSupply,
// name, symbol, decimals, increaseAllowance, decreaseAllowance, owner.
const ERC20 = new Set(['a9059cbb', '23b872dd', '095ea7b3', '70a08231', 'dd62ed3e', '18160ddd', '06fdde03', '95d89b41', '313ce567', '39509351', 'a457c2d7', '8da5cb5b']);
const XFER = ['a9059cbb', '23b872dd'];
const OWNER_SEL = '8da5cb5b';

// taint bits
const T = { CALLER: 1, ORIGIN: 2, SLOAD: 4, HASH: 8, XOR: 16, TIME: 32, GASPRICE: 64, CODESIZE: 128, BALANCE: 256, COINBASE: 512, GAS: 1024, GUARD: 2048, CDSIZE: 4096, CAP: 8192, CDATA: 16384 };
const ENV = { 0x33: T.CALLER, 0x32: T.ORIGIN, 0x42: T.TIME, 0x43: T.TIME, 0x3a: T.GASPRICE, 0x41: T.COINBASE, 0x5a: T.GAS, 0x47: T.BALANCE, 0x36: T.CDSIZE };
const TWO32 = 1n << 32n;
// A bound worth noting: not 0/1, not a mask (2^k - 1) or a power of two (ABI and type checks use those).
const isBound = (c) => c != null && c > 1n && (c & (c + 1n)) !== 0n && (c & (c - 1n)) !== 0n;
const jumpTo = (d, v) => (v.c != null && v.c < TWO32 && d.dest.has(Number(v.c)) ? Number(v.c) : null);

// [pops, pushes] for every opcode that neither jumps nor halts; anything missing halts.
const STACK = {};
const set = (ops, pops, pushes) => { for (const o of ops) STACK[o] = [pops, pushes]; };
set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0a, 0x0b, 0x10, 0x11, 0x12, 0x13, 0x14, 0x16, 0x17, 0x18, 0x1a, 0x1b, 0x1c, 0x1d, 0x20], 2, 1);
set([0x08, 0x09], 3, 1);
set([0x15, 0x19, 0x31, 0x35, 0x3b, 0x3f, 0x40, 0x49, 0x51, 0x54, 0x5c], 1, 1);
set([0x30, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3a, 0x3d, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x4a, 0x58, 0x59, 0x5a], 0, 1);
set([0x37, 0x39, 0x3e, 0x5e], 3, 0);
set([0x3c], 4, 0);
set([0x50], 1, 0);
set([0x52, 0x53, 0x55, 0x5d], 2, 0);
set([0x5b], 0, 0);
for (let n = 0; n <= 4; n++) STACK[0xa0 + n] = [2 + n, 0];
set([0xf0], 3, 1);
set([0xf1, 0xf2], 7, 1);
set([0xf4, 0xfa], 6, 1);
set([0xf5], 4, 1);
const HALT_BAD = new Set([0xfd, 0xfe]);

const BUDGET_FN = 3000;     // abstract paths per function...
const BUDGET_ALL = 40000;   // ...and per contract (split over its functions)
const BUDGET_REVERT = 96;   // instructions to decide "this branch reverts"

/** Decoded code: op per pc, small push values, the Transfer-topic pushes, JUMPDESTs. */
function decode(codeHex) {
  let bytes;
  try { bytes = hexToBytes(codeHex); } catch { return null; }
  const end = codeLengthWithoutMetadata(bytes);
  const op = new Int16Array(end).fill(-1);
  const val = new Map();
  const topic = new Set();
  const dest = new Set();
  const order = [];
  for (let pc = 0; pc < end; pc++) {
    const o = bytes[pc];
    op[pc] = o;
    order.push(pc);
    if (o === 0x5b) dest.add(pc);
    if (o >= 0x60 && o <= 0x7f) {
      const n = o - 0x5f;
      let h = '';
      for (let i = 1; i <= n; i++) h += (bytes[pc + i] ?? 0).toString(16).padStart(2, '0');
      val.set(pc, BigInt('0x' + h));
      if (h === TRANSFER_TOPIC) topic.add(pc);
      pc += n;
    }
  }
  return { op, val, topic, dest, order, end };
}

const nextPc = (d, pc) => { const o = d.op[pc]; return o >= 0x60 && o <= 0x7f ? pc + o - 0x5e : pc + 1; };

/** Dispatcher entries: selector -> JUMPDEST. */
function entries(d) {
  const out = new Map();
  const ord = d.order.filter((pc) => d.op[pc] >= 0);
  for (let i = 0; i < ord.length; i++) {
    const pc = ord[i];
    if (d.op[pc] !== 0x63) continue;
    let j = i + 1;
    if (d.op[ord[j]] === 0x81) j++;
    if (d.op[ord[j]] !== 0x14) continue;
    const pushPc = ord[j + 1];
    if (pushPc == null || !(d.op[pushPc] >= 0x60 && d.op[pushPc] <= 0x62) || d.op[ord[j + 2]] !== 0x57) continue;
    const sel = d.val.get(pc).toString(16).padStart(8, '0');
    const to = Number(d.val.get(pushPc));
    if (d.dest.has(to) && !out.has(sel)) out.set(sel, to);
  }
  return out;
}

// c: the value when it is a known constant; t: taint bits; s: the storage slot it was read from (constant slots)
const V = (c = null, t = 0, s = null) => ({ c, t, s });
const at = (st, i) => st[st.length - 1 - i] ?? V();

/** Does execution from `pc` (with this stack) end in REVERT/INVALID on every path, without writing anything? */
function revertsSoon(d, pc, stack) {
  const work = [[pc, stack.slice(-16)]];
  let budget = BUDGET_REVERT;
  let paths = 0;
  while (work.length) {
    let [p, st] = work.pop();
    if (++paths > 6) return false;
    for (;;) {
      if (--budget < 0 || p >= d.end) return false;
      const o = d.op[p];
      if (HALT_BAD.has(o)) break;
      if (o === 0x56 || o === 0x57) {
        const to = jumpTo(d, st.pop() ?? V());
        if (o === 0x57) st.pop();
        if (to == null) return false;
        if (o === 0x57) work.push([nextPc(d, p), st.slice()]);
        p = to;
        continue;
      }
      if (o === 0x55 || (o >= 0xa0 && o <= 0xa4) || o === 0xf1 || o === 0xf3 || o === 0x00 || o === 0xff || o === 0xf4 || o === 0xf0 || o === 0xf5) return false;
      if (!step(d, p, o, st, null)) return false;
      p = nextPc(d, p);
    }
  }
  return true;
}

/** Applies one non-jumping instruction to the abstract stack. Returns false on a halt or unknown op. */
function step(d, pc, o, st, mem) {
  if (o >= 0x60 && o <= 0x7f) { st.push(V(d.val.has(pc) ? d.val.get(pc) : null)); return true; }
  if (o === 0x5f) { st.push(V(0n)); return true; }
  if (o >= 0x80 && o <= 0x8f) { st.push({ ...at(st, o - 0x80) }); return true; }
  if (o >= 0x90 && o <= 0x9f) {
    const n = o - 0x8f;
    while (st.length < n + 1) st.unshift(V());
    const a = st.length - 1; const b = a - n;
    [st[a], st[b]] = [st[b], st[a]];
    return true;
  }
  const sp = STACK[o];
  if (!sp) return false;
  const [pops, pushes] = sp;
  const args = [];
  for (let i = 0; i < pops; i++) args.push(st.pop() ?? V());
  let t = 0;
  for (const a of args) t |= a.t;
  if (o === 0x52 || o === 0x53) { if (mem) mem.t |= args[1].t; return true; }
  if (!pushes) return true;
  let out;
  if (ENV[o] != null) out = V(null, ENV[o]);
  else if (o === 0x58) out = V(BigInt(pc));
  else if (o === 0x54) out = V(null, t | T.SLOAD, args[0].c);
  else if (o === 0x35) out = V(null, t | T.CDATA);
  else if (o === 0x20) out = V(null, t | (mem ? mem.t : 0) | T.HASH);
  else if (o === 0x51) out = V(null, t | (mem ? mem.t : 0));
  else if (o === 0x18) out = V(null, t | T.XOR);
  else if (o === 0x3b || o === 0x3f) out = V(null, t | T.CODESIZE);
  else if (o === 0x31) out = V(null, t | T.BALANCE);
  else if (o === 0x14) {
    // EQ(something from the caller, something stored that is not itself caller-keyed): an owner check
    const who = (x) => (x.t & (T.CALLER | T.ORIGIN)) !== 0;
    const stored = (x) => (x.t & T.SLOAD) !== 0 && !who(x);
    const guard = (who(args[0]) && stored(args[1])) || (who(args[1]) && stored(args[0]));
    out = V(null, t | (guard ? T.GUARD : 0));
  } else if (o >= 0x10 && o <= 0x13) {
    // x < BOUND / x > BOUND against a constant bound (a cap, a fee ceiling), not an ABI or type check
    const capOf = (k, x) => isBound(k.c) && x.c == null && !(x.t & T.CDSIZE);
    out = V(null, t | (capOf(args[0], args[1]) || capOf(args[1], args[0]) ? T.CAP : 0));
  } else if (o === 0x16 && args[0].c != null && args[1].c != null) out = V(args[0].c & args[1].c, t); // masked jump targets
  else if ((o === 0x16 || o === 0x1c || o === 0x04) && (args[0].s ?? args[1].s) != null && (args[0].c ?? args[1].c) != null) out = V(null, t, args[0].s ?? args[1].s); // unpacking a stored value keeps its slot
  else out = V(null, t);
  st.push(out);
  return true;
}

/** Explores one function from its entry. */
function explore(d, entry, budgetFn = BUDGET_FN) {
  const r = { ops: new Set(), transfer: false, sstore: false, guarded: false, capped: false, txGuard: false, jumpis: 0, sloads: 0, done: true, setSlots: new Set(), mulSlots: new Set() };
  const seen = new Set();
  const work = [{ pc: entry, st: [], mem: { t: 0 }, wrote: false }];
  let budget = budgetFn;
  while (work.length) {
    const s = work.pop();
    const key = `${s.pc}|${s.wrote ? 1 : 0}|${s.mem.t}|${s.st.slice(-10).map((v) => `${v.c != null && v.c < TWO32 ? v.c : ''}:${v.t}`).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (--budget < 0) { r.done = false; break; }
    let { pc } = s;
    const st = s.st; const mem = s.mem; let wrote = s.wrote;
    for (let guardSteps = 0; guardSteps < 4096; guardSteps++) {
      if (pc >= d.end || pc < 0) break;
      const o = d.op[pc];
      if (o < 0) break;
      r.ops.add(o);
      if (d.topic.has(pc)) r.transfer = true;
      if (o === 0x54) r.sloads++;
      if (o === 0x55) {
        r.sstore = true; wrote = true;
        const k = at(st, 0); const v = at(st, 1);
        if (k.c != null && (v.t & T.CDATA)) r.setSlots.add(String(k.c)); // a constant slot set from the caller's input
      }
      if (o === 0x02) for (const a of [at(st, 0), at(st, 1)]) if (a.s != null) r.mulSlots.add(String(a.s)); // a stored value used as a multiplier (a rate)
      if ((o >= 0xa0 && o <= 0xa4) || o === 0xf1 || o === 0xf4) wrote = true;
      if (o === 0x56) {
        const to = jumpTo(d, st.pop() ?? V());
        if (to == null) break;
        pc = to;
        continue;
      }
      if (o === 0x57) {
        const to = jumpTo(d, st.pop() ?? V());
        const cond = st.pop() ?? V();
        r.jumpis++;
        const fall = nextPc(d, pc);
        if (cond.t & (T.GUARD | T.CAP)) {
          // a require(): exactly one way out reverts at once
          const revTaken = to != null && revertsSoon(d, to, st.slice());
          const revFall = revertsSoon(d, fall, st.slice());
          if (revTaken !== revFall) {
            if (cond.t & T.GUARD) {
              r.txGuard = true;
              if (!wrote) r.guarded = true;
            }
            if (cond.t & T.CAP) r.capped = true;
          }
        }
        if (to != null) work.push({ pc: to, st: st.slice(), mem: { t: mem.t }, wrote });
        pc = fall;
        continue;
      }
      if (!step(d, pc, o, st, mem)) break;
      pc = nextPc(d, pc);
    }
  }
  return r;
}

export const FLOW_FEATURES = [
  'x_fn_found', 'x_fn_xfer', 'x_priv_fns', 'x_priv_unknown', 'x_priv_xfer', 'x_priv_xfer_unknown', 'x_priv_xfer_free', 'x_priv_sstore', 'x_priv_capped',
  'x_owner_const', 'x_fake_renounce', 'x_fee_owner_set', 'x_fee_owner_free',
  'x_tx_found', 'x_tx_guard', 'x_tx_time', 'x_tx_gasprice', 'x_tx_origin', 'x_tx_codesize', 'x_tx_balance', 'x_tx_coinbase', 'x_tx_gas',
  'x_tx_branches', 'x_tx_sloads', 'x_tx_div',
];

/**
 * Path features of a contract's runtime code (hex). `known(sel)` says whether a selector has a name
 * (the reader's signature list); unknown + owner-checked + moves tokens is the drain / seize / hidden
 * mint shape. Every value is finite; missing code gives all zeros.
 */
export function flowFeatures(codeHex, { known = () => false } = {}) {
  const out = Object.fromEntries(FLOW_FEATURES.map((n) => [n, 0]));
  if (!codeHex || codeHex === '0x') return out;
  const d = decode(codeHex);
  if (!d) return out;
  const ent = entries(d);
  if (!ent.size) return out;
  const fns = new Map();
  const each = Math.max(300, Math.min(BUDGET_FN, Math.floor(BUDGET_ALL / ent.size)));
  for (const [sel, pc] of [...ent.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) fns.set(sel, explore(d, pc, each));
  let xfer = 0; let priv = 0; let privUnknown = 0; let privXfer = 0; let privXferUnknown = 0; let privXferFree = 0; let privStore = 0; let privCapped = 0;
  for (const [sel, f] of fns) {
    if (f.transfer) xfer++;
    if (ERC20.has(sel) || !f.guarded) continue;
    priv++;
    const unk = !known(sel);
    if (unk) privUnknown++;
    if (f.transfer) { privXfer++; if (unk) privXferUnknown++; if (!f.capped) privXferFree++; }
    if (f.sstore) privStore++;
    if (f.capped) privCapped++;
  }
  out.x_fn_found = 1;
  out.x_fn_xfer = Math.log1p(xfer);
  out.x_priv_fns = Math.log1p(priv);
  out.x_priv_unknown = Math.log1p(privUnknown);
  out.x_priv_xfer = Math.log1p(privXfer);
  out.x_priv_xfer_unknown = Math.log1p(privXferUnknown);
  out.x_priv_xfer_free = Math.log1p(privXferFree);
  out.x_priv_sstore = Math.log1p(privStore);
  out.x_priv_capped = Math.log1p(privCapped);
  const own = fns.get(OWNER_SEL);
  if (own && own.done && !own.ops.has(0x54) && own.ops.has(0xf3)) {
    out.x_owner_const = 1;
    if (priv > 0) out.x_fake_renounce = 1;
  }
  const tx = XFER.map((s) => fns.get(s)).filter(Boolean);
  // A rate transfer() multiplies by, read from a slot an owner-only function sets from its input: the owner sets the
  // fee. "free" when that function has no fixed bound (setFee(99) works).
  const rates = new Set(tx.flatMap((f) => [...f.mulSlots]));
  for (const [sel, f] of fns) {
    if (ERC20.has(sel) || !f.guarded || ![...f.setSlots].some((k) => rates.has(k))) continue;
    out.x_fee_owner_set = 1;
    if (!f.capped) out.x_fee_owner_free = 1;
  }
  if (tx.length) {
    const has = (...ops) => (tx.some((f) => ops.some((o) => f.ops.has(o))) ? 1 : 0);
    out.x_tx_found = 1;
    out.x_tx_guard = tx.some((f) => f.txGuard) ? 1 : 0;
    out.x_tx_time = has(0x42, 0x43);
    out.x_tx_gasprice = has(0x3a);
    out.x_tx_origin = has(0x32);
    out.x_tx_codesize = has(0x3b, 0x3f);
    out.x_tx_balance = has(0x31, 0x47);
    out.x_tx_coinbase = has(0x41);
    out.x_tx_gas = tx.some((f) => f.ops.has(0x5a) && !f.ops.has(0xf1) && !f.ops.has(0xfa)) ? 1 : 0;
    out.x_tx_branches = Math.log1p(Math.max(...tx.map((f) => f.jumpis))) / 5;
    out.x_tx_sloads = Math.log1p(Math.max(...tx.map((f) => f.sloads))) / 5;
    out.x_tx_div = has(0x04);
  }
  return out;
}
