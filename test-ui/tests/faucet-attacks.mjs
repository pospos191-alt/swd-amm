// Attack tests for api/devnet-faucet.js — run with `node faucet-attacks.mjs`.
// @vercel/kv and @solana/web3.js are replaced by in-memory fakes, so no
// network, no secrets and no npm install are needed.
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const store = new Map();
const kv = {
  async set(k, v, o = {}) { if (o.nx && store.has(k)) return null; store.set(k, v); return "OK"; },
  async del(k) { store.delete(k); return 1; },
  async incr(k) { const n = (Number(store.get(k)) || 0) + 1; store.set(k, n); return n; },
  async expire() { return 1; },
};
let sent = 0;
class PublicKey {
  constructor(s) { if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error("Invalid public key input"); this.s = s; }
  toBase58() { return this.s; }
}
const web3 = {
  PublicKey,
  LAMPORTS_PER_SOL: 1e9,
  Keypair: { fromSecretKey: () => ({ publicKey: new PublicKey("11111111111111111111111111111111") }) },
  SystemProgram: { transfer: (x) => x },
  Transaction: class { add() { return this; } },
  Connection: class { async getBalance() { return 100e9; } async getGenesisHash() { return "devnet"; } },
  sendAndConfirmTransaction: async () => { sent++; return "sig" + sent; },
};
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "@vercel/kv") return { kv };
  if (req === "@solana/web3.js") return web3;
  return realLoad.call(this, req, ...rest);
};
const require = Module.createRequire(import.meta.url);
process.env.DEVNET_FAUCET_SECRET_KEY = JSON.stringify(Array(64).fill(7));
const handler = require(path.join(here, "../api/devnet-faucet.js"));

function call({ method = "POST", body, headers = {}, query = {} }) {
  return new Promise((resolve) => {
    const res = {
      code: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(o) { resolve({ code: this.code, body: o }); },
      end() { resolve({ code: this.code, body: null }); },
    };
    handler({ method, body, headers, query, socket: { remoteAddress: "10.0.0.1" } }, res);
  });
}
const addr = (i) => "So1111111111111111111111111111111111111" + String(i).padStart(4, "1").replace(/0/g, "2");
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("✓", name); } catch (e) { failures++; console.log("✗", name, "—", e.message); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

await check("same wallet twice is refused", async () => {
  const a = await call({ body: { address: addr(1) }, headers: { "x-vercel-forwarded-for": "1.1.1.1" } });
  const b = await call({ body: { address: addr(1) }, headers: { "x-vercel-forwarded-for": "1.1.1.2" } });
  expect(a.code === 200 && b.code === 429, `got ${a.code} then ${b.code}`);
});
await check("same IP, new wallet each time, is refused", async () => {
  const b = await call({ body: { address: addr(2) }, headers: { "x-vercel-forwarded-for": "1.1.1.1" } });
  expect(b.code === 429, `got ${b.code}`);
});
await check("a forged X-Forwarded-For does not dodge the IP limit", async () => {
  const r = await call({ body: { address: addr(3) }, headers: { "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "9.9.9.9" } });
  expect(r.code === 429, `got ${r.code}`);
});
await check("many IPs and wallets hit the global hourly cap", async () => {
  let ok = 0, refused = 0;
  for (let i = 10; i < 60; i++) {
    const r = await call({ body: { address: addr(i) }, headers: { "x-vercel-forwarded-for": `2.2.${i}.1` } });
    if (r.code === 200) ok++; else if (r.code === 429) refused++;
  }
  expect(ok <= 30 && refused >= 19, `${ok} served, ${refused} refused`);
});
await check("refused requests don't burn the wallet's daily slot", async () => {
  const wk = `devnet-faucet:wallet:${addr(59)}`;
  expect(!store.has(wk), "wallet lock kept after a global-cap refusal");
});
await check("bad and oversized addresses are rejected", async () => {
  const a = await call({ body: { address: "not-a-key" }, headers: { "x-vercel-forwarded-for": "3.3.3.3" } });
  const b = await call({ body: { address: "1".repeat(5000) }, headers: { "x-vercel-forwarded-for": "3.3.3.4" } });
  const c = await call({ body: "{broken", headers: { "x-vercel-forwarded-for": "3.3.3.5" } });
  expect(a.code === 400 && b.code === 400 && c.code === 400, `${a.code} ${b.code} ${c.code}`);
});
await check("only POST dispenses", async () => {
  const r = await call({ method: "GET", headers: {} });
  expect(r.code === 405, `got ${r.code}`);
});
await check("diag never echoes the secret", async () => {
  process.env.DEVNET_FAUCET_SECRET_KEY = '[1,2,SECRETSECRETSECRET';
  const r = await call({ method: "GET", query: { diag: "1" } });
  expect(r.code === 500 && !JSON.stringify(r.body).includes("SECRET"), JSON.stringify(r.body));
});

console.log(failures ? `\n${failures} faucet attack test(s) FAILED` : "\nfaucet attack tests passed");
process.exit(failures ? 1 : 0);
