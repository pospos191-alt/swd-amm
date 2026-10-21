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
    ["open Swap (dock tab)", () => page.click('.dock-tab[data-dock-tool="swap"]', { timeout: 5000 })],
    ["close popup (Escape)", () => page.keyboard.press("Escape")],
    ["Multi-hop fills mint in/out from the active pair", async () => {
      await page.click('.dock-tab[data-dock-tool="mh"]', { timeout: 5000 });
      const v = await page.evaluate(() => [document.getElementById("mh-mint-in").value, document.getElementById("mh-mint-out").value]);
      if (v[0] !== A || v[1] !== B) throw new Error(`mint in/out = ${v.join(" / ")}`);
      await page.click("#mh-direction-flip-btn", { timeout: 5000 });
      const f = await page.evaluate(() => [document.getElementById("mh-mint-in").value, document.getElementById("mh-mint-out").value]);
      if (f[0] !== B || f[1] !== A) throw new Error(`after flip mint in/out = ${f.join(" / ")}`);
      await page.keyboard.press("Escape");
    }],
    // Swap is docked beside the chart on wide screens (build 2026-10-07c).
    ["Dock tabs switch tools in place (no popup)", async () => {
      for (const tool of ["lo", "dca", "bpf", "mh", "swap"]) {
        await page.click(`.dock-tab[data-dock-tool="${tool}"]`, { timeout: 5000 });
        const r = await page.evaluate((tool) => {
          const ids = { lo: "lo-create-btn", dca: "dca-create-btn", bpf: "bpf-find-btn", mh: "mh-swap-btn", swap: "swap-btn" };
          const btn = document.querySelector(`#trade-dock-body #${ids[tool]}`) || (tool === "swap" && document.querySelector("#trade-dock-body #dlmm-swap-btn"));
          return { docked: !!btn, popup: !document.getElementById("form-popup-overlay").hidden, active: document.querySelector(".dock-tab.active")?.dataset.dockTool };
        }, tool);
        if (!r.docked || r.popup || r.active !== tool) throw new Error(`${tool}: ${JSON.stringify(r)}`);
      }
    }],
    ["Swap form is docked beside the chart (1440px)", async () => {
      const docked = await page.evaluate(() => !document.getElementById("trade-dock").hidden && !!document.querySelector("#trade-dock-body #swap-btn, #trade-dock-body #dlmm-swap-btn"));
      if (!docked) throw new Error("no Swap form in #trade-dock-body");
      const popupOpen = await page.evaluate(() => !document.getElementById("form-popup-overlay").hidden);
      if (popupOpen) throw new Error("Swap opened a popup instead of using the dock");
    }],
    // Easy swap (build 2026-10-07d): token amounts in, raw units underneath.
    ["Swap takes token amounts (1.5 -> 1500000 raw at 6 decimals) and back", async () => {
      await page.fill("#swap-amount-in-ui", "1.5");
      await page.waitForFunction(() => document.getElementById("swap-amount-in").value === "1500000", null, { timeout: 3000 })
        .catch(() => { throw new Error("raw amount not written from the token amount"); });
      await page.evaluate(() => { document.getElementById("swap-amount-in").value = "2500000"; });
      await page.waitForFunction(() => document.getElementById("swap-amount-in-ui").value === "2.5", null, { timeout: 3000 })
        .catch(() => { throw new Error("token amount not updated when the raw amount is set (MAX / auto-route path)"); });
      await page.fill("#swap-amount-in-ui", "");
    }],
    ["Every amount field takes token amounts (Limit, DCA, Multi-hop, liquidity, ...)", async () => {
      const bad = await page.evaluate(async () => {
        const ids = ["mh-amount-in", "lo-amount-in", "dca-amount-per-run", "bpf-amount-in", "sim-amount-a", "add-amount-a", "add-min-lp", "rm-lp-amount", "rm-min-a", "dlmm-add-amount-a", "dlmm-rm-min-a"];
        const out = [];
        for (const id of ids) {
          const ui = document.getElementById(`${id}-ui`);
          if (!ui) { out.push(`${id}: no token-amount field`); continue; }
          const raw = document.getElementById(id);
          raw.value = "2500000";
          await new Promise((r) => setTimeout(r, 60));
          if (ui.value !== "2.5") out.push(`${id}: raw 2500000 shows "${ui.value}"`);
        }
        return out;
      });
      if (bad.length) throw new Error(bad.join("; "));
    }],
    ["Token picker opens from You send and closes", async () => {
      await page.click("#swap-form-content .dir-flip-side:not(.dir-flip-side-to)", { timeout: 5000 });
      const open = await page.evaluate(() => !document.getElementById("token-picker-overlay").hidden);
      if (!open) throw new Error("token picker did not open");
      await page.keyboard.press("Escape");
      const closed = await page.evaluate(() => document.getElementById("token-picker-overlay").hidden);
      if (!closed) throw new Error("token picker did not close on Escape");
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
      for (const id of ['.dock-tab[data-dock-tool="swap"]', '.dock-tab[data-dock-tool="lo"]', '.dock-tab[data-dock-tool="dca"]']) {
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
    ["Pools: SWDMM v2 filter chip; Create → SWDMM v2 opens the v2 create form", async () => {
      await page.click('.tab-nav-btn[data-tab="liquidity"]', { timeout: 5000 });
      await page.click("#lq-filter-v2", { timeout: 5000 });
      const wizardHidden = await page.evaluate(() => getComputedStyle(document.getElementById("pool-wizard-panel")).display === "none");
      if (!wizardHidden) throw new Error("create-pool wizard shows under the pool list");
      await page.click("#lq-create-btn", { timeout: 5000 });
      await page.click("#cpm-option-v2", { timeout: 5000 });
      await page.click("#cpm-continue-btn", { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector(".grid").dataset.activeTab === "v2", null, { timeout: 5000 });
      const navActive = await page.evaluate(() => document.querySelector('.tab-nav-btn[data-tab="liquidity"]').classList.contains("active"));
      if (!navActive) throw new Error("Pools nav item is not highlighted on the SWDMM v2 page");
      await page.click('#v2c-mode button[data-val="1"]', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector("#v2c-fee-chart svg path") && document.querySelector("#v2c-range-chart svg"), null, { timeout: 5000 });
      await page.click('[data-v2-view="gov"]', { timeout: 5000 });
      await page.click('[data-v2-view="pools"]', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector(".grid").dataset.activeTab === "liquidity" && document.querySelector("#lq-filter-v2.active"), null, { timeout: 5000 });
    }],
    ["DLMM add: range picker (3 modes, no Bin ID typing) + preview box", async () => {
      await page.evaluate(() => { document.querySelector('.tab-nav-btn[data-tab="portfolio"]').click(); });
      const r = await page.evaluate(() => {
        const host = document.getElementById("dlmm-add-rp");
        const adv = document.getElementById("dlmm-add-bin-lower")?.closest("details.rp-advanced");
        return { host: !!host, modes: host ? host.querySelectorAll("[data-rp-mode]").length : 0, adv: !!adv, preview: !!document.getElementById("dlmm-add-preview"), cpPreview: !!document.getElementById("add-liq-preview") };
      });
      if (!r.host || r.modes !== 3 || !r.adv || !r.preview || !r.cpPreview) throw new Error(JSON.stringify(r));
    }],
    ["Developer mode hides / shows Advanced and Dev Tools", async () => {
      const r = await page.evaluate(() => {
        const vis = () => ["amm", "dlmm", "devtools"].map((t) => getComputedStyle(document.querySelector(`.rd-more-item[data-tab="${t}"]`)).display !== "none");
        const before = vis();
        document.querySelector('.rd-more-item[data-tab="amm"]').click();
        const landed = document.querySelector(".grid").dataset.activeTab;
        const tg = document.getElementById("dev-mode-toggle"); tg.checked = true; tg.dispatchEvent(new Event("change"));
        const after = vis();
        document.querySelector('.rd-more-item[data-tab="amm"]').click();
        const landedDev = document.querySelector(".grid").dataset.activeTab;
        tg.checked = false; tg.dispatchEvent(new Event("change"));
        const back = document.querySelector(".grid").dataset.activeTab;
        return { before, landed, after, landedDev, back };
      });
      if (r.before.some(Boolean)) throw new Error("dev items visible without Developer mode");
      if (r.landed !== "tools") throw new Error(`Advanced AMM opened without Developer mode (${r.landed})`);
      if (!r.after.every(Boolean) || r.landedDev !== "amm") throw new Error("Developer mode did not unlock Advanced AMM");
      if (r.back !== "tools") throw new Error("turning Developer mode off left a dev page open");
    }],
    ["Swap page: pair bar and 4h / 1D timeframes", async () => {
      await page.click('.tab-nav-btn[data-tab="tools"]', { timeout: 5000 });
      const ok = await page.evaluate(() => !!document.querySelector("#tb-pair-bar .pb-pair") && !!document.getElementById("tb-tf-4h") && !!document.getElementById("tb-tf-1d"));
      if (!ok) throw new Error("pair bar or 4h / 1D buttons missing");
      await page.click("#tb-tf-1d", { timeout: 5000 });
      await page.click("#tb-tf-1m", { timeout: 5000 });
    }],
    ["open Portfolio tab", () => page.click('.tab-nav-btn[data-tab="portfolio"]', { timeout: 5000 })],
    ["header links to the ZETAPHY DEX site (https://swap.sawasdeecoin.com/)", async () => {
      const a = await page.evaluate(() => {
        const el = document.getElementById("rd-nav-zetaphy");
        return el && { href: el.getAttribute("href"), target: el.getAttribute("target"), rel: el.getAttribute("rel") };
      });
      if (!a) throw new Error("#rd-nav-zetaphy missing");
      if (a.href !== "https://swap.sawasdeecoin.com/") throw new Error(`#rd-nav-zetaphy href is ${a.href}`);
      if (a.target !== "_blank" || !/\bnoopener\b/.test(a.rel ?? "")) throw new Error(`#rd-nav-zetaphy target=${a.target} rel=${a.rel}`);
    }],
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
