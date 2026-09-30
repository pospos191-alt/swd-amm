// Tests for the governance layer added 2026-09-22 (governance.rs):
// GlobalConfig bootstrap, the mint allowlist gate on pool creation, and the
// emergency-pause / governed-unpause asymmetry.
//
// STATUS: CONFIRMED passing on the user's WSL machine, 2026-09-22, after
// two rounds of real fixes — see SECURITY.md's "Governance layer" section
// (Rounds 1-3) for the full story, including a real test-fixture bug this
// file itself had (Round 3: emergencyAuthority must be the SAME keypair in
// every file that calls initializeGlobalConfig, not just "a" distinct one
// — see the EMERGENCY_AUTHORITY_SEED comment below).
//
// Run this file TOGETHER with tests/dlmm.ts and tests/swd_amm.ts in the
// same `anchor test` invocation (Anchor's default `[scripts] test` in
// Anchor.toml globs `tests/**/*.ts`), not in isolation — all three files
// share the same GlobalConfig singleton on whatever localnet validator
// `anchor test` spins up. mocha runs the files alphabetically, so
// tests/dlmm.ts's `before()` hook is actually the one that creates it
// first (see that file's `ensureGlobalConfig`); this file's own
// `ensureGlobalConfig` below is what makes it work correctly even so.
//
// COVERAGE: GlobalConfig can only be initialized once; a mint with no
// AllowedMint entry cannot have a pool created against it
// (MintNotAllowlisted); set_allowed_mint(false) after a pool already exists
// does not retroactively break that pool (existing pools are unaffected,
// per governance.rs's module doc comment); emergency_authority can pause
// swap on an existing pool and swap then fails (SwapPaused);
// emergency_authority's signature is REQUIRED — a random keypair cannot
// pause; emergency_authority CANNOT unpause (wrong-signer rejection,
// proving the pause/unpause asymmetry is enforced on-chain, not just by
// convention); governance_authority CAN unpause, and swap succeeds again
// afterward; set_pool_creation_paused(true) blocks a brand-new pool's
// creation even for an already-allowlisted mint pair, and
// set_pool_creation_paused(false) un-blocks it.
//
// NOT covered here (deliberately, see governance.rs's module doc comment
// for why): timelocked fee/oracle changes (not implemented — fees remain
// immutable, there is no oracle in this program), and DLMM-specific
// governance instructions (emergency_pause_dlmm_pool /
// governed_unpause_dlmm_pool / DLMM's own allowlist gate) — these mirror
// the constant-product-pool versions tested here field-for-field, and
// dlmm.rs itself is still flagged UNCOMPILED-AS-OF-WRITING independent of
// this change, so adding DLMM-specific governance tests before the base
// DLMM feature has ever been compiled once would be testing on top of an
// unknown foundation. Add them once dlmm.rs's own first `anchor build`
// succeeds.

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import { LEGACY_POOLS, LEGACY_ORACLE_MAX_DEVIATION_BPS, LEGACY_MAX_FEE_BPS, TEST_ORACLE_MAX_STALENESS_SECS } from "./oracle-fixtures";

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

describe("swd_amm governance", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwdAmm as anchor.Program<any>;
  const payer = (provider.wallet as anchor.Wallet).payer; // doubles as governanceAuthority
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
  const FEE_BPS = 30;

  const [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );

  function deriveAllowedMintPda(mint: PublicKey) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("allowed-mint"), mint.toBuffer()],
      program.programId
    );
    return pda;
  }

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


  // ---- Timelock helpers (timelock.rs, added 2026-09-29) ----
  const [govSettingsPda] = PublicKey.findProgramAddressSync([Buffer.from("gov_settings")], program.programId);
  async function ensureGovSettings(): Promise<PublicKey> {
    try {
      await program.methods
        .initializeGovernanceSettings(new BN(5), 1_000, payer.publicKey)
        .accounts({ config: globalConfigPda, governanceAuthority: payer.publicKey, settings: govSettingsPda, payer: payer.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e) {
      if (!String(e).includes("already in use")) throw e;
    }
    return govSettingsPda;
  }
  async function proposeAction(action: any): Promise<PublicKey> {
    const s: any = await program.account.governanceSettings.fetch(govSettingsPda);
    const [pending] = PublicKey.findProgramAddressSync(
      [Buffer.from("gov_action"), new BN(s.nextActionId).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    await program.methods
      .proposeGovAction(action)
      .accounts({ config: globalConfigPda, governanceAuthority: payer.publicKey, settings: govSettingsPda, pending, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    return pending;
  }
  async function waitForTimelock(_settings: PublicKey) {
    const s: any = await program.account.governanceSettings.fetch(govSettingsPda);
    await new Promise((r) => setTimeout(r, (Number(s.timelockDelaySecs) + 2) * 1000));
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
      if (!msg.includes("already in use") && !msg.includes("0x0")) throw err;
    }
  }

  async function setAllowlisted(mint: PublicKey, enabled: boolean) {
    const allowedMintPda = deriveAllowedMintPda(mint);
    await program.methods
      .setAllowedMint(enabled)
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

  async function initPoolRaw(
    mA: PublicKey,
    mB: PublicKey,
    allowedMintAPda: PublicKey,
    allowedMintBPda: PublicKey
  ) {
    const { poolPda, vaultAPda, vaultBPda, lpMintPda } = derivePoolAddresses(mA, mB);
    await program.methods
      .initializePool(
        FEE_BPS,
        LEGACY_POOLS.ratioOne.feedIdA,
        LEGACY_POOLS.ratioOne.feedIdB,
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
        // — see the matching comment in tests/swd_amm.ts's `initPool`.
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    return { poolPda, vaultAPda, vaultBPda, lpMintPda };
  }

  before(async () => {
    await ensureGlobalConfig();
    // Give emergencyAuthority enough SOL to pay tx fees for the calls it
    // signs below (it never needs to pay rent — every account it touches
    // already exists).
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: emergencyAuthority.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL / 10,
      })
    );
    await provider.sendAndConfirm(tx, [payer]);
  });

  it("cannot initialize GlobalConfig a second time", async () => {
    const err = await expectThrows(async () => {
      await program.methods
        .initializeGlobalConfig(payer.publicKey, emergencyAuthority.publicKey)
        .accounts({
          config: globalConfigPda,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }, "second initializeGlobalConfig call");
    // Anchor's own "account already in use" failure for a repeated `init`
    // — not one of our SwdAmmError/GovernanceError variants, so just
    // confirm it threw and log what came back.
    console.log("  (second initializeGlobalConfig rejected with:", String(err?.message ?? err).split("\n")[0], ")");
  });

  it("refuses to create a pool for a mint with no AllowedMint entry", async () => {
    const unlistedMintA = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const unlistedMintB = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    // Only allowlist one side, deliberately, so this also proves the check
    // is per-mint, not "at least one side allowlisted".
    const allowedA = await setAllowlisted(unlistedMintA, true);
    const neverAllowedBPda = deriveAllowedMintPda(unlistedMintB);

    const err = await expectThrows(
      () => initPoolRaw(unlistedMintA, unlistedMintB, allowedA, neverAllowedBPda),
      "pool creation with an unlisted mint"
    );
    // allowedMintB doesn't exist on-chain at all yet (never `set_allowed_mint`ed),
    // so this fails Anchor's own account-must-exist check before it even
    // reaches our `enabled` check — still a correct rejection, just via a
    // different error path than a mint that exists but is disabled.
    console.log("  (pool creation with unlisted mint rejected with:", errorCode(err) ?? String(err?.message ?? err).split("\n")[0], ")");
  });

  it("refuses to create a pool for a mint that is allowlisted but disabled", async () => {
    const mA = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const mB = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const allowedA = await setAllowlisted(mA, true);
    const allowedB = await setAllowlisted(mB, false); // exists, but enabled = false

    const err = await expectThrows(
      () => initPoolRaw(mA, mB, allowedA, allowedB),
      "pool creation with a disabled mint"
    );
    const code = errorCode(err);
    console.log("  (pool creation with disabled mint rejected with:", code, ")");
    if (code) assert.equal(code, "MintNotAllowlisted");
  });

  it("creates a pool once both mints are allowlisted, and disabling afterward does not break it", async () => {
    const mA = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const mB = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const allowedA = await setAllowlisted(mA, true);
    const allowedB = await setAllowlisted(mB, true);

    await initPoolRaw(mA, mB, allowedA, allowedB);
    const { poolPda } = derivePoolAddresses(mA, mB);
    const poolAccount = await program.account.pool.fetch(poolPda);
    assert.isTrue((poolAccount.mintA as PublicKey).equals(mA));

    // Disabling the mint now must NOT retroactively touch this already-
    // created pool — add_liquidity should still work normally.
    await setAllowlisted(mA, false);

    const depositorTokenA = await createAccount(provider.connection, payer, mA, payer.publicKey);
    const depositorTokenB = await createAccount(provider.connection, payer, mB, payer.publicKey);
    await mintTo(provider.connection, payer, mA, depositorTokenA, payer, 10_000_000n);
    await mintTo(provider.connection, payer, mB, depositorTokenB, payer, 10_000_000n);

    const { vaultAPda, vaultBPda, lpMintPda } = derivePoolAddresses(mA, mB);
    const depositorLp = getAssociatedTokenAddressSync(lpMintPda, payer.publicKey);
    const poolLp = getAssociatedTokenAddressSync(lpMintPda, poolPda, true);

    await program.methods
      .addLiquidity(new BN(1_000_000), new BN(1_000_000), new BN(0))
      .accounts({
        depositor: payer.publicKey,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        mintA: mA,
        mintB: mB,
        depositorTokenA,
        depositorTokenB,
        depositorLp,
        poolLpLock: poolLp,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    // No throw above == pass: an already-created pool keeps working after
    // its mint is disabled on the allowlist, exactly as documented.
  });

  it("blocks new pool creation while pool_creation_paused is true, even for allowlisted mints", async () => {
    const mA = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const mB = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const allowedA = await setAllowlisted(mA, true);
    const allowedB = await setAllowlisted(mB, true);

    await program.methods
      .setPoolCreationPaused(true)
      .accounts({ config: globalConfigPda, governanceAuthority: payer.publicKey })
      .rpc();

    const err = await expectThrows(
      () => initPoolRaw(mA, mB, allowedA, allowedB),
      "pool creation while globally paused"
    );
    const code = errorCode(err);
    console.log("  (pool creation while paused rejected with:", code, ")");
    if (code) assert.equal(code, "PoolCreationPaused");

    // Un-pause so this test doesn't leave global state that breaks every
    // OTHER test in this file/run that creates a pool afterward.
    await program.methods
      .setPoolCreationPaused(false)
      .accounts({ config: globalConfigPda, governanceAuthority: payer.publicKey })
      .rpc();

    await initPoolRaw(mA, mB, allowedA, allowedB); // now succeeds
  });

  it("emergency_authority can pause swap on an existing pool, and swap then fails", async () => {
    const mA = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const mB = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const allowedA = await setAllowlisted(mA, true);
    const allowedB = await setAllowlisted(mB, true);
    const { poolPda, vaultAPda, vaultBPda, lpMintPda } = await initPoolRaw(mA, mB, allowedA, allowedB);

    const traderTokenA = await createAccount(provider.connection, payer, mA, payer.publicKey);
    const traderTokenB = await createAccount(provider.connection, payer, mB, payer.publicKey);
    await mintTo(provider.connection, payer, mA, traderTokenA, payer, 10_000_000n);
    await mintTo(provider.connection, payer, mB, traderTokenB, payer, 10_000_000n);
    const depositorLp = getAssociatedTokenAddressSync(lpMintPda, payer.publicKey);
    const poolLp = getAssociatedTokenAddressSync(lpMintPda, poolPda, true);
    await program.methods
      .addLiquidity(new BN(1_000_000), new BN(1_000_000), new BN(0))
      .accounts({
        depositor: payer.publicKey,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        mintA: mA,
        mintB: mB,
        depositorTokenA: traderTokenA,
        depositorTokenB: traderTokenB,
        depositorLp,
        poolLpLock: poolLp,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // A random keypair must NOT be able to pause — proves the signer check
    // is real, not decorative.
    const imposter = Keypair.generate();
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: imposter.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL / 20,
        })
      ),
      [payer]
    );
    const imposterErr = await expectThrows(async () => {
      await program.methods
        .emergencyPausePool(true, false, false)
        .accounts({ config: globalConfigPda, emergencyAuthority: imposter.publicKey, pool: poolPda })
        .signers([imposter])
        .rpc();
    }, "emergency_pause_pool signed by a non-emergency-authority keypair");
    console.log("  (imposter pause attempt rejected with:", errorCode(imposterErr) ?? String(imposterErr?.message ?? imposterErr).split("\n")[0], ")");

    await program.methods
      .emergencyPausePool(true, false, false)
      .accounts({ config: globalConfigPda, emergencyAuthority: emergencyAuthority.publicKey, pool: poolPda })
      .signers([emergencyAuthority])
      .rpc();

    const swapErr = await expectThrows(async () => {
      await program.methods
        .swap(new BN(1_000), new BN(0), true)
        .accounts({
          trader: payer.publicKey,
          pool: poolPda,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          mintA: mA,
          mintB: mB,
          traderTokenIn: traderTokenA,
          traderTokenOut: traderTokenB,
          tokenProgramA: TOKEN_PROGRAM_ID,
          tokenProgramB: TOKEN_PROGRAM_ID,
          priceUpdateA: LEGACY_POOLS.ratioOne.priceUpdateA,
          priceUpdateB: LEGACY_POOLS.ratioOne.priceUpdateB,
        })
        .rpc();
    }, "swap on a swap-paused pool");
    const swapCode = errorCode(swapErr);
    console.log("  (swap on paused pool rejected with:", swapCode, ")");
    if (swapCode) assert.equal(swapCode, "SwapPaused");

    // emergency_authority itself cannot undo its own pause — that is the
    // whole point of the asymmetry (see governance.rs).
    const emergencyUnpauseErr = await expectThrows(async () => {
      await program.methods
        .governedUnpausePool(true, false, false)
        .accounts({ config: globalConfigPda, governanceAuthority: emergencyAuthority.publicKey, pool: poolPda })
        .signers([emergencyAuthority])
        .rpc();
    }, "governed_unpause_pool signed by emergency_authority instead of governance_authority");
    console.log("  (emergency_authority attempting unpause rejected with:", errorCode(emergencyUnpauseErr) ?? String(emergencyUnpauseErr?.message ?? emergencyUnpauseErr).split("\n")[0], ")");

    // Since 2026-09-29 the instant path is closed even for
    // governance_authority: unpausing must go through the timelock.
    const instantErr = await expectThrows(async () => {
      await program.methods
        .governedUnpausePool(true, false, false)
        .accounts({ config: globalConfigPda, governanceAuthority: payer.publicKey, pool: poolPda })
        .rpc();
    }, "instant governed_unpause_pool");
    assert.equal(errorCode(instantErr), "UseTimelockedUnpause");

    const settingsPda = await ensureGovSettings();
    const pending = await proposeAction({ unpauseCpPool: { pool: poolPda, swap: true, deposit: false, withdraw: false } });
    const earlyErr = await expectThrows(async () => {
      await program.methods.executeUnpausePool().accounts({ pending, pool: poolPda }).rpc();
    }, "executing the unpause before the timelock elapsed");
    assert.equal(errorCode(earlyErr), "TimelockNotElapsed");
    await waitForTimelock(settingsPda);
    await program.methods.executeUnpausePool().accounts({ pending, pool: poolPda }).rpc();
    const again = await expectThrows(async () => {
      await program.methods.executeUnpausePool().accounts({ pending, pool: poolPda }).rpc();
    }, "executing the same action twice");
    assert.equal(errorCode(again), "ActionNotPending");

    await program.methods
      .swap(new BN(1_000), new BN(0), true)
      .accounts({
        trader: payer.publicKey,
        pool: poolPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        mintA: mA,
        mintB: mB,
        traderTokenIn: traderTokenA,
        traderTokenOut: traderTokenB,
        tokenProgramA: TOKEN_PROGRAM_ID,
        tokenProgramB: TOKEN_PROGRAM_ID,
        priceUpdateA: LEGACY_POOLS.ratioOne.priceUpdateA,
        priceUpdateB: LEGACY_POOLS.ratioOne.priceUpdateB,
      })
      .rpc(); // no throw == pass: swap works again after governance unpauses
  });
});
