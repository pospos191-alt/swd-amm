// Syntax check for test-ui/index.html (added 2026-09-25): pulls every inline
// <script> out of the page and runs `node --check` on it, so a typo in the
// ~1.3 MB module script fails CI in seconds instead of in a browser.
// Usage: node test-ui/tests/check-syntax.mjs [path/to/index.html]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(process.argv[2] || path.join(here, "..", "index.html"));
const html = fs.readFileSync(htmlPath, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swd-ui-check-"));

let checked = 0, failed = 0;
for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
  const [, attrs, body] = m;
  if (/\bsrc=/.test(attrs) || !body.trim()) continue;
  const isModule = /type=["']module["']/.test(attrs);
  const file = path.join(tmp, `inline-${checked}.${isModule ? "mjs" : "cjs"}`);
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  checked++;
  if (r.status !== 0) {
    failed++;
    console.error(`✗ inline script #${checked} (${isModule ? "module" : "classic"}):\n${r.stderr}`);
  } else {
    console.log(`✓ inline script #${checked} (${isModule ? "module" : "classic"}, ${body.length} chars)`);
  }
}
if (!checked) { console.error("no inline <script> found — wrong file?"); process.exit(1); }
if (failed) process.exit(1);
console.log(`syntax OK (${checked} inline scripts)`);
