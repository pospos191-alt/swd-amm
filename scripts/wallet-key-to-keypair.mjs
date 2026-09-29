#!/usr/bin/env node
// Turn a wallet's exported private key (e.g. MetaMask / Phantom "Show private
// key", a base58 string) into a Solana CLI keypair file ([..64 numbers..]).
//
// The key is read from the SOLANA_EXPORTED_KEY environment variable so it
// never appears in shell history or on screen, and the script prints only the
// public address. Nothing is sent anywhere.
//
// Usage (WSL / Linux):
//   read -rs SOLANA_EXPORTED_KEY      # paste the key, press Enter (nothing is shown)
//   SOLANA_EXPORTED_KEY="$SOLANA_EXPORTED_KEY" node scripts/wallet-key-to-keypair.mjs \
//       --expect <address> --out ~/.config/solana/devnet-deployer.json
//   unset SOLANA_EXPORTED_KEY
//
// Accepts: base58 64-byte secret key (most wallets), base58 32-byte seed,
// hex (64 or 128 chars), or a JSON array. Refuses to write if the derived
// address differs from --expect.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58decode = (s) => {
  let n = 0n;
  for (const c of s) {
    const i = ALPH.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Buffer.from(out);
};
const b58encode = (buf) => {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
};
// ed25519 public key from a 32-byte seed, using Node's built-in crypto.
const pubFromSeed = (seed) => {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const spki = crypto.createPublicKey(crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }))
    .export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32);
};

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const expect = arg("--expect");
const outPath = (arg("--out") || "").replace(/^~(?=\/|$)/, os.homedir());
const raw = (process.env.SOLANA_EXPORTED_KEY || "").trim();
if (!raw || !outPath) {
  console.error("Set SOLANA_EXPORTED_KEY (see the header of this file) and pass --out <file>.");
  process.exit(1);
}

let bytes;
try {
  if (raw.startsWith("[")) bytes = Buffer.from(JSON.parse(raw));
  else if (/^[0-9a-fA-F]+$/.test(raw) && (raw.length === 64 || raw.length === 128)) bytes = Buffer.from(raw, "hex");
  else bytes = b58decode(raw);
} catch {
  console.error("Could not read the key — expected base58, hex, or a JSON array.");
  process.exit(1);
}
if (bytes.length !== 32 && bytes.length !== 64) {
  console.error(`Key is ${bytes.length} bytes; expected 32 (seed) or 64 (secret key).`);
  process.exit(1);
}

const seed = bytes.subarray(0, 32);
const pub = pubFromSeed(seed);
if (bytes.length === 64 && !pub.equals(bytes.subarray(32))) {
  console.error("The key's two halves don't match each other — it was probably copied incompletely.");
  process.exit(1);
}
const address = b58encode(pub);
if (expect && address !== expect) {
  console.error(`This key is for ${address}, not ${expect}. Nothing written.`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
fs.chmodSync(outPath, 0o600);
console.log(`Wrote keypair for ${address} to ${outPath} (readable only by you).`);
