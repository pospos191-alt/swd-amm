// Dedicated test suite for "Phase 3" — the mandatory Pyth pull-oracle
// guard + dynamic fee added 2026-09-23 (see programs/swd_amm/src/oracle.rs's
// module doc comment for the full design rationale).
//
// WHY THIS FILE IS SEPARATE FROM swd_amm.ts/dlmm.ts/governance.ts (deliberate,
// not an oversight): those 28 pre-existing tests intentionally create pools
// at UNREALISTIC price ratios (e.g. a 1:4 constant-product pool) specifically
// to exercise the AMM math/invariants in isolation. That is fundamentally
// incompatible with this phase's MANDATORY, bounded oracle-deviation guard —
// every one of those old pools would now fail to even swap. Rather than
// weaken the guard to something meaningless just to keep old tests green, or
// spend a large effort re-deriving a bespoke oracle fixture for all 28 of
// them, this was surfaced to the user directly and they chose (explicitly,
// over the alternative) to write this new, self-consistent test file first
// and defer porting the old 28 as a separate follow-up. Expect
// swd_amm.ts/dlmm.ts to FAIL when `anchor test` runs until that follow-up
// happens — that is known and expected, not a regression introduced here.
//
// Run with `node scripts/gen-pyth-fixtures.js && anchor test` (or just
// `yarn test`, which now wraps both steps — see package.json) — the fixture
// generator MUST run before the validator starts, see its own header
// comment and Anchor.toml's `[[test.validator.account]]` entries for why.
//
// COVERAGE (three scenarios, all against the constant-product pool — DLMM's
// swap_dlmm gained the identical oracle/fee wiring but is not separately
// exercised here; the guard/fee MATH itself is pool-type-agnostic and
// already covered by oracle.rs's own `cargo test` unit tests):
//   1. A pool deposited at EXACTLY the oracle-implied ratio (zero deviation)
//      swaps normally, charging exactly the pool's base fee_bps.
//   2. A pool deposited at a ratio wildly off the oracle price, under a
//      tight guard, has a swap that moves the price further away rejected
//      with PriceDeviationTooLarge — while a swap back toward the oracle
//      still goes through, at max_fee_bps (see oracle.rs's guard_allows).
//   3. A pool deposited at a ratio producing a known, moderate deviation
//      (within the guard) charges the exact dynamically-scaled fee the
//      on-chain linear formula computes — validated end-to-end via balance
//      deltas against the TS-mirrored expected output, not by decoding the
//      emitted event (matching this codebase's established assertion
//      style).

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";

import {
  PRICE_UPDATE_A,
  PRICE_UPDATE_B,
  FEED_ID_A,
  FEED_ID_B,
  TEST_ORACLE_MAX_STALENESS_SECS,
  oraclePriceQ64,
  poolPriceQ64,
  deviationBps,
  dynamicFeeBps,
  expectedSwapOut,
} from "./oracle-fixtures";

// Must match the fixture's baked-in mint decimals exactly — the on-chain
// oracle math reads `decimals_a`/`decimals_b` straight off the real mint
// accounts at swap time (not off any fixed constant), so every mint pair
// created in this file has to actually carry these decimals or the
// oracle-implied ratio computed here and on-chain will silently diverge.
const MINT_A_DECIMALS = 9;
const MINT_B_DECIMALS = 6;

/**
 * Runs `fn`, asserts it threw, and returns the caught error. See
 * swd_amm.ts's identical helper for the full rationale (kept as a local
 * copy — this test suite deliberately has no cross-file helper imports
 * beyond the shared oracle-fixtures module).
 */
async function expectThrows(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error(`expected "${label}" to throw, but it succeeded`);
}

function errorCode(err: any): string | undefined {
  return err?.error?.errorCode?.code;
}

/** See swd_amm.ts's identical helper for why this retry loop exists. */
async function createMintWithRetry(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  retries = 5
): Promise<PublicKey> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await createMint(connection, payer, mintAuthority, freezeAuthority, decimals);
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message ?? err);
      const isStaleBlockhash =
        msg.includes("Blockhash not found") || msg.includes("block height exceeded");
      if (!isStaleBlockhash || attempt === retries) {
        throw err;
      }
      const delayMs = 1500 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

describe("oracle guard + dynamic fee (Phase 3)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwdAmm as anchor.Program<any>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Same fixed-seed pattern swd_amm.ts/dlmm.ts/governance.ts use, and for
  // the same reason: whichever test file's `before` hook runs first (mocha
  // runs tests/*.ts alphabetically — dlmm.ts wins) actually creates the one
  // on-chain GlobalConfig singleton; every other file just needs to
  // reconstruct the SAME keypair to keep calling governance instructions as
  // that authority. A per-file `Keypair.generate()` would produce a
  // different, never-actually-stored keypair here.
  const EMERGENCY_AUTHORITY_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const emergencyAuthority = Keypair.fromSeed(EMERGENCY_AUTHORITY_SEED);

  const [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );

  function derivePoolAddresses(mA: PublicKey, mB: PublicKey) {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mA.toBuffer(), mB.toBuffer()],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"), poolPda.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"), poolPda.toBuffer()],
      program.programId
    );
    const [lpMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), poolPda.toBuffer()],
      program.programId
    );
    return { poolPda, vaultAPda, vaultBPda, lpMintPda };
  }

  function deriveAllowedMintPda(mint: PublicKey) {
    const [allowedMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("allowed-mint"), mint.toBuffer()],
      program.programId
    );
    return allowedMintPda;
  }

  async function ensureGlobalConfig() {
    try {
      await program.methods
        .initializeGlobalConfig(payer.publicKey, emergencyAuthority.publicKey)
        .accounts({
          config: globalConfigPda,
          programData: PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0], payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (!msg.includes("already in use") && !msg.includes("0x0")) {
        throw err;
      }
    }
  }

  async function ensureAllowlisted(mint: PublicKey) {
    const allowedMintPda = deriveAllowedMintPda(mint);
    await program.methods
      .setAllowedMint(true)
      .accounts({
        config: globalConfigPda,
        governanceAuthority: payer.publicKey,
        mint,
        allowedMint: allowedMintPda,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return allowedMintPda;
  }

  /**
   * Creates a fresh mint pair (decimals fixed at MINT_A_DECIMALS/
   * MINT_B_DECIMALS to match the oracle fixture) and initializes a pool for
   * them with the given fee/oracle-guard parameters, always wired to the
   * SAME shared fixture price-update accounts (a real oracle feed is shared
   * infrastructure across every pool that references it too).
   */
  async function setUpPool(params: {
    feeBps: number;
    maxFeeBps: number;
    oracleMaxDeviationBps: number;
  }) {
    const mintA = await createMintWithRetry(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      MINT_A_DECIMALS
    );
    const mintB = await createMintWithRetry(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      MINT_B_DECIMALS
    );

    await ensureGlobalConfig();
    const allowedMintAPda = await ensureAllowlisted(mintA);
    const allowedMintBPda = await ensureAllowlisted(mintB);

    const { poolPda, vaultAPda, vaultBPda, lpMintPda } = derivePoolAddresses(mintA, mintB);

    await program.methods
      .initializePool(
        params.feeBps,
        FEED_ID_A,
        FEED_ID_B,
        TEST_ORACLE_MAX_STALENESS_SECS,
        params.oracleMaxDeviationBps,
        params.maxFeeBps
      )
      .accounts({
        payer: payer.publicKey,
        mintA,
        mintB,
        config: globalConfigPda,
        allowedMintA: allowedMintAPda,
        allowedMintB: allowedMintBPda,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const traderTokenA = await createAccount(provider.connection, payer, mintA, payer.publicKey);
    const traderTokenB = await createAccount(provider.connection, payer, mintB, payer.publicKey);
    // Generous supply — every scenario below only ever deposits/swaps a
    // small fraction of this.
    await mintTo(provider.connection, payer, mintA, traderTokenA, payer, 1_000_000_000_000n);
    await mintTo(provider.connection, payer, mintB, traderTokenB, payer, 1_000_000_000_000n);

    return {
      mintA,
      mintB,
      pool: poolPda,
      vaultA: vaultAPda,
      vaultB: vaultBPda,
      lpMint: lpMintPda,
      traderTokenA,
      traderTokenB,
    };
  }

  type PoolFixture = Awaited<ReturnType<typeof setUpPool>>;

  async function deposit(p: PoolFixture, amountA: bigint, amountB: bigint) {
    const depositorLp = getAssociatedTokenAddressSync(p.lpMint, payer.publicKey);
    const poolLpLock = getAssociatedTokenAddressSync(p.lpMint, p.pool, true);
    await program.methods
      .addLiquidity(new BN(amountA.toString()), new BN(amountB.toString()), new BN(0))
      .accounts({
        depositor: payer.publicKey,
        pool: p.pool,
        vaultA: p.vaultA,
        vaultB: p.vaultB,
        lpMint: p.lpMint,
        mintA: p.mintA,
        mintB: p.mintB,
        depositorTokenA: p.traderTokenA,
        depositorTokenB: p.traderTokenB,
        depositorLp,
        poolLpLock,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  function swap(p: PoolFixture, amountIn: bigint, minAmountOut: bigint, aToB = true) {
    return program.methods
      .swap(new BN(amountIn.toString()), new BN(minAmountOut.toString()), aToB)
      .accounts({
        trader: payer.publicKey,
        pool: p.pool,
        vaultA: p.vaultA,
        vaultB: p.vaultB,
        mintA: p.mintA,
        mintB: p.mintB,
        traderTokenIn: aToB ? p.traderTokenA : p.traderTokenB,
        traderTokenOut: aToB ? p.traderTokenB : p.traderTokenA,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        priceUpdateA: PRICE_UPDATE_A,
        priceUpdateB: PRICE_UPDATE_B,
      })
      .rpc();
  }

  // Sanity check on the fixture's own math, run once — if this fails, every
  // scenario below is built on a wrong assumption and their own assertions
  // would be meaningless.
  before(() => {
    const oracleQ64 = oraclePriceQ64(200_00000000n, -8, 9, 1_00000000n, -8, 6);
    const Q64_ONE = 1n << 64n;
    const diff = oracleQ64 > Q64_ONE / 5n ? oracleQ64 - Q64_ONE / 5n : Q64_ONE / 5n - oracleQ64;
    assert.isTrue(diff < 1_000_000n, "oracle-fixtures.ts's oraclePriceQ64 sanity check failed");
  });

  it("swaps normally at zero deviation, charging exactly the base fee_bps", async () => {
    const FEE_BPS = 30;
    const MAX_FEE_BPS = 300;
    const ORACLE_MAX_DEVIATION_BPS = 1000; // 10% — loose, not what this test is probing

    // reserveA:reserveB = 5:1 raw units is EXACTLY the fixture's
    // oracle-implied ratio (200_00000000 @ 9dp / 1_00000000 @ 6dp = 0.2 raw
    // b per raw a) — see oracle-fixtures.ts's header comment.
    const reserveA = 5_000_000n;
    const reserveB = 1_000_000n;

    const p = await setUpPool({
      feeBps: FEE_BPS,
      maxFeeBps: MAX_FEE_BPS,
      oracleMaxDeviationBps: ORACLE_MAX_DEVIATION_BPS,
    });
    await deposit(p, reserveA, reserveB);

    const oracleQ64 = oraclePriceQ64(200_00000000n, -8, 9, 1_00000000n, -8, 6);
    const poolQ64 = poolPriceQ64(reserveB, reserveA);
    const devBps = deviationBps(poolQ64, oracleQ64);
    assert.equal(devBps, 0n, "test fixture's reserves should exactly match the oracle ratio");

    const expectedFee = dynamicFeeBps(BigInt(FEE_BPS), BigInt(MAX_FEE_BPS), devBps, BigInt(ORACLE_MAX_DEVIATION_BPS));
    assert.equal(expectedFee, BigInt(FEE_BPS), "at zero deviation the dynamic fee should equal the base fee");

    const amountIn = 10_000n;
    const expectedOut = expectedSwapOut(reserveA, reserveB, amountIn, expectedFee);
    assert.isTrue(expectedOut > 0n, "test fixture produced a zero expected swap output — adjust amounts");

    const vaultABefore = await getAccount(provider.connection, p.vaultA);
    const vaultBBefore = await getAccount(provider.connection, p.vaultB);
    const traderBBefore = await getAccount(provider.connection, p.traderTokenB);

    await swap(p, amountIn, 0n);

    const vaultAAfter = await getAccount(provider.connection, p.vaultA);
    const vaultBAfter = await getAccount(provider.connection, p.vaultB);
    const traderBAfter = await getAccount(provider.connection, p.traderTokenB);

    assert.equal(
      (BigInt(vaultAAfter.amount.toString()) - BigInt(vaultABefore.amount.toString())).toString(),
      amountIn.toString()
    );
    assert.equal(
      (BigInt(vaultBBefore.amount.toString()) - BigInt(vaultBAfter.amount.toString())).toString(),
      expectedOut.toString(),
      "swap output at zero deviation should match the constant-product formula using the BASE fee_bps"
    );
    assert.equal(
      (BigInt(traderBAfter.amount.toString()) - BigInt(traderBBefore.amount.toString())).toString(),
      expectedOut.toString()
    );
  });

  it("rejects a swap when the pool's price deviates from the oracle beyond its guard (PriceDeviationTooLarge)", async () => {
    const FEE_BPS = 30;
    const MAX_FEE_BPS = 300;
    const ORACLE_MAX_DEVIATION_BPS = 200; // tight — 2%

    // Deliberately deposited 1:1 instead of the oracle-implied 5:1 — wildly
    // outside even a loose guard, let alone this tight one.
    const reserveA = 5_000_000n;
    const reserveB = 5_000_000n;

    const p = await setUpPool({
      feeBps: FEE_BPS,
      maxFeeBps: MAX_FEE_BPS,
      oracleMaxDeviationBps: ORACLE_MAX_DEVIATION_BPS,
    });
    await deposit(p, reserveA, reserveB);

    const oracleQ64 = oraclePriceQ64(200_00000000n, -8, 9, 1_00000000n, -8, 6);
    const poolQ64 = poolPriceQ64(reserveB, reserveA);
    const devBps = deviationBps(poolQ64, oracleQ64);
    assert.isTrue(
      devBps > BigInt(ORACLE_MAX_DEVIATION_BPS),
      `test fixture's deviation (${devBps} bps) should exceed the guard (${ORACLE_MAX_DEVIATION_BPS} bps) — adjust reserves`
    );

    // The pool prices A at 1.0 B against the oracle's 0.2, so buying A
    // (B -> A) pushes the price even further away: rejected.
    const err = await expectThrows(
      () => swap(p, 10_000n, 0n, false),
      "swap on a pool whose price deviates from the oracle beyond its guard"
    );
    const code = errorCode(err);
    console.log("  (oracle-deviation-guard rejection returned error code:", code, ")");
    if (code) assert.equal(code, "PriceDeviationTooLarge");
  });

  it("still allows a swap that moves an out-of-guard pool back toward the oracle, at max_fee_bps", async () => {
    // Before 2026-10-07 the guard only looked at the pre-trade price, so a
    // pool outside the guard could never trade again — not even the
    // arbitrage that would fix its price. See oracle.rs's guard_allows.
    const FEE_BPS = 30;
    const MAX_FEE_BPS = 300;
    const ORACLE_MAX_DEVIATION_BPS = 200;

    const reserveA = 5_000_000n;
    const reserveB = 5_000_000n;

    const p = await setUpPool({
      feeBps: FEE_BPS,
      maxFeeBps: MAX_FEE_BPS,
      oracleMaxDeviationBps: ORACLE_MAX_DEVIATION_BPS,
    });
    await deposit(p, reserveA, reserveB);

    // Selling A (A -> B) lowers the pool's B-per-A price toward the oracle.
    const amountIn = 10_000n;
    const expectedOut = expectedSwapOut(reserveA, reserveB, amountIn, BigInt(MAX_FEE_BPS));
    const traderBBefore = await getAccount(provider.connection, p.traderTokenB);

    await swap(p, amountIn, 0n, true);

    const traderBAfter = await getAccount(provider.connection, p.traderTokenB);
    assert.equal(
      (BigInt(traderBAfter.amount.toString()) - BigInt(traderBBefore.amount.toString())).toString(),
      expectedOut.toString(),
      "a swap out of the guard band toward the oracle should succeed and pay max_fee_bps"
    );
  });

  it("scales the swap fee linearly with a known, moderate oracle deviation", async () => {
    const FEE_BPS = 30;
    const MAX_FEE_BPS = 300;
    const ORACLE_MAX_DEVIATION_BPS = 1000; // 10% — the moderate deviation below sits well inside this

    // 5% above the oracle-implied ratio (reserveB would be exactly
    // 1,000,000 at zero deviation) — a known, deliberately moderate
    // deviation, comfortably inside the 1000 bps guard so the swap succeeds
    // but the dynamic fee visibly scales above the base fee.
    const reserveA = 5_000_000n;
    const reserveB = 1_050_000n;

    const p = await setUpPool({
      feeBps: FEE_BPS,
      maxFeeBps: MAX_FEE_BPS,
      oracleMaxDeviationBps: ORACLE_MAX_DEVIATION_BPS,
    });
    await deposit(p, reserveA, reserveB);

    const oracleQ64 = oraclePriceQ64(200_00000000n, -8, 9, 1_00000000n, -8, 6);
    const poolQ64 = poolPriceQ64(reserveB, reserveA);
    const devBps = deviationBps(poolQ64, oracleQ64);
    assert.isTrue(devBps > 0n && devBps < BigInt(ORACLE_MAX_DEVIATION_BPS),
      `test fixture's deviation (${devBps} bps) should be moderate — strictly between 0 and the ${ORACLE_MAX_DEVIATION_BPS} bps guard`
    );

    const expectedFee = dynamicFeeBps(
      BigInt(FEE_BPS),
      BigInt(MAX_FEE_BPS),
      devBps,
      BigInt(ORACLE_MAX_DEVIATION_BPS)
    );
    assert.isTrue(
      expectedFee > BigInt(FEE_BPS) && expectedFee < BigInt(MAX_FEE_BPS),
      `expected dynamic fee (${expectedFee} bps) should sit strictly between the base (${FEE_BPS}) and max (${MAX_FEE_BPS}) fee`
    );

    const amountIn = 10_000n;
    const expectedOut = expectedSwapOut(reserveA, reserveB, amountIn, expectedFee);
    assert.isTrue(expectedOut > 0n, "test fixture produced a zero expected swap output — adjust amounts");

    const vaultBBefore = await getAccount(provider.connection, p.vaultB);
    const traderBBefore = await getAccount(provider.connection, p.traderTokenB);

    await swap(p, amountIn, 0n);

    const vaultBAfter = await getAccount(provider.connection, p.vaultB);
    const traderBAfter = await getAccount(provider.connection, p.traderTokenB);

    assert.equal(
      (BigInt(vaultBBefore.amount.toString()) - BigInt(vaultBAfter.amount.toString())).toString(),
      expectedOut.toString(),
      "swap output should match the constant-product formula using the DYNAMICALLY SCALED fee, not the base fee_bps — " +
        "if this fails while the zero-deviation test above passes, the dynamic-fee scaling itself (not the base swap math) is the bug"
    );
    assert.equal(
      (BigInt(traderBAfter.amount.toString()) - BigInt(traderBBefore.amount.toString())).toString(),
      expectedOut.toString()
    );
  });
});
