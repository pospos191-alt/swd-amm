#!/usr/bin/env ts-node
// Governance OPS CLI (added 2026-09-24) — a real operational tool for
// calling this program's governance instructions against a REAL deployed
// program (devnet or mainnet-beta), signed by a REAL keypair or, more
// realistically, run once per member as part of building up a Squads
// proposal. This is NOT a test script — nothing here spins up a local
// validator or uses test fixtures; it talks to whatever cluster/wallet
// your Solana CLI config (or ANCHOR_PROVIDER_URL/ANCHOR_WALLET env vars)
// currently points at, exactly like any other Anchor CLI-adjacent tool.
//
// WRITTEN BLIND, NOT YET RUN AGAINST A REAL DEPLOYMENT: same caveat as
// everything else added this pass (see SECURITY.md) — this was authored
// without a live devnet/mainnet deployment to actually exercise it
// against. Try every subcommand against devnet first, read the printed
// output carefully, and only then trust it against mainnet-beta.
//
// SAFETY: every state-changing subcommand PRINTS what it is about to do
// and requires `--yes` to actually submit the transaction — running any
// subcommand without `--yes` is always a safe, read-only dry run that
// shows you the exact accounts/args it would use.
//
// Usage:
//   yarn ts-node scripts/governance.ts <command> [args...] [--yes]
//
// Commands:
//   status
//       Fetch and print GlobalConfig (governance_authority,
//       emergency_authority, pool_creation_paused) plus the program id and
//       cluster this CLI is currently pointed at. Always read-only.
//
//   init-global-config <governanceAuthority> <emergencyAuthority>
//       One-time bootstrap. Only ever works once per deployment.
//
//   set-authorities <newGovernanceAuthority> <newEmergencyAuthority>
//       Must be signed by the CURRENT governance_authority — if that is a
//       Squads vault, this instruction has to be wrapped in a Squads
//       vaultTransactionCreate/proposalCreate/.../vaultTransactionExecute
//       flow (e.g. via the Squads UI or SDK), not run directly from this
//       CLI's own wallet. This subcommand still builds and prints the
//       instruction's accounts/args either way, useful for constructing
//       that Squads transaction by hand.
//
//   set-pool-creation-paused <true|false>
//       Governance-only global switch — stops ALL new pool creation
//       instantly, does not touch any existing pool.
//
//   set-allowed-mint <mintPubkey> <true|false>
//       Governance-only. Enables/disables a mint for NEW pool creation
//       (existing pools using this mint are unaffected either way).
//
//   emergency-pause-pool <mintA> <mintB> <pauseSwap> <pauseDeposit> <pauseWithdraw>
//   emergency-pause-dlmm-pool <mintA> <mintB> <pauseSwap> <pauseDeposit> <pauseWithdraw>
//       Emergency-authority-only, instant, pause-only. <mintA>/<mintB>
//       must be given in the SAME order the pool was created with (this
//       program has no canonical mint ordering — see SECURITY.md's design
//       notes). <pauseSwap>/<pauseDeposit>/<pauseWithdraw> are each
//       "true"/"false".
//
//   governed-unpause-pool <mintA> <mintB> <unpauseSwap> <unpauseDeposit> <unpauseWithdraw>
//   governed-unpause-dlmm-pool <mintA> <mintB> <unpauseSwap> <unpauseDeposit> <unpauseWithdraw>
//       Governance-only (NOT emergency_authority — see governance.rs's
//       module doc comment for why that split is deliberate).
//
//   --- Governance v2 (timelock.rs / swdmm_v2.rs, added 2026-09-29) ---
//
//   init-settings <timelockDelaySecs> <protocolFeeShareBps> <treasury>
//       One-time. Delay must be 5s-48h on a devnet build, 24h-48h on a
//       `--features mainnet` build. Share is capped at 2000 (20%).
//
//   settings
//       Read-only: GovernanceSettings plus every governance action and its
//       status (pending / ready / executed / cancelled).
//
//   set-mint-policy <mint> <true|false> [reviewed]
//       SWDMM v2 allowlist. Pass "reviewed" to confirm a Token-2022 mint
//       was reviewed (required to enable one).
//
//   propose-unpause-cp   <mintA> <mintB> <swap> <deposit> <withdraw>
//   propose-unpause-dlmm <mintA> <mintB> <swap> <deposit> <withdraw>
//   propose-unpause-v2   <pool> <swap> <deposit> <withdraw>
//   propose-protocol-fee-share <bps>
//   propose-timelock-delay <secs>
//   propose-treasury <pubkey>
//   propose-v2-params <pool> <maxPriceImpactBps> <dynamicFeeEnabled>
//   propose-withdraw-protocol-fees <pool>
//       Governance-only: queue a timelocked action. Prints its id and the
//       earliest time it can be executed.
//
//   execute <actionId>
//       Anyone, after the delay. Builds the right accounts for the action
//       kind (for protocol-fee withdrawals it creates the treasury's token
//       accounts if needed).
//
//   cancel <actionId>
//       Governance-only, before execution.
//
//   emergency-pause-v2-pool <pool> <pauseSwap> <pauseDeposit> <pauseWithdraw>
//
//   NOTE: governed-unpause-pool / governed-unpause-dlmm-pool below now
//   always fail on-chain (UseTimelockedUnpause) — use propose-unpause-*.
//
//   verify-multisig <squadsMultisigPubkey> <vaultIndex>
//       Permissionless, read-only in effect (emits an event, writes
//       nothing). Confirms the given Squads Multisig account's vault at
//       <vaultIndex> really is this program's current governance_authority
//       and prints that multisig's real threshold/member count. See
//       tests/z-squads-live-verification.ts for the same check exercised
//       against a real cloned Squads program in the test suite.
//
// Every subcommand accepts an optional trailing `--yes` to actually submit
// (state-changing ones only — `status` and `verify-multisig` always run).

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const GLOBAL_CONFIG_SEED = Buffer.from("global-config");
const ALLOWED_MINT_SEED = Buffer.from("allowed-mint");
const POOL_SEED = Buffer.from("pool");
const DLMM_POOL_SEED = Buffer.from("dlmm_pool"); // fixed 2026-09-29: the program seed is "dlmm_pool"
const GOV_SETTINGS_SEED = Buffer.from("gov_settings");
const GOV_ACTION_SEED = Buffer.from("gov_action");
const MINT_POLICY_SEED = Buffer.from("mint_policy");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function loadProgram(): anchor.Program<anchor.Idl> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idlPath = path.resolve(__dirname, "..", "target", "idl", "swd_amm.json");
  if (!fs.existsSync(idlPath)) {
    console.error(
      `Could not find ${idlPath} — run \`anchor build\` first (this CLI reads the IDL it generates, ` +
        `same as \`anchor test\` does).`
    );
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  // Anchor 0.30+ IDLs embed the program's address; older ones need it
  // passed explicitly. Prefer the embedded one so this CLI automatically
  // tracks whichever cluster's declare_id! you actually built against.
  const programId = new PublicKey(idl.address ?? idl.metadata?.address);
  return new anchor.Program(idl, provider) as anchor.Program<anchor.Idl>;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function parseBool(raw: string | undefined, label: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  console.error(`Expected "true" or "false" for ${label}, got: ${raw}`);
  process.exit(1);
}

function parsePubkey(raw: string | undefined, label: string): PublicKey {
  if (!raw) {
    console.error(`Missing required argument: ${label}`);
    process.exit(1);
  }
  try {
    return new PublicKey(raw);
  } catch {
    console.error(`Not a valid pubkey for ${label}: ${raw}`);
    process.exit(1);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const yes = rawArgs.includes("--yes");
  const args = rawArgs.filter((a) => a !== "--yes");
  const [command, ...rest] = args;

  const program = loadProgram();
  const provider = program.provider as anchor.AnchorProvider;
  const wallet = provider.wallet.publicKey;
  const configPda = pda([GLOBAL_CONFIG_SEED], program.programId);
  const actionPda = (id: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(id));
    return pda([GOV_ACTION_SEED, b], program.programId);
  };

  console.log(`# swd-amm governance CLI`);
  console.log(`# cluster:    ${provider.connection.rpcEndpoint}`);
  console.log(`# program id: ${program.programId.toBase58()}`);
  console.log(`# wallet:     ${wallet.toBase58()}`);
  console.log(`# config PDA: ${configPda.toBase58()}`);
  console.log();

  async function confirmOrDryRun(describe: () => void, submit: () => Promise<string>) {
    describe();
    if (!yes) {
      console.log();
      console.log("(dry run — nothing was submitted. Re-run with --yes to actually send this transaction.)");
      return;
    }
    console.log();
    console.log("Submitting...");
    const sig = await submit();
    console.log(`Confirmed: ${sig}`);
  }

  switch (command) {
    case "status": {
      const config = await (program.account as any).globalConfig.fetch(configPda);
      console.log("GlobalConfig:");
      console.log(`  governance_authority: ${(config.governanceAuthority as PublicKey).toBase58()}`);
      console.log(`  emergency_authority:  ${(config.emergencyAuthority as PublicKey).toBase58()}`);
      console.log(`  pool_creation_paused: ${config.poolCreationPaused}`);
      break;
    }

    case "init-global-config": {
      const governanceAuthority = parsePubkey(rest[0], "governanceAuthority");
      const emergencyAuthority = parsePubkey(rest[1], "emergencyAuthority");
      await confirmOrDryRun(
        () => {
          console.log("Would call initialize_global_config with:");
          console.log(`  governance_authority: ${governanceAuthority.toBase58()}`);
          console.log(`  emergency_authority:  ${emergencyAuthority.toBase58()}`);
          console.log(`  payer (this wallet):  ${wallet.toBase58()}`);
        },
        () =>
          program.methods
            .initializeGlobalConfig(governanceAuthority, emergencyAuthority)
            .accounts({ config: configPda, programData: PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0], payer: wallet, systemProgram: SystemProgram.programId })
            .rpc()
      );
      break;
    }

    case "set-authorities": {
      const newGovernanceAuthority = parsePubkey(rest[0], "newGovernanceAuthority");
      const newEmergencyAuthority = parsePubkey(rest[1], "newEmergencyAuthority");
      const config = await (program.account as any).globalConfig.fetch(configPda);
      await confirmOrDryRun(
        () => {
          console.log("Would call set_authorities with:");
          console.log(`  new_governance_authority: ${newGovernanceAuthority.toBase58()}`);
          console.log(`  new_emergency_authority:  ${newEmergencyAuthority.toBase58()}`);
          console.log(
            `  governance_authority (signer, must == current governance_authority = ` +
              `${(config.governanceAuthority as PublicKey).toBase58()}): ${wallet.toBase58()}`
          );
          if (!(config.governanceAuthority as PublicKey).equals(wallet)) {
            console.log(
              "  WARNING: this wallet is NOT the current governance_authority — if that authority is a " +
                "Squads vault, submitting from here will fail. Use this subcommand's printed accounts/args " +
                "to build the equivalent instruction inside a Squads proposal instead."
            );
          }
        },
        () =>
          program.methods
            .setAuthorities(newGovernanceAuthority, newEmergencyAuthority)
            .accounts({ config: configPda, governanceAuthority: wallet })
            .rpc()
      );
      break;
    }

    case "set-pool-creation-paused": {
      const paused = parseBool(rest[0], "paused");
      await confirmOrDryRun(
        () => console.log(`Would call set_pool_creation_paused(${paused})`),
        () =>
          program.methods
            .setPoolCreationPaused(paused)
            .accounts({ config: configPda, governanceAuthority: wallet })
            .rpc()
      );
      break;
    }

    case "set-allowed-mint": {
      const mint = parsePubkey(rest[0], "mintPubkey");
      const enabled = parseBool(rest[1], "enabled");
      const allowedMintPda = pda([ALLOWED_MINT_SEED, mint.toBuffer()], program.programId);
      await confirmOrDryRun(
        () => {
          console.log(`Would call set_allowed_mint(${enabled}) for:`);
          console.log(`  mint:         ${mint.toBase58()}`);
          console.log(`  allowed_mint: ${allowedMintPda.toBase58()}`);
        },
        () =>
          program.methods
            .setAllowedMint(enabled)
            .accounts({
              config: configPda,
              governanceAuthority: wallet,
              mint,
              allowedMint: allowedMintPda,
              payer: wallet,
              systemProgram: SystemProgram.programId,
            })
            .rpc()
      );
      break;
    }

    case "emergency-pause-pool":
    case "emergency-pause-dlmm-pool":
    case "governed-unpause-pool":
    case "governed-unpause-dlmm-pool": {
      const isDlmm = command.includes("dlmm");
      const isEmergency = command.startsWith("emergency");
      const mintA = parsePubkey(rest[0], "mintA");
      const mintB = parsePubkey(rest[1], "mintB");
      const flagSwap = parseBool(rest[2], isEmergency ? "pauseSwap" : "unpauseSwap");
      const flagDeposit = parseBool(rest[3], isEmergency ? "pauseDeposit" : "unpauseDeposit");
      const flagWithdraw = parseBool(rest[4], isEmergency ? "pauseWithdraw" : "unpauseWithdraw");

      const poolSeed = isDlmm ? DLMM_POOL_SEED : POOL_SEED;
      const poolPda = pda([poolSeed, mintA.toBuffer(), mintB.toBuffer()], program.programId);
      const authorityField = isEmergency ? "emergencyAuthority" : "governanceAuthority";
      const methodName = isEmergency
        ? isDlmm
          ? "emergencyPauseDlmmPool"
          : "emergencyPausePool"
        : isDlmm
          ? "governedUnpauseDlmmPool"
          : "governedUnpausePool";

      await confirmOrDryRun(
        () => {
          console.log(`Would call ${methodName}(${flagSwap}, ${flagDeposit}, ${flagWithdraw}) for:`);
          console.log(`  pool (${isDlmm ? "DLMM" : "constant-product"}): ${poolPda.toBase58()}`);
          console.log(`  mintA: ${mintA.toBase58()}`);
          console.log(`  mintB: ${mintB.toBase58()}`);
          console.log(`  ${authorityField} (signer): ${wallet.toBase58()}`);
        },
        () =>
          (program.methods as any)
            [methodName](flagSwap, flagDeposit, flagWithdraw)
            .accounts({ config: configPda, [authorityField]: wallet, pool: poolPda })
            .rpc()
      );
      break;
    }

    case "init-settings": {
      const delay = Number(rest[0]);
      const share = Number(rest[1]);
      const treasury = parsePubkey(rest[2], "treasury");
      const settings = pda([GOV_SETTINGS_SEED], program.programId);
      await confirmOrDryRun(
        () => console.log(`Would call initialize_governance_settings(delay=${delay}s, protocolFeeShare=${share}bps, treasury=${treasury.toBase58()})`),
        () =>
          program.methods
            .initializeGovernanceSettings(new anchor.BN(delay), share, treasury)
            .accounts({ config: configPda, governanceAuthority: wallet, settings, payer: wallet, systemProgram: SystemProgram.programId })
            .rpc()
      );
      break;
    }

    case "settings": {
      const settingsPda = pda([GOV_SETTINGS_SEED], program.programId);
      const st: any = await (program.account as any).governanceSettings.fetchNullable(settingsPda);
      if (!st) {
        console.log("GovernanceSettings not initialized yet — run init-settings.");
        break;
      }
      console.log("GovernanceSettings:");
      console.log(`  timelock_delay_secs:    ${st.timelockDelaySecs.toString()}`);
      console.log(`  protocol_fee_share_bps: ${st.protocolFeeShareBps}`);
      console.log(`  treasury:               ${st.treasury.toBase58()}`);
      console.log(`  actions proposed:       ${st.nextActionId.toString()}`);
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < Number(st.nextActionId); i++) {
        const a: any = await (program.account as any).pendingAction.fetchNullable(actionPda(i));
        if (!a) continue;
        const status = a.executed ? "executed" : a.cancelled ? "cancelled" : now >= Number(a.executeAfter) ? "READY" : `pending until ${new Date(Number(a.executeAfter) * 1000).toISOString()}`;
        console.log(`  #${i} ${JSON.stringify(a.action, (_k, v) => (v instanceof PublicKey ? v.toBase58() : v))} — ${status}`);
      }
      break;
    }

    case "set-mint-policy": {
      const mint = parsePubkey(rest[0], "mint");
      const enabled = parseBool(rest[1], "enabled");
      const reviewed = rest[2] === "reviewed";
      const info = await provider.connection.getAccountInfo(mint);
      if (!info) { console.error("Mint not found on this cluster."); process.exit(1); }
      const tokenProgram = info.owner;
      const mintPolicy = pda([MINT_POLICY_SEED, mint.toBuffer()], program.programId);
      await confirmOrDryRun(
        () => console.log(`Would call set_mint_policy(enabled=${enabled}, token_2022_reviewed=${reviewed}) for ${mint.toBase58()} (token program ${tokenProgram.toBase58()})`),
        () =>
          program.methods
            .setMintPolicy(enabled, reviewed)
            .accounts({ config: configPda, governanceAuthority: wallet, mint, tokenProgram, mintPolicy, payer: wallet, systemProgram: SystemProgram.programId })
            .rpc()
      );
      break;
    }

    case "propose-unpause-cp":
    case "propose-unpause-dlmm":
    case "propose-unpause-v2":
    case "propose-protocol-fee-share":
    case "propose-timelock-delay":
    case "propose-treasury":
    case "propose-v2-params":
    case "propose-withdraw-protocol-fees": {
      let action: any;
      if (command === "propose-unpause-cp" || command === "propose-unpause-dlmm") {
        const mintA = parsePubkey(rest[0], "mintA");
        const mintB = parsePubkey(rest[1], "mintB");
        const seed = command === "propose-unpause-cp" ? POOL_SEED : DLMM_POOL_SEED;
        const pool = pda([seed, mintA.toBuffer(), mintB.toBuffer()], program.programId);
        const body = { pool, swap: parseBool(rest[2], "swap"), deposit: parseBool(rest[3], "deposit"), withdraw: parseBool(rest[4], "withdraw") };
        action = command === "propose-unpause-cp" ? { unpauseCpPool: body } : { unpauseDlmmPool: body };
      } else if (command === "propose-unpause-v2") {
        action = { unpauseV2Pool: { pool: parsePubkey(rest[0], "pool"), swap: parseBool(rest[1], "swap"), deposit: parseBool(rest[2], "deposit"), withdraw: parseBool(rest[3], "withdraw") } };
      } else if (command === "propose-protocol-fee-share") {
        action = { setProtocolFeeShare: { bps: Number(rest[0]) } };
      } else if (command === "propose-timelock-delay") {
        action = { setTimelockDelay: { secs: new anchor.BN(Number(rest[0])) } };
      } else if (command === "propose-treasury") {
        action = { setTreasury: { treasury: parsePubkey(rest[0], "treasury") } };
      } else if (command === "propose-v2-params") {
        action = { setV2PoolParams: { pool: parsePubkey(rest[0], "pool"), maxPriceImpactBps: Number(rest[1]), dynamicFeeEnabled: parseBool(rest[2], "dynamicFeeEnabled") } };
      } else {
        action = { withdrawV2ProtocolFees: { pool: parsePubkey(rest[0], "pool") } };
      }
      const settingsPda = pda([GOV_SETTINGS_SEED], program.programId);
      const st: any = await (program.account as any).governanceSettings.fetch(settingsPda);
      const id = Number(st.nextActionId);
      const pending = actionPda(id);
      await confirmOrDryRun(
        () => {
          console.log(`Would propose governance action #${id}:`);
          console.log(`  ${JSON.stringify(action, (_k, v) => (v instanceof PublicKey ? v.toBase58() : v))}`);
          console.log(`  executable after ~${st.timelockDelaySecs.toString()}s (timelock)`);
        },
        () =>
          program.methods
            .proposeGovAction(action)
            .accounts({ config: configPda, governanceAuthority: wallet, settings: settingsPda, pending, payer: wallet, systemProgram: SystemProgram.programId })
            .rpc()
      );
      break;
    }

    case "execute":
    case "cancel": {
      const id = Number(rest[0]);
      const pending = actionPda(id);
      const a: any = await (program.account as any).pendingAction.fetch(pending);
      const kind = Object.keys(a.action)[0];
      const body = a.action[kind];
      if (command === "cancel") {
        await confirmOrDryRun(
          () => console.log(`Would cancel action #${id} (${kind})`),
          () => program.methods.cancelGovAction().accounts({ config: configPda, governanceAuthority: wallet, pending }).rpc()
        );
        break;
      }
      const settingsPda = pda([GOV_SETTINGS_SEED], program.programId);
      let builder: any;
      if (kind === "unpauseCpPool") builder = program.methods.executeUnpausePool().accounts({ pending, pool: body.pool });
      else if (kind === "unpauseDlmmPool") builder = program.methods.executeUnpauseDlmmPool().accounts({ pending, pool: body.pool });
      else if (kind === "unpauseV2Pool" || kind === "setV2PoolParams") builder = program.methods.executeV2PoolAction().accounts({ pending, pool: body.pool });
      else if (kind === "withdrawV2ProtocolFees") {
        const st: any = await (program.account as any).governanceSettings.fetch(settingsPda);
        const pool: any = await (program.account as any).swdmmV2Pool.fetch(body.pool);
        const ataOf = (mint: PublicKey, owner: PublicKey, prog: PublicKey) =>
          PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
        const ta = ataOf(pool.mintA, st.treasury, pool.tokenProgramA);
        const tb = ataOf(pool.mintB, st.treasury, pool.tokenProgramB);
        const createAta = (ata: PublicKey, mint: PublicKey, prog: PublicKey) => new anchor.web3.TransactionInstruction({
          programId: ATA_PROGRAM,
          keys: [
            { pubkey: wallet, isSigner: true, isWritable: true },
            { pubkey: ata, isSigner: false, isWritable: true },
            { pubkey: st.treasury, isSigner: false, isWritable: false },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: prog, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([1]), // CreateIdempotent
        });
        builder = program.methods.executeWithdrawProtocolFees()
          .accounts({ pending, settings: settingsPda, pool: body.pool, mintA: pool.mintA, mintB: pool.mintB, vaultA: pool.vaultA, vaultB: pool.vaultB, treasuryTokenA: ta, treasuryTokenB: tb, tokenProgramA: pool.tokenProgramA, tokenProgramB: pool.tokenProgramB })
          .preInstructions([createAta(ta, pool.mintA, pool.tokenProgramA), createAta(tb, pool.mintB, pool.tokenProgramB)]);
      } else builder = program.methods.executeSettingsAction().accounts({ pending, settings: settingsPda });
      await confirmOrDryRun(
        () => console.log(`Would execute action #${id} (${kind}); earliest execution ${new Date(Number(a.executeAfter) * 1000).toISOString()}`),
        () => builder.rpc()
      );
      break;
    }

    case "emergency-pause-v2-pool": {
      const pool = parsePubkey(rest[0], "pool");
      const f = [parseBool(rest[1], "pauseSwap"), parseBool(rest[2], "pauseDeposit"), parseBool(rest[3], "pauseWithdraw")];
      await confirmOrDryRun(
        () => console.log(`Would call emergency_pause_v2_pool(${f.join(", ")}) on ${pool.toBase58()} (signer must be emergency_authority)`),
        () => program.methods.emergencyPauseV2Pool(f[0], f[1], f[2]).accounts({ config: configPda, emergencyAuthority: wallet, pool }).rpc()
      );
      break;
    }

    case "verify-multisig": {
      const squadsMultisig = parsePubkey(rest[0], "squadsMultisigPubkey");
      const vaultIndex = Number(rest[1] ?? "0");
      console.log(`Calling verify_governance_multisig(vault_index=${vaultIndex}) for ${squadsMultisig.toBase58()}...`);
      console.log("(permissionless + read-only in effect — this always submits, no --yes needed)");
      const sig = await program.methods
        .verifyGovernanceMultisig(vaultIndex)
        .accounts({ config: configPda, squadsMultisig })
        .rpc();
      console.log(`Confirmed: ${sig}`);
      const tx = await provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = tx?.meta?.logMessages ?? [];
      const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
      const ev = Array.from(parser.parseLogs(logs)).find((e) => e.name === "governanceMultisigVerified" || e.name === "GovernanceMultisigVerified");
      if (ev) {
        const d: any = ev.data;
        console.log("GovernanceMultisigVerified:");
        console.log(`  squads_multisig:      ${d.squadsMultisig?.toBase58?.() ?? d.squads_multisig?.toBase58?.()}`);
        console.log(`  governance_authority: ${(d.governanceAuthority ?? d.governance_authority)?.toBase58?.()}`);
        console.log(`  threshold:            ${d.threshold} of ${d.memberCount ?? d.member_count}`);
      } else {
        console.log("(no GovernanceMultisigVerified event found in this transaction's logs — check the signature on an explorer)");
      }
      break;
    }

    default:
      console.error(
        `Unknown or missing command: ${command ?? "(none)"}\n\n` +
          `Run with no arguments to see this file's own header comment for the full command list, or open ` +
          `scripts/governance.ts directly.`
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
