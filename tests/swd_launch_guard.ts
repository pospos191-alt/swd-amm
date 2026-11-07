// SWD Launch Guard (programs/swd_launch_guard, added 2026-11-07).
// Runs in the same `anchor test` validator as the other suites; touches only
// its own program and Token-2022 mints it creates here.
//
// Covers: who may initialise (mint authority only); the 24 h hard maximum and
// the 7-day launch-delay bound; the hook really running inside Token-2022
// transfers (extra accounts resolved from the on-chain list by
// @solana/spl-token); pre-launch refusal of buys; per-transfer cap,
// cumulative cap and cooldown; unregistered recipients; exemptions (launch
// wallet -> launch wallet); SELLS AND HOLDER TRANSFERS NEVER BLOCKED (also
// above the caps, also before launch); calling `execute` directly is refused;
// end_window (never extends), relax_limits (only loosens), add_launch_wallet
// only before launch; the hook is a no-op after the window (natural end and
// early end); close_recipient refunds the payer after the window only.

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
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
  assert.isTrue(hasCode(err, name), `expected ${name}, got: ${String(err?.message ?? err).slice(0, 400)} ${JSON.stringify(err?.logs ?? err?.transactionLogs ?? []).slice(0, 900)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("swd_launch_guard", () => {
  // "confirmed" for every send and read: @solana/spl-token resolves the hook's
  // extra accounts (and tests read balances) at "confirmed", and Anchor's
  // default "processed" would race those reads. Own provider, so the other
  // suites' global provider is left as it is.
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(new Connection(envProvider.connection.rpcEndpoint, "confirmed"), envProvider.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const program = new anchor.Program<any>((anchor.workspace.SwdLaunchGuard as anchor.Program<any>).idl, provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // mint authority
  const DECIMALS = 6;

  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const guardPda = (mint: PublicKey) => pda(Buffer.from("guard"), mint.toBuffer());
  const metasPda = (mint: PublicKey) => pda(Buffer.from("extra-account-metas"), mint.toBuffer());
  const recipientPda = (mint: PublicKey, wallet: PublicKey) => pda(Buffer.from("recipient"), mint.toBuffer(), wallet.toBuffer());
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

  /** the validator's clock (the hook compares against this, not the wall clock) */
  async function chainNow(): Promise<number> {
    const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
    return t ?? Math.floor(Date.now() / 1000);
  }
  async function waitUntilChain(ts: number) {
    for (let i = 0; i < 120; i++) {
      if ((await chainNow()) >= ts) return;
      await sleep(500);
    }
    throw new Error(`validator clock never reached ${ts}`);
  }

  const creator = payer; // launch wallet #1 (mint authority, holds the supply)
  const pool = Keypair.generate(); // launch wallet #2: stands in for a pool-vault authority (a PDA in reality)
  const buyerA = Keypair.generate(); // registered
  const buyerB = Keypair.generate(); // registered
  const unregistered = Keypair.generate();
  const holder = Keypair.generate(); // got tokens before launch, never a launch wallet
  const stranger = Keypair.generate();

  async function fund(...ks: Keypair[]) {
    const tx = new Transaction();
    for (const k of ks) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: LAMPORTS_PER_SOL / 10 }));
    await sendAndConfirmTransaction(conn, tx, [payer]);
  }

  /** A Token-2022 mint whose TransferHook points at the guard, with ATAs for everyone and some supply minted (MintTo does not run the hook). */
  async function makeMint(holders: { owner: PublicKey; amount: bigint }[]): Promise<PublicKey> {
    const mint = Keypair.generate();
    const len = getMintLen([ExtensionType.TransferHook]);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: len,
        lamports: await conn.getMinimumBalanceForRentExemption(len),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      // hook authority = none (the launcher should never keep one: it could repoint the hook)
      createInitializeTransferHookInstruction(mint.publicKey, PublicKey.default, program.programId, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    );
    await sendAndConfirmTransaction(conn, tx, [payer, mint]);
    const owners = [creator.publicKey, pool.publicKey, buyerA.publicKey, buyerB.publicKey, unregistered.publicKey, holder.publicKey];
    const t2 = new Transaction();
    for (const o of owners) t2.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint.publicKey, o), o, mint.publicKey, TOKEN_2022_PROGRAM_ID));
    for (const h of holders) t2.add(createMintToInstruction(mint.publicKey, ata(mint.publicKey, h.owner), payer.publicKey, h.amount, [], TOKEN_2022_PROGRAM_ID));
    await sendAndConfirmTransaction(conn, t2, [payer]);
    return mint.publicKey;
  }

  interface P { launchTs: number; windowSecs: number; maxPerTransfer: number; maxPerWallet: number; cooldownSecs: number; launchWallets?: PublicKey[]; authority?: PublicKey }
  const params = (p: P) => ({
    guardAuthority: p.authority ?? payer.publicKey,
    launchTs: new BN(p.launchTs),
    windowSecs: new BN(p.windowSecs),
    maxPerTransfer: new BN(p.maxPerTransfer),
    maxPerWallet: new BN(p.maxPerWallet),
    cooldownSecs: new BN(p.cooldownSecs),
    launchWallets: p.launchWallets ?? [creator.publicKey, pool.publicKey],
  });
  function initIx(mint: PublicKey, p: P, authority: Keypair = payer) {
    return program.methods
      .initializeExtraAccountMetaList(params(p))
      .accountsStrict({
        payer: payer.publicKey,
        authority: authority.publicKey,
        mint,
        extraAccountMetaList: metasPda(mint),
        guard: guardPda(mint),
        systemProgram: SystemProgram.programId,
      })
      .signers(authority === payer ? [] : [authority]);
  }
  async function register(mint: PublicKey, wallet: PublicKey) {
    await program.methods
      .registerRecipient(wallet)
      .accountsStrict({ payer: payer.publicKey, guard: guardPda(mint), recipient: recipientPda(mint, wallet), systemProgram: SystemProgram.programId })
      .rpc();
  }
  /** A real Token-2022 transfer_checked; spl-token resolves the hook's extra accounts from the on-chain list. */
  async function xfer(mint: PublicKey, from: Keypair, to: PublicKey, amount: number | bigint) {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      conn, ata(mint, from.publicKey), mint, ata(mint, to), from.publicKey, BigInt(amount), DECIMALS, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix);
    const signers = from.publicKey.equals(payer.publicKey) ? [payer] : [payer, from];
    return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  }
  const bal = async (mint: PublicKey, owner: PublicKey) => (await getAccount(conn, ata(mint, owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const admin = (mint: PublicKey, signer: Keypair = payer) => ({ authority: signer.publicKey, guard: guardPda(mint) });

  before(async () => {
    await fund(pool, buyerA, buyerB, unregistered, holder, stranger);
  });

  describe("initialisation bounds", () => {
    let mint: PublicKey;
    before(async () => {
      mint = await makeMint([]);
    });

    it("only the mint authority (or hook authority) can configure the mint", async () => {
      const now = await chainNow();
      await expectCode(() => initIx(mint, { launchTs: now, windowSecs: 60, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 0 }, stranger).rpc(), "NotMintAuthority");
    });

    it("refuses a window longer than 24 h (hard maximum, in code)", async () => {
      const now = await chainNow();
      await expectCode(() => initIx(mint, { launchTs: now, windowSecs: 86_401, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 0 }).rpc(), "WindowTooLong");
    });

    it("refuses a launch more than 7 days ahead", async () => {
      const now = await chainNow();
      await expectCode(() => initIx(mint, { launchTs: now + 8 * 86_400, windowSecs: 60, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 0 }).rpc(), "LaunchTooFar");
    });

    it("refuses caps that make no sense", async () => {
      const now = await chainNow();
      await expectCode(() => initIx(mint, { launchTs: now, windowSecs: 60, maxPerTransfer: 0, maxPerWallet: 10, cooldownSecs: 0 }).rpc(), "ZeroCap");
      await expectCode(() => initIx(mint, { launchTs: now, windowSecs: 60, maxPerTransfer: 10, maxPerWallet: 5, cooldownSecs: 0 }).rpc(), "WalletCapBelowTransferCap");
      await expectCode(() => initIx(mint, { launchTs: now, windowSecs: 60, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 61 }).rpc(), "BadCooldown");
    });

    it("accepts exactly 24 h and stores window_end = launch_ts + window", async () => {
      const now = await chainNow();
      await initIx(mint, { launchTs: now + 10, windowSecs: 86_400, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 0 }).rpc();
      const g: any = await program.account.guard.fetch(guardPda(mint));
      assert.equal(g.windowEnd.toNumber(), now + 10 + 86_400);
      // cannot be created twice
      await expectThrows(() => initIx(mint, { launchTs: now, windowSecs: 60, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 0 }).rpc(), "re-init");
    });
  });

  describe("a launch", () => {
    let mint: PublicKey;
    let launchTs: number;
    const CAP = 1_000;
    const WALLET_CAP = 2_500;
    const COOLDOWN = 3;

    before(async () => {
      mint = await makeMint([
        { owner: creator.publicKey, amount: 1_000_000n },
        { owner: pool.publicKey, amount: 1_000_000n },
        { owner: holder.publicKey, amount: 50_000n },
      ]);
      launchTs = (await chainNow()) + 6;
      await initIx(mint, { launchTs, windowSecs: 3_600, maxPerTransfer: CAP, maxPerWallet: WALLET_CAP, cooldownSecs: COOLDOWN }).rpc();
      await register(mint, buyerA.publicKey);
      await register(mint, buyerB.publicKey);
    });

    it("before launch: buys from a launch wallet are refused", async () => {
      await expectCode(() => xfer(mint, pool, buyerA.publicKey, 10), "NotOpenYet");
    });

    it("before launch: holders can still sell and send (never blocked)", async () => {
      await xfer(mint, holder, pool.publicKey, 5_000); // a sell, far above the caps
      await xfer(mint, holder, unregistered.publicKey, 5_000); // holder -> anyone
      assert.equal(await bal(mint, unregistered.publicKey), 5_000n);
    });

    it("launch wallets move freely between themselves (exemption)", async () => {
      await xfer(mint, creator, pool.publicKey, 100_000); // creator adds liquidity
    });

    it("adding a launch wallet works only before launch", async () => {
      const extra = Keypair.generate().publicKey;
      await program.methods.addLaunchWallet(extra).accountsStrict(admin(mint)).rpc();
      await program.methods.removeLaunchWallet(extra).accountsStrict(admin(mint)).rpc();
      await expectCode(() => program.methods.addLaunchWallet(extra).accountsStrict(admin(mint, stranger)).signers([stranger]).rpc(), "Unauthorized");
    });

    it("in the window: per-transfer cap", async () => {
      await waitUntilChain(launchTs);
      await expectCode(() => xfer(mint, pool, buyerA.publicKey, CAP + 1), "OverPerTransferCap");
      await xfer(mint, pool, buyerA.publicKey, CAP);
      const r: any = await program.account.recipient.fetch(recipientPda(mint, buyerA.publicKey));
      assert.equal(r.received.toNumber(), CAP);
      assert.equal(r.transfers, 1);
    });

    it("in the window: cooldown between buys", async () => {
      await expectCode(() => xfer(mint, pool, buyerA.publicKey, 1), "CooldownActive");
    });

    it("in the window: cumulative per-wallet cap", async () => {
      const r0: any = await program.account.recipient.fetch(recipientPda(mint, buyerA.publicKey));
      await waitUntilChain(r0.lastReceiveTs.toNumber() + COOLDOWN);
      await xfer(mint, pool, buyerA.publicKey, CAP); // 2000
      const r1: any = await program.account.recipient.fetch(recipientPda(mint, buyerA.publicKey));
      await waitUntilChain(r1.lastReceiveTs.toNumber() + COOLDOWN);
      await expectCode(() => xfer(mint, pool, buyerA.publicKey, 501), "OverPerWalletCap");
      await xfer(mint, pool, buyerA.publicKey, 500); // exactly 2500
      assert.equal(await bal(mint, buyerA.publicKey), 2_500n);
    });

    it("in the window: the creator's distributions are capped too", async () => {
      await xfer(mint, creator, buyerB.publicKey, CAP);
      await expectCode(() => xfer(mint, creator, buyerB.publicKey, CAP + 1), "OverPerTransferCap");
    });

    it("in the window: an unregistered wallet cannot buy", async () => {
      await expectCode(() => xfer(mint, pool, unregistered.publicKey, 1), "RecipientNotRegistered");
    });

    it("in the window: SELLS are never blocked, even above every cap and during the cooldown", async () => {
      // buyerA is at its cumulative cap and inside its cooldown
      await xfer(mint, buyerA, pool.publicKey, 2_500);
      await xfer(mint, unregistered, pool.publicKey, 5_000);
      assert.equal(await bal(mint, buyerA.publicKey), 0n);
    });

    it("in the window: holder-to-holder transfers are never blocked", async () => {
      await xfer(mint, holder, buyerA.publicKey, 20_000); // way above the caps, to a capped wallet
      await xfer(mint, buyerA, unregistered.publicKey, 20_000); // to an unregistered wallet
    });

    it("calling execute directly (outside a transfer) is refused", async () => {
      // with the real accounts, but the token accounts' `transferring` flag is off
      const ix = await program.methods
        .execute(new BN(1))
        .accountsStrict({
          sourceToken: ata(mint, pool.publicKey),
          mint,
          destinationToken: ata(mint, buyerB.publicKey),
          owner: pool.publicKey,
          extraAccountMetaList: metasPda(mint),
          guard: guardPda(mint),
          recipient: recipientPda(mint, buyerB.publicKey),
        })
        .instruction();
      await expectCode(() => sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]), "NotInTransfer");
    });

    it("after launch: launch wallets can no longer be added", async () => {
      await expectCode(() => program.methods.addLaunchWallet(Keypair.generate().publicKey).accountsStrict(admin(mint)).rpc(), "LaunchStarted");
    });

    it("limits can only be loosened", async () => {
      await expectCode(() => program.methods.relaxLimits(new BN(CAP - 1), new BN(WALLET_CAP), new BN(COOLDOWN)).accountsStrict(admin(mint)).rpc(), "NotLooser");
      await expectCode(() => program.methods.relaxLimits(new BN(CAP), new BN(WALLET_CAP - 1), new BN(COOLDOWN)).accountsStrict(admin(mint)).rpc(), "NotLooser");
      await expectCode(() => program.methods.relaxLimits(new BN(CAP), new BN(WALLET_CAP), new BN(COOLDOWN + 1)).accountsStrict(admin(mint)).rpc(), "NotLooser");
      await program.methods.relaxLimits(new BN(CAP * 2), new BN(WALLET_CAP * 2), new BN(0)).accountsStrict(admin(mint)).rpc();
      await xfer(mint, pool, buyerB.publicKey, CAP * 2); // looser cap + no cooldown take effect
    });

    it("close_recipient is refused while the window runs", async () => {
      await expectCode(
        () => program.methods.closeRecipient().accountsStrict({ guard: guardPda(mint), recipient: recipientPda(mint, buyerA.publicKey), payer: payer.publicKey }).rpc(),
        "WindowNotOver",
      );
    });

    it("end_window: only the authority; ends now and never extends", async () => {
      await expectCode(() => program.methods.endWindow().accountsStrict(admin(mint, stranger)).signers([stranger]).rpc(), "Unauthorized");
      const before: any = await program.account.guard.fetch(guardPda(mint));
      await program.methods.endWindow().accountsStrict(admin(mint)).rpc();
      const after: any = await program.account.guard.fetch(guardPda(mint));
      assert.isBelow(after.windowEnd.toNumber(), before.windowEnd.toNumber());
      await program.methods.endWindow().accountsStrict(admin(mint)).rpc(); // again: still never later
      const again: any = await program.account.guard.fetch(guardPda(mint));
      assert.isAtMost(again.windowEnd.toNumber(), after.windowEnd.toNumber());
    });

    it("after the window: the hook is a no-op (no cap, no registration, no cooldown)", async () => {
      const sig = await xfer(mint, pool, unregistered.publicKey, 100_000);
      await xfer(mint, pool, unregistered.publicKey, 100_000);
      // and cheap: the hook's own compute (logged by the runtime) stays small
      const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const line = (tx?.meta?.logMessages ?? []).find((l) => l.startsWith(`Program ${program.programId.toBase58()} consumed`));
      const cu = Number(/consumed (\d+)/.exec(line ?? "")?.[1] ?? NaN);
      console.log(`      hook compute after the window: ${cu} CU`);
      assert.isBelow(cu, 6_000);
      await xfer(mint, creator, buyerA.publicKey, 50_000);
      assert.equal(await bal(mint, unregistered.publicKey), 220_000n);
    });

    it("after the window: register is refused and close_recipient refunds the payer", async () => {
      await expectCode(() => register(mint, stranger.publicKey), "WindowOver");
      const lamportsBefore = await conn.getBalance(payer.publicKey, "confirmed");
      await program.methods.closeRecipient().accountsStrict({ guard: guardPda(mint), recipient: recipientPda(mint, buyerA.publicKey), payer: payer.publicKey }).rpc();
      assert.isNull(await conn.getAccountInfo(recipientPda(mint, buyerA.publicKey), "confirmed"));
      assert.isAbove(await conn.getBalance(payer.publicKey, "confirmed"), lamportsBefore - 10_000);
      // closing to someone else than the recorded payer is refused
      await expectCode(
        () => program.methods.closeRecipient().accountsStrict({ guard: guardPda(mint), recipient: recipientPda(mint, buyerB.publicKey), payer: stranger.publicKey }).rpc(),
        "WrongRecipient",
      );
    });
  });

  describe("a window that ends by itself", () => {
    let mint: PublicKey;
    let windowEnd: number;
    before(async () => {
      mint = await makeMint([{ owner: pool.publicKey, amount: 1_000_000n }]);
      const now = await chainNow();
      await initIx(mint, { launchTs: now - 1, windowSecs: 6, maxPerTransfer: 10, maxPerWallet: 10, cooldownSecs: 0 }).rpc();
      windowEnd = (await program.account.guard.fetch(guardPda(mint)) as any).windowEnd.toNumber();
    });

    it("caps apply until window_end, then nothing", async () => {
      await expectCode(() => xfer(mint, pool, buyerA.publicKey, 11), "RecipientNotRegistered");
      await register(mint, buyerA.publicKey);
      await expectCode(() => xfer(mint, pool, buyerA.publicKey, 11), "OverPerTransferCap");
      await waitUntilChain(windowEnd + 1);
      await xfer(mint, pool, buyerA.publicKey, 500_000);
      await xfer(mint, pool, buyerB.publicKey, 1); // unregistered for this mint, fine now
      assert.equal(await bal(mint, buyerA.publicKey), 500_000n);
    });

    it("renouncing the authority freezes the config for good", async () => {
      await program.methods.setAuthority(PublicKey.default).accountsStrict(admin(mint)).rpc();
      await expectCode(() => program.methods.endWindow().accountsStrict(admin(mint)).rpc(), "Unauthorized");
    });
  });
});
