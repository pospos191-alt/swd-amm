#!/usr/bin/env node
// SWD AMM — Pyth PriceUpdateV2 localnet test fixtures ("Phase 3", added
// 2026-09-23). Run this BEFORE `anchor test` (not part of the ts-mocha
// suite itself — see the "WHY A SEPARATE STEP" note below):
//
//   node scripts/gen-pyth-fixtures.js
//   anchor test
//
// (or just `yarn test`, if you keep package.json's "test" script as this
// repo's Phase 3 update leaves it — that script now runs both for you.)
//
// WHAT THIS DOES AND WHY: this program's `swap`/`swap_dlmm` now REQUIRE a
// real, fresh Pyth `PriceUpdateV2` account for both sides of every pool
// (see programs/swd_amm/src/oracle.rs's module doc comment) — but a real
// one can only ever be written by Pyth's own Receiver program, from a
// signed cross-chain price update; there is no documented way (checked
// against Pyth's own docs, 2026-09-23) to manufacture one on a bare
// `solana-test-validator` the way this project already does for its own
// SPL token/pool accounts. Chasing a fully faithful local reproduction of
// Pyth's actual posting flow was judged not worth it for THIS pass — see
// this script's "WHAT THIS DOES NOT PROVE" section below for the explicit
// tradeoff, same spirit as this project's other documented deferrals
// (SECURITY.md, governance.rs's Squads verification).
//
// Instead: this script hand-builds the exact on-chain BYTES a real
// `PriceUpdateV2` account would contain (Anchor account discriminator +
// Borsh-encoded fields, in the field order Pyth's own `pyth-solana-
// receiver-sdk`/`pythnet-sdk` crates declare — cross-checked against
// docs.rs for both crates, 2026-09-23), and writes two ready-to-load
// account snapshot JSON files that `Anchor.toml`'s
// `[[test.validator.account]]` entries point `solana-test-validator` at
// for every `anchor test` run. `programs/swd_amm/src/oracle.rs`'s
// `evaluate_oracle_and_fee` reads these through the EXACT same Anchor
// `Account<'info, PriceUpdateV2>`/`get_price_no_older_than` path
// production code uses — nothing about the PROGRAM side of this is
// mocked, only how the two price accounts get onto the local validator
// in the first place.
//
// WHY A SEPARATE STEP, NOT PART OF `anchor test` ITSELF: Anchor's own
// test orchestration starts `solana-test-validator` (loading whatever
// `[[test.validator.account]]` files already exist on disk at that
// moment) BEFORE it ever runs the ts-mocha suite in `[scripts] test` —
// so these files have to already be in their final form before you type
// `anchor test`, not generated from inside a `before()` hook.
//
// WHY THIS SCRIPT REGENERATES `publish_time` EVERY RUN: the pools these
// tests create are configured with a generous but still FINITE
// `oracle_max_staleness_secs` (see tests/swd_amm.ts/tests/dlmm.ts's
// `TEST_ORACLE_MAX_STALENESS_SECS`) — a fixture whose `publish_time` is
// hours or days old will make every swap in the suite fail with
// `PriceUnavailable`. Run this script again (fresh timestamps) any time
// `anchor test` starts failing that way, e.g. after leaving the fixture
// files sitting around for a while.
//
// WHAT THIS DOES NOT PROVE: it does not exercise Pyth's real signature
// verification, VAA parsing, or the Receiver program's actual `post_*`
// instructions at all — this program's `swap`/`swap_dlmm` never CPI into
// the Receiver program (they only read an already-posted account), so
// none of that matters for what THIS program does with the data, but it
// does mean a real byte-layout drift in a future Pyth SDK version, or an
// error in this script's own hand-rolled serialization, would not
// necessarily be caught here — the receiver program id
// (`rec5EKMGg6...`) and field layout below were independently
// cross-checked against two separate Pyth-maintained crates' published
// docs, not against a live compile, since this sandbox cannot reach
// crates.io (see this project's standing verification workflow, and
// oracle.rs's own "KNOWN UNCERTAINTY" paragraph).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------
// Minimal base58 (no external dependency — this script intentionally
// does not require @solana/web3.js/bs58 so it has nothing to fail to
// resolve if run before `yarn install`, or outside this repo's own
// devDependency set).
// ---------------------------------------------------------------------
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf) {
  let digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (let k = 0; buf[k] === 0 && k < buf.length - 1; k++) result += B58_ALPHABET[0];
  for (let q = digits.length - 1; q >= 0; q--) result += B58_ALPHABET[digits[q]];
  return result;
}

function base58Decode(str) {
  let bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const value = B58_ALPHABET.indexOf(str[i]);
    if (value === -1) throw new Error(`invalid base58 character in "${str}"`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; str[k] === "1" && k < str.length - 1; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

// ---------------------------------------------------------------------
// Fixed test identities. These MUST match tests/oracle-fixtures.ts,
// which imports them for use as the `price_update_a`/`price_update_b`
// account addresses and `pyth_feed_id_a`/`pyth_feed_id_b` instruction
// arguments — see that file.
// ---------------------------------------------------------------------

// The real Pyth Receiver program's mainnet address (Pyth deploys the
// same program id on every cluster) — cross-checked against docs.rs for
// both `pyth-solana-receiver-sdk` and `pyth-solana-receiver-sdk-legacy`
// (2026-09-23), which agreed with each other, and independently against
// three third-party block explorers showing real transaction history at
// this address. MUST match oracle.rs's `PYTH_RECEIVER_PROGRAM_ID`.
const PYTH_RECEIVER_PROGRAM_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

// Fixed (not regenerated per run) so Anchor.toml's `[[test.validator.account]]`
// `address = ...` entries and the tests' instruction calls always agree
// on where to find these two accounts.
const PRICE_UPDATE_A_PUBKEY = "7CSX26gEAc7Usyiqpse21fJ5uC2yi5AyMqaUePCKa1mZ";
const PRICE_UPDATE_B_PUBKEY = "AQbYtZkh2MxCjRK6yjthMJWiqNDVptxeSqEFv7XtAFkf";

// Deterministic (sha256 of a fixed label), not random — so re-running
// this generator always derives the SAME feed ids, matching whatever
// `pyth_feed_id_a`/`pyth_feed_id_b` the tests pass to
// `initialize_pool`/`initialize_dlmm_pool`.
const FEED_ID_A = sha256(Buffer.from("swd-amm-test-feed-a"));
const FEED_ID_B = sha256(Buffer.from("swd-amm-test-feed-b"));

// A fixture's `write_authority` field is never checked by this program
// (see oracle.rs) — the System Program's own address is used here purely
// as a recognizable, valid-looking placeholder.
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// ---------------------------------------------------------------------
// "Legacy pool" fixtures (added 2026-09-24, porting the 28 pre-Phase-3
// tests in tests/swd_amm.ts / tests/dlmm.ts / tests/governance.ts to
// work under the now-mandatory oracle guard — see those files' own
// comments for the full story). Those tests were written before Phase 3
// existed, so their pool ratios were chosen purely to exercise AMM
// math/security properties, not to track a real price — unlike
// tests/oracle.ts's purpose-built scenarios, they can't all share ONE
// fixture price. Three more feed pairs cover every distinct ratio those
// tests actually need (traced by hand against each test's own deposit
// amounts — see each legacy test file's call sites for which applies):
//   - legacy-ratio1:    1 raw mint_b per raw mint_a (price_a == price_b)
//   - legacy-ratio4:    4 raw mint_b per raw mint_a
//   - legacy-ratiohalf: 0.5 raw mint_b per raw mint_a
// All mints in those three files are 6-decimal, uniformly — unlike
// tests/oracle-fixtures.ts's 9dp/6dp pair, these need no decimals
// adjustment: oracle_price_q64 == price_a/price_b directly (see
// oracle-fixtures.ts's `oraclePriceQ64` mirror — netExp is 0 when
// decimals_a == decimals_b). Pubkeys are deterministic (sha256 of a
// fixed label, base58-encoded), not real keypairs — these accounts are
// only ever loaded as raw `[[test.validator.account]]` snapshot data,
// never signed for.
// ---------------------------------------------------------------------

function derivedPubkey(label) {
  return base58Encode(sha256(Buffer.from(label)));
}

const LEGACY_SCENARIOS = [
  {
    label: "legacy-ratio1",
    pubkeyA: derivedPubkey("swd-amm-legacy-ratio1-a-pubkey"),
    pubkeyB: derivedPubkey("swd-amm-legacy-ratio1-b-pubkey"),
    feedIdA: sha256(Buffer.from("swd-amm-legacy-ratio1-feed-a")),
    feedIdB: sha256(Buffer.from("swd-amm-legacy-ratio1-feed-b")),
    priceA: 1_00000000n,
    priceB: 1_00000000n,
  },
  {
    label: "legacy-ratio4",
    pubkeyA: derivedPubkey("swd-amm-legacy-ratio4-a-pubkey"),
    pubkeyB: derivedPubkey("swd-amm-legacy-ratio4-b-pubkey"),
    feedIdA: sha256(Buffer.from("swd-amm-legacy-ratio4-feed-a")),
    feedIdB: sha256(Buffer.from("swd-amm-legacy-ratio4-feed-b")),
    priceA: 4_00000000n,
    priceB: 1_00000000n,
  },
  {
    label: "legacy-ratiohalf",
    pubkeyA: derivedPubkey("swd-amm-legacy-ratiohalf-a-pubkey"),
    pubkeyB: derivedPubkey("swd-amm-legacy-ratiohalf-b-pubkey"),
    feedIdA: sha256(Buffer.from("swd-amm-legacy-ratiohalf-feed-a")),
    feedIdB: sha256(Buffer.from("swd-amm-legacy-ratiohalf-feed-b")),
    priceA: 1_00000000n,
    priceB: 2_00000000n,
  },
];

// ---------------------------------------------------------------------
// PriceUpdateV2 byte layout (Anchor discriminator + Borsh, field order
// per pyth_solana_receiver_sdk::price_update::PriceUpdateV2 /
// pythnet_sdk::messages::PriceFeedMessage — see this file's header
// comment for how this was cross-checked).
// ---------------------------------------------------------------------

const ANCHOR_DISCRIMINATOR = sha256(Buffer.from("account:PriceUpdateV2")).subarray(0, 8);

/**
 * @param {object} p
 * @param {Buffer} p.feedId - 32 bytes
 * @param {bigint} p.price - i64
 * @param {bigint} p.conf - u64
 * @param {number} p.exponent - i32
 * @param {bigint} p.publishTime - i64 (unix seconds)
 * @param {bigint} p.prevPublishTime - i64
 * @param {bigint} p.emaPrice - i64
 * @param {bigint} p.emaConf - u64
 * @param {bigint} p.postedSlot - u64
 */
function serializePriceUpdateV2(p) {
  const buf = Buffer.alloc(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  let o = 0;

  ANCHOR_DISCRIMINATOR.copy(buf, o);
  o += 8;

  base58Decode(SYSTEM_PROGRAM_ID).copy(buf, o); // write_authority
  o += 32;

  buf.writeUInt8(1, o); // VerificationLevel::Full (unit variant, index 1 — Partial{num_signatures:u8} is index 0)
  o += 1;

  p.feedId.copy(buf, o); // price_message.feed_id
  o += 32;
  buf.writeBigInt64LE(p.price, o);
  o += 8;
  buf.writeBigUInt64LE(p.conf, o);
  o += 8;
  buf.writeInt32LE(p.exponent, o);
  o += 4;
  buf.writeBigInt64LE(p.publishTime, o);
  o += 8;
  buf.writeBigInt64LE(p.prevPublishTime, o);
  o += 8;
  buf.writeBigInt64LE(p.emaPrice, o);
  o += 8;
  buf.writeBigUInt64LE(p.emaConf, o);
  o += 8;

  buf.writeBigUInt64LE(p.postedSlot, o); // posted_slot
  o += 8;

  if (o !== buf.length) {
    throw new Error(`internal error: wrote ${o} bytes, expected ${buf.length}`);
  }
  return buf;
}

function accountFixtureJson(pubkeyBase58, dataBuf) {
  return {
    pubkey: pubkeyBase58,
    account: {
      lamports: 10_000_000,
      data: [dataBuf.toString("base64"), "base64"],
      owner: PYTH_RECEIVER_PROGRAM_ID,
      executable: false,
      rentEpoch: 0,
      space: dataBuf.length,
    },
  };
}

function writePricePair(outDir, fileBaseName, pubkeyA, pubkeyB, feedIdA, feedIdB, priceA, priceB, nowSecs) {
  const dataA = serializePriceUpdateV2({
    feedId: feedIdA,
    price: priceA,
    conf: priceA / 4000n > 0n ? priceA / 4000n : 1n, // ~2.5bps of confidence width — plausible, not load-bearing
    exponent: -8,
    publishTime: nowSecs,
    prevPublishTime: nowSecs - 1n,
    emaPrice: priceA,
    emaConf: priceA / 4000n > 0n ? priceA / 4000n : 1n,
    postedSlot: 1n,
  });
  const dataB = serializePriceUpdateV2({
    feedId: feedIdB,
    price: priceB,
    conf: priceB / 4000n > 0n ? priceB / 4000n : 1n,
    exponent: -8,
    publishTime: nowSecs,
    prevPublishTime: nowSecs - 1n,
    emaPrice: priceB,
    emaConf: priceB / 4000n > 0n ? priceB / 4000n : 1n,
    postedSlot: 1n,
  });
  const fileA = path.join(outDir, `${fileBaseName}-a.json`);
  const fileB = path.join(outDir, `${fileBaseName}-b.json`);
  fs.writeFileSync(fileA, JSON.stringify(accountFixtureJson(pubkeyA, dataA), null, 2));
  fs.writeFileSync(fileB, JSON.stringify(accountFixtureJson(pubkeyB, dataB), null, 2));
  console.log(`wrote ${fileA} (${dataA.length} bytes, publish_time=${nowSecs})`);
  console.log(`wrote ${fileB} (${dataB.length} bytes, publish_time=${nowSecs})`);
}

// --publish-ahead-hours N (opt-in; default 0 = unchanged behavior for
// `yarn test` / `anchor test`): stamps every fixture's publish_time N hours
// in the FUTURE. oracle.rs's get_price_no_older_than deliberately treats a
// future publish_time as age 0 (see its doc comment), so a pool keeps
// accepting these static fixture prices for N hours PLUS its own
// oracle_max_staleness_secs, instead of only oracle_max_staleness_secs
// (capped at 3600s by MAX_ORACLE_STALENESS_SECS) after this script ran.
// For long MANUAL test sessions on `anchor localnet` (e.g. the test-ui)
// only — this changes nothing in the program, and nothing here is ever
// loaded on devnet/mainnet (those use real Pyth-posted accounts).
function parsePublishAheadHours(argv) {
  const i = argv.indexOf("--publish-ahead-hours");
  if (i === -1) return 0;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 30) {
    throw new Error("--publish-ahead-hours needs a number of hours between 0 and 720");
  }
  return n;
}

function main() {
  const aheadHours = parsePublishAheadHours(process.argv.slice(2));
  const nowSecs = BigInt(Math.floor(Date.now() / 1000) + Math.round(aheadHours * 3600));
  if (aheadHours > 0) {
    console.log(`publish_time set ${aheadHours}h ahead (manual localnet session mode)`);
  }
  const outDir = path.join(__dirname, "..", "tests", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });

  // The original tests/oracle.ts pair — mint_a priced like a ~$200 asset
  // (9 decimals, e.g. "SOL-like"), mint_b like a ~$1 asset (6 decimals,
  // e.g. "USDC-like"). Untouched by the 2026-09-24 legacy-fixture work
  // below — same pubkeys, same filenames, same values as always.
  // Same base filenames as always ("pyth-price-a.json"/"pyth-price-b.json")
  // — Anchor.toml's original two [[test.validator.account]] entries for
  // tests/oracle.ts point at these exact names and must keep working
  // unchanged.
  writePricePair(
    outDir,
    "pyth-price",
    PRICE_UPDATE_A_PUBKEY,
    PRICE_UPDATE_B_PUBKEY,
    FEED_ID_A,
    FEED_ID_B,
    200_00000000n,
    1_00000000n,
    nowSecs
  );

  for (const scenario of LEGACY_SCENARIOS) {
    writePricePair(
      outDir,
      `pyth-price-${scenario.label}`,
      scenario.pubkeyA,
      scenario.pubkeyB,
      scenario.feedIdA,
      scenario.feedIdB,
      scenario.priceA,
      scenario.priceB,
      nowSecs
    );
  }

  console.log("Run `anchor test` now — these fixtures are fresh as of this moment.");
}

main();

module.exports = {
  base58Encode,
  base58Decode,
  serializePriceUpdateV2,
  PYTH_RECEIVER_PROGRAM_ID,
  PRICE_UPDATE_A_PUBKEY,
  PRICE_UPDATE_B_PUBKEY,
  FEED_ID_A,
  FEED_ID_B,
  LEGACY_SCENARIOS,
};
