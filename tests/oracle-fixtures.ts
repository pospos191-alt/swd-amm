// Shared constants for "Phase 3" (Pyth oracle guard + dynamic fee, added
// 2026-09-23) tests — see tests/oracle.ts and scripts/gen-pyth-fixtures.js.
//
// Deliberately imports the SAME JS module `anchor test` needs run
// BEFORE the validator starts (see that script's header comment) rather
// than re-declaring these values here by hand — this is the single source
// of truth for the fixed pubkeys/feed ids, so this file and the fixture
// bytes actually loaded into the local validator can never drift apart.
// Importing it also regenerates the fixture files (a harmless side
// effect — see gen-pyth-fixtures.js's `main()`), which does NOT help the
// CURRENT `anchor test` run (the validator already started with whatever
// was on disk a moment earlier) but leaves fresh-enough fixtures in place
// for the next one.
//
// A plain `import * as ... from` (NOT `require()`) — added 2026-09-24
// after the first real `anchor test` run on the user's own machine
// crashed with `ReferenceError: require is not defined in ES module
// scope`: mocha's file loader (`tests/**/*.ts` in Anchor.toml's
// [scripts] test command matches this helper file too, not just actual
// *.test.ts suites) loads some files via a dynamic `import()` rather
// than `require()`, and a raw `require()` call is not defined in that
// context. A static `import` compiles correctly under ts-node either
// way (to a `require()` call for CJS output, or a real `import` for
// ESM), and `esModuleInterop` (tsconfig.json) makes the CommonJS
// `module.exports = {...}` object in gen-pyth-fixtures.js show up as
// this same `pythFixtureGen.<name>` shape either way — no other line in
// this file needed to change.
import * as pythFixtureGen from "../scripts/gen-pyth-fixtures.js";

import { PublicKey } from "@solana/web3.js";

export const PRICE_UPDATE_A = new PublicKey(pythFixtureGen.PRICE_UPDATE_A_PUBKEY as string);
export const PRICE_UPDATE_B = new PublicKey(pythFixtureGen.PRICE_UPDATE_B_PUBKEY as string);

// [u8; 32] Rust args are passed from Anchor's JS client as plain
// number[]/Buffer/Uint8Array — Array.from(...) here gives a plain
// number[], the least ambiguous of the three across @coral-xyz/anchor
// versions.
export const FEED_ID_A: number[] = Array.from(pythFixtureGen.FEED_ID_A as Buffer);
export const FEED_ID_B: number[] = Array.from(pythFixtureGen.FEED_ID_B as Buffer);

// ---------------------------------------------------------------------
// "Legacy pool" fixtures (added 2026-09-24) — for porting the 28 pre-
// Phase-3 tests in tests/swd_amm.ts/tests/dlmm.ts/tests/governance.ts
// to work under the mandatory oracle guard. Those tests were written
// before Phase 3 existed, so their pool ratios were chosen purely to
// exercise AMM math/security properties, not to track one shared real
// price the way tests/oracle.ts's own scenarios do — three separate
// price pairs cover the distinct ratios those tests actually use (see
// scripts/gen-pyth-fixtures.js's "Legacy pool fixtures" section for how
// each was derived, and each legacy test file's own call sites for
// which pair applies where):
//   - LEGACY_POOLS.ratioOne:  1 raw mint_b per raw mint_a
//   - LEGACY_POOLS.ratioFour: 4 raw mint_b per raw mint_a
//   - LEGACY_POOLS.ratioHalf: 0.5 raw mint_b per raw mint_a
// All mints in those three files are 6-decimal uniformly, so (unlike
// this file's own 9dp/6dp PRICE_UPDATE_A/B above) no decimals
// adjustment is needed: oracle_price_q64 == price_a/price_b directly.
function legacyScenario(label: string) {
  const s = (pythFixtureGen.LEGACY_SCENARIOS as any[]).find((x) => x.label === label);
  if (!s) throw new Error(`gen-pyth-fixtures.js: no LEGACY_SCENARIOS entry named "${label}"`);
  return {
    priceUpdateA: new PublicKey(s.pubkeyA as string),
    priceUpdateB: new PublicKey(s.pubkeyB as string),
    feedIdA: Array.from(s.feedIdA as Buffer) as number[],
    feedIdB: Array.from(s.feedIdB as Buffer) as number[],
  };
}

export const LEGACY_POOLS = {
  ratioOne: legacyScenario("legacy-ratio1"),
  ratioFour: legacyScenario("legacy-ratio4"),
  ratioHalf: legacyScenario("legacy-ratiohalf"),
};

// Generous, fixed bounds every legacy pool creation call can reuse
// unchanged — these tests don't probe the oracle guard's own bounds
// (tests/oracle.ts already does that), they just need SOME valid
// values so `initializePool`/`initializeDlmmPool` accept them.
// LEGACY_MAX_DEVIATION_BPS sits at oracle.rs's own hard ceiling
// (MAX_ORACLE_DEVIATION_GUARD_BPS = 5000 = 50%) — loose enough that
// ordinary reserve drift across a sequential test file's own swaps
// never trips PriceDeviationTooLarge. LEGACY_MAX_FEE_BPS sits at
// lib.rs's own hard ceiling (MAX_FEE_BPS = 1000 = 10%), comfortably
// above every fee_bps these legacy tests actually use (30/100/500).
export const LEGACY_ORACLE_MAX_DEVIATION_BPS = 5000;
export const LEGACY_MAX_FEE_BPS = 1000;

// The fixture prices `gen-pyth-fixtures.js` bakes in: mint_a priced like a
// ~$200 asset at 9 decimals, mint_b like a ~$1 asset at 6 decimals, both
// at Pyth exponent -8. Exported so tests can compute exact expected
// on-chain values off-chain — see `oraclePriceQ64` below.
export const FIXTURE_PRICE_A = 200_00000000n;
export const FIXTURE_EXPO_A = -8;
export const FIXTURE_DECIMALS_A = 9;
export const FIXTURE_PRICE_B = 1_00000000n;
export const FIXTURE_EXPO_B = -8;
export const FIXTURE_DECIMALS_B = 6;

// Generous relative to the fixture's staleness (freshly (re)generated by
// requiring gen-pyth-fixtures.js above), tight enough to still be a
// meaningful production-shaped value.
export const TEST_ORACLE_MAX_STALENESS_SECS = 300;

// ---------------------------------------------------------------------
// Bit-exact BigInt mirrors of oracle.rs's Q64.64 math (same technique
// swd_amm.ts's `expectedSwapOut` already uses for the constant-product
// formula) — lets tests assert EXACT expected values, not just "some
// plausible-looking number".
// ---------------------------------------------------------------------

export const Q64_ONE = 1n << 64n;

/** Mirrors oracle.rs's `oracle_price_q64`. */
export function oraclePriceQ64(
  priceA: bigint,
  expoA: number,
  decimalsA: number,
  priceB: bigint,
  expoB: number,
  decimalsB: number
): bigint {
  const netExp = BigInt(expoA - decimalsA) - BigInt(expoB - decimalsB);
  let ratio = (priceA << 64n) / priceB;
  if (netExp > 0n) {
    ratio = ratio * 10n ** netExp;
  } else if (netExp < 0n) {
    ratio = ratio / 10n ** -netExp;
  }
  return ratio;
}

/** Mirrors dlmm.rs's `q64_div_amount` as used on a plain reserve ratio. */
export function poolPriceQ64(reserveB: bigint, reserveA: bigint): bigint {
  return (reserveB << 64n) / reserveA;
}

/** Mirrors oracle.rs's `deviation_bps`. */
export function deviationBps(poolPriceQ64_: bigint, oraclePriceQ64_: bigint): bigint {
  const diff = poolPriceQ64_ >= oraclePriceQ64_ ? poolPriceQ64_ - oraclePriceQ64_ : oraclePriceQ64_ - poolPriceQ64_;
  return (diff * 10_000n) / oraclePriceQ64_;
}

/** Mirrors oracle.rs's `dynamic_fee_bps`. */
export function dynamicFeeBps(
  baseFeeBps: bigint,
  maxFeeBps: bigint,
  deviationBps_: bigint,
  maxDeviationBps: bigint
): bigint {
  if (deviationBps_ >= maxDeviationBps) return maxFeeBps;
  const range = maxFeeBps - baseFeeBps;
  const extra = (range * deviationBps_) / maxDeviationBps;
  return baseFeeBps + extra;
}

/** Mirrors the `swap` instruction's constant-product-with-fee formula (same as swd_amm.ts's private copy). */
export function expectedSwapOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
  const feeMultiplier = 10_000n - feeBps;
  const amountInAfterFee = (amountIn * feeMultiplier) / 10_000n;
  const k = reserveIn * reserveOut;
  const newReserveIn = reserveIn + amountInAfterFee;
  // The pool keeps ceil(k / newReserveIn): the payout rounds DOWN, in the
  // pool's favour (lib.rs swap, fixed 2026-10-08 — see
  // security/attack-tests attack_rounding_drain_with_dust_swaps).
  const newReserveOutCeil = (k + newReserveIn - 1n) / newReserveIn;
  return reserveOut - newReserveOutCeil;
}

// ---------------------------------------------------------------------
// Mint → Pyth feed registry (2026-10-08). Pool creation must name the
// feeds governance registered for its mints (governance.rs set_mint_feed),
// so every suite registers them right before it creates a pool.
// ---------------------------------------------------------------------
export function mintFeedPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("mint-feed"), mint.toBuffer()], programId)[0];
}

export async function registerFeeds(
  program: any,
  governance: { publicKey: PublicKey },
  config: PublicKey,
  pairs: Array<[PublicKey, number[] | Uint8Array]>
) {
  for (const [mint, feed] of pairs) {
    await program.methods
      .setMintFeed(Array.from(feed))
      .accounts({
        config,
        governanceAuthority: governance.publicKey,
        mint,
        mintFeed: mintFeedPda(program.programId, mint),
        payer: governance.publicKey,
        systemProgram: new PublicKey("11111111111111111111111111111111"),
      })
      .rpc();
  }
}

// SWDMM v2 position index for (owner, nonce): first 8 bytes (LE) of
// sha256("swdmm_v2_position_index" || owner || nonce LE) — swdmm_v2.rs
// v2_position_index.
export function v2PositionIndex(owner: PublicKey, nonce: number | bigint): bigint {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto");
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(BigInt(nonce));
  const h: Buffer = createHash("sha256").update(Buffer.from("swdmm_v2_position_index")).update(owner.toBuffer()).update(n).digest();
  return h.readBigUInt64LE(0);
}
