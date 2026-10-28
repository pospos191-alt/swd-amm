// test-ui/sol-safety.js: reading what a Solana transaction does before it is signed.
// Run: node --test test-ui/tests/sol-safety.test.mjs (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { solTxInfo, instructionsOf, SPL_UNLIMITED_MIN, confirmSolana } from "../sol-safety.js";

const OWNER = "JDxHq1Zk2yN3xG8m9pXa7vQeW4tRbY6uLcFs5oPeamz";
const OTHER = "4T8mq3mX7nB2cR8tY4wZ1aS6dF5gH3jK2kP9o5867iN";
const SYS = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const AMM = "SWDammProgram1111111111111111111111111111111";
const le = (v, n) => { const b = []; let x = BigInt(v); for (let i = 0; i < n; i++) { b.push(Number(x & 255n)); x >>= 8n; } return b; };
const transfer = (from, lamports) => ({ programId: { toBase58: () => SYS }, keys: [{ pubkey: from }, { pubkey: OTHER }], data: Uint8Array.from([...le(2, 4), ...le(lamports, 8)]) });
const approve = (amount, kind = 4) => ({ programId: TOKEN, keys: [{ pubkey: "src" }, { pubkey: "delegate1" }, { pubkey: OWNER }], data: Uint8Array.from([kind, ...le(amount, 8), ...(kind === 13 ? [6] : [])]) });

test("legacy transactions: SOL sent by the owner, programs named, approvals", () => {
  const tx = { instructions: [transfer(OWNER, 1_500_000_000n), transfer(OTHER, 7n), { programId: AMM, keys: [], data: new Uint8Array([1, 2]) }, approve(5n), approve((1n << 64n) - 1n, 13)] };
  const i = solTxInfo(tx, OWNER, { [AMM]: "SWD AMM" });
  assert.equal(i.txs, 1);
  assert.equal(i.instructions, 5);
  assert.equal(i.solOut, 1_500_000_000n, "only the owner's transfers count");
  assert.deepEqual(i.programs, [`System (${SYS})`, `SWD AMM (${AMM})`, `SPL Token (${TOKEN})`]);
  assert.deepEqual(i.approvals, [{ delegate: "delegate1", amount: 5n, unlimited: false }, { delegate: "delegate1", amount: (1n << 64n) - 1n, unlimited: true }]);
  assert.equal(SPL_UNLIMITED_MIN, 1n << 63n);
});

test("versioned transactions (compiled instructions) and lists (signAllTransactions)", () => {
  const v0 = { message: { staticAccountKeys: [OWNER, OTHER, SYS].map((k) => ({ toBase58: () => k })), compiledInstructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: Uint8Array.from([...le(2, 4), ...le(42n, 8)]) }] } };
  assert.deepEqual(instructionsOf(v0)[0].accounts, [OWNER, OTHER]);
  const i = solTxInfo([v0, v0], OWNER);
  assert.equal(i.txs, 2);
  assert.equal(i.solOut, 84n);
  assert.deepEqual(i.programs, [`System (${SYS})`]);
});

test("anything unreadable is no instruction, never a throw", () => {
  for (const x of [null, undefined, {}, { message: {} }, { instructions: [{ programId: null, data: "zz" }] }]) assert.doesNotThrow(() => solTxInfo(x, OWNER));
  assert.equal(solTxInfo({ instructions: [{ programId: SYS, keys: [{ pubkey: OWNER }], data: new Uint8Array([2, 0, 0]) }] }, OWNER).solOut, 0n, "a short transfer is not read");
});

test("confirmSolana: the summary fields, and Cancel is false", async () => {
  let seen;
  const sf = { t: (k, v = {}) => `${k}${JSON.stringify(v)}`, confirmTx: async (o) => { seen = o; return null; } };
  const ok = await confirmSolana(sf, { network: "Solana devnet", owner: OWNER, txs: { instructions: [transfer(OWNER, 2_000_000_000n), approve((1n << 64n) - 1n)] } });
  assert.equal(ok, false);
  assert.equal(seen.network, "Solana devnet");
  assert.equal(seen.from, OWNER);
  assert.equal(seen.value, 2_000_000_000n);
  assert.equal(seen.decimals, 9);
  assert.equal(seen.symbol, "SOL");
  assert.match(seen.warnings[0], /^cfSplUnlimited/);
  sf.confirmTx = async () => "0x";
  assert.equal(await confirmSolana(sf, { network: "x", owner: OWNER, txs: [] }), true);
});
