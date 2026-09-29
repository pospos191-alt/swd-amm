#!/usr/bin/env node
// Check which Pyth price feeds are live on a cluster (added 2026-09-29).
//
// swd-amm pools need two Pyth PriceUpdateV2 accounts (one per token) that
// are fresh (<= the pool's oracle_max_staleness_secs, max 3600s) and fully
// verified. On devnet the only realistic source is Pyth's "sponsored"
// push-oracle feeds, whose account address is derived from the feed id:
//   PDA(seeds = [shard_id as u16 LE, feed_id], program = Pyth Push Oracle)
// This script derives those addresses for a few common feeds (or any feed
// ids / account addresses you pass), fetches them, and prints price, age
// and verification level so you can pick a pair for a devnet pool.
//
// Usage:
//   node scripts/check-pyth-feeds.mjs                       # devnet, common feeds
//   node scripts/check-pyth-feeds.mjs --url https://api.devnet.solana.com
//   node scripts/check-pyth-feeds.mjs 0x<feed id hex> <price account pubkey> ...
// Read-only: no wallet needed, nothing is sent.

import { Connection, PublicKey } from "@solana/web3.js";

const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
const COMMON = {
  "SOL/USD": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "USDC/USD": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "USDT/USD": "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  "BTC/USD": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH/USD": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

const argv = process.argv.slice(2);
const urlIdx = argv.indexOf("--url");
const url = urlIdx >= 0 ? argv[urlIdx + 1] : "https://api.devnet.solana.com";
const extra = argv.filter((a, i) => a !== "--url" && i !== urlIdx + 1);

const feedPda = (feedHex, shard = 0) => {
  const shardLe = Buffer.alloc(2);
  shardLe.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([shardLe, Buffer.from(feedHex, "hex")], PUSH_ORACLE)[0];
};

// PriceUpdateV2 layout (same one programs/swd_amm/src/oracle.rs reads):
// 8 discriminator | 32 write_authority | verification_level (1 tag [+1 if Partial])
// | feed_id 32 | price i64 | conf u64 | exponent i32 | publish_time i64 | ...
export function decodePriceUpdateV2(data) {
  let o = 8 + 32;
  const tag = data[o]; o += 1;
  const verification = tag === 1 ? "Full" : `Partial(${data[o]})`;
  if (tag === 0) o += 1;
  const feedId = Buffer.from(data.subarray(o, o + 32)).toString("hex"); o += 32;
  const price = data.readBigInt64LE(o); o += 8;
  const conf = data.readBigUInt64LE(o); o += 8;
  const exponent = data.readInt32LE(o); o += 4;
  const publishTime = Number(data.readBigInt64LE(o));
  return { verification, feedId, price, conf, exponent, publishTime };
}

const targets = [];
for (const [name, hex] of Object.entries(COMMON)) targets.push({ name, feedHex: hex, account: feedPda(hex) });
for (const a of extra) {
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(a)) {
    const hex = a.replace(/^0x/, "").toLowerCase();
    targets.push({ name: `feed ${hex.slice(0, 8)}…`, feedHex: hex, account: feedPda(hex) });
  } else {
    targets.push({ name: `account ${a.slice(0, 6)}…`, feedHex: null, account: new PublicKey(a) });
  }
}

const conn = new Connection(url, "confirmed");
const infos = await conn.getMultipleAccountsInfo(targets.map((t) => t.account));
const now = Math.floor(Date.now() / 1000);
console.log(`cluster: ${url}\n`);
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  const info = infos[i];
  console.log(`${t.name}`);
  console.log(`  price account: ${t.account.toBase58()}`);
  if (!info) { console.log("  ✗ account does not exist on this cluster\n"); continue; }
  try {
    const d = decodePriceUpdateV2(Buffer.from(info.data));
    const age = now - d.publishTime;
    const human = Number(d.price) * 10 ** d.exponent;
    const fresh = age <= 3600 ? (age <= 120 ? "✓ fresh" : "~ usable (<1h)") : "✗ stale (>1h, swd-amm rejects)";
    console.log(`  feed id:       0x${d.feedId}${t.feedHex && d.feedId !== t.feedHex ? "  ⚠ differs from requested" : ""}`);
    console.log(`  price:         ${human} (raw ${d.price} × 10^${d.exponent})`);
    console.log(`  verification:  ${d.verification}${d.verification === "Full" ? "" : "  ✗ swd-amm needs Full"}`);
    console.log(`  published:     ${new Date(d.publishTime * 1000).toISOString()}  (${age}s ago)  ${fresh}`);
  } catch (e) {
    console.log(`  ✗ not a PriceUpdateV2 account (${e.message})`);
  }
  console.log();
}
