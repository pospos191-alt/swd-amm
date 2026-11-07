// SWD Audit Court (programs/swd_audit_court, added 2026-11-07).
// Runs in the same `anchor test` validator as the other suites; its Config
// singleton is created here by the provider wallet (= the program's upgrade
// authority, Anchor.toml [test] upgradeable).
//
// Covers: upgrade-authority-only initialize; parameter bounds; badge mints
// must be NonTransferable Token-2022 mints; the subject named like the Audit
// Registry (Record PDA ["audit", chain_id LE, sha256(address)]); bond escrow;
// defend; badge-weighted votes (distinct mints summed), one vote per voter,
// opener/defender cannot vote, someone else's badge / a transferable token /
// no badge refused; voting-period enforcement; Upheld (opener paid + share of
// the defender's bond), Rejected without defender (bond -> treasury),
// NoQuorum (refund), admin cancel (refund only); pause (finalize still works);
// mark_applied; close_vote; two-step admin hand-over.

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { createHash } from "crypto";
import { PublicKey, Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeNonTransferableMintInstruction,
  createInitializeMintInstruction,
  createMint,
  createAssociatedTokenAccountIdempotent,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
  mintTo,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

async function expectThrows(fn: () => Promise<unknown>, label: string): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error(`expected "${label}" to throw, but it succeeded`);
}
function hasCode(err: any, name: string): boolean {
  if (err?.error?.errorCode?.code === name) return true;
  const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
  return logs.some((l) => l.includes(`Error Code: ${name}.`)) || String(err?.message ?? err).includes(name);
}
async function expectCode(fn: () => Promise<unknown>, name: string) {
  const err = await expectThrows(fn, name);
  assert.isTrue(hasCode(err, name), `expected ${name}, got: ${String(err?.message ?? err).slice(0, 400)} ${JSON.stringify(err?.logs ?? []).slice(0, 900)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest();

describe("swd_audit_court", () => {
  // "confirmed" for every send and read: @solana/spl-token resolves the hook's
  // extra accounts (and tests read balances) at "confirmed", and Anchor's
  // default "processed" would race those reads. Own provider, so the other
  // suites' global provider is left as it is.
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(new Connection(envProvider.connection.rpcEndpoint, "confirmed"), envProvider.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const program = new anchor.Program<any>((anchor.workspace.SwdAuditCourt as anchor.Program<any>).idl, provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // upgrade authority + admin

  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const config = pda(Buffer.from("court"));
  const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u64le = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const disputePda = (id: number) => pda(Buffer.from("dispute"), u64le(id));
  const vaultPda = (d: PublicKey) => pda(Buffer.from("vault"), d.toBuffer());
  const votePda = (d: PublicKey, v: PublicKey) => pda(Buffer.from("vote"), d.toBuffer(), v.toBuffer());
  const programData = PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];

  // the registry is another program (not deployed); any id works for deriving Record PDAs
  const registryProgram = Keypair.generate().publicKey;
  const SOL_MINT = Buffer.from("So11111111111111111111111111111111111111112");
  const subjectHash = sha256(SOL_MINT);
  const recordPda = PublicKey.findProgramAddressSync([Buffer.from("audit"), u16le(6), subjectHash], registryProgram)[0];

  const BOND = 1_000_000; // 10 SWD at 5 decimals
  const VOTING_SECS = 6;
  const treasuryOwner = Keypair.generate();
  const opener = Keypair.generate();
  const defender = Keypair.generate();
  const v1 = Keypair.generate(); // badge A (w1)
  const v2 = Keypair.generate(); // badges A + B (w4)
  const v3 = Keypair.generate(); // badge B (w3)
  const noBadge = Keypair.generate();
  const stranger = Keypair.generate();
  let bondMint: PublicKey;
  let badgeA: PublicKey;
  let badgeB: PublicKey;
  let transferable: PublicKey; // a plain Token-2022 mint (NOT soulbound)

  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(bondMint, owner, true, TOKEN_PROGRAM_ID);
  const badgeAta = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const bal = async (owner: PublicKey) => (await getAccount(conn, ata(owner), "confirmed")).amount;

  async function makeT22Mint(soulbound: boolean): Promise<PublicKey> {
    const mint = Keypair.generate();
    const exts = soulbound ? [ExtensionType.NonTransferable] : [];
    const len = getMintLen(exts);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
    );
    if (soulbound) tx.add(createInitializeNonTransferableMintInstruction(mint.publicKey, TOKEN_2022_PROGRAM_ID));
    tx.add(createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID));
    await sendAndConfirmTransaction(conn, tx, [payer, mint]);
    return mint.publicKey;
  }
  async function giveBadge(mint: PublicKey, owner: PublicKey) {
    const a = badgeAta(mint, owner);
    await sendAndConfirmTransaction(conn, new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, owner, mint, TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(mint, a, payer.publicKey, 1, [], TOKEN_2022_PROGRAM_ID),
    ), [payer]);
  }

  const baseParams = (over: any = {}) => ({
    admin: payer.publicKey,
    treasuryOwner: treasuryOwner.publicKey,
    registryProgram,
    bondAmount: new BN(BOND),
    votingSecs: new BN(VOTING_SECS),
    quorumWeight: new BN(4),
    passBps: 5_000,
    winnerShareBps: 5_000,
    badges: [{ mint: badgeA, weight: 1 }, { mint: badgeB, weight: 3 }],
    ...over,
  });
  const badgeMintAccounts = (mints: PublicKey[]) => mints.map((m) => ({ pubkey: m, isSigner: false, isWritable: false }));

  async function open(id: number, by: Keypair = opener) {
    const dispute = disputePda(id);
    await program.methods
      .openDispute(6, Array.from(subjectHash), Array.from(sha256(Buffer.from("payload"))), 0, Array.from(sha256(Buffer.from(`evidence ${id}`))))
      .accountsStrict({
        opener: by.publicKey, config, dispute, vault: vaultPda(dispute), openerToken: ata(by.publicKey), bondMint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([by])
      .rpc();
    return dispute;
  }
  function voteIx(dispute: PublicKey, voter: Keypair, support: boolean, badgeAccounts: PublicKey[]) {
    return program.methods
      .vote(support)
      .accountsStrict({ voter: voter.publicKey, config, dispute, voteRecord: votePda(dispute, voter.publicKey), systemProgram: SystemProgram.programId })
      .remainingAccounts(badgeAccounts.map((p) => ({ pubkey: p, isSigner: false, isWritable: false })))
      .signers([voter]);
  }
  const settleAccounts = (dispute: PublicKey, defenderOwner: PublicKey | null) => ({
    config, dispute, vault: vaultPda(dispute), opener: opener.publicKey, openerToken: ata(opener.publicKey),
    defenderToken: defenderOwner ? ata(defenderOwner) : null, treasuryToken: ata(treasuryOwner.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
  });
  const finalize = (dispute: PublicKey, defenderOwner: PublicKey | null = null) =>
    program.methods.finalize().accountsStrict(settleAccounts(dispute, defenderOwner)).rpc();

  before(async () => {
    const tx = new Transaction();
    for (const k of [treasuryOwner, opener, defender, v1, v2, v3, noBadge, stranger]) {
      tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: LAMPORTS_PER_SOL / 5 }));
    }
    await sendAndConfirmTransaction(conn, tx, [payer]);

    bondMint = await createMint(conn, payer, payer.publicKey, null, 5); // classic SPL, like SWD
    for (const k of [treasuryOwner, opener, defender, v1, stranger]) {
      await createAssociatedTokenAccountIdempotent(conn, payer, bondMint, k.publicKey);
    }
    for (const k of [opener, defender, v1]) await mintTo(conn, payer, bondMint, ata(k.publicKey), payer, 10 * BOND);

    badgeA = await makeT22Mint(true);
    badgeB = await makeT22Mint(true);
    transferable = await makeT22Mint(false);
    await giveBadge(badgeA, v1.publicKey);
    await giveBadge(badgeA, v2.publicKey);
    await giveBadge(badgeB, v2.publicKey);
    await giveBadge(badgeB, v3.publicKey);
    await giveBadge(badgeA, opener.publicKey);
    await giveBadge(transferable, noBadge.publicKey);
  });

  describe("initialize / config", () => {
    it("only the upgrade authority can initialize", async () => {
      await expectCode(
        () => program.methods.initialize(baseParams({ admin: stranger.publicKey })).accountsStrict({ config, payer: stranger.publicKey, programData, bondMint, systemProgram: SystemProgram.programId })
          .remainingAccounts(badgeMintAccounts([badgeA, badgeB])).signers([stranger]).rpc(),
        "Unauthorized",
      );
    });

    it("refuses a badge mint that is not NonTransferable", async () => {
      await expectCode(
        () => program.methods.initialize(baseParams({ badges: [{ mint: transferable, weight: 1 }] })).accountsStrict({ config, payer: payer.publicKey, programData, bondMint, systemProgram: SystemProgram.programId })
          .remainingAccounts(badgeMintAccounts([transferable])).rpc(),
        "BadgeNotSoulbound",
      );
    });

    it("refuses out-of-bounds parameters", async () => {
      const init = (p: any) => program.methods.initialize(baseParams(p)).accountsStrict({ config, payer: payer.publicKey, programData, bondMint, systemProgram: SystemProgram.programId })
        .remainingAccounts(badgeMintAccounts([badgeA, badgeB])).rpc();
      await expectCode(() => init({ votingSecs: new BN(1) }), "VotingPeriod");
      await expectCode(() => init({ passBps: 4_000 }), "PassBps");
      await expectCode(() => init({ quorumWeight: new BN(0) }), "ZeroQuorum");
      await expectCode(() => init({ bondAmount: new BN(0) }), "ZeroBond");
      await expectCode(() => init({ winnerShareBps: 10_001 }), "WinnerShareBps");
    });

    it("initializes", async () => {
      await program.methods.initialize(baseParams()).accountsStrict({ config, payer: payer.publicKey, programData, bondMint, systemProgram: SystemProgram.programId })
        .remainingAccounts(badgeMintAccounts([badgeA, badgeB])).rpc();
      const c: any = await program.account.config.fetch(config);
      assert.isTrue(c.admin.equals(payer.publicKey));
      assert.equal(c.badges.length, 2);
    });

    it("update_config is admin-only and re-checks badges", async () => {
      await expectCode(
        () => program.methods.updateConfig(baseParams()).accountsStrict({ config, admin: stranger.publicKey }).remainingAccounts(badgeMintAccounts([badgeA, badgeB])).signers([stranger]).rpc(),
        "Unauthorized",
      );
      await expectCode(
        () => program.methods.updateConfig(baseParams()).accountsStrict({ config, admin: payer.publicKey }).remainingAccounts(badgeMintAccounts([badgeB, badgeA])).rpc(),
        "BadgeMintAccounts",
      );
      await program.methods.updateConfig(baseParams()).accountsStrict({ config, admin: payer.publicKey }).remainingAccounts(badgeMintAccounts([badgeA, badgeB])).rpc();
    });
  });

  describe("disputes", () => {
    let d0: PublicKey; // defended, upheld
    let d1: PublicKey; // undefended, rejected
    let d2: PublicKey; // no votes: no quorum
    let d3: PublicKey; // cancelled by the admin
    let opener0: bigint;
    let treasury0: bigint;
    let defender0: bigint;

    before(async () => {
      opener0 = await bal(opener.publicKey);
      treasury0 = await bal(treasuryOwner.publicKey);
      defender0 = await bal(defender.publicKey);
    });

    it("open: escrows the bond and names the registry Record PDA", async () => {
      d0 = await open(0);
      const d: any = await program.account.dispute.fetch(d0);
      assert.isTrue(d.record.equals(recordPda));
      assert.equal(d.chainId, 6);
      assert.deepEqual(Buffer.from(d.addressHash), subjectHash);
      assert.equal((await getAccount(conn, vaultPda(d0), "confirmed")).amount, BigInt(BOND));
      assert.equal(await bal(opener.publicKey), opener0 - BigInt(BOND));
      d1 = await open(1);
      d2 = await open(2);
      d3 = await open(3);
    });

    it("defend: matches the bond, once, not by the opener", async () => {
      await expectCode(() => program.methods.defend().accountsStrict({ defender: opener.publicKey, config, dispute: d0, vault: vaultPda(d0), defenderToken: ata(opener.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).signers([opener]).rpc(), "ConflictOfInterest");
      await program.methods.defend().accountsStrict({ defender: defender.publicKey, config, dispute: d0, vault: vaultPda(d0), defenderToken: ata(defender.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).signers([defender]).rpc();
      await expectCode(() => program.methods.defend().accountsStrict({ defender: v1.publicKey, config, dispute: d0, vault: vaultPda(d0), defenderToken: ata(v1.publicKey), tokenProgram: TOKEN_PROGRAM_ID }).signers([v1]).rpc(), "AlreadyDefended");
      assert.equal((await getAccount(conn, vaultPda(d0), "confirmed")).amount, BigInt(2 * BOND));
    });

    it("vote: badge-weighted, distinct mints summed", async () => {
      await voteIx(d0, v1, true, [badgeAta(badgeA, v1.publicKey)]).rpc(); // +1 yes
      // v2 passes badge A twice and B once: counts A once -> 1 + 3 = 4
      await voteIx(d0, v2, true, [badgeAta(badgeA, v2.publicKey), badgeAta(badgeA, v2.publicKey), badgeAta(badgeB, v2.publicKey)]).rpc();
      await voteIx(d0, v3, false, [badgeAta(badgeB, v3.publicKey)]).rpc(); // +3 no
      const d: any = await program.account.dispute.fetch(d0);
      assert.equal(d.yesWeight.toNumber(), 5);
      assert.equal(d.noWeight.toNumber(), 3);
      assert.equal(d.voters, 3);
      const vr: any = await program.account.voteRecord.fetch(votePda(d0, v2.publicKey));
      assert.equal(vr.weight.toNumber(), 4);
    });

    it("vote: one vote per voter per dispute", async () => {
      await expectThrows(() => voteIx(d0, v1, false, [badgeAta(badgeA, v1.publicKey)]).rpc(), "double vote");
    });

    it("vote: opener and defender cannot vote", async () => {
      await expectCode(() => voteIx(d0, opener, true, [badgeAta(badgeA, opener.publicKey)]).rpc(), "ConflictOfInterest");
    });

    it("vote: no badge / someone else's badge / a transferable token are refused", async () => {
      await expectCode(() => voteIx(d1, noBadge, true, []).rpc(), "NoBadge");
      await expectCode(() => voteIx(d1, noBadge, true, [badgeAta(badgeB, v3.publicKey)]).rpc(), "BadgeNotOwned");
      await expectCode(() => voteIx(d1, noBadge, true, [badgeAta(transferable, noBadge.publicKey)]).rpc(), "UnknownBadgeMint");
      await expectCode(() => voteIx(d1, noBadge, true, [ata(stranger.publicKey)]).rpc(), "InvalidBadgeAccount"); // classic SPL account
    });

    it("d1 gets a 'no' majority above quorum", async () => {
      await voteIx(d1, v2, false, [badgeAta(badgeA, v2.publicKey), badgeAta(badgeB, v2.publicKey)]).rpc(); // 4 no
      await voteIx(d1, v1, true, [badgeAta(badgeA, v1.publicKey)]).rpc(); // 1 yes
    });

    it("finalize is refused before the voting period ends", async () => {
      await expectCode(() => finalize(d0, defender.publicKey), "VotingNotOver");
    });

    it("cancel: admin only, refunds in full", async () => {
      await expectCode(() => program.methods.cancelDispute().accountsStrict({ admin: stranger.publicKey, settle: settleAccounts(d3, null) }).signers([stranger]).rpc(), "Unauthorized");
      await program.methods.cancelDispute().accountsStrict({ admin: payer.publicKey, settle: settleAccounts(d3, null) }).rpc();
      const d: any = await program.account.dispute.fetch(d3);
      assert.equal(d.status, 4);
      assert.isNull(await conn.getAccountInfo(vaultPda(d3), "confirmed"));
    });

    it("pause blocks new disputes and votes, but never finalize", async () => {
      await program.methods.setPaused(true).accountsStrict({ config, admin: payer.publicKey }).rpc();
      await expectCode(() => open(4), "Paused");
      await expectCode(() => voteIx(d2, v3, true, [badgeAta(badgeB, v3.publicKey)]).rpc(), "Paused");
      await sleep((VOTING_SECS + 2) * 1000);
      await finalize(d2); // no votes -> NoQuorum, works while paused
      const d: any = await program.account.dispute.fetch(d2);
      assert.equal(d.status, 3);
      await program.methods.setPaused(false).accountsStrict({ config, admin: payer.publicKey }).rpc();
    });

    it("voting closes at voting_ends_at", async () => {
      await expectCode(() => voteIx(d1, v3, true, [badgeAta(badgeB, v3.publicKey)]).rpc(), "VotingClosed"); // v3 has not voted on d1
    });

    it("finalize checks the payout accounts", async () => {
      await expectCode(() => program.methods.finalize().accountsStrict({ ...settleAccounts(d0, defender.publicKey), treasuryToken: ata(stranger.publicKey) }).rpc(), "WrongRecipient");
      await expectCode(() => program.methods.finalize().accountsStrict(settleAccounts(d0, null)).rpc(), "WrongRecipient"); // defender's account missing
    });

    it("Upheld: opener gets its bond + 50% of the defender's, treasury the rest", async () => {
      await finalize(d0, defender.publicKey);
      const d: any = await program.account.dispute.fetch(d0);
      assert.equal(d.status, 1);
      assert.isNull(await conn.getAccountInfo(vaultPda(d0), "confirmed"));
      await expectCode(() => finalize(d0, defender.publicKey), "AccountNotInitialized"); // vault gone: cannot settle twice
    });

    it("Rejected without a defender: the bond goes to the treasury (and a donation to the vault cannot block finalize)", async () => {
      // griefing attempt: send extra tokens to the vault so close_account would fail
      await sendAndConfirmTransaction(conn, new Transaction().add(
        createTransferInstruction(ata(v1.publicKey), vaultPda(d1), v1.publicKey, 7),
      ), [payer, v1]);
      await finalize(d1);
      assert.isNull(await conn.getAccountInfo(vaultPda(d1), "confirmed"));
      const d: any = await program.account.dispute.fetch(d1);
      assert.equal(d.status, 2);
    });

    it("balances add up", async () => {
      // opener paid 4 bonds; got back: d0 bond + 0.5 bond, d2 bond, d3 bond; lost d1 bond
      assert.equal(await bal(opener.publicKey), opener0 - BigInt(4 * BOND) + BigInt(BOND + BOND / 2 + BOND + BOND));
      assert.equal(await bal(defender.publicKey), defender0 - BigInt(BOND));
      assert.equal(await bal(treasuryOwner.publicKey), treasury0 + BigInt(BOND / 2 + BOND + 7)); // + the 7-token donation
    });

    it("mark_applied: admin only, Upheld only, once", async () => {
      await expectCode(() => program.methods.markApplied().accountsStrict({ config, admin: payer.publicKey, dispute: d1 }).rpc(), "NotUpheld");
      await expectCode(() => program.methods.markApplied().accountsStrict({ config, admin: stranger.publicKey, dispute: d0 }).signers([stranger]).rpc(), "Unauthorized");
      await program.methods.markApplied().accountsStrict({ config, admin: payer.publicKey, dispute: d0 }).rpc();
      await expectCode(() => program.methods.markApplied().accountsStrict({ config, admin: payer.publicKey, dispute: d0 }).rpc(), "AlreadyApplied");
    });

    it("close_vote returns the rent once the dispute is closed", async () => {
      await program.methods.closeVote().accountsStrict({ voter: v1.publicKey, dispute: d0, voteRecord: votePda(d0, v1.publicKey) }).signers([v1]).rpc();
      assert.isNull(await conn.getAccountInfo(votePda(d0, v1.publicKey), "confirmed"));
    });
  });

  describe("admin hand-over", () => {
    it("two steps; only the proposed key can accept", async () => {
      const next = Keypair.generate();
      await program.methods.proposeAdmin(next.publicKey).accountsStrict({ config, admin: payer.publicKey }).rpc();
      await expectCode(() => program.methods.acceptAdmin().accountsStrict({ config, newAdmin: stranger.publicKey }).signers([stranger]).rpc(), "Unauthorized");
      await program.methods.acceptAdmin().accountsStrict({ config, newAdmin: next.publicKey }).signers([next]).rpc();
      // hand it back so the rest of the run (and reruns on the same ledger) keep working
      await program.methods.proposeAdmin(payer.publicKey).accountsStrict({ config, admin: next.publicKey }).signers([next]).rpc();
      await program.methods.acceptAdmin().accountsStrict({ config, newAdmin: payer.publicKey }).rpc();
      const c: any = await program.account.config.fetch(config);
      assert.isTrue(c.admin.equals(payer.publicKey));
    });
  });
});
