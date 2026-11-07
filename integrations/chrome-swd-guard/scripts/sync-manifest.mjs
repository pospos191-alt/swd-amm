// Writes the bundled phishing list (data/phishing-domains.json) into the manifest's phishing content script matches.
// Run after editing the list:  node scripts/sync-manifest.mjs   (scripts/check.mjs fails if they differ)
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const G = require("../src/common.js");
const dir = new URL("..", import.meta.url);
const list = JSON.parse(readFileSync(new URL("data/phishing-domains.json", dir), "utf8"));
const m = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const cs = m.content_scripts.find((c) => c.js.includes("src/content-phish.js"));
cs.matches = G.matchPatterns(G.cleanDomainList(list));
writeFileSync(new URL("manifest.json", dir), JSON.stringify(m, null, 2) + "\n");
console.log(`manifest: ${cs.matches.length} match patterns for ${cs.matches.length / 2} domains`);
