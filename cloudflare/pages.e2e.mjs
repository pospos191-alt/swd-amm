// End-to-end check of the staged sites with Cloudflare's own Pages engine
// (`wrangler pages dev`), because _headers rules do not combine the way Vercel's
// do. Run by .github/workflows/cf-pages.yml after staging:
//   WRANGLER=<path to wrangler> node cloudflare/pages.e2e.mjs <stageDir>
// <stageDir> holds one folder per site (hub, neuro, explorer are checked).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const STAGE = process.argv[2];
const WRANGLER = process.env.WRANGLER || 'wrangler';
if (!STAGE) { console.error('usage: node cloudflare/pages.e2e.mjs <stageDir>'); process.exit(2); }

async function serve(dir, port, inspector) {
  const p = spawn(WRANGLER, ['pages', 'dev', dir, '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspector)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 120; i++) {
    if (/Ready on/.test(log)) return p;
    if (p.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  p.kill();
  throw new Error(`wrangler did not start for ${dir}:\n${log.slice(-2000)}`);
}

const head = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
  await r.arrayBuffer();
  return r;
};

const procs = [];
try {
  procs.push(await serve(join(STAGE, 'hub'), 8788, 9331));
  procs.push(await serve(join(STAGE, 'neuro'), 8790, 9332));
  procs.push(await serve(join(STAGE, 'explorer'), 8789, 9333));

  // hub: the app shell
  let r = await head(8788, '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'; /);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  // hub: the ceremony gets ONLY its own CSP (wasm), never joined with the shell's
  r = await head(8788, '/ceremony');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
  assert.ok(!r.headers.get('content-security-policy').includes(','), 'one CSP only');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  r = await head(8788, '/ceremony.html');
  assert.equal(r.status, 308);
  // hub: the zk worker: its own CSP, no frame options (as on Vercel)
  r = await head(8788, '/zkid-worker.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
  // hub: /api goes to Neuro's site
  r = await head(8788, '/api/usage');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://neuro.sawasdeecoin.com/api/usage');

  // neuro: / -> /web/, and the function sources are not uploaded
  r = await head(8790, '/');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), '/web/');
  assert.equal((await head(8790, '/web/')).status, 200);
  assert.equal((await head(8790, '/api/usage.js')).status, 404);

  // explorer: per-file headers replace, never join
  r = await head(8789, '/sw.js');
  assert.equal(r.headers.get('cache-control'), 'no-cache, max-age=0');
  assert.equal(r.headers.get('service-worker-allowed'), '/');
  r = await head(8789, '/manifest.webmanifest');
  assert.equal(r.headers.get('content-type'), 'application/manifest+json');
  // unknown paths are 404 (as on Vercel), not the single-page-app fallback
  assert.equal((await head(8789, '/test/')).status, 404, 'explorer test/ is not uploaded');
  assert.equal((await head(8788, '/no-such-page')).status, 404);
  console.log('cloudflare pages e2e: ok');
} finally {
  for (const p of procs) p.kill();
}
