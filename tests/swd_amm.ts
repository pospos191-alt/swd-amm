// Test suite for the SWD AMM program.
//
// STATUS (updated 2026-09-08): all tests below pass on localnet, including
// after the internal-reserve-tracking + MIN_INITIAL_DEPOSIT fix for the
// first-depositor/donation attack (see lib.rs's `Pool.reserve_a` doc
// comment and SECURITY.md for the full writeup of what changed and why).
//
// Run with `anchor test` from this directory (spins up a local validator
// automatically) once `yarn install` (or `npm install`) has been run. The
// pure-math fuzz tests for `integer_sqrt`/`mul_div` are SEPARATE from this
// file — they're plain Rust unit tests in lib.rs's `#[cfg(test)] mod
// tests`, run with `cargo test` (from `programs/swd_amm/` or the workspace
// root), not `anchor test`.
//
// COVERAGE: happy paths for all four instructions with exact balance
// assertions, slippage/zero-amount rejections, the account-substitution
// attack (the single most important test here — see its comment), the
// minimum-first-deposit floor, the first-depositor/donation attack
// (asserted to have ZERO effect on a later depositor's LP, not just
// "measured"), a repeated-swap k-invariant check, numerical exactness at
// true-maximum scale (a pool holding an entire u64::MAX-supply mint — see
// that test's comment for why an actual "overflow the vault" scenario is
// provably impossible and therefore not what's tested), and full isolation
// across multiple concurrent pools. NOT covered yet, and still needed
// before SECURITY.md's checklist item 3 can be considered fully done:
// devnet testing (everything here runs on a fresh localnet validator only).

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  transfer as splTransfer,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import { LEGACY_POOLS, LEGACY_ORACLE_MAX_DEVIATION_BPS, LEGACY_MAX_FEE_BPS, TEST_ORACLE_MAX_STALENESS_SECS } from "./oracle-fixtures";

// TODO: once `anchor build` has generated target/types/swd_amm.ts, replace
// `anchor.Program<any>` with `Program<SwdAmm>` and uncomment this import for full
// type safety on `.methods.*` calls below.
// import { SwdAmm } from "../target/types/swd_amm";

// ---------------------------------------------------------------------
// Off-chain mirrors of the on-chain integer math (lib.rs `mul_div` and
// `integer_sqrt`). Used to compute exact expected values so assertions
// check "the math is right", not just "no error was thrown". These MUST
// stay in lockstep with lib.rs — if you change the on-chain formula,
// change these too.
// ---------------------------------------------------------------------

function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("mulDiv: denom is 0");
  return (a * b) / denom; // bigint division floors, matching u128 checked_div
}

function integerSqrt(value: bigint): bigint {
  if (value === 0n) return 0n;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

const MINIMUM_LIQUIDITY = 1000n;
// Must match lib.rs's `MIN_INITIAL_DEPOSIT` exactly.
const MIN_INITIAL_DEPOSIT = 1_000_000n;

/** Mirrors the `swap` instruction's constant-product-with-fee formula. */
function expectedSwapOut(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: bigint
): bigint {
  const feeMultiplier = 10_000n - feeBps;
  const amountInAfterFee = (amountIn * feeMultiplier) / 10_000n;
  const k = reserveIn * reserveOut;
  const newReserveIn = reserveIn + amountInAfterFee;
  const newReserveOutFloor = k / newReserveIn;
  return reserveOut - newReserveOutFloor;
}

/**
 * Runs `fn`, asserts it threw, and returns the caught error so the caller
 * can optionally inspect it further. Anchor wraps program errors in
 * `AnchorError` with `.error.errorCode.code` set to the Rust error enum's
 * variant name (e.g. "SlippageExceeded") — but the exact code names for
 * *account constraint* failures (e.g. the `address = pool.vault_a` check)
 * come from Anchor's own internal error set (things like
 * "ConstraintAddress") rather than our SwdAmmError enum, and the precise
 * string has not been confirmed against a real build. Where that
 * distinction matters, the test logs the actual code so you can tighten
 * the assertion after the first real run.
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

/**
 * Wraps `createMint` with a retry-on-stale-blockhash loop.
 *
 * ADDED 2026-09-09 after real devnet testing (see SECURITY.md's "devnet
 * testing" section for the full log): every `createMint` call AFTER the
 * first pair in this file's `before` hook reliably failed with
 * `Simulation failed: Blockhash not found` on devnet — reproduced
 * identically against BOTH the public `api.devnet.solana.com` endpoint
 * (with heavy 429 rate-limiting) AND a private Helius devnet RPC endpoint
 * (with zero 429s), so it is not a rate-limit artifact. The failure always
 * happened before any of our own program instructions ran (`createMint` is
 * a plain SPL Token program call), so it is not a bug in swd_amm's logic —
 * these same tests already have a fully-passing localnet track record.
 *
 * Root cause is most likely load-balanced devnet RPC backends being
 * momentarily out of sync (the node that answers `getLatestBlockhash()`
 * isn't the node that ends up validating `sendTransaction`, so it rejects
 * a blockhash it hasn't seen yet) — a known class of issue with shared
 * devnet infrastructure, not something a test or client can fix at the
 * root. The practical fix is to retry: each retry calls `createMint` fresh,
 * which fetches a brand-new blockhash from scratch, so a transient
 * node-sync mismatch on one attempt does not repeat on the next.
 */
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
      console.log(
        `  (createMint hit "${msg.split("\n")[0]}" — retrying in ${delayMs}ms, attempt ${
          attempt + 1
        }/${retries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable — the loop above always either returns or throws — but
  // TypeScript can't see that, so satisfy the return type.
  throw lastErr;
}

// UPDATED 2026-09-22: initializePool now requires 3 additional accounts
// (config, allowedMintA, allowedMintB) because pool creation is gated by
// governance.rs's allowlist — see that file's module doc comment in
// lib.rs/governance.rs for why. `initPool()` below bootstraps a
// GlobalConfig once (in `before`) and allowlists every mint pair it's
// asked to create a pool for, so every existing test keeps working
// unmodified from the outside — only `initPool`'s own internals changed.
// Dedicated governance/allowlist/pause tests live in tests/governance.ts,
// not here, to keep this file's existing scope (the constant-product
// pool's own math/security properties) unchanged.

describe("swd_amm", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // TODO: const program = anchor.workspace.SwdAmm as Program<SwdAmm>;
  const program = anchor.workspace.SwdAmm as anchor.Program<any>;

  const payer = (provider.wallet as anchor.Wallet).payer;

  const FEE_BPS = 30; // 0.30%, a common default — chosen for these tests, not a recommendation

  // ---- Shared pool fixtures (created once in `before`, reused by the
  // happy-path tests in order — each test's starting state depends on the
  // previous one, which is deliberate: it exercises the pool across a
  // realistic sequence of deposits/swaps/withdrawals rather than resetting
  // to a fresh pool every time). ----
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

  let mintA: PublicKey;
  let mintB: PublicKey;
  let depositor: Keypair;
  let depositorTokenA: PublicKey;
  let depositorTokenB: PublicKey;
  let pool: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let lpMint: PublicKey;
  let depositorLp: PublicKey;
  let poolLpLock: PublicKey;

  const INITIAL_MINT_SUPPLY = 1_000_000_000_000n; // 1,000,000 tokens at 6 decimals

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

  // Bootstraps the one GlobalConfig singleton, at most once per test run —
  // `initializeGlobalConfig`'s `init` constraint fails on a second call
  // (see governance.rs), and every test file in this suite shares the
  // SAME localnet validator instance / program deployment within one
  // `anchor test` run, so a second `describe` block's `before` hook
  // calling this again would fail — guard with try/catch so this file
  // stays runnable whether it executes before or after tests/governance.ts.
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
      // Already initialized by an earlier test file in this same run —
      // that's fine, this function is meant to be idempotent-ish.
    }
  }

  // Governance-only, and this suite's `governanceAuthority` is just
  // `payer` (see `ensureGlobalConfig` above) — idempotent: calling this
  // again for an already-enabled mint just re-writes the same `enabled:
  // true`, which is harmless.
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

  // "Phase 3" (2026-09-24): `oracleFeed` defaults to LEGACY_POOLS.ratioOne
  // (a 1:1 raw-b-per-raw-a oracle price) — right for every pool in this
  // file that either never calls `swap` at all, or only needs the swap
  // to be SYNTACTICALLY valid (its test expects a DIFFERENT error to
  // fire before the oracle guard is ever reached). The one pool that
  // actually swaps and asserts an EXACT off-chain-computed output
  // (`expectedSwapOut`, a flat fee_bps formula with no deviation-based
  // fee scaling) passes LEGACY_POOLS.ratioFour explicitly below, chosen
  // to exactly match ITS deliberate 1:4 initial deposit ratio — zero
  // deviation means the on-chain dynamic fee equals the base fee_bps
  // exactly, so that pre-existing flat-fee assertion stays valid
  // unchanged. See tests/oracle-fixtures.ts's LEGACY_POOLS comment for
  // the full rationale and scripts/gen-pyth-fixtures.js for how each
  // fixture price was derived.
  async function initPool(
    mA: PublicKey,
    mB: PublicKey,
    feeBps: number,
    oracleFeed: typeof LEGACY_POOLS.ratioOne = LEGACY_POOLS.ratioOne
  ) {
    await ensureGlobalConfig();
    const allowedMintAPda = await ensureAllowlisted(mA);
    const allowedMintBPda = await ensureAllowlisted(mB);
    const { poolPda, vaultAPda, vaultBPda, lpMintPda } = derivePoolAddresses(mA, mB);
    await program.methods
      .initializePool(
        feeBps,
        oracleFeed.feedIdA,
        oracleFeed.feedIdB,
        TEST_ORACLE_MAX_STALENESS_SECS,
        LEGACY_ORACLE_MAX_DEVIATION_BPS,
        LEGACY_MAX_FEE_BPS
      )
      .accounts({
        payer: payer.publicKey,
        mintA: mA,
        mintB: mB,
        config: globalConfigPda,
        allowedMintA: allowedMintAPda,
        allowedMintB: allowedMintBPda,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        // UPDATED 2026-09-23: Token-2022 support (lib.rs's `InitializePool`)
        // split the single `tokenProgram` field into `tokenProgramA`/
        // `tokenProgramB` (one per side's own vault/mint) — `tokenProgram`
        // itself stays, now specifically for the LP mint, which is always
        // classic SPL Token. Every mint used by this whole test file is a
        // classic SPL Token mint, so all three are the same program id.
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return { poolPda, vaultAPda, vaultBPda, lpMintPda };
  }

  /**
   * Funds `to` with `lamports` of SOL by transferring from `payer`, instead
   * of requesting a fresh faucet airdrop for every throwaway test keypair.
   *
   * On localnet this is equivalent either way (the local validator funds
   * `payer` generously by default). On devnet it matters: a faucet airdrop
   * is rate-limited per IP, so if `payer` already had to go through the web
   * faucet once to afford `anchor deploy`, a second and third
   * `requestAirdrop` call later in this same run (previously done for the
   * `attacker`/`victim` keypairs below) reliably gets rejected with the
   * same "rate limit reached" error. Funding everyone from the one
   * already-funded `payer` via a plain SOL transfer sidesteps the faucet
   * entirely after the first top-up (2026-09-08, devnet testing).
   */
  async function fundWithSol(to: PublicKey, lamports: number) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: to,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx, [payer]);
  }

  async function addLiquidity(
    depositorKp: Keypair,
    depTokenA: PublicKey,
    depTokenB: PublicKey,
    amountA: bigint,
    amountB: bigint,
    minLpOut: bigint
  ) {
    const depLp = getAssociatedTokenAddressSync(lpMint, depositorKp.publicKey);
    const poolLp = getAssociatedTokenAddressSync(lpMint, pool, true);
    await program.methods
      .addLiquidity(new BN(amountA.toString()), new BN(amountB.toString()), new BN(minLpOut.toString()))
      .accounts({
        depositor: depositorKp.publicKey,
        pool,
        vaultA,
        vaultB,
        lpMint,
        // NEW 2026-09-23: `AddLiquidity` now needs the actual mint accounts
        // (not just their pubkeys read from `pool.mint_a`/`pool.mint_b`),
        // since `transfer_checked` (required for Token-2022 support) takes
        // the mint account and its decimals as explicit CPI arguments.
        mintA,
        mintB,
        depositorTokenA: depTokenA,
        depositorTokenB: depTokenB,
        depositorLp: depLp,
        poolLpLock: poolLp,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(depositorKp === payer ? [] : [depositorKp])
      .rpc();
    return { depLp, poolLp };
  }

  before(async () => {
    mintA = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    mintB = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);

    depositor = payer; // the payer doubles as the main depositor/trader in most tests
    depositorTokenA = await createAccount(provider.connection, payer, mintA, depositor.publicKey);
    depositorTokenB = await createAccount(provider.connection, payer, mintB, depositor.publicKey);

    await mintTo(provider.connection, payer, mintA, depositorTokenA, payer, INITIAL_MINT_SUPPLY);
    await mintTo(provider.connection, payer, mintB, depositorTokenB, payer, INITIAL_MINT_SUPPLY);

    const { poolPda, vaultAPda, vaultBPda, lpMintPda } = derivePoolAddresses(mintA, mintB);
    pool = poolPda;
    vaultA = vaultAPda;
    vaultB = vaultBPda;
    lpMint = lpMintPda;
  });

  it("initializes a pool", async () => {
    await initPool(mintA, mintB, FEE_BPS, LEGACY_POOLS.ratioFour);

    const poolAccount = await program.account.pool.fetch(pool);
    assert.equal(poolAccount.feeBps, FEE_BPS);
    assert.isTrue((poolAccount.mintA as PublicKey).equals(mintA));
    assert.isTrue((poolAccount.mintB as PublicKey).equals(mintB));
  });

  it("adds initial liquidity and locks MINIMUM_LIQUIDITY", async () => {
    const amountA = 1_000_000n;
    const amountB = 4_000_000n; // deliberately different ratio — first deposit sets the price

    const expectedLpSupply = integerSqrt(amountA * amountB);
    assert.isTrue(
      expectedLpSupply > MINIMUM_LIQUIDITY,
      "test fixture amounts are too small — pick larger amountA/amountB"
    );
    const expectedDepositorLp = expectedLpSupply - MINIMUM_LIQUIDITY;

    const { depLp, poolLp } = await addLiquidity(
      depositor,
      depositorTokenA,
      depositorTokenB,
      amountA,
      amountB,
      0n
    );
    depositorLp = depLp;
    poolLpLock = poolLp;

    const vaultAAcc = await getAccount(provider.connection, vaultA);
    const vaultBAcc = await getAccount(provider.connection, vaultB);
    assert.equal(vaultAAcc.amount.toString(), amountA.toString());
    assert.equal(vaultBAcc.amount.toString(), amountB.toString());

    const lpMintAcc = await getAccount(provider.connection, depositorLp);
    assert.equal(lpMintAcc.amount.toString(), expectedDepositorLp.toString());

    const poolLpLockAcc = await getAccount(provider.connection, poolLpLock);
    assert.equal(poolLpLockAcc.amount.toString(), MINIMUM_LIQUIDITY.toString());
  });

  it("rejects a second deposit with a ratio the pool doesn't accept (SlippageExceeded)", async () => {
    // Pool ratio is 1_000_000 : 4_000_000 (1:4). Offering far less B than
    // that ratio requires for a given A must fail rather than silently
    // accept an imbalanced deposit at a different ratio.
    const err = await expectThrows(
      () => addLiquidity(depositor, depositorTokenA, depositorTokenB, 100_000n, 1n, 0n),
      "imbalanced second deposit"
    );
    const code = errorCode(err);
    console.log("  (imbalanced-deposit rejection returned error code:", code, ")");
    if (code) assert.equal(code, "SlippageExceeded");
  });

  it("swaps A for B and matches the constant-product formula off-chain", async () => {
    const vaultABefore = await getAccount(provider.connection, vaultA);
    const vaultBBefore = await getAccount(provider.connection, vaultB);
    const traderBBefore = await getAccount(provider.connection, depositorTokenB);

    const amountIn = 10_000n;
    const expectedOut = expectedSwapOut(
      BigInt(vaultABefore.amount.toString()),
      BigInt(vaultBBefore.amount.toString()),
      amountIn,
      BigInt(FEE_BPS)
    );
    assert.isTrue(expectedOut > 0n, "test fixture produced a zero expected swap output — adjust amounts");

    await program.methods
      .swap(new BN(amountIn.toString()), new BN(0), true)
      .accounts({
        trader: depositor.publicKey,
        pool,
        vaultA,
        vaultB,
        // NEW 2026-09-23: `Swap` now needs both mint accounts (for
        // `transfer_checked`'s decimals argument), and its single
        // `tokenProgram` field was split into `tokenProgramA`/
        // `tokenProgramB` — see lib.rs's `Swap` Accounts struct.
        mintA,
        mintB,
        traderTokenIn: depositorTokenA,
        traderTokenOut: depositorTokenB,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        priceUpdateA: LEGACY_POOLS.ratioFour.priceUpdateA,
        priceUpdateB: LEGACY_POOLS.ratioFour.priceUpdateB,
      })
      .rpc();

    const vaultAAfter = await getAccount(provider.connection, vaultA);
    const vaultBAfter = await getAccount(provider.connection, vaultB);
    const traderBAfter = await getAccount(provider.connection, depositorTokenB);

    assert.equal(
      (BigInt(vaultAAfter.amount.toString()) - BigInt(vaultABefore.amount.toString())).toString(),
      amountIn.toString()
    );
    assert.equal(
      (BigInt(vaultBBefore.amount.toString()) - BigInt(vaultBAfter.amount.toString())).toString(),
      expectedOut.toString()
    );
    assert.equal(
      (BigInt(traderBAfter.amount.toString()) - BigInt(traderBBefore.amount.toString())).toString(),
      expectedOut.toString()
    );

    // k must not decrease across a swap (fees make it increase slightly).
    const kBefore = BigInt(vaultABefore.amount.toString()) * BigInt(vaultBBefore.amount.toString());
    const kAfter = BigInt(vaultAAfter.amount.toString()) * BigInt(vaultBAfter.amount.toString());
    assert.isTrue(kAfter >= kBefore, "pool's k value decreased across a swap — this is a bug");
  });

  it("rejects a swap below min_amount_out (slippage protection)", async () => {
    const vaultABefore = await getAccount(provider.connection, vaultA);
    const vaultBBefore = await getAccount(provider.connection, vaultB);
    const amountIn = 10_000n;
    const expectedOut = expectedSwapOut(
      BigInt(vaultABefore.amount.toString()),
      BigInt(vaultBBefore.amount.toString()),
      amountIn,
      BigInt(FEE_BPS)
    );
    const impossibleMinOut = expectedOut + 1n; // one more than the swap can actually deliver

    const err = await expectThrows(
      () =>
        program.methods
          .swap(new BN(amountIn.toString()), new BN(impossibleMinOut.toString()), true)
          .accounts({
            trader: depositor.publicKey,
            pool,
            vaultA,
            vaultB,
            mintA,
            mintB,
            traderTokenIn: depositorTokenA,
            traderTokenOut: depositorTokenB,
            tokenProgramA: TOKEN_PROGRAM_ID,
            tokenProgramB: TOKEN_PROGRAM_ID,
            priceUpdateA: LEGACY_POOLS.ratioFour.priceUpdateA,
            priceUpdateB: LEGACY_POOLS.ratioFour.priceUpdateB,
          })
          .rpc(),
      "over-tight min_amount_out"
    );
    const code = errorCode(err);
    console.log("  (slippage rejection returned error code:", code, ")");
    if (code) assert.equal(code, "SlippageExceeded");
  });

  it("removes liquidity proportionally", async () => {
    const lpAcc = await getAccount(provider.connection, depositorLp);
    const lpToRemove = BigInt(lpAcc.amount.toString()) / 2n; // remove half

    const lpMintInfo = await program.provider.connection.getTokenSupply(lpMint);
    const lpSupply = BigInt(lpMintInfo.value.amount);

    const vaultABefore = await getAccount(provider.connection, vaultA);
    const vaultBBefore = await getAccount(provider.connection, vaultB);
    const expectedA = mulDiv(lpToRemove, BigInt(vaultABefore.amount.toString()), lpSupply);
    const expectedB = mulDiv(lpToRemove, BigInt(vaultBBefore.amount.toString()), lpSupply);

    const ownerTokenABefore = await getAccount(provider.connection, depositorTokenA);
    const ownerTokenBBefore = await getAccount(provider.connection, depositorTokenB);

    await program.methods
      .removeLiquidity(new BN(lpToRemove.toString()), new BN(0), new BN(0))
      .accounts({
        owner: depositor.publicKey,
        pool,
        vaultA,
        vaultB,
        lpMint,
        // NEW 2026-09-23: `RemoveLiquidity` now needs both mint accounts
        // (for `transfer_checked`'s decimals argument), and gained separate
        // `tokenProgramA`/`tokenProgramB` fields alongside the pre-existing
        // `tokenProgram` (which stays, now specifically for the LP mint's
        // `burn`) — see lib.rs's `RemoveLiquidity` Accounts struct.
        mintA,
        mintB,
        ownerLp: depositorLp,
        ownerTokenA: depositorTokenA,
        ownerTokenB: depositorTokenB,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const ownerTokenAAfter = await getAccount(provider.connection, depositorTokenA);
    const ownerTokenBAfter = await getAccount(provider.connection, depositorTokenB);

    assert.equal(
      (BigInt(ownerTokenAAfter.amount.toString()) - BigInt(ownerTokenABefore.amount.toString())).toString(),
      expectedA.toString()
    );
    assert.equal(
      (BigInt(ownerTokenBAfter.amount.toString()) - BigInt(ownerTokenBBefore.amount.toString())).toString(),
      expectedB.toString()
    );

    const lpAccAfter = await getAccount(provider.connection, depositorLp);
    assert.equal(
      (BigInt(lpAcc.amount.toString()) - BigInt(lpAccAfter.amount.toString())).toString(),
      lpToRemove.toString()
    );
  });

  it("rejects add_liquidity/remove_liquidity/swap with amount = 0", async () => {
    const addErr = await expectThrows(
      () => addLiquidity(depositor, depositorTokenA, depositorTokenB, 0n, 0n, 0n),
      "add_liquidity with amount 0"
    );
    console.log("  (zero add_liquidity returned error code:", errorCode(addErr), ")");

    const removeErr = await expectThrows(
      () =>
        program.methods
          .removeLiquidity(new BN(0), new BN(0), new BN(0))
          .accounts({
            owner: depositor.publicKey,
            pool,
            vaultA,
            vaultB,
            lpMint,
            mintA,
            mintB,
            ownerLp: depositorLp,
            ownerTokenA: depositorTokenA,
            ownerTokenB: depositorTokenB,
            tokenProgramA: TOKEN_PROGRAM_ID,
            tokenProgramB: TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      "remove_liquidity with amount 0"
    );
    console.log("  (zero remove_liquidity returned error code:", errorCode(removeErr), ")");

    const swapErr = await expectThrows(
      () =>
        program.methods
          .swap(new BN(0), new BN(0), true)
          .accounts({
            trader: depositor.publicKey,
            pool,
            vaultA,
            vaultB,
            mintA,
            mintB,
            traderTokenIn: depositorTokenA,
            traderTokenOut: depositorTokenB,
            tokenProgramA: TOKEN_PROGRAM_ID,
            tokenProgramB: TOKEN_PROGRAM_ID,
            priceUpdateA: LEGACY_POOLS.ratioFour.priceUpdateA,
            priceUpdateB: LEGACY_POOLS.ratioFour.priceUpdateB,
          })
          .rpc(),
      "swap with amount 0"
    );
    console.log("  (zero swap returned error code:", errorCode(swapErr), ")");

    for (const [label, err] of [
      ["add_liquidity", addErr],
      ["remove_liquidity", removeErr],
      ["swap", swapErr],
    ] as const) {
      const code = errorCode(err);
      if (code) assert.equal(code, "ZeroAmount", `${label} with amount 0 should report ZeroAmount`);
    }
  });

  it("rejects a pool's first deposit below MIN_INITIAL_DEPOSIT, accepts exactly at the floor (2026-09-08 fix)", async () => {
    const smallMintA = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const smallMintB = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const { vaultAPda: smallVaultA } = await initPool(smallMintA, smallMintB, FEE_BPS);
    const { poolPda: smallPool, vaultBPda: smallVaultB, lpMintPda: smallLpMint } =
      derivePoolAddresses(smallMintA, smallMintB);

    const smallDepositorTokenA = await createAccount(provider.connection, payer, smallMintA, payer.publicKey);
    const smallDepositorTokenB = await createAccount(provider.connection, payer, smallMintB, payer.publicKey);
    await mintTo(provider.connection, payer, smallMintA, smallDepositorTokenA, payer, 10_000_000n);
    await mintTo(provider.connection, payer, smallMintB, smallDepositorTokenB, payer, 10_000_000n);

    const belowFloor = MIN_INITIAL_DEPOSIT - 1n; // one raw unit short of the floor
    const smallDepositorLp = getAssociatedTokenAddressSync(smallLpMint, payer.publicKey);
    const smallPoolLpLock = getAssociatedTokenAddressSync(smallLpMint, smallPool, true);

    const err = await expectThrows(
      () =>
        program.methods
          .addLiquidity(new BN(belowFloor.toString()), new BN(belowFloor.toString()), new BN(0))
          .accounts({
            depositor: payer.publicKey,
            pool: smallPool,
            vaultA: smallVaultA,
            vaultB: smallVaultB,
            lpMint: smallLpMint,
            mintA: smallMintA,
            mintB: smallMintB,
            depositorTokenA: smallDepositorTokenA,
            depositorTokenB: smallDepositorTokenB,
            depositorLp: smallDepositorLp,
            poolLpLock: smallPoolLpLock,
            tokenProgramA: TOKEN_PROGRAM_ID,
            tokenProgramB: TOKEN_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "first deposit below MIN_INITIAL_DEPOSIT"
    );
    const code = errorCode(err);
    console.log("  (below-minimum first deposit rejected with:", code, ")");
    if (code) assert.equal(code, "InitialDepositTooSmall");

    // Boundary check: exactly at the floor must succeed (the check is >=,
    // not >).
    await program.methods
      .addLiquidity(new BN(MIN_INITIAL_DEPOSIT.toString()), new BN(MIN_INITIAL_DEPOSIT.toString()), new BN(0))
      .accounts({
        depositor: payer.publicKey,
        pool: smallPool,
        vaultA: smallVaultA,
        vaultB: smallVaultB,
        lpMint: smallLpMint,
        mintA: smallMintA,
        mintB: smallMintB,
        depositorTokenA: smallDepositorTokenA,
        depositorTokenB: smallDepositorTokenB,
        depositorLp: smallDepositorLp,
        poolLpLock: smallPoolLpLock,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const depLpAcc = await getAccount(provider.connection, smallDepositorLp);
    assert.isTrue(
      BigInt(depLpAcc.amount.toString()) > 0n,
      "depositing exactly MIN_INITIAL_DEPOSIT should succeed and mint LP"
    );
  });

  // -----------------------------------------------------------------
  // THE SINGLE MOST IMPORTANT TEST IN THIS FILE.
  //
  // Every mutating instruction pins its vaults/mints to the pool's
  // recorded addresses via Anchor's `address = pool.vault_a` (etc.)
  // constraint. If that constraint were ever missing or wrong, an
  // attacker could substitute a completely unrelated (but validly-typed)
  // token account in place of a real vault — for example, pointing
  // `vault_a` at their own token account instead of the pool's — and
  // either steal funds or corrupt the pool's accounting. This test
  // creates a second, throwaway pool for an unrelated mint pair and
  // tries to use ITS vault in place of the real pool's vault_a on a
  // swap. If this test does NOT fail as expected, STOP — do not deploy
  // this program until the constraint is fixed.
  // -----------------------------------------------------------------
  it("does not let a foreign vault substitute for the real one (account substitution attack)", async () => {
    const foreignMintA = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const foreignMintB = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const { poolPda: foreignPool, vaultAPda: foreignVaultA } = derivePoolAddresses(
      foreignMintA,
      foreignMintB
    );
    await initPool(foreignMintA, foreignMintB, FEE_BPS);

    const err = await expectThrows(
      () =>
        program.methods
          .swap(new BN(1), new BN(0), true)
          .accounts({
            trader: depositor.publicKey,
            pool, // the REAL pool
            vaultA: foreignVaultA, // but a FOREIGN vault substituted in
            vaultB,
            // The REAL pool's own mints — only vaultA is the substituted
            // foreign account here, everything else stays legitimate.
            mintA,
            mintB,
            traderTokenIn: depositorTokenA,
            traderTokenOut: depositorTokenB,
            tokenProgramA: TOKEN_PROGRAM_ID,
            tokenProgramB: TOKEN_PROGRAM_ID,
            priceUpdateA: LEGACY_POOLS.ratioOne.priceUpdateA,
            priceUpdateB: LEGACY_POOLS.ratioOne.priceUpdateB,
          })
          .rpc(),
      "swap with a substituted foreign vault"
    );
    console.log("  (account-substitution attack rejected with:", err?.message ?? err, ")");
    // However Anchor phrases this particular rejection, it MUST reject —
    // that is the only assertion that matters here. If this line is
    // reached, the transaction was rejected as required.
    assert.isOk(err);
  });

  // -----------------------------------------------------------------
  // First-depositor / share-inflation ("donation") attack — FIXED
  // 2026-09-08.
  //
  // Classic attack: (1) create a fresh pool, (2) attacker opens it with a
  // real deposit, (3) attacker donates a large amount directly into the
  // vaults via a plain SPL transfer (bypassing add_liquidity, so no LP is
  // minted against it), (4) a later, unsuspecting depositor's
  // add_liquidity call used to be priced against the now-inflated VAULT
  // BALANCE and could receive far fewer LP tokens than their deposit was
  // actually worth, or round down to zero outright (this was measured and
  // documented in SECURITY.md before the fix).
  //
  // THE FIX (see lib.rs's `Pool.reserve_a`/`reserve_b` doc comment): every
  // instruction now prices against reserve fields TRACKED on the Pool
  // account, updated only by this program's own instructions — never
  // against the vault's live token balance. So step 3's donation can no
  // longer move the price at all. This test proves that directly: it
  // performs the exact same attack sequence as before, then asserts the
  // victim receives EXACTLY the LP a donation-free pool would have given
  // them, and that the donated tokens are stuck in the vault, unused by
  // any pricing math (a bug in the reserve-bookkeeping introduced by the
  // fix would show up here as a wrong LP amount, not as a crash).
  // -----------------------------------------------------------------
  it("first-depositor / donation attack has ZERO effect on other depositors (2026-09-08 fix)", async () => {
    const victimMintA = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const victimMintB = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const { vaultAPda: attackVaultA } = await initPool(victimMintA, victimMintB, FEE_BPS);
    const { poolPda: attackPool, vaultBPda: attackVaultB, lpMintPda: attackLpMint } =
      derivePoolAddresses(victimMintA, victimMintB);

    const attacker = Keypair.generate();
    await fundWithSol(attacker.publicKey, 1_000_000_000);
    const attackerTokenA = await createAccount(provider.connection, payer, victimMintA, attacker.publicKey);
    const attackerTokenB = await createAccount(provider.connection, payer, victimMintB, attacker.publicKey);
    await mintTo(provider.connection, payer, victimMintA, attackerTokenA, payer, 10_000_000_000n);
    await mintTo(provider.connection, payer, victimMintB, attackerTokenB, payer, 10_000_000_000n);

    // Step 2: attacker opens the pool. Must now be >= MIN_INITIAL_DEPOSIT
    // (the other half of the 2026-09-08 fix) — a flat 1,100-raw-unit
    // deposit like the old version of this test used would itself now be
    // rejected with InitialDepositTooSmall.
    const attackerDeposit = MIN_INITIAL_DEPOSIT; // 1:1 ratio for simplicity
    const attackerLp = getAssociatedTokenAddressSync(attackLpMint, attacker.publicKey);
    const attackPoolLpLock = getAssociatedTokenAddressSync(attackLpMint, attackPool, true);
    await program.methods
      .addLiquidity(new BN(attackerDeposit.toString()), new BN(attackerDeposit.toString()), new BN(0))
      .accounts({
        depositor: attacker.publicKey,
        pool: attackPool,
        vaultA: attackVaultA,
        vaultB: attackVaultB,
        lpMint: attackLpMint,
        mintA: victimMintA,
        mintB: victimMintB,
        depositorTokenA: attackerTokenA,
        depositorTokenB: attackerTokenB,
        depositorLp: attackerLp,
        poolLpLock: attackPoolLpLock,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([attacker])
      .rpc();

    // Step 3: donate directly into the vaults via a plain SPL transfer,
    // bypassing add_liquidity entirely — no LP is minted for this, and
    // (per the fix) it should not move `pool.reserve_a`/`reserve_b` at all.
    const donation = 5_000_000_000n;
    await splTransfer(provider.connection, payer, attackerTokenA, attackVaultA, attacker, donation);
    await splTransfer(provider.connection, payer, attackerTokenB, attackVaultB, attacker, donation);

    // Confirm the donation landed in the real vault balance but did NOT
    // touch the tracked reserves.
    const poolAfterDonation = await program.account.pool.fetch(attackPool);
    const vaultAAfterDonation = await getAccount(provider.connection, attackVaultA);
    const vaultBAfterDonation = await getAccount(provider.connection, attackVaultB);
    assert.equal(poolAfterDonation.reserveA.toString(), attackerDeposit.toString());
    assert.equal(poolAfterDonation.reserveB.toString(), attackerDeposit.toString());
    assert.equal(
      (BigInt(vaultAAfterDonation.amount.toString()) - BigInt(poolAfterDonation.reserveA.toString())).toString(),
      donation.toString(),
      "the donated amount should sit in the vault, entirely outside the tracked reserve"
    );

    // Step 4: a victim deposits at the pool's TRUE (tracked) ratio,
    // completely unaware of the donation sitting in the vault.
    const victim = Keypair.generate();
    await fundWithSol(victim.publicKey, 1_000_000_000);
    const victimTokenA = await createAccount(provider.connection, payer, victimMintA, victim.publicKey);
    const victimTokenB = await createAccount(provider.connection, payer, victimMintB, victim.publicKey);
    const victimDeposit = 1_000_000n;
    await mintTo(provider.connection, payer, victimMintA, victimTokenA, payer, victimDeposit);
    await mintTo(provider.connection, payer, victimMintB, victimTokenB, payer, victimDeposit);

    const lpSupplyInfo = await provider.connection.getTokenSupply(attackLpMint);
    const lpSupplyBefore = BigInt(lpSupplyInfo.value.amount);
    const reserveA = BigInt(poolAfterDonation.reserveA.toString());
    const reserveB = BigInt(poolAfterDonation.reserveB.toString());
    const expectedLpFromA = mulDiv(victimDeposit, lpSupplyBefore, reserveA);
    const expectedLpFromB = mulDiv(victimDeposit, lpSupplyBefore, reserveB);
    const expectedVictimLp = expectedLpFromA < expectedLpFromB ? expectedLpFromA : expectedLpFromB;
    assert.isTrue(expectedVictimLp > 0n, "test fixture should not itself round to zero — adjust amounts");

    const victimLp = getAssociatedTokenAddressSync(attackLpMint, victim.publicKey);
    await program.methods
      .addLiquidity(new BN(victimDeposit.toString()), new BN(victimDeposit.toString()), new BN(0))
      .accounts({
        depositor: victim.publicKey,
        pool: attackPool,
        vaultA: attackVaultA,
        vaultB: attackVaultB,
        lpMint: attackLpMint,
        mintA: victimMintA,
        mintB: victimMintB,
        depositorTokenA: victimTokenA,
        depositorTokenB: victimTokenB,
        depositorLp: victimLp,
        poolLpLock: attackPoolLpLock,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([victim])
      .rpc();

    const victimLpAcc = await getAccount(provider.connection, victimLp);
    const victimLpMinted = BigInt(victimLpAcc.amount.toString());

    console.log("  --- first-depositor/donation attack (post-fix) ---");
    console.log("  attacker donated:", (donation * 2n).toString(), "raw units total (now permanently stuck)");
    console.log("  tracked reserves seen by victim's deposit:", reserveA.toString(), "/", reserveB.toString());
    console.log("  real vault balance at the same moment:", vaultAAfterDonation.amount.toString(), "/", vaultBAfterDonation.amount.toString());
    console.log("  victim deposited:", victimDeposit.toString(), "of each token, received:", victimLpMinted.toString(), "LP");

    // THE assertion this whole test exists for: the victim's deposit was
    // NOT rejected, and was NOT shortchanged by the donation — they got
    // exactly what a donation-free pool at this same true ratio would
    // have given them.
    assert.equal(
      victimLpMinted.toString(),
      expectedVictimLp.toString(),
      "the donation must have zero effect on the victim's LP — if this fails, the reserve-tracking fix has a bug"
    );

    // And the donated tokens are still just sitting there, unclaimed by
    // anyone — confirming the "dead weight, not stolen" tradeoff
    // documented on `Pool.reserve_a`.
    const poolAfterVictim = await program.account.pool.fetch(attackPool);
    const vaultAAfterVictim = await getAccount(provider.connection, attackVaultA);
    assert.equal(
      (BigInt(vaultAAfterVictim.amount.toString()) - BigInt(poolAfterVictim.reserveA.toString())).toString(),
      donation.toString(),
      "the donation should still be sitting outside the tracked reserve after the victim's deposit"
    );
  });

  // -----------------------------------------------------------------
  // Arithmetic at the true maximum scale (2026-09-08).
  //
  // SCOPE NOTE — read before extending this test: it deliberately does NOT
  // attempt to push a vault's balance PAST u64::MAX. That specific scenario
  // is provably impossible to construct through legitimate token
  // operations: an SPL mint's total supply is ITSELF a u64 field, so no
  // mint can ever have more than u64::MAX units in circulation in the
  // first place, and the SPL Token program's own Transfer instruction
  // already refuses to let any token account's balance exceed u64::MAX.
  // `Pool.reserve_a`/`reserve_b`'s own checked_add overflow guards (see
  // add_liquidity/swap in lib.rs) are real defense-in-depth, but are
  // unreachable via real token flows without first breaking an invariant
  // SPL Token itself enforces — so there is no honest way to integration-
  // test "the reserve overflows," and pretending otherwise would just be a
  // test that can never actually exercise the failure path it claims to.
  //
  // What CAN actually go wrong at this scale is precision loss in the
  // u128 intermediate math (`mul_div`, `integer_sqrt`, the swap formula) —
  // a u64-instead-of-u128 mistake, or a JS-side BN/bigint encoding bug for
  // numbers this large, would show up here as a mismatch against the
  // off-chain formula. That's what this test actually targets. (The pure
  // Rust math itself — including genuine overflow behavior of `mul_div`
  // and `integer_sqrt` at u64::MAX/u128::MAX — is unit/fuzz-tested
  // separately in lib.rs's `#[cfg(test)] mod tests`, run with `cargo test`,
  // not `anchor test`.)
  // -----------------------------------------------------------------
  it("is numerically exact at the true maximum scale — a pool holding an entire u64::MAX-supply mint (2026-09-08)", async () => {
    const U64_MAX = 2n ** 64n - 1n;
    const bigSupplyA = U64_MAX; // the absolute maximum any single mint can ever have in circulation
    const bigSupplyB = U64_MAX / 2n; // still enormous, and deliberately asymmetric to A

    const bigMintA = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const bigMintB = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
    const { vaultAPda: bigVaultA } = await initPool(bigMintA, bigMintB, FEE_BPS, LEGACY_POOLS.ratioHalf);
    const { poolPda: bigPool, vaultBPda: bigVaultB, lpMintPda: bigLpMint } =
      derivePoolAddresses(bigMintA, bigMintB);

    const bigDepositorTokenA = await createAccount(provider.connection, payer, bigMintA, payer.publicKey);
    const bigDepositorTokenB = await createAccount(provider.connection, payer, bigMintB, payer.publicKey);
    await mintTo(provider.connection, payer, bigMintA, bigDepositorTokenA, payer, bigSupplyA);
    await mintTo(provider.connection, payer, bigMintB, bigDepositorTokenB, payer, bigSupplyB);

    const bigDepositorLp = getAssociatedTokenAddressSync(bigLpMint, payer.publicKey);
    const bigPoolLpLock = getAssociatedTokenAddressSync(bigLpMint, bigPool, true);

    // A swap that's modest relative to these reserves (still a trillion
    // raw units) — big enough to produce a clearly nonzero output, small
    // enough to leave the pool far from empty. Deposit everything EXCEPT
    // this amount of mint A, so the depositor still has something left in
    // their own wallet to actually swap with afterward — depositing the
    // entire u64::MAX supply would leave 0 to swap and fail with
    // "insufficient funds" (caught by an earlier run of this test).
    const amountIn = 1_000_000_000_000n; // 1e12
    const depositAmountA = bigSupplyA - amountIn;

    // Deposit everything else — still the largest a pool can ever
    // legitimately be, short by exactly the amount reserved for the swap.
    await program.methods
      .addLiquidity(new BN(depositAmountA.toString()), new BN(bigSupplyB.toString()), new BN(0))
      .accounts({
        depositor: payer.publicKey,
        pool: bigPool,
        vaultA: bigVaultA,
        vaultB: bigVaultB,
        lpMint: bigLpMint,
        mintA: bigMintA,
        mintB: bigMintB,
        depositorTokenA: bigDepositorTokenA,
        depositorTokenB: bigDepositorTokenB,
        depositorLp: bigDepositorLp,
        poolLpLock: bigPoolLpLock,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let vaultAAcc = await getAccount(provider.connection, bigVaultA);
    let vaultBAcc = await getAccount(provider.connection, bigVaultB);
    assert.equal(vaultAAcc.amount.toString(), depositAmountA.toString());
    assert.equal(vaultBAcc.amount.toString(), bigSupplyB.toString());
    const poolAfterDeposit = await program.account.pool.fetch(bigPool);
    assert.equal(poolAfterDeposit.reserveA.toString(), depositAmountA.toString());
    assert.equal(poolAfterDeposit.reserveB.toString(), bigSupplyB.toString());

    const traderBBefore = await getAccount(provider.connection, bigDepositorTokenB);
    const expectedOut = expectedSwapOut(depositAmountA, bigSupplyB, amountIn, BigInt(FEE_BPS));
    assert.isTrue(expectedOut > 0n, "test fixture produced a zero expected swap output — adjust amounts");

    await program.methods
      .swap(new BN(amountIn.toString()), new BN(0), true)
      .accounts({
        trader: payer.publicKey,
        pool: bigPool,
        vaultA: bigVaultA,
        vaultB: bigVaultB,
        mintA: bigMintA,
        mintB: bigMintB,
        traderTokenIn: bigDepositorTokenA,
        traderTokenOut: bigDepositorTokenB,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        priceUpdateA: LEGACY_POOLS.ratioHalf.priceUpdateA,
        priceUpdateB: LEGACY_POOLS.ratioHalf.priceUpdateB,
      })
      .rpc();

    vaultAAcc = await getAccount(provider.connection, bigVaultA);
    vaultBAcc = await getAccount(provider.connection, bigVaultB);
    const traderBAfter = await getAccount(provider.connection, bigDepositorTokenB);

    assert.equal(
      (BigInt(vaultAAcc.amount.toString()) - depositAmountA).toString(),
      amountIn.toString(),
      "vault A should have grown by exactly amountIn, even at this scale"
    );
    // Vault A should now hold EXACTLY bigSupplyA (u64::MAX) — the deposit
    // was short by exactly amountIn, and the swap just put it back.
    assert.equal(vaultAAcc.amount.toString(), bigSupplyA.toString());
    assert.equal(
      (bigSupplyB - BigInt(vaultBAcc.amount.toString())).toString(),
      expectedOut.toString(),
      "vault B should have shrunk by exactly the off-chain-computed amount"
    );
    assert.equal(
      (BigInt(traderBAfter.amount.toString()) - BigInt(traderBBefore.amount.toString())).toString(),
      expectedOut.toString()
    );

    const kBefore = depositAmountA * bigSupplyB;
    const kAfter = BigInt(vaultAAcc.amount.toString()) * BigInt(vaultBAcc.amount.toString());
    assert.isTrue(kAfter >= kBefore, "pool's k value decreased across a swap at u64::MAX scale — this is a bug");

    const poolAfterSwap = await program.account.pool.fetch(bigPool);
    assert.equal(poolAfterSwap.reserveA.toString(), vaultAAcc.amount.toString());
    assert.equal(poolAfterSwap.reserveB.toString(), vaultBAcc.amount.toString());

    // remove_liquidity at this scale too — half the depositor's LP.
    const depLpAcc = await getAccount(provider.connection, bigDepositorLp);
    const lpToRemove = BigInt(depLpAcc.amount.toString()) / 2n;
    const lpSupplyInfo = await provider.connection.getTokenSupply(bigLpMint);
    const lpSupply = BigInt(lpSupplyInfo.value.amount);
    const expectedA = mulDiv(lpToRemove, BigInt(vaultAAcc.amount.toString()), lpSupply);
    const expectedB = mulDiv(lpToRemove, BigInt(vaultBAcc.amount.toString()), lpSupply);

    const ownerTokenABefore = await getAccount(provider.connection, bigDepositorTokenA);
    const ownerTokenBBefore = await getAccount(provider.connection, bigDepositorTokenB);

    await program.methods
      .removeLiquidity(new BN(lpToRemove.toString()), new BN(0), new BN(0))
      .accounts({
        owner: payer.publicKey,
        pool: bigPool,
        vaultA: bigVaultA,
        vaultB: bigVaultB,
        lpMint: bigLpMint,
        mintA: bigMintA,
        mintB: bigMintB,
        ownerLp: bigDepositorLp,
        ownerTokenA: bigDepositorTokenA,
        ownerTokenB: bigDepositorTokenB,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const ownerTokenAAfter = await getAccount(provider.connection, bigDepositorTokenA);
    const ownerTokenBAfter = await getAccount(provider.connection, bigDepositorTokenB);
    assert.equal(
      (BigInt(ownerTokenAAfter.amount.toString()) - BigInt(ownerTokenABefore.amount.toString())).toString(),
      expectedA.toString()
    );
    assert.equal(
      (BigInt(ownerTokenBAfter.amount.toString()) - BigInt(ownerTokenBBefore.amount.toString())).toString(),
      expectedB.toString()
    );
  });

  // -----------------------------------------------------------------
  // Multiple concurrent pools (2026-09-08).
  //
  // Every prior test in this file operates on a single pool at a time.
  // This test creates THREE independent pools (different mint pairs,
  // different fees) and interleaves operations across all three — deposit
  // into all three, swap in a different order than they were created,
  // deposit again unevenly — then asserts each pool's tracked reserves
  // exactly match its own vault balances and that each kept its own
  // distinct fee. A bug where one pool's instruction accidentally read or
  // wrote another pool's state (e.g. a missing seeds/address constraint)
  // would show up here as cross-contamination between pools that were
  // never supposed to interact at all.
  // -----------------------------------------------------------------
  it("keeps multiple concurrent pools fully isolated from each other (2026-09-08)", async () => {
    async function makePool(feeBps: number, oracleFeed: typeof LEGACY_POOLS.ratioOne) {
      const mA = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
      const mB = await createMintWithRetry(provider.connection, payer, payer.publicKey, null, 6);
      const { vaultAPda } = await initPool(mA, mB, feeBps, oracleFeed);
      const { poolPda, vaultBPda, lpMintPda } = derivePoolAddresses(mA, mB);
      const tokenA = await createAccount(provider.connection, payer, mA, payer.publicKey);
      const tokenB = await createAccount(provider.connection, payer, mB, payer.publicKey);
      await mintTo(provider.connection, payer, mA, tokenA, payer, 1_000_000_000_000n);
      await mintTo(provider.connection, payer, mB, tokenB, payer, 1_000_000_000_000n);
      return { mA, mB, pool: poolPda, vaultA: vaultAPda, vaultB: vaultBPda, lpMint: lpMintPda, tokenA, tokenB, oracleFeed };
    }
    type PoolFixture = Awaited<ReturnType<typeof makePool>>;

    // Deliberately different fees, so a later check that each pool kept
    // its OWN fee also proves the three Pool accounts are genuinely
    // independent, not aliased to the same state. Oracle feed per pool
    // matches each pool's OWN eventual deposit ratio (see the deposit
    // calls below): pools[0]/[2] end up 1:1 (ratioOne), pools[1] ends
    // up 6M:24M = 1:4 (ratioFour) after its second deposit.
    const pools = await Promise.all([
      makePool(30, LEGACY_POOLS.ratioOne),
      makePool(100, LEGACY_POOLS.ratioFour),
      makePool(500, LEGACY_POOLS.ratioOne),
    ]);

    async function deposit(p: PoolFixture, amountA: bigint, amountB: bigint) {
      const depLp = getAssociatedTokenAddressSync(p.lpMint, payer.publicKey);
      const poolLp = getAssociatedTokenAddressSync(p.lpMint, p.pool, true);
      await program.methods
        .addLiquidity(new BN(amountA.toString()), new BN(amountB.toString()), new BN(0))
        .accounts({
          depositor: payer.publicKey,
          pool: p.pool,
          vaultA: p.vaultA,
          vaultB: p.vaultB,
          lpMint: p.lpMint,
          mintA: p.mA,
          mintB: p.mB,
          depositorTokenA: p.tokenA,
          depositorTokenB: p.tokenB,
          depositorLp: depLp,
          poolLpLock: poolLp,
          tokenProgramA: TOKEN_PROGRAM_ID,
          tokenProgramB: TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    async function swap(p: PoolFixture, amountIn: bigint) {
      await program.methods
        .swap(new BN(amountIn.toString()), new BN(0), true)
        .accounts({
          trader: payer.publicKey,
          pool: p.pool,
          vaultA: p.vaultA,
          vaultB: p.vaultB,
          mintA: p.mA,
          mintB: p.mB,
          traderTokenIn: p.tokenA,
          traderTokenOut: p.tokenB,
          tokenProgramA: TOKEN_PROGRAM_ID,
          tokenProgramB: TOKEN_PROGRAM_ID,
          priceUpdateA: p.oracleFeed.priceUpdateA,
          priceUpdateB: p.oracleFeed.priceUpdateB,
        })
        .rpc();
    }

    // Interleaved on purpose — not one pool fully finished before the
    // next starts.
    await deposit(pools[0], 10_000_000n, 10_000_000n);
    await deposit(pools[1], 5_000_000n, 20_000_000n);
    await deposit(pools[2], 50_000_000n, 50_000_000n);
    await swap(pools[2], 1_000_000n);
    await swap(pools[0], 500_000n);
    await deposit(pools[1], 1_000_000n, 4_000_000n);
    await swap(pools[1], 200_000n);

    for (const p of pools) {
      const poolAccount = await program.account.pool.fetch(p.pool);
      const vaultAAcc = await getAccount(provider.connection, p.vaultA);
      const vaultBAcc = await getAccount(provider.connection, p.vaultB);
      assert.equal(
        poolAccount.reserveA.toString(),
        vaultAAcc.amount.toString(),
        `pool ${p.pool.toBase58()}: tracked reserve_a must match its own vault balance`
      );
      assert.equal(
        poolAccount.reserveB.toString(),
        vaultBAcc.amount.toString(),
        `pool ${p.pool.toBase58()}: tracked reserve_b must match its own vault balance`
      );
      assert.isTrue((poolAccount.mintA as PublicKey).equals(p.mA));
      assert.isTrue((poolAccount.mintB as PublicKey).equals(p.mB));
    }

    const feeBpsSeen = await Promise.all(
      pools.map(async (p) => (await program.account.pool.fetch(p.pool)).feeBps)
    );
    assert.deepEqual(feeBpsSeen, [30, 100, 500], "each pool must have kept its own distinct fee");
  });
});
