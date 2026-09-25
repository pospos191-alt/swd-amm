// Test suite for the DLMM (concentrated liquidity, bin-based) pool type
// added in programs/swd_amm/src/dlmm.rs.
//
// STATUS (written 2026-09-09, alongside dlmm.rs itself): UNRUN. This file
// has never been executed — dlmm.rs was reviewed line-by-line (catching
// and fixing two real bugs before this was ever compiled — see dlmm.rs's
// own comments on `bin_price_q64` and `initialize_dlmm_pool` for what was
// wrong and why), but neither the Rust code nor this test file has been
// compiled or run yet. Treat every test here as unverified until `anchor
// test` has actually been run against it and you've read the output —
// same rule as the rest of this program, doubly so for something this new.
//
// Run with `anchor test` from the project root (tests/**/*.ts is picked up
// automatically per Anchor.toml's [scripts] test glob) once `anchor build`
// succeeds. Does NOT need a separate command — it runs alongside
// tests/swd_amm.ts in the same `anchor test` invocation.
//
// UPDATE (2026-09-22): initialize_dlmm_pool now requires GlobalConfig +
// an enabled AllowedMint entry for both mints (see the governance layer
// added to lib.rs/dlmm.rs/governance.rs). This file's `before()` hook now
// bootstraps both via the same idempotent ensureGlobalConfig()/
// ensureAllowlisted() pattern tests/swd_amm.ts uses — idempotent because
// mocha runs every tests/*.ts file in one shared `anchor test` invocation
// against the same localnet validator, and GlobalConfig can only ever be
// `init`ed once across all of them, regardless of which file's `before`
// hook runs first.
//
// SCOPE: covers pool init, single-sided add-liquidity above/below the
// active bin, mixed add-liquidity AT the active bin, the single-sided-rule
// rejection, the per-bin minimum-liquidity floor (MIN_BIN_LIQUIDITY —
// dlmm.rs's analogue of the constant-product pool's donation-resistance
// MINIMUM_LIQUIDITY), a swap that crosses multiple bins, and
// remove_dlmm_liquidity. NOT covered: devnet, fuzzing the Q64.64 math
// end-to-end through real transactions (that's what dlmm.rs's own
// `#[cfg(test)] mod dlmm_math_tests`, run via `cargo test`, is for),
// exhausting the whole MAX_BINS_CROSSED_PER_SWAP limit, or the
// RangeTooWide/AmountsLengthMismatch/BinOutOfRange edge cases individually
// (each is a single `require!` in dlmm.rs and lower-risk than the
// mechanics this file does cover).

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import { LEGACY_POOLS, LEGACY_ORACLE_MAX_DEVIATION_BPS, LEGACY_MAX_FEE_BPS, TEST_ORACLE_MAX_STALENESS_SECS } from "./oracle-fixtures";

// TODO: once `anchor build` has generated target/types/swd_amm.ts, replace
// `anchor.Program<any>` with `Program<SwdAmm>` for full type safety on
// `.methods.*` calls below — same TODO as tests/swd_amm.ts.
// import { SwdAmm } from "../target/types/swd_amm";

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

describe("swd_amm — dlmm", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwdAmm as anchor.Program<any>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Deterministic across ALL THREE test files (dlmm.ts, governance.ts,
  // swd_amm.ts) that call initializeGlobalConfig — see the "Round 3" note
  // in SECURITY.md's Governance layer section for the full story. mocha
  // runs tests/*.ts alphabetically, so dlmm.ts's before() hook is the one
  // that actually creates the on-chain GlobalConfig singleton (its `init`
  // constraint means only the FIRST successful call sets anything); every
  // other file's ensureGlobalConfig() just catches "already in use" and
  // moves on. A later file can only sign as emergency_authority if it
  // reconstructs the EXACT SAME keypair the winning file used — a fresh
  // Keypair.generate() per file (the original, buggy approach) produces a
  // different keypair in each file's own process memory, so whichever
  // file didn't win the race held a keypair for a pubkey that was never
  // actually stored on-chain. Fixed by deriving all three from the same
  // fixed seed, so they're identical regardless of run order.
  const EMERGENCY_AUTHORITY_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const emergencyAuthority = Keypair.fromSeed(EMERGENCY_AUTHORITY_SEED);

  const [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );

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
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (!msg.includes("already in use") && !msg.includes("0x0")) {
        throw err;
      }
      // Already initialized by an earlier test file in this same run.
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

  const BIN_STEP_BPS = 25; // 0.25% per bin — must match dlmm.rs's MAX_BIN_STEP_BPS ceiling (1000) with room to spare
  const FEE_BPS = 30;
  const ACTIVE_BIN_ID = 0; // keep small/near zero so the off-chain float price check below stays simple

  let mintA: PublicKey;
  let mintB: PublicKey;
  let depositorTokenA: PublicKey;
  let depositorTokenB: PublicKey;

  let pool: PublicKey;
  let binArray: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  const INITIAL_MINT_SUPPLY = 1_000_000_000_000n;

  function derivePoolAddresses(mA: PublicKey, mB: PublicKey) {
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dlmm_pool"), mA.toBuffer(), mB.toBuffer()],
      program.programId
    );
    const [binArrayPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dlmm_bin_array"), poolPda.toBuffer()],
      program.programId
    );
    const [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dlmm_vault_a"), poolPda.toBuffer()],
      program.programId
    );
    const [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dlmm_vault_b"), poolPda.toBuffer()],
      program.programId
    );
    return { poolPda, binArrayPda, vaultAPda, vaultBPda };
  }

  function derivePosition(poolKey: PublicKey, owner: PublicKey, binIdLower: number, binIdUpper: number) {
    const lowerBuf = Buffer.alloc(4);
    lowerBuf.writeInt32LE(binIdLower);
    const upperBuf = Buffer.alloc(4);
    upperBuf.writeInt32LE(binIdUpper);
    const [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dlmm_position"), poolKey.toBuffer(), owner.toBuffer(), lowerBuf, upperBuf],
      program.programId
    );
    return positionPda;
  }

  /** Off-chain float mirror of dlmm.rs's bin_price_q64, for approximate
   * (not bit-exact) assertions only — the exact Q64.64 math is already
   * covered bit-for-bit by dlmm.rs's own `cargo test` suite. */
  function binPriceApprox(binId: number, binStepBps: number): number {
    return Math.pow(1 + binStepBps / 10_000, binId);
  }

  async function addDlmmLiquidity(
    depositor: Keypair,
    depTokenA: PublicKey,
    depTokenB: PublicKey,
    binIdLower: number,
    binIdUpper: number,
    amounts: { amountA: bigint; amountB: bigint }[]
  ) {
    const position = derivePosition(pool, depositor.publicKey, binIdLower, binIdUpper);
    await program.methods
      .addDlmmLiquidity(
        binIdLower,
        binIdUpper,
        amounts.map((a) => ({ amountA: new BN(a.amountA.toString()), amountB: new BN(a.amountB.toString()) }))
      )
      .accounts({
        depositor: depositor.publicKey,
        pool,
        binArray,
        vaultA,
        vaultB,
        depositorTokenA: depTokenA,
        depositorTokenB: depTokenB,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(depositor === payer ? [] : [depositor])
      .rpc();
    return { position };
  }

  before(async () => {
    mintA = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    mintB = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    depositorTokenA = await createAccount(provider.connection, payer, mintA, payer.publicKey);
    depositorTokenB = await createAccount(provider.connection, payer, mintB, payer.publicKey);
    await mintTo(provider.connection, payer, mintA, depositorTokenA, payer, INITIAL_MINT_SUPPLY);
    await mintTo(provider.connection, payer, mintB, depositorTokenB, payer, INITIAL_MINT_SUPPLY);

    await ensureGlobalConfig();
    await ensureAllowlisted(mintA);
    await ensureAllowlisted(mintB);

    const { poolPda, binArrayPda, vaultAPda, vaultBPda } = derivePoolAddresses(mintA, mintB);
    pool = poolPda;
    binArray = binArrayPda;
    vaultA = vaultAPda;
    vaultB = vaultBPda;
  });

  it("initializes a DLMM pool", async () => {
    await program.methods
      .initializeDlmmPool(
        BIN_STEP_BPS,
        FEE_BPS,
        ACTIVE_BIN_ID,
        LEGACY_POOLS.ratioOne.feedIdA,
        LEGACY_POOLS.ratioOne.feedIdB,
        TEST_ORACLE_MAX_STALENESS_SECS,
        LEGACY_ORACLE_MAX_DEVIATION_BPS,
        LEGACY_MAX_FEE_BPS
      )
      .accounts({
        payer: payer.publicKey,
        mintA,
        mintB,
        config: globalConfigPda,
        allowedMintA: deriveAllowedMintPda(mintA),
        allowedMintB: deriveAllowedMintPda(mintB),
        pool,
        binArray,
        vaultA,
        vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const poolAccount = await program.account.dlmmPool.fetch(pool);
    assert.equal(poolAccount.binStepBps, BIN_STEP_BPS);
    assert.equal(poolAccount.feeBps, FEE_BPS);
    assert.equal(poolAccount.activeBinId, ACTIVE_BIN_ID);
    assert.equal(poolAccount.minBinId, ACTIVE_BIN_ID - 100); // HALF_RANGE in dlmm.rs
    assert.equal(poolAccount.maxBinId, ACTIVE_BIN_ID + 100);
  });

  it("adds single-sided liquidity ABOVE the active bin (ask side, mint_a only)", async () => {
    const binIdLower = ACTIVE_BIN_ID + 1;
    const binIdUpper = ACTIVE_BIN_ID + 3;
    const amountEach = 5_000_000n;
    const before_ = await getAccount(provider.connection, vaultA);

    await addDlmmLiquidity(payer, depositorTokenA, depositorTokenB, binIdLower, binIdUpper, [
      { amountA: amountEach, amountB: 0n },
      { amountA: amountEach, amountB: 0n },
      { amountA: amountEach, amountB: 0n },
    ]);

    const after = await getAccount(provider.connection, vaultA);
    assert.equal((after.amount - before_.amount).toString(), (amountEach * 3n).toString());
  });

  it("adds single-sided liquidity BELOW the active bin (bid side, mint_b only)", async () => {
    const binIdLower = ACTIVE_BIN_ID - 3;
    const binIdUpper = ACTIVE_BIN_ID - 1;
    const amountEach = 5_000_000n;
    const before_ = await getAccount(provider.connection, vaultB);

    await addDlmmLiquidity(payer, depositorTokenA, depositorTokenB, binIdLower, binIdUpper, [
      { amountA: 0n, amountB: amountEach },
      { amountA: 0n, amountB: amountEach },
      { amountA: 0n, amountB: amountEach },
    ]);

    const after = await getAccount(provider.connection, vaultB);
    assert.equal((after.amount - before_.amount).toString(), (amountEach * 3n).toString());
  });

  it("adds liquidity AT the active bin (both sides)", async () => {
    const amountA = 2_000_000n;
    const amountB = 2_000_000n; // price ~1.0 at bin 0, so a 1:1 deposit matches the bootstrap ratio
    const beforeA = await getAccount(provider.connection, vaultA);
    const beforeB = await getAccount(provider.connection, vaultB);

    await addDlmmLiquidity(payer, depositorTokenA, depositorTokenB, ACTIVE_BIN_ID, ACTIVE_BIN_ID, [
      { amountA, amountB },
    ]);

    const afterA = await getAccount(provider.connection, vaultA);
    const afterB = await getAccount(provider.connection, vaultB);
    assert.equal((afterA.amount - beforeA.amount).toString(), amountA.toString());
    assert.equal((afterB.amount - beforeB.amount).toString(), amountB.toString());
  });

  it("rejects a bin ABOVE active receiving mint_b (single-sided violation)", async () => {
    const err = await expectThrows(
      () =>
        addDlmmLiquidity(payer, depositorTokenA, depositorTokenB, ACTIVE_BIN_ID + 10, ACTIVE_BIN_ID + 10, [
          { amountA: 1_000_000n, amountB: 1_000n }, // illegal: above active bin, but amount_b != 0
        ]),
      "single-sided violation above active bin"
    );
    const code = errorCode(err);
    if (code) assert.equal(code, "SingleSidedViolation");
  });

  it("rejects a bin's first deposit below MIN_BIN_LIQUIDITY", async () => {
    // A brand-new bin (never touched by the tests above) whose first
    // deposit is smaller than dlmm.rs's MIN_BIN_LIQUIDITY (10) must be
    // rejected — this is the DLMM analogue of the constant-product pool's
    // MINIMUM_LIQUIDITY/first-depositor donation-resistance test.
    const err = await expectThrows(
      () =>
        addDlmmLiquidity(payer, depositorTokenA, depositorTokenB, ACTIVE_BIN_ID + 50, ACTIVE_BIN_ID + 50, [
          { amountA: 5n, amountB: 0n }, // raw_shares = 5, <= MIN_BIN_LIQUIDITY (10)
        ]),
      "bin first-deposit floor"
    );
    const code = errorCode(err);
    if (code) assert.equal(code, "InsufficientBinLiquidity");
  });

  it("swaps mint_a for mint_b, crossing multiple bins", async () => {
    // At this point the active bin (0) and bins -3..-1 (bid side, mint_b)
    // hold liquidity from the earlier tests. Selling mint_a should drain
    // bin 0's mint_b first, then cross down into bin -1, -2, ... consuming
    // each bin's mint_b in turn (see dlmm.rs's swap_dlmm doc comment for
    // why a_to_b moves the active bin DOWN).
    const trader = payer;
    const traderTokenIn = depositorTokenA;
    const traderTokenOut = depositorTokenB;

    const poolBefore = await program.account.dlmmPool.fetch(pool);
    const vaultAInBefore = await getAccount(provider.connection, vaultA);
    const vaultBOutBefore = await getAccount(provider.connection, vaultB);

    // Large enough (relative to the 3x 5,000,000-unit bid-side bins added
    // above) to exhaust bin 0 and bin -1 and land partway into bin -2 —
    // i.e. a genuine multi-bin crossing, not a single-bin trade.
    const amountIn = 9_000_000n;
    const minAmountOut = 1n; // loose bound; exactness is dlmm.rs's cargo-test job, this checks the mechanics

    await program.methods
      .swapDlmm(new BN(amountIn.toString()), new BN(minAmountOut.toString()), true)
      .accounts({
        trader: trader.publicKey,
        pool,
        binArray,
        vaultA,
        vaultB,
        traderTokenIn,
        traderTokenOut,
        tokenProgram: TOKEN_PROGRAM_ID,
        priceUpdateA: LEGACY_POOLS.ratioOne.priceUpdateA,
        priceUpdateB: LEGACY_POOLS.ratioOne.priceUpdateB,
      })
      .rpc();

    const poolAfter = await program.account.dlmmPool.fetch(pool);
    const vaultAInAfter = await getAccount(provider.connection, vaultA);
    const vaultBOutAfter = await getAccount(provider.connection, vaultB);

    // The trade must have crossed at least one bin (active bin moved down
    // from where it started) — this is the actual thing this test exists
    // to prove, distinct from tests/swd_amm.ts's single-pool swap test.
    assert.isBelow(poolAfter.activeBinId, poolBefore.activeBinId, "active bin should have moved down");

    // Conservation sanity checks (approximate, via the float price mirror,
    // generous tolerance — exact fixed-point correctness is dlmm.rs's own
    // cargo-test job): input actually left the trader's side...
    const vaultAIn = vaultAInAfter.amount - vaultAInBefore.amount;
    assert.equal(vaultAIn.toString(), amountIn.toString());
    // ...output actually came out, and roughly matches a fee-adjusted,
    // near-1.0-price conversion (bins -3..0 are all within a few bps of
    // price 1.0 given BIN_STEP_BPS=25 and activeBinId=0).
    const vaultBOut = vaultBOutBefore.amount - vaultBOutAfter.amount;
    assert.isAbove(Number(vaultBOut), 0);
    const feeAdjusted = (Number(amountIn) * (10_000 - FEE_BPS)) / 10_000;
    assert.approximately(Number(vaultBOut), feeAdjusted, feeAdjusted * 0.02, "swap output far from the expected ~1:1 (within 2%) conversion");
  });

  it("removes liquidity from the active bin", async () => {
    const position = derivePosition(pool, payer.publicKey, ACTIVE_BIN_ID, ACTIVE_BIN_ID);
    const positionBefore = await program.account.position.fetch(position);
    const sharesHeld = positionBefore.shares[0] as BN;
    assert.isTrue(sharesHeld.gtn(0), "expected the active-bin position from the earlier test to hold shares");

    const beforeA = await getAccount(provider.connection, depositorTokenA);
    const beforeB = await getAccount(provider.connection, depositorTokenB);

    await program.methods
      .removeDlmmLiquidity([sharesHeld], new BN(0), new BN(0))
      .accounts({
        owner: payer.publicKey,
        pool,
        binArray,
        vaultA,
        vaultB,
        ownerTokenA: depositorTokenA,
        ownerTokenB: depositorTokenB,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const afterA = await getAccount(provider.connection, depositorTokenA);
    const afterB = await getAccount(provider.connection, depositorTokenB);
    const gainedA = afterA.amount - beforeA.amount;
    const gainedB = afterB.amount - beforeB.amount;
    assert.isTrue(gainedA > 0n || gainedB > 0n, "removing liquidity should return at least one side's tokens");

    const positionAfter = await program.account.position.fetch(position);
    assert.equal((positionAfter.shares[0] as BN).toString(), "0");
  });
});
