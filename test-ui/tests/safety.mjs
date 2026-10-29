// Wallet-safety browser check for test-ui/index.html (same harness as smoke.mjs: the page served
// locally with the esm.sh libraries swapped for ./stubs, no network, no validator), with a stand-in
// Phantom: the "Use a hardware wallet" help (Ledger through Phantom / Solflare), the banner at
// 10 SOL or more (hidden 7 days on request), the wallet disconnected after 30 idle minutes, and the
// in-page summary before signing (SOL sent, programs, an unlimited SPL approval warned about).
// Run: cd test-ui/tests && node safety.mjs   (playwright: npm install here, or NODE_PATH with it)
// Env: SMOKE_CHROMIUM=<path to a chromium binary> (optional)
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const stub = (name) => fs.readFileSync(path.join(here, "stubs", name));
const FILES = { "/index.html": "text/html; charset=utf-8", "/wallet-safety.js": "text/javascript", "/wallet-safety-i18n.js": "text/javascript", "/wallet-safety.css": "text/css", "/sol-safety.js": "text/javascript" };
const csp = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")).headers[0].headers.find((h) => h.key === "Content-Security-Policy").value;

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (!FILES[p]) { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", FILES[p]);
  res.setHeader("content-security-policy", csp);
  res.end(fs.readFileSync(path.join(root, p)));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const OWNER = "JDxHq1Zk2yN3xG8m9pXa7vQeW4tRbY6uLcFs5oPeamz";

const browser = await chromium.launch(process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {});
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route((url) => !url.href.startsWith(origin), async (route) => {
    const u = route.request().url();
    const js = (body) => route.fulfill({ status: 200, contentType: "application/javascript", body });
    if (u.includes("esm.sh/@solana/web3.js")) return js(stub("web3.js"));
    if (u.includes("esm.sh/@coral-xyz/anchor")) return js(stub("anchor.js"));
    if (u.includes("esm.sh/@solana/spl-token")) return js(stub("spl-token.js"));
    if (u.includes("esm.sh/buffer")) return js(stub("buffer.js"));
    if (u.includes("klinecharts")) return js("window.klinecharts={init(){return new Proxy({}, {get:()=>()=>null})},dispose(){},registerOverlay(){},registerIndicator(){},getSupportedOverlays(){return []}};");
    if (/\.(css)(\?|$)/.test(u) || u.includes("fonts.googleapis")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return js("");
  });
  // A stand-in Phantom with 12 SOL (the stub Connection's getBalance answers __smokeLamports).
  await ctx.addInitScript((owner) => {
    globalThis.__smokeLamports = 12_000_000_000;
    const pk = { toBase58: () => owner, toString: () => owner, toBytes: () => new Uint8Array(32), toBuffer: () => new Uint8Array(32), equals: () => false };
    window.phantom = { solana: { isPhantom: true, publicKey: pk, connect: async () => ({ publicKey: pk }), disconnect: async () => { window.__phantomDisconnected = true; }, on() {}, off() {}, signTransaction: async (t) => t, signAllTransactions: async (t) => t } };
  }, OWNER);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/.test(m.text()) && !/esm\.sh|klinecharts|fonts/.test(m.text())) errors.push(m.text()); });
  await page.clock.install();
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "1", null, { timeout: 20000 });

  // the help, from the footer: Ledger through Phantom / Solflare; the site cannot lock the extension
  await page.click('#footer-help [data-ws="help"]');
  await page.waitForSelector("#ws-help[open]");
  const help = await page.textContent("#ws-help");
  check(/Phantom[\s\S]*Solflare/.test(help) && /Ledger/.test(help), `help: Phantom/Solflare + Ledger: ${help.slice(0, 200)}`);
  check(/cannot lock your wallet extension/.test(help), "help: says the site cannot lock the extension");
  check(/30 minutes/.test(help), "help: 30 minutes by default");
  check(!/Ledger \(USB\)|Snap/.test(help), "help: no Ledger-over-USB / Snap on the Solana page");
  check(await page.evaluate(() => document.getElementById("ws-help").getBoundingClientRect().right <= innerWidth), "help fits 390px");
  await page.keyboard.press("Escape");

  // connect the stand-in Phantom: the wallet picker shows the help link; 12 SOL -> the banner
  await page.click("#connect-btn");
  await page.waitForSelector('#wallet-modal-help [data-ws="help"]');
  await page.click('#wallet-modal-list .wallet-option:has-text("Phantom")');
  await page.waitForFunction(() => document.getElementById("wallet-status").classList.contains("connected"), null, { timeout: 10000 });
  await page.waitForSelector("#ws-host .ws-banner", { timeout: 10000 }).catch(() => failures.push("no banner at 12 SOL"));
  check(/12 SOL[\s\S]*hardware wallet/.test(await page.textContent("#ws-host")), "banner: 12 SOL, hardware wallet");
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "banner: no sideways scroll at 390px");
  await page.click('#ws-host [data-ws="banner-hide"]');
  check(await page.evaluate(() => !document.querySelector("#ws-host .ws-banner") && Number(localStorage.getItem("zetaphy:safety:bannerHiddenUntil")) > Date.now() + 6.9 * 86400000), "banner hidden for 7 days");

  // the summary before signing, in the page (the same code the wallet wrapper calls)
  const r = page.evaluate((owner) => Promise.all([import("./wallet-safety.js"), import("./sol-safety.js")]).then(([w, s]) => {
    const le = (v, n) => { const b = []; let x = BigInt(v); for (let i = 0; i < n; i++) { b.push(Number(x & 255n)); x >>= 8n; } return b; };
    const tx = { instructions: [
      { programId: "11111111111111111111111111111111", keys: [{ pubkey: owner }, { pubkey: "4T8mq3mX7nB2cR8tY4wZ1aS6dF5gH3jK2kP9o5867iN" }], data: Uint8Array.from([...le(2, 4), ...le(1_500_000_000n, 8)]) },
      { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", keys: [{ pubkey: "So11111111111111111111111111111111111111112" }, { pubkey: "Dele9atexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }, { pubkey: owner }], data: Uint8Array.from([4, ...le((1n << 64n) - 1n, 8)]) },
    ] };
    return s.confirmSolana(w.safety({ win: window }), { network: "Solana devnet", owner, txs: tx });
  }), OWNER);
  await page.waitForSelector("#ws-confirm[open]");
  const sum = await page.textContent("#ws-confirm");
  check(/Solana devnet/.test(sum) && sum.includes(OWNER) && /1\.5 SOL/.test(sum) && /System \(1111/.test(sum) && /SPL Token/.test(sum), `summary: network, owner, 1.5 SOL, programs: ${sum}`);
  check(/Unlimited token approval: Dele9a…xxxxxx/.test(sum), `summary warns of the unlimited approval: ${sum}`);
  await page.click('#ws-confirm [data-ws="cancel"]');
  check((await r) === false, "Cancel -> nothing goes to the wallet");

  // 30 idle minutes: the wallet is disconnected, a notice says so
  await page.clock.fastForward("29:00");
  check(await page.evaluate(() => document.getElementById("wallet-status").classList.contains("connected")), "still connected at 29 minutes");
  await page.clock.fastForward("01:30");
  await page.waitForFunction(() => document.getElementById("wallet-status").classList.contains("disconnected"), null, { timeout: 5000 }).catch(() => failures.push("not disconnected after 30 idle minutes"));
  check(await page.evaluate(() => !!document.getElementById("ws-idle") && window.__phantomDisconnected === true && !localStorage.getItem("swd-amm-wallet-autoconnect")), "idle: notice, Phantom told to disconnect, no auto-reconnect");
  for (const e of errors) failures.push(`page error: ${e}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\nSAFETY CHECK FAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("safety check OK: help, banner, summary, idle disconnect");
