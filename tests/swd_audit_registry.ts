// SWD Audit Registry (programs/swd_audit_registry, added 2026-11-06).
// Runs in the same `anchor test` validator as the swd_amm suites but touches
// only its own program (its Config singleton is created here, by the provider
// wallet = the program's upgrade authority, Anchor.toml [test] upgradeable).
//
// Covers: upgrade-authority-only initialize; the Ed25519 precompile pattern
// (instruction built with @solana/web3.js `Ed25519Program`, record bytes
// byte-identical to the Rust golden vector); create / update / no-rollback;
// unknown, retired and revoked attestor keys; a tampered field; a forged
// signature; Ed25519 offsets pointing at another instruction; a missing
// Ed25519 instruction; address normalization and hash checks; future
// timestamps; pause; revoke / restore; the Ed25519 instruction found by position;
// the two-step authority hand-over; reading a level by PDA (raw bytes).

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { createHash } from "crypto";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";

async function expectThrows(fn: () => Promise<unknown>, label: string): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error(`expected "${label}" to throw, but it succeeded`);
}
/** Anchor error code name, also when the failure came back from a raw sendAndConfirm (logs only). */
function hasCode(err: any, name: string): boolean {
  if (err?.error?.errorCode?.code === name) return true;
  const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
  return logs.some((l) => l.includes(`Error Code: ${name}.`)) || String(err?.message ?? err).includes(name);
}
async function expectCode(fn: () => Promise<unknown>, name: string) {
  const err = await expectThrows(fn, name);
  assert.isTrue(hasCode(err, name), `expected ${name}, got: ${String(err?.message ?? err).slice(0, 400)} ${JSON.stringify(err?.logs ?? []).slice(0, 600)}`);
}

// ---- the record message (mirror of programs/swd_audit_registry/src/message.rs) ----
export const DOMAIN_TAG = Buffer.from("swd.audit-registry.v1\0", "utf8");
export const CHAIN_IDS: Record<string, number> = {
  eth: 1, bsc: 2, base: 3, arbitrum: 4, zetaphy: 5, sol: 6, sui: 7, aptos: 8,
  osmosis: 9, neutron: 10, near: 11, starknet: 12, bitcoin: 13, ton: 14,
};
export const LEVELS: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3 };
const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest();
export const keyIdOf = (publicKey: Uint8Array) => sha256(publicKey).subarray(0, 8);

export interface Fields {
  chainId: number;
  address: Buffer;
  level: number;
  verdict: Buffer; // 32
  payloadHash: Buffer; // 32
  mldsaKeyId: Buffer; // 8
  ed25519KeyId: Buffer; // 8
  auditedAt: number; // unix seconds
}
export function recordMessage(registry: PublicKey | Buffer, f: Fields, addressHash = sha256(f.address)): Buffer {
  const m = Buffer.alloc(177);
  DOMAIN_TAG.copy(m, 0);
  (Buffer.isBuffer(registry) ? registry : registry.toBuffer()).copy(m, 22);
  m.writeUInt16LE(f.chainId, 54);
  addressHash.copy(m, 56);
  m.writeUInt8(f.level, 88);
  f.verdict.copy(m, 89);
  f.payloadHash.copy(m, 121);
  f.mldsaKeyId.copy(m, 153);
  f.ed25519KeyId.copy(m, 161);
  m.writeBigInt64LE(BigInt(f.auditedAt), 169);
  return m;
}

// Same as GOLDEN_MESSAGE_HEX in programs/swd_audit_registry/src/tests.rs.
const GOLDEN_MESSAGE_HEX =
  "7377642e61756469742d72656769737472792e763100" +
  "1111111111111111111111111111111111111111111111111111111111111111" +
  "0600" +
  "d77cf5c8a1c79d6b78408a3f545dea88441790fb0245268398f1d09455e29b18" +
  "03" +
  "abababababababababababababababababababababababababababababababab" +
  "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" +
  "0102030405060708" +
  "090a0b0c0d0e0f10" +
  "4002df6a00000000";

describe("swd_audit_registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwdAuditRegistry as anchor.Program<any>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // upgrade authority + registry authority

  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const config = pda(Buffer.from("config"));
  const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const recordPda = (chainId: number, address: Buffer) => pda(Buffer.from("audit"), u16le(chainId), sha256(address));
  const programData = PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];

  const attestorA = Keypair.generate();
  const attestorB = Keypair.generate();
  const stranger = Keypair.generate();
  const mldsaKeyId = Buffer.from("00112233aabbccdd", "hex"); // stand-in for sha256(ML-DSA pk)[0..8]
  const now = () => Math.floor(Date.now() / 1000);
  let t0 = now() - 86_400;

  const SOL_MINT = Buffer.from("So11111111111111111111111111111111111111112");
  const EVM_TOKEN = Buffer.from("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f");

  function fields(over: Partial<Fields> = {}, signer: Keypair = attestorA): Fields {
    return {
      chainId: CHAIN_IDS.sol,
      address: SOL_MINT,
      level: LEVELS.medium,
      verdict: sha256(Buffer.from("verdict")),
      payloadHash: sha256(Buffer.from("payload")),
      mldsaKeyId,
      ed25519KeyId: keyIdOf(signer.publicKey.toBytes()),
      auditedAt: (t0 += 10),
      ...over,
    };
  }
  const input = (f: Fields, addressHash = sha256(f.address)) => ({
    chainId: f.chainId,
    addressHash: Array.from(addressHash),
    address: f.address,
    level: f.level,
    verdict: Array.from(f.verdict),
    payloadHash: Array.from(f.payloadHash),
    mldsaKeyId: Array.from(f.mldsaKeyId),
    ed25519KeyId: Array.from(f.ed25519KeyId),
    auditedAt: new BN(f.auditedAt),
  });
  /** The Ed25519 precompile instruction: one signature, all offsets inside itself (instruction index 0xffff). */
  const edIx = (signer: Keypair, message: Buffer, instructionIndex?: number) =>
    Ed25519Program.createInstructionWithPrivateKey({ privateKey: signer.secretKey, message, instructionIndex });

  const upsertIx = (f: Fields, addressHash = sha256(f.address), relayer: PublicKey = payer.publicKey) =>
    program.methods
      .upsertRecord(input(f, addressHash))
      .accountsStrict({
        config,
        record: pda(Buffer.from("audit"), u16le(f.chainId), addressHash),
        payer: relayer,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

  async function send(ixs: TransactionInstruction[], signers: Keypair[] = [payer]) {
    return provider.sendAndConfirm(new Transaction().add(...ixs), signers);
  }
  /** signs `f` with `signer` and submits [ed25519, upsert_record], paid by `relayer` (anyone) */
  async function upsert(f: Fields, signer: Keypair = attestorA, relayer: Keypair = payer) {
    const tx = new Transaction().add(edIx(signer, recordMessage(config, f)), await upsertIx(f, undefined, relayer.publicKey));
    if (relayer === payer) return provider.sendAndConfirm(tx, [payer]);
    // provider.sendAndConfirm would add the provider wallet as a signer: send it as the relayer alone
    // same commitments as the provider: a "confirmed" preflight could miss state the previous call just wrote
    return sendAndConfirmTransaction(conn, tx, [relayer], provider.opts);
  }
  async function fund(kp: Keypair, sol = 1) {
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: sol * LAMPORTS_PER_SOL })]);
  }
  const admin = (signer: Keypair = payer) => ({ config, authority: signer.publicKey });

  it("encodes the record message exactly like the Rust golden vector", () => {
    const m = recordMessage(Buffer.alloc(32, 0x11), {
      chainId: 6,
      address: SOL_MINT,
      level: 3,
      verdict: Buffer.alloc(32, 0xab),
      payloadHash: Buffer.alloc(32, 0xcd),
      mldsaKeyId: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      ed25519KeyId: Buffer.from([9, 10, 11, 12, 13, 14, 15, 16]),
      auditedAt: 1_793_000_000,
    });
    assert.equal(m.toString("hex"), GOLDEN_MESSAGE_HEX);
  });

  it("only the upgrade authority can initialize", async () => {
    await fund(stranger);
    await expectCode(
      () =>
        program.methods
          .initialize(stranger.publicKey, [])
          .accountsStrict({ config, payer: stranger.publicKey, programData, systemProgram: SystemProgram.programId })
          .signers([stranger])
          .rpc(),
      "Unauthorized"
    );
    await program.methods
      .initialize(payer.publicKey, [{ pubkey: attestorA.publicKey, status: 1 }])
      .accountsStrict({ config, payer: payer.publicKey, programData, systemProgram: SystemProgram.programId })
      .rpc();
    const c: any = await program.account.config.fetch(config);
    assert.isTrue(c.authority.equals(payer.publicKey));
    assert.equal(c.attestors.length, 1);
    assert.equal(c.attestors[0].status, 1);
    assert.deepEqual(Buffer.from(c.attestors[0].keyId), keyIdOf(attestorA.publicKey.toBytes()));
    assert.isFalse(c.paused);
    // a second initialize can never overwrite it
    await expectThrows(
      () => program.methods.initialize(stranger.publicKey, []).accountsStrict({ config, payer: payer.publicKey, programData, systemProgram: SystemProgram.programId }).rpc(),
      "re-initialize"
    );
  });

  it("creates a record from a relayer-submitted attestor signature", async () => {
    const f = fields({ level: LEVELS.high });
    await upsert(f, attestorA, stranger); // any wallet may relay: the signature is what counts
    const r: any = await program.account.record.fetch(recordPda(f.chainId, f.address));
    assert.equal(r.version, 1);
    assert.equal(r.chainId, CHAIN_IDS.sol);
    assert.equal(r.level, LEVELS.high);
    assert.isFalse(r.revoked);
    assert.deepEqual(Buffer.from(r.address), SOL_MINT);
    assert.deepEqual(Buffer.from(r.addressHash), sha256(SOL_MINT));
    assert.deepEqual(Buffer.from(r.verdict), f.verdict);
    assert.deepEqual(Buffer.from(r.payloadHash), f.payloadHash);
    assert.deepEqual(Buffer.from(r.mldsaKeyId), mldsaKeyId);
    assert.deepEqual(Buffer.from(r.ed25519KeyId), keyIdOf(attestorA.publicKey.toBytes()));
    assert.equal(r.auditedAt.toNumber(), f.auditedAt);
    assert.isAbove(r.updatedSlot.toNumber(), 0);
    const c: any = await program.account.config.fetch(config);
    assert.equal(c.recordCount.toNumber(), 1);

    // account is exactly 146 + address bytes, rent-exempt
    const info = await conn.getAccountInfo(recordPda(f.chainId, f.address));
    assert.equal(info!.data.length, 146 + SOL_MINT.length);
    assert.isTrue(info!.owner.equals(program.programId));
    // a wallet / DEX reads the level straight from the PDA (offset 12), no IDL needed
    assert.equal(info!.data[12], LEVELS.high);
    assert.equal(info!.data[13], 0); // not revoked
  });

  it("updates with a newer audit and refuses a rollback", async () => {
    const f = fields({ level: LEVELS.low });
    await upsert(f);
    let r: any = await program.account.record.fetch(recordPda(f.chainId, f.address));
    assert.equal(r.level, LEVELS.low);
    assert.equal(r.auditedAt.toNumber(), f.auditedAt);
    // same time (a replay, here by another relayer) and an older one are both refused
    await expectCode(() => upsert({ ...f }, attestorA, stranger), "StaleRecord");
    await expectCode(() => upsert({ ...f, level: LEVELS.high, auditedAt: f.auditedAt - 5 }), "StaleRecord");
    r = await program.account.record.fetch(recordPda(f.chainId, f.address));
    assert.equal(r.level, LEVELS.low);
    const c: any = await program.account.config.fetch(config);
    assert.equal(c.recordCount.toNumber(), 1, "an update does not count as a new record");
  });

  it("requires the Ed25519 instruction right before upsert_record", async () => {
    const f = fields();
    await expectCode(async () => send([await upsertIx(f)]), "MissingEd25519Instruction");
    // something else in between
    await expectCode(
      async () => send([edIx(attestorA, recordMessage(config, f)), ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), await upsertIx(f)]),
      "MissingEd25519Instruction"
    );
  });

  it("rejects a key that is not an attestor", async () => {
    const f = fields({}, stranger);
    await expectCode(() => upsert(f, stranger), "UnknownAttestor");
  });

  it("rejects a signed message that differs from the submitted record", async () => {
    const signed = fields({ level: LEVELS.info });
    const submitted = { ...signed, level: LEVELS.high };
    await expectCode(async () => send([edIx(attestorA, recordMessage(config, signed)), await upsertIx(submitted)]), "MessageMismatch");
    // signed for another registry (e.g. devnet) -> mismatch here
    await expectCode(async () => send([edIx(attestorA, recordMessage(Keypair.generate().publicKey, signed)), await upsertIx(signed)]), "MessageMismatch");
    // wrong ed25519 key id
    const badId = fields({ ed25519KeyId: Buffer.alloc(8, 7) });
    await expectCode(() => upsert(badId), "KeyIdMismatch");
  });

  it("a forged signature fails in the Ed25519 precompile", async () => {
    const f = fields();
    const ix = edIx(attestorA, recordMessage(config, f));
    ix.data[16 + 32] ^= 0xff; // first signature byte (web3.js layout: pk at 16, sig at 48)
    await expectThrows(async () => send([ix, await upsertIx(f)]), "forged signature");
  });

  it("rejects Ed25519 offsets that point at another instruction", async () => {
    const f = fields();
    // instructionIndex 0 = the Ed25519 instruction's own position: the precompile accepts it,
    // the registry still refuses anything but 0xffff (Wormhole-class offset confusion)
    const ix = edIx(attestorA, recordMessage(config, f), 0);
    await expectCode(async () => send([ix, await upsertIx(f)]), "Ed25519ForeignOffsets");
  });

  it("validates address, hash, chain, level and time", async () => {
    // EVM addresses must be lowercase (the site's normalized form)
    const upper = fields({ chainId: CHAIN_IDS.eth, address: Buffer.from("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f") });
    await expectCode(() => upsert(upper), "AddressFormat");
    // address_hash must be sha256(address)
    const f = fields({ chainId: CHAIN_IDS.eth, address: EVM_TOKEN });
    const wrongHash = sha256(Buffer.from("something else"));
    await expectCode(async () => send([edIx(attestorA, recordMessage(config, f, wrongHash)), await upsertIx(f, wrongHash)]), "AddressHashMismatch");
    await expectCode(() => upsert(fields({ chainId: 99 })), "UnknownChain");
    await expectCode(() => upsert(fields({ level: 4 })), "InvalidLevel");
    await expectCode(() => upsert(fields({ auditedAt: now() + 3600 })), "TimestampInFuture");
    // and the good EVM one goes through
    await upsert(f);
    const r: any = await program.account.record.fetch(recordPda(CHAIN_IDS.eth, EVM_TOKEN));
    assert.equal(r.chainId, CHAIN_IDS.eth);
  });

  it("finds the Ed25519 instruction by position (current - 1), not at index 0", async () => {
    // [compute budget, ed25519, upsert]: the registry reads the instruction just before itself.
    // (One record per legacy transaction: an Ed25519 + upsert pair is ~480 bytes, so two pairs plus
    // the account keys exceed the 1232-byte limit — docs/SWD_AUDIT_REGISTRY.md "Costs".)
    const a = fields({ chainId: CHAIN_IDS.sui, address: Buffer.from("0x2::sui::SUI"), level: LEVELS.info });
    await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), edIx(attestorA, recordMessage(config, a)), await upsertIx(a)]);
    assert.equal(((await program.account.record.fetch(recordPda(a.chainId, a.address))) as any).level, LEVELS.info);
    const b = fields({ chainId: CHAIN_IDS.ton, address: Buffer.from("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"), level: LEVELS.medium });
    await upsert(b);
    const info = await conn.getAccountInfo(recordPda(b.chainId, b.address));
    assert.equal(info!.data.length, 146 + b.address.length);
    assert.equal(info!.data[12], LEVELS.medium);
  });

  it("pause stops writes; only the authority can pause", async () => {
    await expectCode(() => program.methods.setPaused(true).accountsStrict(admin(stranger)).signers([stranger]).rpc(), "Unauthorized");
    await program.methods.setPaused(true).accountsStrict(admin()).rpc();
    await expectCode(() => upsert(fields()), "Paused");
    await program.methods.setPaused(false).accountsStrict(admin()).rpc();
    await upsert(fields());
  });

  it("revoke / restore a record (authority only)", async () => {
    const rec = recordPda(CHAIN_IDS.sol, SOL_MINT);
    await expectCode(
      () => program.methods.revokeRecord(1).accountsStrict({ config, record: rec, authority: stranger.publicKey }).signers([stranger]).rpc(),
      "Unauthorized"
    );
    await program.methods.revokeRecord(1).accountsStrict({ config, record: rec, authority: payer.publicKey }).rpc();
    const info = await conn.getAccountInfo(rec);
    assert.equal(info!.data[13], 1, "revoked flag at offset 13");
    await expectCode(() => upsert(fields()), "RecordRevoked");
    await program.methods.restoreRecord().accountsStrict({ config, record: rec, authority: payer.publicKey }).rpc();
    await upsert(fields({ level: LEVELS.info }));
    const r: any = await program.account.record.fetch(rec);
    assert.isFalse(r.revoked);
    assert.equal(r.level, LEVELS.info);
  });

  it("rotates attestor keys: retired keys stop signing, revoked keys never come back", async () => {
    await program.methods
      .setAttestors([
        { pubkey: attestorA.publicKey, status: 2 },
        { pubkey: attestorB.publicKey, status: 1 },
      ])
      .accountsStrict(admin())
      .rpc();
    await expectCode(() => upsert(fields(), attestorA), "AttestorNotActive");
    await upsert(fields({}, attestorB), attestorB);
    await program.methods
      .setAttestors([
        { pubkey: attestorA.publicKey, status: 3 },
        { pubkey: attestorB.publicKey, status: 1 },
      ])
      .accountsStrict(admin())
      .rpc();
    await expectCode(
      () => program.methods.setAttestors([{ pubkey: attestorA.publicKey, status: 1 }]).accountsStrict(admin()).rpc(),
      "AttestorRevokedForever"
    );
    await expectCode(
      () => program.methods.setAttestors([{ pubkey: attestorB.publicKey, status: 1 }, { pubkey: attestorB.publicKey, status: 2 }]).accountsStrict(admin()).rpc(),
      "DuplicateAttestor"
    );
    await expectCode(
      () => program.methods.setAttestors([{ pubkey: attestorB.publicKey, status: 1 }]).accountsStrict(admin(stranger)).signers([stranger]).rpc(),
      "Unauthorized"
    );
  });

  it("hands authority over in two steps", async () => {
    const next = Keypair.generate();
    await program.methods.proposeAuthority(next.publicKey).accountsStrict(admin()).rpc();
    await expectCode(
      () => program.methods.acceptAuthority().accountsStrict({ config, newAuthority: stranger.publicKey }).signers([stranger]).rpc(),
      "Unauthorized"
    );
    await program.methods.acceptAuthority().accountsStrict({ config, newAuthority: next.publicKey }).signers([next]).rpc();
    let c: any = await program.account.config.fetch(config);
    assert.isTrue(c.authority.equals(next.publicKey));
    assert.isNull(c.pendingAuthority);
    // the old authority lost its rights; hand it back for any later suite
    await expectCode(() => program.methods.setPaused(true).accountsStrict(admin()).rpc(), "Unauthorized");
    await program.methods.proposeAuthority(payer.publicKey).accountsStrict({ config, authority: next.publicKey }).signers([next]).rpc();
    await program.methods.acceptAuthority().accountsStrict({ config, newAuthority: payer.publicKey }).rpc();
    c = await program.account.config.fetch(config);
    assert.isTrue(c.authority.equals(payer.publicKey));
  });
});
