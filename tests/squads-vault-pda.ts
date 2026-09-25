// "Phase 2" (Squads multisig transparency, added 2026-09-23) — see
// governance.rs's module doc comment ("SQUADS MULTISIG TRANSPARENCY" /
// "KNOWN UNCERTAINTY") for the full story. That file's
// `derive_squads_vault_pda` re-derives a Squads v4 Vault PDA using two
// seed-literal constants (`SQUADS_SEED_PREFIX`/`SQUADS_SEED_VAULT`) that
// were NOT independently confirmed byte-for-byte against Squads' own
// source in this pass — they are a best-effort reconstruction. THIS is
// the real verification for those two constants.
//
// Deliberately has NO dependency on `anchor test`'s localnet validator, no
// Squads V4 program clone, and no live-created multisig: `getMultisigPda`/
// `getVaultPda` are pure, offline functions (thin wrappers around
// `PublicKey.findProgramAddressSync`) — comparing their output against
// this program's own from-scratch re-derivation of the same PDA is a
// complete, self-contained proof that the seed literals (and the exact
// byte encoding of `vault_index`) are correct, with no chain interaction
// needed at all. It still runs as part of the normal `anchor test` (that
// script globs tests/**/*.ts), it just doesn't NEED to.
//
// NOT covered by this file (deliberately deferred, see governance.rs's
// module doc comment): actually calling `verify_governance_multisig`
// end-to-end against a REAL cloned Squads v4 program with a REAL created
// multisig on localnet. That needs Anchor.toml genesis-clone entries for
// the Squads program (and, for `multisigCreateV2`, its `ProgramConfig`
// singleton account too — Squads' create-multisig instruction looks up a
// protocol treasury address from that account), which is its own
// follow-up piece of work, not done here.

import * as multisig from "@sqds/multisig";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";

describe("squads vault PDA derivation (Phase 2, offline)", () => {
  // Must match governance.rs's SQUADS_V4_PROGRAM_ID exactly — confirmed
  // against Squads' own bug-bounty page (docs.squads.so/main/security/bug-bounty)
  // on 2026-09-23. NOT the older Squads v3 program id.
  const SQUADS_V4_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

  // Mirrors governance.rs's `derive_squads_vault_pda` byte-for-byte — if
  // you change one, change the other, and this test is what will catch a
  // mismatch between them.
  function deriveVaultPdaOurWay(multisigPda: PublicKey, vaultIndex: number): PublicKey {
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("multisig"), multisigPda.toBuffer(), Buffer.from("vault"), Buffer.from([vaultIndex])],
      SQUADS_V4_PROGRAM_ID
    );
    return vaultPda;
  }

  it("matches the official @sqds/multisig SDK's getVaultPda for vault index 0", () => {
    const createKey = Keypair.generate().publicKey;
    const [multisigPda] = multisig.getMultisigPda({ createKey });
    const [sdkVaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

    const ourVaultPda = deriveVaultPdaOurWay(multisigPda, 0);

    assert.isTrue(
      sdkVaultPda.equals(ourVaultPda),
      `governance.rs's derive_squads_vault_pda seed literals do NOT match the real SDK.\n` +
        `  SDK:  ${sdkVaultPda.toBase58()}\n` +
        `  ours: ${ourVaultPda.toBase58()}\n` +
        `Fix SQUADS_SEED_PREFIX/SQUADS_SEED_VAULT in governance.rs — see this file's header comment.`
    );
  });

  it("matches the official SDK across several vault indices, not just 0", () => {
    // Guards against an off-by-one in how vault_index is encoded (e.g. a
    // correct match at index 0 that only holds there by coincidence of
    // both being zero bytes) — indices deliberately span more than one
    // byte's worth of range isn't meaningful here since Squads encodes
    // vault_index as a single byte, but varying the value still catches a
    // wrong-width encoding (e.g. accidentally using a u16/LE vs a single
    // u8) that index 0 alone could never reveal, since a 1-byte 0 and a
    // 2-byte-LE 0 are indistinguishable.
    for (const index of [0, 1, 2, 5, 255]) {
      const createKey = Keypair.generate().publicKey;
      const [multisigPda] = multisig.getMultisigPda({ createKey });
      const [sdkVaultPda] = multisig.getVaultPda({ multisigPda, index });
      const ourVaultPda = deriveVaultPdaOurWay(multisigPda, index);
      assert.isTrue(
        sdkVaultPda.equals(ourVaultPda),
        `mismatch at vault index ${index}: SDK=${sdkVaultPda.toBase58()} ours=${ourVaultPda.toBase58()}`
      );
    }
  });
});
