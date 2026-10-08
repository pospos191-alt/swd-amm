// SWDMM v2 pools (swdmm_v2.rs) + governance v2 (timelock.rs), added
// 2026-09-29. Runs in the same `anchor test` validator as the other files
// (shares GlobalConfig / GovernanceSettings singletons, same fixed
// emergency-authority seed as governance.ts).

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import { v2PositionIndex } from "./oracle-fixtures";

async function expectThrows(fn: () => Promise<unknown>, label: string): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error(`expected "${label}" to throw, but it succeeded`);
}
const code = (e: any) => e?.error?.errorCode?.code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SWDMM v2 pools", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SwdAmm as anchor.Program<any>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // governance authority
  const emergencyAuthority = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

  const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const globalConfig = pda(Buffer.from("global-config"));
  const settings = pda(Buffer.from("gov_settings"));
  const mintPolicy = (m: PublicKey) => pda(Buffer.from("mint_policy"), m.toBuffer());
  const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u64le = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);
  const v2Pool = (a: PublicKey, b: PublicKey, floor: number) => pda(Buffer.from("swdmm_v2_pool"), a.toBuffer(), b.toBuffer(), u16le(floor));
  const v2Vault = (pool: PublicKey, m: PublicKey) => pda(Buffer.from("swdmm_v2_vault"), pool.toBuffer(), m.toBuffer());
  const v2Position = (pool: PublicKey, i: number | BN) => pda(Buffer.from("swdmm_v2_position"), pool.toBuffer(), u64le(i));
  // Position addresses are bound to their owner (swdmm_v2.rs
  // v2_position_index), so nobody can create the address someone else's
  // transaction is about to use.
  const ownerIndex = (owner: PublicKey, nonce: number) => new BN(v2PositionIndex(owner, nonce).toString());

  const FIXED_1PCT = { mode: 0, decay: 0, cliffFeeBps: 100, floorFeeBps: 100, numberOfPeriods: 0, periodFrequency: new BN(0), reductionFactor: new BN(0) };
  const NO_DYNAMIC = { enabled: false, maxDynamicFeeBps: 0, variableFeeControl: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, maxVolatilityAccumulator: new BN(0) };
  const NO_ORACLE = { enabled: false, pythFeedIdA: Array(32).fill(0), pythFeedIdB: Array(32).fill(0), maxStalenessSecs: 0, maxDeviationBps: 0 };

  async function fund(kp: Keypair, sol = 2) {
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: sol * LAMPORTS_PER_SOL })),
      [payer]
    );
  }

  async function ensureGlobals() {
    try {
      await program.methods.initializeGlobalConfig(payer.publicKey, emergencyAuthority.publicKey)
        .accounts({ config: globalConfig, programData: PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0], payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    } catch (e) { if (!String(e).includes("already in use")) throw e; }
    try {
      await program.methods.initializeGovernanceSettings(new BN(5), 1_000, payer.publicKey)
        .accounts({ config: globalConfig, governanceAuthority: payer.publicKey, settings, payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    } catch (e) { if (!String(e).includes("already in use")) throw e; }
  }

  async function allow(m: PublicKey, enabled = true) {
    await program.methods.setMintPolicy(enabled, false)
      .accounts({ config: globalConfig, governanceAuthority: payer.publicKey, mint: m, tokenProgram: TOKEN_PROGRAM_ID, mintPolicy: mintPolicy(m), payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  }

  async function newPair() {
    const a = await createMint(conn, payer, payer.publicKey, null, 6);
    const b = await createMint(conn, payer, payer.publicKey, null, 9);
    await allow(a); await allow(b);
    return { a, b };
  }

  async function ata(m: PublicKey, owner: Keypair, amount = 0n) {
    const acc = await getOrCreateAssociatedTokenAccount(conn, payer, m, owner.publicKey);
    if (amount > 0n) await mintTo(conn, payer, m, acc.address, payer, amount);
    return acc.address;
  }

  async function initPool(a: PublicKey, b: PublicKey, over: any = {}) {
    const params = {
      baseFee: FIXED_1PCT, dynamicFee: NO_DYNAMIC, collectFeeMode: 0, activationTs: new BN(0),
      maxPriceImpactBps: 5_000, oracle: NO_ORACLE, ...over,
    };
    const pool = v2Pool(a, b, params.baseFee.floorFeeBps);
    await program.methods.initializeV2Pool(params)
      .accounts({
        creator: payer.publicKey, config: globalConfig, settings, mintA: a, mintB: b,
        mintPolicyA: mintPolicy(a), mintPolicyB: mintPolicy(b), pool,
        vaultA: v2Vault(pool, a), vaultB: v2Vault(pool, b),
        mintFeedA: null, mintFeedB: null,
        tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();
    return pool;
  }

  async function newPosition(pool: PublicKey, owner: Keypair) {
    const p: any = await program.account.swdmmV2Pool.fetch(pool);
    const nonce = p.positionCount.toNumber();
    const index = ownerIndex(owner.publicKey, nonce);
    const position = v2Position(pool, index);
    await program.methods.createV2Position(new BN(nonce), index).accounts({ owner: owner.publicKey, pool, position, systemProgram: SystemProgram.programId }).signers([owner]).rpc();
    return position;
  }

  function modifyAccounts(pool: PublicKey, p: any, position: PublicKey, owner: Keypair, ta: PublicKey, tb: PublicKey) {
    return {
      owner: owner.publicKey, pool, position, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB,
      ownerTokenA: ta, ownerTokenB: tb, tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
    };
  }

  async function swap(pool: PublicKey, trader: Keypair, ta: PublicKey, tb: PublicKey, amountIn: number | BN, aToB: boolean, minOut = 0) {
    const p: any = await program.account.swdmmV2Pool.fetch(pool);
    return program.methods.swapV2(new BN(amountIn), new BN(minOut), aToB)
      .accounts({
        trader: trader.publicKey, settings, pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB,
        traderTokenA: ta, traderTokenB: tb, tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
        priceUpdateA: null, priceUpdateB: null,
      }).signers([trader]).rpc();
  }

  async function propose(action: any) {
    const s: any = await program.account.governanceSettings.fetch(settings);
    const pending = pda(Buffer.from("gov_action"), u64le(s.nextActionId));
    await program.methods.proposeGovAction(action)
      .accounts({ config: globalConfig, governanceAuthority: payer.publicKey, settings, pending, payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    return pending;
  }
  async function waitDelay() {
    const s: any = await program.account.governanceSettings.fetch(settings);
    await sleep((Number(s.timelockDelaySecs) + 2) * 1000);
  }

  const bal = async (a: PublicKey) => (await getAccount(conn, a)).amount;

  let pool: PublicKey, mA: PublicKey, mB: PublicKey, taP: PublicKey, tbP: PublicKey, pos0: PublicKey;

  before(async () => {
    await ensureGlobals();
  });

  it("mint policy: a mint without a policy cannot be used", async () => {
    const a = await createMint(conn, payer, payer.publicKey, null, 6);
    const b = await createMint(conn, payer, payer.publicKey, null, 6);
    await allow(a);
    const err = await expectThrows(() => initPool(a, b), "pool with an un-allowed mint");
    assert.ok(String(err).includes("AccountNotInitialized") || code(err) === "MintNotAllowed", String(err));
    await allow(b, false);
    const err2 = await expectThrows(() => initPool(a, b), "pool with a disabled mint");
    assert.equal(code(err2), "MintNotAllowed");
  });

  it("rejects invalid fee configurations", async () => {
    const { a, b } = await newPair();
    const bad = { ...FIXED_1PCT, cliffFeeBps: 200 }; // fixed mode needs cliff == floor
    assert.equal(code(await expectThrows(() => initPool(a, b, { baseFee: bad }), "fixed with cliff != floor")), "InvalidBaseFee");
    assert.equal(code(await expectThrows(() => initPool(a, b, { maxPriceImpactBps: 6_000 }), "impact cap > 50%")), "InvalidPriceImpactCap");
    assert.equal(code(await expectThrows(() => initPool(a, b, { collectFeeMode: 3 }), "bad fee mode")), "InvalidCollectFeeMode");
  });

  it("creates a pool; only the creator can make the first (price-setting) deposit", async () => {
    ({ a: mA, b: mB } = await newPair());
    pool = await initPool(mA, mB);
    taP = await ata(mA, payer, 10_000_000_000n);
    tbP = await ata(mB, payer, 10_000_000_000_000n);

    const stranger = Keypair.generate(); await fund(stranger);
    const sa = await ata(mA, stranger, 1_000_000_000n); const sb = await ata(mB, stranger, 1_000_000_000_000n);
    const sPos = await newPosition(pool, stranger);
    const p: any = await program.account.swdmmV2Pool.fetch(pool);
    const err = await expectThrows(() => program.methods.addV2Liquidity(new BN(1_000_000), new BN(1_000_000), new BN(0))
      .accounts(modifyAccounts(pool, p, sPos, stranger, sa, sb)).signers([stranger]).rpc(), "stranger first deposit");
    assert.equal(code(err), "OnlyCreatorFirstDeposit");

    pos0 = await newPosition(pool, payer);
    // 1,000 A (6 dp) + 10 B (9 dp): 1 A = 0.01 B
    await program.methods.addV2Liquidity(new BN(1_000_000_000), new BN(10_000_000_000), new BN(0))
      .accounts(modifyAccounts(pool, p, pos0, payer, taP, tbP)).rpc();
    const after: any = await program.account.swdmmV2Pool.fetch(pool);
    assert.equal(after.reserveA.toString(), "1000000000");
    assert.equal(after.reserveB.toString(), "10000000000");
    assert.ok(new BN(after.lockedLiquidity).eqn(1000), "dead share locked");
    const pos: any = await program.account.swdmmV2Position.fetch(pos0);
    assert.ok(new BN(pos.liquidity).gtn(0));
  });

  it("swaps both ways with a 1% fee, accrues LP and protocol fees, and the LP can claim", async () => {
    const trader = Keypair.generate(); await fund(trader);
    const ta = await ata(mA, trader, 100_000_000n); const tb = await ata(mB, trader, 0n);
    await swap(pool, trader, ta, tb, 10_000_000, true); // 10 A -> B
    const got = await bal(tb);
    // x=10 A, fee 1% on input: 9.9 A into the curve; out = 9.9e6*1e10/(1e9+9.9e6)
    const expected = (9_900_000n * 10_000_000_000n) / (1_000_000_000n + 9_900_000n);
    assert.equal(got, expected);
    const p: any = await program.account.swdmmV2Pool.fetch(pool);
    assert.equal(p.protocolFeeA.toString(), "10000"); // 10% of 100_000
    assert.ok(new BN(p.feePerLiquidityA).gtn(0));
    // back the other way
    await swap(pool, trader, ta, tb, got, false);
    const p2: any = await program.account.swdmmV2Pool.fetch(pool);
    assert.ok(new BN(p2.protocolFeeB).gtn(0));

    const a0 = await bal(taP); const b0 = await bal(tbP);
    await program.methods.claimV2Fees().accounts(modifyAccounts(pool, p2, pos0, payer, taP, tbP)).rpc();
    const claimedA = (await bal(taP)) - a0; const claimedB = (await bal(tbP)) - b0;
    assert.ok(claimedA > 0n && claimedA <= 90_000n, `claimed A ${claimedA}`);
    assert.ok(claimedB > 0n, `claimed B ${claimedB}`);
  });

  it("enforces slippage and the price-impact cap", async () => {
    const trader = Keypair.generate(); await fund(trader);
    const ta = await ata(mA, trader, 5_000_000_000n); const tb = await ata(mB, trader, 0n);
    assert.equal(code(await expectThrows(() => swap(pool, trader, ta, tb, 1_000_000, true, 1_000_000_000), "min out too high")), "SlippageExceeded");
    // pushing more than the whole A reserve through the curve is > 50% impact
    assert.equal(code(await expectThrows(() => swap(pool, trader, ta, tb, 2_000_000_000, true), "huge swap")), "PriceImpactTooHigh");
  });

  it("second LP: deposit, withdraw, permanent lock (locked cannot be withdrawn), close", async () => {
    const lp = Keypair.generate(); await fund(lp);
    const la = await ata(mA, lp, 1_000_000_000n); const lb = await ata(mB, lp, 100_000_000_000n);
    const pos = await newPosition(pool, lp);
    const p: any = await program.account.swdmmV2Pool.fetch(pool);
    await program.methods.addV2Liquidity(new BN(100_000_000), new BN(100_000_000_000), new BN(1))
      .accounts(modifyAccounts(pool, p, pos, lp, la, lb)).signers([lp]).rpc();
    let ps: any = await program.account.swdmmV2Position.fetch(pos);
    const half = new BN(ps.liquidity).divn(2);
    await program.methods.lockV2Liquidity(half).accounts({ owner: lp.publicKey, pool, position: pos }).signers([lp]).rpc();
    ps = await program.account.swdmmV2Position.fetch(pos);
    assert.ok(new BN(ps.lockedLiquidity).eq(half));
    const tooMuch = new BN(ps.liquidity).addn(1);
    assert.equal(code(await expectThrows(() => program.methods.removeV2Liquidity(tooMuch, new BN(0), new BN(0))
      .accounts(modifyAccounts(pool, p, pos, lp, la, lb)).signers([lp]).rpc(), "withdraw locked")), "InsufficientLiquidity");
    const a0 = await bal(la);
    await program.methods.removeV2Liquidity(new BN(ps.liquidity), new BN(1), new BN(1))
      .accounts(modifyAccounts(pool, p, pos, lp, la, lb)).signers([lp]).rpc();
    assert.ok((await bal(la)) > a0);
    // position still holds locked liquidity -> cannot close
    assert.equal(code(await expectThrows(() => program.methods.closeV2Position().accounts({ owner: lp.publicKey, pool, position: pos }).signers([lp]).rpc(), "close locked position")), "PositionNotEmpty");

    // an empty position can be closed
    const empty = await newPosition(pool, lp);
    await program.methods.closeV2Position().accounts({ owner: lp.publicKey, pool, position: empty }).signers([lp]).rpc();
    assert.isNull(await conn.getAccountInfo(empty));
  });

  it("position ownership can be transferred; the old owner loses control", async () => {
    const alice = Keypair.generate(); const bob = Keypair.generate(); await fund(alice); await fund(bob);
    const pos = await newPosition(pool, alice);
    await program.methods.transferV2Position(bob.publicKey).accounts({ owner: alice.publicKey, position: pos }).signers([alice]).rpc();
    const err = await expectThrows(() => program.methods.transferV2Position(alice.publicKey).accounts({ owner: alice.publicKey, position: pos }).signers([alice]).rpc(), "old owner");
    assert.equal(code(err), "NotPositionOwner");
    assert.equal(((await program.account.swdmmV2Position.fetch(pos)) as any).owner.toBase58(), bob.publicKey.toBase58());
  });

  it("time scheduler: starts at the cliff fee (anti-sniper) and activation delays trading", async () => {
    const { a, b } = await newPair();
    const chainNow = async () => (await conn.getBlockTime(await conn.getSlot())) ?? Math.floor(Date.now() / 1000);
    const now = await chainNow();
    const sched = { mode: 1, decay: 1, cliffFeeBps: 5_000, floorFeeBps: 25, numberOfPeriods: 100, periodFrequency: new BN(3_600), reductionFactor: new BN(500) };
    const p1 = await initPool(a, b, { baseFee: sched, activationTs: new BN(now + 25) });
    const ta = await ata(a, payer, 10_000_000_000n); const tb = await ata(b, payer, 10_000_000_000_000n);
    const pos = await newPosition(p1, payer);
    const p: any = await program.account.swdmmV2Pool.fetch(p1);
    await program.methods.addV2Liquidity(new BN(1_000_000_000), new BN(1_000_000_000_000), new BN(0)).accounts(modifyAccounts(p1, p, pos, payer, ta, tb)).rpc();
    const trader = Keypair.generate(); await fund(trader);
    const xa = await ata(a, trader, 10_000_000n); const xb = await ata(b, trader, 0n);
    assert.equal(code(await expectThrows(() => swap(p1, trader, xa, xb, 1_000_000, true), "before activation")), "NotActivated");
    while ((await chainNow()) < now + 26) await sleep(2_000);
    await swap(p1, trader, xa, xb, 1_000_000, true);
    const out = await bal(xb);
    const expected = (500_000n * 1_000_000_000_000n) / (1_000_000_000n + 500_000n); // 50% fee
    assert.equal(out, expected);
  });

  it("quote-only and compounding fee modes take the fee in token B", async () => {
    for (const mode of [1, 2]) {
      const { a, b } = await newPair();
      const p1 = await initPool(a, b, { collectFeeMode: mode });
      const ta = await ata(a, payer, 10_000_000_000n); const tb = await ata(b, payer, 10_000_000_000_000n);
      const pos = await newPosition(p1, payer);
      let p: any = await program.account.swdmmV2Pool.fetch(p1);
      await program.methods.addV2Liquidity(new BN(1_000_000_000), new BN(1_000_000_000_000), new BN(0)).accounts(modifyAccounts(p1, p, pos, payer, ta, tb)).rpc();
      const trader = Keypair.generate(); await fund(trader);
      const xa = await ata(a, trader, 10_000_000n); const xb = await ata(b, trader, 0n);
      await swap(p1, trader, xa, xb, 10_000_000, true);
      p = await program.account.swdmmV2Pool.fetch(p1);
      assert.equal(p.protocolFeeA.toString(), "0", `mode ${mode}: no fee in A`);
      assert.ok(new BN(p.protocolFeeB).gtn(0), `mode ${mode}: protocol fee in B`);
      if (mode === 1) assert.ok(new BN(p.feePerLiquidityB).gtn(0));
      else assert.ok(new BN(p.feePerLiquidityB).eqn(0), "compounding does not accrue claimable fees");
    }
  });

  it("dynamic fee raises the fee after a volatile swap", async () => {
    const { a, b } = await newPair();
    const dyn = { enabled: true, maxDynamicFeeBps: 500, variableFeeControl: 1_000, filterPeriod: 10, decayPeriod: 120, reductionFactor: 5_000, maxVolatilityAccumulator: new BN(100_000) };
    const p1 = await initPool(a, b, { dynamicFee: dyn });
    const ta = await ata(a, payer, 10_000_000_000n); const tb = await ata(b, payer, 10_000_000_000_000n);
    const pos = await newPosition(p1, payer);
    const p: any = await program.account.swdmmV2Pool.fetch(p1);
    await program.methods.addV2Liquidity(new BN(1_000_000_000), new BN(1_000_000_000_000), new BN(0)).accounts(modifyAccounts(p1, p, pos, payer, ta, tb)).rpc();
    const trader = Keypair.generate(); await fund(trader);
    const xa = await ata(a, trader, 1_000_000_000n); const xb = await ata(b, trader, 0n);
    await swap(p1, trader, xa, xb, 200_000_000, true); // ~20% price move
    const after: any = await program.account.swdmmV2Pool.fetch(p1);
    assert.ok(new BN(after.volatilityAccumulator).gtn(0), "volatility recorded");
  });

  it("emergency pause stops swaps; unpause and protocol-fee withdrawal need the timelock", async () => {
    await program.methods.emergencyPauseV2Pool(true, false, false)
      .accounts({ config: globalConfig, emergencyAuthority: emergencyAuthority.publicKey, pool }).signers([emergencyAuthority]).rpc();
    const trader = Keypair.generate(); await fund(trader);
    const ta = await ata(mA, trader, 10_000_000n); const tb = await ata(mB, trader, 0n);
    assert.equal(code(await expectThrows(() => swap(pool, trader, ta, tb, 1_000_000, true), "paused")), "SwapPaused");

    const pending = await propose({ unpauseV2Pool: { pool, swap: true, deposit: false, withdraw: false } });
    assert.equal(code(await expectThrows(() => program.methods.executeV2PoolAction().accounts({ pending, pool }).rpc(), "early")), "TimelockNotElapsed");
    await waitDelay();
    await program.methods.executeV2PoolAction().accounts({ pending, pool }).rpc();
    await swap(pool, trader, ta, tb, 1_000_000, true);

    // protocol fees -> treasury (payer) via timelock
    const p: any = await program.account.swdmmV2Pool.fetch(pool);
    const feeA = BigInt(p.protocolFeeA.toString());
    assert.ok(feeA > 0n);
    const w = await propose({ withdrawV2ProtocolFees: { pool } });
    await waitDelay();
    const before = await bal(taP);
    await program.methods.executeWithdrawProtocolFees()
      .accounts({ pending: w, settings, pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, treasuryTokenA: taP, treasuryTokenB: tbP, tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID })
      .rpc();
    assert.equal((await bal(taP)) - before, feeA);
    const p2: any = await program.account.swdmmV2Pool.fetch(pool);
    assert.equal(p2.protocolFeeA.toString(), "0");
  });

  it("governance: settings changes are timelocked and bounded; cancel works", async () => {
    assert.equal(code(await expectThrows(() => propose({ setProtocolFeeShare: { bps: 2_001 } }), "share > 20%")), "ProtocolFeeShareTooHigh");
    const c = await propose({ setProtocolFeeShare: { bps: 500 } });
    await program.methods.cancelGovAction().accounts({ config: globalConfig, governanceAuthority: payer.publicKey, pending: c }).rpc();
    await waitDelay();
    assert.equal(code(await expectThrows(() => program.methods.executeSettingsAction().accounts({ pending: c, settings }).rpc(), "cancelled")), "ActionNotPending");
    const ok = await propose({ setProtocolFeeShare: { bps: 1_500 } });
    await waitDelay();
    await program.methods.executeSettingsAction().accounts({ pending: ok, settings }).rpc();
    assert.equal(((await program.account.governanceSettings.fetch(settings)) as any).protocolFeeShareBps, 1_500);
    // a random signer cannot propose
    const rando = Keypair.generate(); await fund(rando, 1);
    const s: any = await program.account.governanceSettings.fetch(settings);
    const pending = pda(Buffer.from("gov_action"), u64le(s.nextActionId));
    const err = await expectThrows(() => program.methods.proposeGovAction({ setProtocolFeeShare: { bps: 0 } })
      .accounts({ config: globalConfig, governanceAuthority: rando.publicKey, settings, pending, payer: rando.publicKey, systemProgram: SystemProgram.programId })
      .signers([rando]).rpc(), "non-governance propose");
    assert.equal(code(err), "Unauthorized");
  });
});
