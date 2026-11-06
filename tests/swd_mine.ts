// Test suite for the SWD Mine program (programs/swd_mine — on-chain mining
// payouts, see docs/SWD_MINE.md).
//
// STATUS (2026-11-06): written for `anchor test` (CI's "program" job runs it
// on a local validator). The pure logic — leading-zero bits, day buckets,
// caps math, Ed25519-instruction parsing — has its own Rust unit tests:
// `cargo test -p swd_mine`.
//
// Each proof here is a REAL proof: the test signs the challenge with an
// Ed25519 key (the website's role), searches a nonce at 16 bits (the
// program's minimum; ~65k SHA-256 tries in Node, well under a second), and
// sends [Ed25519 precompile ix, submit_proof] in one transaction — exactly
// what the browser will send.
//
// The Config PDA is a singleton, so the cases run in order and build on
// each other (caps are counted on the validator's current UTC day).

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { createHash } from "crypto";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";

// TODO: once `anchor build` has generated target/types/swd_mine.ts, replace
// `anchor.Program<any>` with `Program<SwdMine>`.
// import { SwdMine } from "../target/types/swd_mine";

const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// ---------------------------------------------------------------------
// Off-chain mirrors of programs/swd_mine/src/logic.rs. MUST stay in
// lockstep with it (the website will use the same code).
// ---------------------------------------------------------------------

const TAG = Buffer.from("SWDMINE1");

function challengeMessage(programId: PublicKey, wallet: PublicKey, seq: bigint, bits: number, expiresAt: bigint): Buffer {
  const m = Buffer.alloc(89);
  TAG.copy(m, 0);
  programId.toBuffer().copy(m, 8);
  wallet.toBuffer().copy(m, 40);
  m.writeBigUInt64LE(seq, 72);
  m.writeUInt8(bits, 80);
  m.writeBigInt64LE(expiresAt, 81);
  return m;
}

const sha256 = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

function powPrefix(msg: Buffer, wallet: PublicKey): Buffer {
  const a = sha256(TAG, Buffer.from([0]), msg, wallet.toBuffer());
  const b = sha256(TAG, Buffer.from([1]), msg, wallet.toBuffer());
  return Buffer.concat([a, b.subarray(0, 28)]);
}

function leadingZeroBits(h: Buffer): number {
  let n = 0;
  for (const x of h) {
    if (x === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(x) - 24;
  }
  return n;
}

function zeroBitsOf(prefix: Buffer, nonce: bigint): number {
  const nb = Buffer.alloc(8);
  nb.writeBigUInt64BE(nonce);
  return leadingZeroBits(sha256(prefix, nb));
}

/** First nonce whose proof hash has >= bits (or, with weak=true, < bits) leading zero bits. */
function findNonce(msg: Buffer, wallet: PublicKey, bits: number, weak = false): bigint {
  const prefix = powPrefix(msg, wallet);
  for (let n = 0n; ; n++) {
    const z = zeroBitsOf(prefix, n);
    if (weak ? z < bits : z >= bits) return n;
  }
}

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

async function expectCode(fn: () => Promise<unknown>, code: string) {
  const err: any = await expectThrows(fn, code);
  const got = errorCode(err);
  assert.equal(got, code, `expected ${code}, got ${got ?? String(err?.message ?? err).slice(0, 300)}`);
}

describe("swd_mine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwdMine as anchor.Program<any>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // upgrade authority + initial authority

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId);
  const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_UPGRADEABLE_LOADER);
  const minerPda = (w: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("miner"), w.toBuffer()], program.programId)[0];

  const R = 100_000n; // 1 SWD (5 decimals)
  const BITS = 16;
  const params = (o: Partial<Record<string, any>> = {}) => ({
    difficultyBits: BITS,
    rewardPerProof: new BN(R.toString()),
    walletDailyCap: new BN((2n * R).toString()),
    siteDailyCap: new BN((3n * R).toString()),
    totalBudget: new BN((100n * R).toString()),
    maxChallengeTtlSecs: 3_600,
    ...o,
  });

  let signer = Keypair.generate(); // the website's challenge-signing key
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const mallory = Keypair.generate();
  const guardian = Keypair.generate(); // on-call key: may only emergency_pause
  let mint: PublicKey;

  async function chainNow(): Promise<bigint> {
    const slot = await connection.getSlot();
    const t = await connection.getBlockTime(slot).catch(() => null);
    return BigInt(t ?? Math.floor(Date.now() / 1000));
  }

  async function airdrop(k: PublicKey) {
    const sig = await connection.requestAirdrop(k, 2 * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  interface Ch { seq: bigint; bits: number; expiresAt: bigint; msg: Buffer }
  async function challenge(wallet: PublicKey, seq: bigint, o: { bits?: number; ttl?: bigint; msgWallet?: PublicKey } = {}): Promise<Ch> {
    const bits = o.bits ?? BITS;
    const expiresAt = (await chainNow()) + (o.ttl ?? 600n);
    const msg = challengeMessage(program.programId, o.msgWallet ?? wallet, seq, bits, expiresAt);
    return { seq, bits, expiresAt, msg };
  }
  const edIx = (msg: Buffer, by: Keypair = signer): TransactionInstruction =>
    Ed25519Program.createInstructionWithPrivateKey({ privateKey: by.secretKey, message: msg });

  async function submit(wallet: Keypair, ch: Ch, nonce: bigint, pre: TransactionInstruction[] | null = null) {
    const b = program.methods
      .submitProof(new BN(ch.seq.toString()), ch.bits, new BN(ch.expiresAt.toString()), new BN(nonce.toString()))
      .accountsPartial({
        config: configPda,
        miner: minerPda(wallet.publicKey),
        wallet: wallet.publicKey,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(pre ?? [edIx(ch.msg)])
      .signers([wallet]);
    return b.rpc();
  }
  async function mine(wallet: Keypair, seq: bigint) {
    const ch = await challenge(wallet.publicKey, seq);
    return submit(wallet, ch, findNonce(ch.msg, wallet.publicKey, ch.bits));
  }
  async function claim(wallet: Keypair) {
    return program.methods
      .claim()
      .accountsPartial({
        config: configPda,
        miner: minerPda(wallet.publicKey),
        vault: vaultPda,
        mint,
        walletAta: getAssociatedTokenAddressSync(mint, wallet.publicKey),
        wallet: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
  }
  const admin = (by: Keypair = payer) => ({ config: configPda, authority: by.publicKey });
  const miner = (w: PublicKey) => (program.account as any).miner.fetch(minerPda(w));
  const config = () => (program.account as any).config.fetch(configPda);

  before(async () => {
    for (const k of [alice, bob, carol, mallory]) await airdrop(k.publicKey);
    mint = await createMint(connection, payer, payer.publicKey, null, 5);
  });

  it("initialize: refused for anyone but the upgrade authority", async () => {
    await expectCode(
      () =>
        program.methods
          .initialize(mallory.publicKey, guardian.publicKey, signer.publicKey, params())
          .accountsPartial({
            config: configPda, vault: vaultPda, mint, payer: mallory.publicKey, programData,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .signers([mallory])
          .rpc(),
      "Unauthorized"
    );
  });

  it("initialize: refuses bad params", async () => {
    await expectCode(
      () =>
        program.methods
          .initialize(payer.publicKey, guardian.publicKey, signer.publicKey, params({ difficultyBits: 15 }))
          .accountsPartial({
            config: configPda, vault: vaultPda, mint, payer: payer.publicKey, programData,
            tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "InvalidDifficulty"
    );
  });

  it("initialize: upgrade authority creates config + PDA-owned vault", async () => {
    await program.methods
      .initialize(payer.publicKey, guardian.publicKey, signer.publicKey, params())
      .accountsPartial({
        config: configPda, vault: vaultPda, mint, payer: payer.publicKey, programData,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    const c = await config();
    assert.ok(c.authority.equals(payer.publicKey));
    assert.ok(c.mint.equals(mint));
    assert.ok(c.vault.equals(vaultPda));
    assert.ok(c.challengeSigner.equals(signer.publicKey));
    assert.equal(c.difficultyBits, BITS);
    assert.equal(c.miningPaused, false);
    const v = await getAccount(connection, vaultPda);
    assert.ok(v.owner.equals(configPda), "vault must be owned by the Config PDA");
    assert.ok(v.mint.equals(mint));
    // fund the vault with 10 SWD
    await mintTo(connection, payer, mint, vaultPda, payer, 10n * R);
  });

  it("submit_proof: refused without the Ed25519 instruction", async () => {
    const ch = await challenge(alice.publicKey, 1n);
    await expectCode(() => submit(alice, ch, 0n, []), "MissingEd25519Instruction");
  });

  it("submit_proof: refused when signed by another key", async () => {
    const ch = await challenge(alice.publicKey, 1n);
    await expectCode(() => submit(alice, ch, findNonce(ch.msg, alice.publicKey, BITS), [edIx(ch.msg, Keypair.generate())]), "WrongChallengeSigner");
  });

  it("submit_proof: a challenge issued to another wallet does not pay this one", async () => {
    const ch = await challenge(mallory.publicKey, 1n, { msgWallet: alice.publicKey });
    await expectCode(() => submit(mallory, ch, findNonce(ch.msg, mallory.publicKey, BITS)), "ChallengeMismatch");
  });

  it("submit_proof: refuses expired, too-long-lived and too-easy challenges", async () => {
    const expired = await challenge(alice.publicKey, 1n, { ttl: -100n });
    await expectCode(() => submit(alice, expired, findNonce(expired.msg, alice.publicKey, BITS)), "ChallengeExpired");
    const long = await challenge(alice.publicKey, 1n, { ttl: 7_200n });
    await expectCode(() => submit(alice, long, findNonce(long.msg, alice.publicKey, BITS)), "ChallengeTtlTooLong");
    const easy = await challenge(alice.publicKey, 1n, { bits: BITS - 1 });
    await expectCode(() => submit(alice, easy, findNonce(easy.msg, alice.publicKey, BITS - 1)), "ChallengeTooEasy");
  });

  it("submit_proof: refuses a nonce without enough work", async () => {
    const ch = await challenge(alice.publicKey, 1n);
    await expectCode(() => submit(alice, ch, findNonce(ch.msg, alice.publicKey, BITS, true)), "InsufficientWork");
  });

  it("submit_proof: a real proof accrues the reward", async () => {
    await mine(alice, 1n);
    const m = await miner(alice.publicKey);
    assert.equal(m.accrued.toString(), R.toString());
    assert.equal(m.lastSeq.toString(), "1");
    assert.equal(m.proofs.toString(), "1");
    const c = await config();
    assert.equal(c.totalCredited.toString(), R.toString());
    assert.equal(c.totalProofs.toString(), "1");
  });

  it("submit_proof: a challenge is single use (seq must increase)", async () => {
    await expectCode(() => mine(alice, 1n), "ChallengeAlreadyUsed");
    await expectCode(() => mine(alice, 0n), "ChallengeAlreadyUsed");
  });

  it("submit_proof: per-wallet daily cap", async () => {
    await mine(alice, 5n);
    assert.equal((await miner(alice.publicKey)).accrued.toString(), (2n * R).toString());
    await expectCode(() => mine(alice, 6n), "WalletDailyCapReached");
    // a refused cap does not consume the seq: still last_seq = 5
    assert.equal((await miner(alice.publicKey)).lastSeq.toString(), "5");
  });

  it("submit_proof: site-wide daily cap", async () => {
    await mine(bob, 1n); // site total today: 3R = cap
    await expectCode(() => mine(carol, 1n), "SiteDailyCapReached");
  });

  it("claim: pays the whole accrued balance to the wallet's ATA (created on the fly)", async () => {
    await claim(alice);
    const ata = await getAccount(connection, getAssociatedTokenAddressSync(mint, alice.publicKey));
    assert.equal(ata.amount.toString(), (2n * R).toString());
    const m = await miner(alice.publicKey);
    assert.equal(m.accrued.toString(), "0");
    assert.equal(m.totalClaimed.toString(), (2n * R).toString());
    assert.equal((await getAccount(connection, vaultPda)).amount.toString(), (8n * R).toString());
    await expectCode(() => claim(alice), "NothingToClaim");
  });

  it("admin: only the authority, and only valid params", async () => {
    await expectCode(() => program.methods.setParams(params()).accountsPartial(admin(mallory)).signers([mallory]).rpc(), "Unauthorized");
    await expectCode(() => program.methods.setPaused(true, true).accountsPartial(admin(mallory)).signers([mallory]).rpc(), "Unauthorized");
    await expectCode(() => program.methods.setChallengeSigner(mallory.publicKey).accountsPartial(admin(mallory)).signers([mallory]).rpc(), "Unauthorized");
    await expectCode(() => program.methods.setParams(params({ difficultyBits: 41 })).accountsPartial(admin()).rpc(), "InvalidDifficulty");
    // 3R already credited: the budget cannot go below it
    await expectCode(
      () => program.methods.setParams(params({ totalBudget: new BN((2n * R).toString()) })).accountsPartial(admin()).rpc(),
      "InvalidBudget"
    );
  });

  it("submit_proof: total budget", async () => {
    await program.methods
      .setParams(params({ walletDailyCap: new BN((10n * R).toString()), siteDailyCap: new BN((10n * R).toString()), totalBudget: new BN((4n * R).toString()) }))
      .accountsPartial(admin())
      .rpc();
    await mine(carol, 1n); // 4R credited = budget
    await expectCode(() => mine(carol, 2n), "BudgetExhausted");
  });

  it("set_challenge_signer: the old key stops working at once", async () => {
    await program.methods.setParams(params({ walletDailyCap: new BN((10n * R).toString()), siteDailyCap: new BN((10n * R).toString()), totalBudget: new BN((100n * R).toString()) })).accountsPartial(admin()).rpc();
    const old = signer;
    const next = Keypair.generate();
    await program.methods.setChallengeSigner(next.publicKey).accountsPartial(admin()).rpc();
    const ch = await challenge(carol.publicKey, 3n);
    await expectCode(() => submit(carol, ch, findNonce(ch.msg, carol.publicKey, BITS), [edIx(ch.msg, old)]), "WrongChallengeSigner");
    signer = next;
    await mine(carol, 3n);
  });

  it("pause + withdraw_unused: miner balances stay reserved", async () => {
    const authAta = await createAccount(connection, payer, mint, payer.publicKey, Keypair.generate());
    const malloryAta = await createAccount(connection, payer, mint, mallory.publicKey, Keypair.generate());
    const withdraw = (amount: bigint, destination: PublicKey) =>
      program.methods
        .withdrawUnused(new BN(amount.toString()))
        .accountsPartial({ config: configPda, vault: vaultPda, mint, destination, authority: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();
    await expectCode(() => withdraw(1n, authAta), "NotPaused");

    await program.methods.setPaused(true, false).accountsPartial(admin()).rpc();
    await expectCode(() => mine(carol, 4n), "MiningPaused");

    // vault 8R; credited 5R, claimed 2R → 3R owed → at most 5R may leave
    await expectCode(() => withdraw(5n * R + 1n, authAta), "WithdrawTooMuch");
    await expectCode(() => withdraw(1n, malloryAta), "DestinationNotAuthority");
    await withdraw(5n * R, authAta);
    assert.equal((await getAccount(connection, authAta)).amount.toString(), (5n * R).toString());

    // claims still work while only mining is paused
    await claim(bob);
    // emergency: claims paused too
    await program.methods.setPaused(true, true).accountsPartial(admin()).rpc();
    await expectCode(() => claim(carol), "ClaimsPaused");
    await program.methods.setPaused(false, false).accountsPartial(admin()).rpc();
    await claim(carol);
    assert.equal((await getAccount(connection, vaultPda)).amount.toString(), "0");
  });

  it("emergency_pause: the guardian can pause everything but not un-pause", async () => {
    const ep = (by: Keypair) =>
      program.methods.emergencyPause().accountsPartial({ config: configPda, signer: by.publicKey }).signers([by]).rpc();
    await expectCode(() => ep(mallory), "Unauthorized");
    await ep(guardian);
    const c = await config();
    assert.equal(c.miningPaused, true);
    assert.equal(c.claimsPaused, true);
    await expectCode(() => mine(alice, 9n), "MiningPaused");
    await expectCode(
      () => program.methods.setPaused(false, false).accountsPartial(admin(guardian)).signers([guardian]).rpc(),
      "Unauthorized"
    );
    await program.methods.setPaused(false, false).accountsPartial(admin()).rpc();
  });

  it("authority handover is two-step", async () => {
    const next = Keypair.generate();
    await program.methods.transferAuthority(next.publicKey).accountsPartial(admin()).rpc();
    await expectCode(
      () => program.methods.acceptAuthority().accountsPartial({ config: configPda, newAuthority: mallory.publicKey }).signers([mallory]).rpc(),
      "Unauthorized"
    );
    await program.methods.acceptAuthority().accountsPartial({ config: configPda, newAuthority: next.publicKey }).signers([next]).rpc();
    assert.ok((await config()).authority.equals(next.publicKey));
    await expectCode(() => program.methods.setPaused(true, true).accountsPartial(admin()).rpc(), "Unauthorized");
  });
});
