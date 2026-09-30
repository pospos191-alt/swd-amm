#!/usr/bin/env ts-node
// Squads v4 multisig setup for SWDMM governance (added 2026-09-29, mainnet kit).
//
// Creates a Squads v4 multisig (2-of-3 or 3-of-5 — the only two policies the
// SWDMM spec allows) and prints the vault PDA that must become:
//   1. GlobalConfig.governance_authority  (scripts/governance.ts set-authorities)
//   2. the program's upgrade authority     (solana program set-upgrade-authority)
// and verifies the result on-chain with `verify_governance_multisig`.
//
// Like scripts/governance.ts: dry run by default, `--yes` to submit.
// Talks to whatever ANCHOR_PROVIDER_URL / ANCHOR_WALLET point at.
//
// Usage:
//   yarn ts-node --transpile-only scripts/squads-setup.ts create <threshold> <member1> <member2> <member3> [member4 member5] [--yes]
//   yarn ts-node --transpile-only scripts/squads-setup.ts show <multisigPda>
//
// Every member should be a separate hardware wallet held by a different
// person. The emergency authority must NOT be one of these keys' vaults.

import * as anchor from "@coral-xyz/anchor";
import * as multisig from "@sqds/multisig";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const raw = process.argv.slice(2);
  const yes = raw.includes("--yes");
  const [command, ...rest] = raw.filter((a) => a !== "--yes");
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  console.log(`# cluster: ${conn.rpcEndpoint}`);
  console.log(`# wallet:  ${payer.publicKey.toBase58()}`);

  if (command === "create") {
    const threshold = Number(rest[0]);
    const members = rest.slice(1).map((m) => {
      try { return new PublicKey(m); } catch { fail(`Not a pubkey: ${m}`); }
    });
    const ok = (threshold === 2 && members.length === 3) || (threshold === 3 && members.length === 5);
    if (!ok) fail("SWDMM policy: use exactly 2-of-3 or 3-of-5 (threshold then the member pubkeys).");
    if (new Set(members.map((m) => m.toBase58())).size !== members.length) fail("Members must be distinct.");

    const createKey = Keypair.generate();
    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
    console.log(`Would create a ${threshold}-of-${members.length} Squads v4 multisig:`);
    members.forEach((m, i) => console.log(`  member ${i + 1}: ${m.toBase58()}`));
    console.log(`  multisig PDA: ${multisigPda.toBase58()}`);
    console.log(`  vault PDA (index 0) — the new governance authority: ${vaultPda.toBase58()}`);
    if (!yes) {
      console.log("\n(dry run — re-run with --yes to create it)");
      return;
    }
    const programConfigPda = multisig.getProgramConfigPda({})[0];
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
    const sig = await multisig.rpc.multisigCreateV2({
      connection: conn,
      createKey,
      creator: payer,
      multisigPda,
      configAuthority: null,
      timeLock: 0,
      members: members.map((key) => ({ key, permissions: multisig.types.Permissions.all() })),
      threshold,
      rentCollector: null,
      treasury: programConfig.treasury,
    });
    const res = await conn.confirmTransaction(sig, "confirmed");
    if (res.value.err) fail(`multisig creation failed on-chain: ${JSON.stringify(res.value.err)}`);
    const out = { multisigPda: multisigPda.toBase58(), vaultPda: vaultPda.toBase58(), threshold, members: members.map((m) => m.toBase58()), createdAt: new Date().toISOString(), cluster: conn.rpcEndpoint, signature: sig };
    const file = path.resolve(__dirname, "..", `squads-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`\nCreated. Details saved to ${file}`);
    console.log("\nNext steps (see docs/MAINNET_RUNBOOK.md):");
    console.log(`  1. yarn governance set-authorities ${vaultPda.toBase58()} <emergencyAuthority> --yes`);
    console.log(`  2. solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority ${vaultPda.toBase58()} --skip-new-upgrade-authority-signer-check`);
    console.log(`  3. yarn governance verify-multisig ${multisigPda.toBase58()} 0`);
    return;
  }

  if (command === "show") {
    const pda = new PublicKey(rest[0] || fail("usage: show <multisigPda>"));
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, pda);
    const [vaultPda] = multisig.getVaultPda({ multisigPda: pda, index: 0 });
    console.log(`multisig:  ${pda.toBase58()}`);
    console.log(`vault[0]:  ${vaultPda.toBase58()}`);
    console.log(`threshold: ${ms.threshold} of ${ms.members.length}`);
    ms.members.forEach((m: any, i: number) => console.log(`  member ${i + 1}: ${m.key.toBase58()}`));
    const policyOk = (ms.threshold === 2 && ms.members.length === 3) || (ms.threshold === 3 && ms.members.length === 5);
    console.log(policyOk ? "policy: OK (2-of-3 or 3-of-5)" : "policy: NOT the SWDMM policy (needs 2-of-3 or 3-of-5)");
    return;
  }

  fail("Commands: create <threshold> <members...> [--yes] | show <multisigPda>");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
