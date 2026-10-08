// "Phase 2b" (Squads multisig LIVE on-chain verification, added 2026-09-24)
// — see governance.rs's module doc comment ("SQUADS MULTISIG TRANSPARENCY"
// / "KNOWN UNCERTAINTY") and tests/squads-vault-pda.ts's header comment
// for the backstory. Between those two, this project already had:
//   1. Offline proof that the VAULT PDA SEED LITERALS are correct
//      (tests/squads-vault-pda.ts, matches the real @sqds/multisig SDK's
//      own getVaultPda — no chain interaction needed).
//   2. The Multisig ACCOUNT BYTE LAYOUT (read_squads_multisig_summary's
//      fixed offsets) cross-checked against Squads' own published docs.
// Neither of those proves `verify_governance_multisig` actually works
// end-to-end against a REAL Squads v4 Multisig account produced by the
// REAL Squads program running on-chain — governance.rs's own comment
// flagged this exact gap as "not done here, a follow-up piece of work".
// THIS file is that follow-up.
//
// HOW: Anchor.toml's `[test.validator]` now sets `url` (a real mainnet-
// beta RPC) and two `[[test.validator.clone]]` entries — the real Squads
// v4 program (SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf) and its
// ProgramConfig singleton PDA — so this localnet validator starts with a
// working copy of the ACTUAL deployed program, not a mock. This file then
// uses the official `@sqds/multisig` SDK (already a package.json
// dependency) to create a genuine multisig against that cloned program.
//
// The ProgramConfig PDA address baked into Anchor.toml
// (BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr) was computed OFFLINE from
// the ACTUAL installed @sqds/multisig v2.1.1 package's own compiled
// source (node_modules/@sqds/multisig/lib/index.js:
// `SEED_PREFIX = toUtfBytes("multisig")`,
// `SEED_PROGRAM_CONFIG = toUtfBytes("program_config")`,
// `getProgramConfigPda` derives `[SEED_PREFIX, SEED_PROGRAM_CONFIG]`) —
// i.e. read directly out of the real, running client code, not
// reconstructed from memory or guessed. The same source also confirms
// getVaultPda's seeds (`[SEED_PREFIX, multisigPda, SEED_VAULT,
// u8(index)]`) match governance.rs's `derive_squads_vault_pda` byte for
// byte, independently corroborating tests/squads-vault-pda.ts's own
// offline result.
//
// IF THIS FILE FAILS AT VALIDATOR STARTUP (before any test even runs):
// the clone itself failed — almost certainly the public mainnet-beta RPC
// in Anchor.toml rate-limited or refused the request for the whole
// program's executable data. Check `.anchor/test-ledger/validator.log`;
// if it's an RPC/timeout error, swap Anchor.toml's `[test.validator].url`
// for a private RPC endpoint and retry — this is an infrastructure
// problem, not a bug in this file or governance.rs.
//
// SHARED-STATE WARNING (read before touching this file): GlobalConfig is
// a program-wide singleton PDA — every test file in this `anchor test`
// run shares ONE GlobalConfig, and by the time this file's tests run,
// some other file's before()/ensureGlobalConfig() has already initialized
// it with governance_authority = payer.publicKey (a plain keypair, NOT a
// Squads vault) so the rest of the governance suite can sign for it
// directly (see tests/governance.ts / tests/swd_amm.ts). The third test
// below temporarily points governance_authority at a REAL vault PDA to
// prove the happy path, then restores it — but restoring is NOT a plain
// signed call (a vault PDA has no private key; only Squads' own program
// can produce a valid signature for it, via invoke_signed during a real
// executed transaction), so the restore itself goes through a genuine
// Squads propose -> approve -> execute flow. If that flow ever throws
// partway, this run's shared GlobalConfig is left pointed at an
// unspendable PDA for the REST of this `anchor test` invocation — this
// file is deliberately named to sort alphabetically LAST among
// tests/**/*.ts (the "z-" prefix) so that outcome can only affect ITS OWN
// remaining tests, never a file that already finished. A later, separate
// `anchor test` run always starts a brand-new validator/ledger regardless
// (Anchor's normal behavior), so a bad run here never contaminates the
// next one.

import * as anchor from "@coral-xyz/anchor";
import * as multisig from "@sqds/multisig";
import { PublicKey, Keypair, SystemProgram, TransactionMessage } from "@solana/web3.js";
import { assert } from "chai";

describe("squads multisig — live on-chain verification (Phase 2b)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwdAmm as anchor.Program<any>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Same deterministic seed every other test file uses (see
  // architecture-and-decisions.md's "Round 3" note) — GlobalConfig can
  // only ever be initialized once across the whole shared `anchor test`
  // run, so every file's emergencyAuthority must resolve to the SAME
  // keypair or whichever file's initializeGlobalConfig call wins the race
  // sets an authority the OTHER files' independently-generated keypair
  // wouldn't match.
  const EMERGENCY_AUTHORITY_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const emergencyAuthority = Keypair.fromSeed(EMERGENCY_AUTHORITY_SEED);

  const [globalConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global-config")],
    program.programId
  );

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
    } catch (_e) {
      // Another test file's before() hook already won the race and
      // initialized the shared singleton first — expected, same
      // idempotent pattern every other file in this suite uses.
    }
  }

  async function extractErrorCode(fn: () => Promise<unknown>): Promise<string | null> {
    try {
      await fn();
      return null;
    } catch (e: any) {
      return e?.error?.errorCode?.code ?? null;
    }
  }

  // BUG FIX (2026-09-24, after the first real `anchor test` run against
  // this file): every `multisig.rpc.*` function is a thin wrapper around
  // `connection.sendTransaction(tx, sendOptions)` (confirmed by reading
  // node_modules/@sqds/multisig/lib/index.js directly — e.g.
  // `multisigCreateV23`/`vaultTransactionCreate3` end with exactly that,
  // nothing more). `sendTransaction` resolves as soon as the RPC *accepts*
  // the transaction for broadcast — NOT once it lands/executes. Combined
  // with `sendOptions: { skipPreflight: true }` (the original version of
  // this file passed that everywhere), a transaction that fails on-chain
  // produces NO exception at all: the call "succeeds", returns a
  // signature, and whatever this test does next silently races ahead
  // against state that was never actually written. That race is what
  // produced the first real run's failure 1 (`NotASquadsMultisigAccount`
  // instead of `MultisigVaultMismatch`): `createRealMultisig` returned
  // before — or regardless of whether — the multisig account actually
  // existed on-chain.
  //
  // Fix: (a) drop `skipPreflight: true` so a real on-chain failure surfaces
  // immediately as a `SendTransactionError` WITH program logs attached,
  // instead of being swallowed; (b) explicitly confirm every signature
  // before treating the call as done, so later reads/instructions never
  // race ahead of a transaction that hasn't landed yet.
  async function sendAndConfirm(sendPromise: Promise<string>): Promise<string> {
    const signature = await sendPromise;
    const result = await provider.connection.confirmTransaction(signature, "confirmed");
    if (result.value.err) {
      throw new Error(
        `transaction ${signature} was accepted but failed on-chain: ${JSON.stringify(result.value.err)}`
      );
    }
    return signature;
  }

  async function createRealMultisig(threshold: number) {
    const createKey = Keypair.generate();
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

    const programConfigPda = multisig.getProgramConfigPda({})[0];
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
      provider.connection,
      programConfigPda
    );

    await sendAndConfirm(
      multisig.rpc.multisigCreateV2({
        connection: provider.connection,
        createKey,
        creator: payer,
        multisigPda,
        configAuthority: null,
        timeLock: 0,
        members: [{ key: payer.publicKey, permissions: multisig.types.Permissions.all() }],
        threshold,
        rentCollector: null,
        treasury: programConfig.treasury,
      })
    );

    return { multisigPda, vaultPda };
  }

  it("rejects an account not owned by the real (cloned) Squads v4 program", async () => {
    await ensureGlobalConfig();

    // globalConfigPda is convenient here: guaranteed to exist (just
    // ensured above), owned by OUR program, definitely not Squads'.
    const code = await extractErrorCode(() =>
      program.methods
        .verifyGovernanceMultisig(0)
        .accounts({ config: globalConfigPda, squadsMultisig: globalConfigPda })
        .rpc()
    );
    assert.equal(code, "NotASquadsMultisigAccount");
  });

  it("parses a REAL, freshly-created Squads v4 Multisig account's layout correctly", async () => {
    await ensureGlobalConfig();
    const { multisigPda } = await createRealMultisig(1);

    // governance_authority in the SHARED GlobalConfig is NOT this
    // multisig's vault (it's payer.publicKey, set by whichever test file's
    // before() ran first) — so this is expected to reach
    // MultisigVaultMismatch, not succeed outright. Reaching THAT SPECIFIC
    // error (rather than NotASquadsMultisigAccount or
    // MultisigAccountTooShort, and rather than a raw Borsh/slice panic) is
    // itself the proof that read_squads_multisig_summary correctly parsed
    // a REAL account's threshold/member_count off the REAL cloned Squads
    // v4 program's output. The full "governance_authority genuinely equals
    // the vault" happy path is proven separately by the next test, via a
    // real Squads-approved CPI rather than by mutating this shared
    // singleton directly here.
    const code = await extractErrorCode(() =>
      program.methods
        .verifyGovernanceMultisig(0)
        .accounts({ config: globalConfigPda, squadsMultisig: multisigPda })
        .rpc()
    );
    assert.equal(
      code,
      "MultisigVaultMismatch",
      `got ${code} instead of MultisigVaultMismatch — if this is MultisigAccountTooShort or a raw ` +
        `deserialization failure, read_squads_multisig_summary's byte offsets in governance.rs do not ` +
        `match the REAL cloned Squads v4 account layout (check the field-by-field comment above that ` +
        `function); if it's NotASquadsMultisigAccount, the program clone in Anchor.toml isn't taking ` +
        `effect (check .anchor/test-ledger/validator.log for the clone step at startup)`
    );
  });

  it("succeeds end-to-end when governance_authority genuinely is the multisig's vault, restored via a REAL Squads-approved CPI", async () => {
    await ensureGlobalConfig();

    // Single-member, threshold-1 — still a completely real Squads v4
    // multisig (Squads does not require more than one member); chosen so
    // ONE signer (payer) can legitimately propose, approve, AND execute
    // without simulating multiple independent parties inside a test.
    const { multisigPda, vaultPda } = await createRealMultisig(1);

    const before = await program.account.globalConfig.fetch(globalConfigPda);
    const originalGovernanceAuthority = before.governanceAuthority as PublicKey;
    const originalEmergencyAuthority = before.emergencyAuthority as PublicKey;

    // Step 1 — point governance_authority at the REAL vault PDA. Signed by
    // the CURRENT governance_authority (payer, per this whole suite's
    // shared convention): an ordinary direct call, nothing Squads-specific
    // needed for this forward step.
    await program.methods
      .setAuthorities(vaultPda, originalEmergencyAuthority)
      .accounts({ config: globalConfigPda, governanceAuthority: originalGovernanceAuthority })
      .rpc();

    // Step 2 — THE actual happy-path proof this file exists for:
    // verify_governance_multisig must now succeed outright, no error.
    await program.methods
      .verifyGovernanceMultisig(0)
      .accounts({ config: globalConfigPda, squadsMultisig: multisigPda })
      .rpc();

    // Step 3 — restore governance_authority back to its original value.
    // governance_authority is now the vault PDA, which has no private key
    // — only the Squads program itself can sign for it (invoke_signed with
    // the vault's own seeds, during a transaction IT executes), so this
    // MUST go through a genuine Squads propose -> approve -> execute flow
    // rather than a plain signed call. This simultaneously proves the
    // OTHER half of governance.rs's design (see its "DESIGN NOTE"): that a
    // real Squads execute_transaction CPI can actually drive this
    // program's governance instructions, which is the whole reason this
    // program trusts a bare signature instead of re-checking Squads'
    // threshold logic itself.
    const restoreIx = await program.methods
      .setAuthorities(originalGovernanceAuthority, originalEmergencyAuthority)
      .accounts({ config: globalConfigPda, governanceAuthority: vaultPda })
      .instruction();

    const transactionIndex = 1n;
    const innerMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: (await provider.connection.getLatestBlockhash()).blockhash,
      instructions: [restoreIx],
    });

    // BUG FIX (2026-09-24): the first real run crashed here with
    // `TypeError: pubkey.toBase58 is not a function`, deep inside
    // @sqds/multisig's OWN nested @solana/web3.js copy's
    // `TransactionMessage.compileToV0Message` -> `CompiledKeys.compile`.
    // Root cause (confirmed by reading the SDK's own .d.ts files, not
    // guessed): `vaultTransactionCreate`'s RPC-level signature is the ONE
    // exception among these four SDK calls that wants `creator: PublicKey`
    // — every sibling here (`multisigCreateV2`, `proposalCreate`,
    // `proposalApprove`) wants `creator`/`member: Signer` instead. This
    // file originally passed `creator: payer` (a Keypair) here too, by
    // analogy with the others; the SDK then threaded that Keypair straight
    // into an `AccountMeta.pubkey` slot with no runtime check, and
    // compileToV0Message crashed the first time it tried to call
    // `.toBase58()` on it. Fixed below to `creator: payer.publicKey`. This
    // was a real bug in this file, not a dual-package/version hazard —
    // `feePayer: payer` (Signer) on the same call was already correct.
    await sendAndConfirm(
      multisig.rpc.vaultTransactionCreate({
        connection: provider.connection,
        feePayer: payer,
        multisigPda,
        transactionIndex,
        creator: payer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: innerMessage,
      })
    );

    await sendAndConfirm(
      multisig.rpc.proposalCreate({
        connection: provider.connection,
        feePayer: payer,
        creator: payer,
        multisigPda,
        transactionIndex,
      })
    );

    await sendAndConfirm(
      multisig.rpc.proposalApprove({
        connection: provider.connection,
        feePayer: payer,
        member: payer,
        multisigPda,
        transactionIndex,
      })
    );

    await sendAndConfirm(
      multisig.rpc.vaultTransactionExecute({
        connection: provider.connection,
        feePayer: payer,
        multisigPda,
        transactionIndex,
        member: payer.publicKey,
      })
    );

    const after = await program.account.globalConfig.fetch(globalConfigPda);
    assert.isTrue(
      (after.governanceAuthority as PublicKey).equals(originalGovernanceAuthority),
      "restore-via-real-Squads-CPI did not land — governance_authority is still the vault PDA. " +
        "This is a real problem: it means this run's shared GlobalConfig is now stuck, which will " +
        "cascade into failures for any OTHER test file that happens to run after this one in the " +
        "same `anchor test` invocation (this file is named to sort last specifically to minimize " +
        "that blast radius, but re-run `anchor test` from scratch after investigating — it always " +
        "starts a brand-new validator/ledger, so this cannot leak into the next run)."
    );
  });
});
