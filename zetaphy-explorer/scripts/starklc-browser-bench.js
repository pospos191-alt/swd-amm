#!/usr/bin/env node
// Browser benchmark of the STARK light-client verifier (vendor/starklc-lib.js)
// in Playwright's preinstalled Chromium, against verifying every ML-DSA-44
// signature of the certificate directly. Proofs are made here (node) with TEST
// keys and handed to lightclient.html (served with the real CSP by serve.js).
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node scripts/starklc-browser-bench.js [n ...]   (default 4 21 100)
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { buildSet, prove, encodeProof, statementMessage, blockStatement } from '../../zetaphy-network/src/starklc/index.js';
import { testValidators, signAll } from '../../zetaphy-network/src/starklc/fixtures.js';

const CHAIN = 'zetaphy_77390-1';
const HASH = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 255);
const b64 = (u) => Buffer.from(u).toString('base64');
const ns = process.argv.slice(2).map(Number);
if (!ns.length) ns.push(4, 21, 100);

const port = await new Promise((r) => { const sv = createServer().listen(0, '127.0.0.1', () => { const { port: p } = sv.address(); sv.close(() => r(p)); }); });
const server = spawn(process.execPath, ['scripts/serve.js', String(port)], { stdio: 'pipe', cwd: new URL('..', import.meta.url) });
await new Promise((r) => server.stdout.once('data', r));
let browser;
try { browser = await chromium.launch({ headless: true }); } catch {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
}
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/lightclient.html`);

const lines = ['| n | mode | proof size | verify (browser) |', '|---|---|---|---|'];
try {
  for (const n of ns) {
    const vals = testValidators(n);
    const set = buildSet(vals);
    const st = blockStatement(CHAIN, 1000 + n, HASH);
    const msg = statementMessage(st);
    const sigs = signAll(vals, msg);
    const proofs = ['none', 'sample', 'all'].map((mode) => ({ mode: mode === 'sample' ? 'sample-128' : mode,
      bytes: b64(encodeProof(prove({ set, statement: st, signatures: sigs, reveal: mode, sigBits: 128 }))) }));
    const direct = vals.map((v) => ({ sig: b64(sigs.get(v.address)), pk: b64(v.pubKey) }));
    const out = await page.evaluate(async ({ proofs: ps, direct: ds, msg: m, pin, chainId }) => {
      const lib = await import('/vendor/starklc-lib.js');
      const un = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const time = (fn) => { const ts = []; for (let i = 0; i < 3; i++) { const t = performance.now(); if (!fn()) throw new Error('verify failed'); ts.push(performance.now() - t); } return median(ts); };
      const res = ps.map((p) => { const b = un(p.bytes); return { mode: p.mode, size: b.length, ms: time(() => lib.verifyProof(b, { pin, chainId, minSigBits: 0 }).ok) }; });
      const msgB = un(m);
      const dd = ds.map((d) => ({ sig: un(d.sig), pk: un(d.pk) }));
      res.push({ mode: 'direct', size: dd.length * 2440, ms: time(() => dd.every((d) => lib.ml_dsa44.verify(d.sig, msgB, d.pk))) });
      return res;
    }, { proofs, direct, msg: b64(msg), pin: set.pin, chainId: CHAIN });
    for (const r of out) lines.push(`| ${n} | ${r.mode} | ${(r.size / 1024).toFixed(1)} KB | ${r.ms.toFixed(0)} ms |`);
    console.error(`n=${n} done`);
  }
  console.log(lines.join('\n'));
} finally {
  await browser.close();
  server.kill();
}
