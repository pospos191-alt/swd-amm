// Page smoke test for test-ui/index.html (added 2026-09-25).
//
// Why this exists: the page is one ~1.3 MB <script type="module">. A single
// top-level statement that throws while the module is being evaluated (for
// example a `const` read before its declaration line — this really happened
// in build 2026-09-25o) stops the whole script, and the page looks frozen.
// `node --check` cannot see that; only running the page can.
//
// What it does: serves index.html from a throwaway local HTTP server, loads
// it in headless Chromium with the three esm.sh libraries swapped for the
// tiny stubs in ./stubs (no network, no validator, no wallet), then clicks
// through tabs / a swap popup / language / network, and fails if:
//   - any uncaught page error happens, or
//   - the page never sets <html data-app-ready="1"> (the last line of the
//     module script), i.e. startup did not reach the end.
//
// Run locally:  cd test-ui/tests && npm install && npx playwright install chromium && node smoke.mjs
// Env: SMOKE_HTML=<path to index.html> (default ../index.html)
//      SMOKE_CHROMIUM=<path to a chromium binary> (optional)

import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(here, process.env.SMOKE_HTML || "../index.html");
const stub = (name) => fs.readFileSync(path.join(here, "stubs", name));

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/index.html")) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(htmlPath));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {});
const failures = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  // Everything off-origin is answered locally: the three libraries get the
  // stubs, klinecharts gets a no-op object, anything else an empty body.
  await ctx.route((url) => !url.href.startsWith(origin), async (route) => {
    const u = route.request().url();
    const js = (body) => route.fulfill({ status: 200, contentType: "application/javascript", body });
    if (u.includes("esm.sh/@solana/web3.js")) return js(stub("web3.js"));
    if (u.includes("esm.sh/@coral-xyz/anchor")) return js(stub("anchor.js"));
    if (u.includes("esm.sh/@solana/spl-token")) return js(stub("spl-token.js"));
    if (u.includes("esm.sh/buffer")) return js(stub("buffer.js"));
    if (u.includes("klinecharts")) {
      return js("window.klinecharts={init(){return new Proxy({}, {get:()=>()=>null})},dispose(){},registerOverlay(){},registerIndicator(){},getSupportedOverlays(){return []}};");
    }
    if (/\.(css)(\?|$)/.test(u) || u.includes("fonts.googleapis")) return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return js("");
  });

  // Seed the saved state a returning user would have, so startup code that
  // only runs with saved pairs/labels (recent-pair chips, pair card, coin
  // badges) is exercised too.
  const A = "JDxHq1Zk2yN3xG8m9pXa7vQeW4tRbY6uLcFs5oPeamz";
  const B = "4T8mq3mX7nB2cR8tY4wZ1aS6dF5gH3jK2kP9o5867iN";
  await ctx.addInitScript(([a, b]) => {
    if (sessionStorage.getItem("smoke-seeded")) return;
    sessionStorage.setItem("smoke-seeded", "1");
    localStorage.setItem("swd-amm-active-mint-a", a);
    localStorage.setItem("swd-amm-active-mint-b", b);
    localStorage.setItem("swd-amm-recent-pairs-v1", JSON.stringify([{ mintA: a, mintB: b, pinned: false, lastUsedAt: Date.now() }]));
    localStorage.setItem("swd-amm-recent-mints", JSON.stringify([a, b]));
    localStorage.setItem("swd-amm-token-labels", JSON.stringify({ [a]: "SWDA" }));
  }, [A, B]);

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${e.message}\n${(e.stack || "").split("\n").slice(1, 4).join("\n")}`));

  await page.goto(`${origin}/index.html`);
  const ready = await page.waitForFunction(() => document.documentElement.dataset.appReady === "1", null, { timeout: 20000 })
    .then(() => true, () => false);
  if (!ready) failures.push("startup never finished: <html data-app-ready=\"1\"> was not set (a top-level statement threw — see page errors)");

  const info = await page.evaluate(() => ({
    build: (document.body.innerText.match(/build \d{4}-\d{2}-\d{2}\w*/) || [""])[0],
    network: document.getElementById("network-select")?.value,
    coinBadges: document.querySelectorAll(".mkt-badge, .token-icon-wrap img").length,
    iconSelects: document.querySelectorAll(".isel-btn").length,
  }));
  console.log("loaded:", JSON.stringify(info));
  if (info.network !== "localnet") failures.push(`network should default to localnet on 127.0.0.1, got ${info.network}`);

  const steps = [
    ["open Trade tab", () => page.click('.tab-nav-btn[data-tab="tools"]', { timeout: 5000 })],
    ["open Swap popup", () => page.click("#tools-nav-swap", { timeout: 5000 })],
    ["close popup (Escape)", () => page.keyboard.press("Escape")],
    ["Multi-hop fills mint in/out from the active pair", async () => {
      await page.click("#tools-nav-mh", { timeout: 5000 });
      const v = await page.evaluate(() => [document.getElementById("mh-mint-in").value, document.getElementById("mh-mint-out").value]);
      if (v[0] !== A || v[1] !== B) throw new Error(`mint in/out = ${v.join(" / ")}`);
      await page.click("#mh-direction-flip-btn", { timeout: 5000 });
      const f = await page.evaluate(() => [document.getElementById("mh-mint-in").value, document.getElementById("mh-mint-out").value]);
      if (f[0] !== B || f[1] !== A) throw new Error(`after flip mint in/out = ${f.join(" / ")}`);
      await page.keyboard.press("Escape");
    }],
    // Swap is docked beside the chart on wide screens (build 2026-10-07c).
    ["Swap form is docked beside the chart (1440px)", async () => {
      const docked = await page.evaluate(() => !document.getElementById("trade-dock").hidden && !!document.querySelector("#trade-dock-body #swap-btn, #trade-dock-body #dlmm-swap-btn"));
      if (!docked) throw new Error("no Swap form in #trade-dock-body");
      const popupOpen = await page.evaluate(() => !document.getElementById("form-popup-overlay").hidden);
      if (popupOpen) throw new Error("Swap opened a popup instead of using the dock");
    }],
    ["Settings popover opens and closes", async () => {
      await page.click("#settings-btn", { timeout: 5000 });
      const open = await page.evaluate(() => !document.getElementById("settings-pop").hidden);
      if (!open) throw new Error("settings popover did not open");
      await page.keyboard.press("Escape");
      const closed = await page.evaluate(() => document.getElementById("settings-pop").hidden);
      if (!closed) throw new Error("settings popover did not close on Escape");
    }],
    ["popups show no pair pickers", async () => {
      for (const id of ["#tools-nav-swap", "#tools-nav-lo", "#tools-nav-dca"]) {
        await page.click(id, { timeout: 5000 });
        const visible = await page.evaluate(() => Array.from(document.querySelectorAll("#form-popup-body select, #form-popup-body .isel-btn, #form-popup-body [data-open-pair-drawer], #trade-dock-body select, #trade-dock-body .isel-btn, #trade-dock-body [data-open-pair-drawer]"))
          .filter((el) => el.offsetParent !== null && /pair-select|pool-type|isel|pair-drawer/.test(el.id + " " + el.className + " " + (el.getAttribute("data-open-pair-drawer") !== null ? "pair-drawer" : ""))).map((el) => el.id || el.className));
        if (visible.length) throw new Error(`${id}: visible ${visible.join(", ")}`);
        const opened = await page.evaluate(() => document.querySelectorAll("#form-popup-body select, #trade-dock-body select").length);
        if (!opened) throw new Error(`${id}: popup did not open`);
        await page.keyboard.press("Escape");
      }
    }],
    ["My Limit Orders / My DCA Plans hidden without a wallet", async () => {
      const shown = await page.evaluate(() => ["lo-list-container", "dca-list-container"].filter((id) => document.getElementById(id)?.offsetParent !== null));
      if (shown.length) throw new Error(`visible without wallet: ${shown.join(", ")}`);
      const onWithWallet = await page.evaluate(() => {
        document.documentElement.dataset.wallet = "1";
        const v = ["lo-list-container", "dca-list-container"].every((id) => document.getElementById(id)?.offsetParent !== null);
        delete document.documentElement.dataset.wallet;
        return v;
      });
      if (!onWithWallet) throw new Error("lists stay hidden even with a wallet connected");
    }],
    ["SWDMM v2 tab: pools, create form (with fee chart), governance render", async () => {
      await page.click('.tab-nav-btn[data-tab="v2"]', { timeout: 5000 });
      await page.click('[data-v2-view="create"]', { timeout: 5000 });
      await page.click('#v2c-mode button[data-val="1"]', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector("#v2c-fee-chart svg path") && document.querySelector("#v2c-range-chart svg"), null, { timeout: 5000 });
      await page.click('[data-v2-view="gov"]', { timeout: 5000 });
      await page.click('[data-v2-view="pools"]', { timeout: 5000 });
    }],
    ["open Portfolio tab", () => page.click('.tab-nav-btn[data-tab="portfolio"]', { timeout: 5000 })],
    ["switch language to Thai", async () => { await page.click("#settings-btn"); await page.selectOption("#lang-select", "th"); await page.keyboard.press("Escape"); }],
    ["switch network to Devnet", () => page.selectOption("#network-select", "devnet")],
    ["switch network back to Localnet", () => page.selectOption("#network-select", "localnet")],
  ];
  for (const [name, run] of steps) {
    const before = errors.length;
    try { await run(); } catch (e) { failures.push(`step "${name}" could not run: ${e.message.split("\n")[0]}`); }
    await page.waitForTimeout(400);
    console.log(`${errors.length > before ? "✗" : "✓"} ${name}`);
  }

  for (const e of errors) failures.push(`page error: ${e}`);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error(`\nSMOKE TEST FAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nsmoke test passed");
