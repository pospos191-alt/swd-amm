// The federated client really runs in a browser: Chromium loads ml/fl/*.js as
// plain ES modules (no bundler), computes a clipped + noised update with the
// browser's crypto random generator, encodes it, and hashes it with WebCrypto.
//   node --test ml/test/fl.browser.e2e.js      (part of npm run test:web)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ML = fileURLToPath(new URL('../', import.meta.url));
const PORT = 18094;
let server; let browser;

async function launch() {
  const opts = { headless: true };
  try { return await chromium.launch(opts); } catch {
    return chromium.launch({ ...opts, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  }
}

before(async () => {
  // serves ml/ only, read-only, with a strict CSP like the hub's
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (path === '' || path === 'index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self'" }).end('<!doctype html><title>fl</title>');
      return;
    }
    const file = ML + path;
    if (path.includes('..') || !existsSync(file)) { res.writeHead(404).end(); return; }
    const type = path.endsWith('.js') ? 'text/javascript' : 'application/json';
    res.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'" }).end(readFileSync(file));
  }).listen(PORT);
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('a browser computes, privatizes, encodes and hashes an update', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const out = await page.evaluate(async () => {
    const { checkModel } = await import('/model.js');
    const { checkHead, sealHead, headProbability } = await import('/fl/head.js');
    const { makeExample, clientUpdate } = await import('/fl/client.js');
    const { encodeUpdate, decodeUpdate } = await import('/fl/codec.js');
    const { PrivacyLedger, l2 } = await import('/fl/dp.js');
    const { buildManifest } = await import('/fl/registry.js');
    const model = checkModel(await (await fetch('/model.json')).json());
    const head = checkHead(model, await (await fetch('/fl/head.json')).json());
    const resealed = await sealHead(head);
    const f = model.check[0].f;
    const ex = [makeExample(model, head, f, 1)];
    const ledger = new PrivacyLedger();
    ledger.record(0, 2);
    const values = clientUpdate(model, head, ex); // crypto.getRandomValues noise
    const bytes = encodeUpdate({ headHash: head.hash, round: 0, clip: 1, z: 2, values });
    const back = decodeUpdate(bytes);
    const manifestBytes = new Uint8Array(await (await fetch('/manifest.json')).arrayBuffer());
    const mf = await buildManifest({ model, modelBytes: new Uint8Array(await (await fetch('/model.json')).arrayBuffer()), head,
      headBytes: new Uint8Array(await (await fetch('/fl/head.json')).arrayBuffer()) });
    return {
      p: headProbability(model, head, f), sameHash: resealed.hash === head.hash, len: bytes.length, dim: back.values.length,
      norm: l2(values), eps: ledger.epsilon, manifestSame: new TextDecoder().decode(manifestBytes) === mf.text,
    };
  });
  assert.deepEqual(errors, []);
  assert.ok(Math.abs(out.p - JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')).check[0].p) < 1e-6);
  assert.equal(out.sameHash, true, 'WebCrypto in the browser gives the head hash Node gave');
  assert.equal(out.manifestSame, true, 'the browser rebuilds the committed manifest byte for byte');
  assert.ok(out.norm > 1, 'noise added (norm well above the clip)');
  assert.ok(out.eps > 5 && out.eps < 5.4);
  assert.equal(out.len, 50 + 4 * out.dim);
});
