// Static checks before a release (no dependencies): node scripts/check.mjs
//  - manifest: MV3, only the expected permissions, every referenced file exists, phishing matches = bundled list
//  - locales: all 8 present with the same keys; every key used in code / HTML exists
//  - safety: no remote scripts, no eval / new Function / innerHTML / outerHTML / insertAdjacentHTML / document.write
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const G = require("../src/common.js");
const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(root + p, "utf8");
const fail = [];
const ok = (cond, msg) => cond || fail.push(msg);

const m = JSON.parse(read("manifest.json"));
ok(m.manifest_version === 3, "manifest_version must be 3");
ok(JSON.stringify(m.permissions.sort()) === JSON.stringify(["activeTab", "alarms", "scripting", "storage"]), `unexpected permissions: ${m.permissions}`);
ok(JSON.stringify(m.host_permissions) === JSON.stringify(["https://swd-zetaphy.sawasdeecoin.com/*"]), "host_permissions must be the SWD API only");
const files = [m.background.service_worker, m.action.default_popup, m.options_page, ...Object.values(m.icons), ...m.content_scripts.flatMap((c) => c.js)];
for (const f of files) ok(existsSync(root + f), `missing file ${f}`);
const list = JSON.parse(read("data/phishing-domains.json"));
const phish = m.content_scripts.find((c) => c.js.includes("src/content-phish.js"));
ok(JSON.stringify(phish.matches) === JSON.stringify(G.matchPatterns(G.cleanDomainList(list))), "phishing matches differ from data/phishing-domains.json: run node scripts/sync-manifest.mjs");
ok(G.cleanDomainList(list).length === list.domains.length, "data/phishing-domains.json has an invalid or duplicate domain");

const LOCALES = ["en", "th", "zh_CN", "ja", "ko", "vi", "es", "ru"];
const msgs = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]));
ok(JSON.stringify(readdirSync(root + "_locales").sort()) === JSON.stringify([...LOCALES].sort()), "unexpected _locales folders");
const keys = Object.keys(msgs.en).sort().join();
for (const l of LOCALES) {
  ok(Object.keys(msgs[l]).sort().join() === keys, `${l}: keys differ from en`);
  for (const [k, v] of Object.entries(msgs[l])) ok(typeof v.message === "string" && v.message.trim(), `${l}.${k} is empty`);
  ok(msgs[l].extDescription.message.length <= 132, `${l}: extDescription longer than 132`);
}

const src = readdirSync(root + "src").map((f) => "src/" + f);
const used = new Set();
for (const f of src) {
  const s = read(f);
  for (const x of s.matchAll(/\bt\("([A-Za-z0-9_]+)"/g)) if (x[1] !== "level_") used.add(x[1]);
  for (const x of s.matchAll(/data-i18n(?:-placeholder)?="([A-Za-z0-9_]+)"/g)) used.add(x[1]);
  for (const x of s.matchAll(/"(opt[A-Za-z]+AllSites)"/g)) used.add(x[1]);
  if (f.endsWith(".js")) {
    ok(!/\beval\s*\(|new\s+Function\s*\(|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/.test(s), `${f}: unsafe DOM / code construct`);
  }
  if (f.endsWith(".html")) ok(!/<script[^>]+src=["']https?:/i.test(s) && !/<script>(?!\s*<\/script>)/i.test(s), `${f}: remote or inline script`);
}
for (const l of ["high", "medium", "low", "info"]) used.add("level_" + l);
for (const k of used) ok(msgs.en[k], `message key "${k}" is used but not defined`);
for (const k of Object.keys(msgs.en)) ok(used.has(k) || ["extName", "extDescription"].includes(k), `message key "${k}" is never used`);
for (const s of [...(read("src/background.js").match(/https?:\/\/[^"'`\s)]+/g) || [])]) ok(/^(https?:\/\/\*\/\*|https:\/\/(swd-zetaphy\.sawasdeecoin\.com|raw\.githubusercontent\.com\/pospos191-alt\/zetaphy\/))/.test(s), `background.js: unexpected URL ${s}`);

if (fail.length) {
  console.error("check failed:\n - " + fail.join("\n - "));
  process.exit(1);
}
console.log(`check ok: ${files.length} files, ${LOCALES.length} locales × ${Object.keys(msgs.en).length} messages, ${list.domains.length} bundled phishing domains`);
