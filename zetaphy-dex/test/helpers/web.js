// Browser-test plumbing for the DEX page (test-ui/zetaphy/): a static server
// for test-ui/ that sends the headers test-ui/vercel.json gives each path (so
// the page runs under its real CSP), and a mock EIP-6963 wallet whose requests
// are answered in Node (it signs nothing itself: the backend executes or
// sends the transaction).

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_UI = fileURLToPath(new URL('../../../test-ui/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

/** Vercel's headers for a path: every rule whose source matches, in order. */
export function vercelHeaders(path) {
  const cfg = JSON.parse(readFileSync(join(TEST_UI, 'vercel.json'), 'utf8'));
  const out = {};
  for (const rule of cfg.headers ?? []) {
    // The sources used there are plain regexes in path-to-regexp's (…) groups.
    if (new RegExp(`^${rule.source}$`).test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

/** Serves test-ui/ on 127.0.0.1; `overrides` maps a path to a body (e.g. the test's deployments.json). */
export async function serveTestUi(overrides = {}) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [k, v] of Object.entries(vercelHeaders(path))) res.setHeader(k, v);
    if (overrides[path] !== undefined) {
      res.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream');
      res.end(overrides[path]);
      return;
    }
    let file = normalize(join(TEST_UI, path));
    if (!file.startsWith(TEST_UI)) { res.statusCode = 403; res.end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Puts a mock wallet in the page: announced over EIP-6963 as "Mock Wallet"
 * (rdns test.zdex.mock). `handler(method, params)` answers in Node; throwing
 * { code, message } becomes a wallet error in the page.
 */
export async function injectWallet(page, handler) {
  await page.exposeFunction('__zdexWallet', async (method, paramsJson) => {
    try {
      return JSON.stringify({ result: await handler(method, JSON.parse(paramsJson ?? '[]')) });
    } catch (e) {
      return JSON.stringify({ error: { code: e.code ?? -32603, message: String(e.message ?? e), data: e.data } });
    }
  });
  await page.addInitScript(() => {
    const listeners = {};
    const provider = {
      async request({ method, params }) {
        const r = JSON.parse(await window.__zdexWallet(method, JSON.stringify(params ?? [])));
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
        return r.result;
      },
      on(ev, fn) { (listeners[ev] ??= []).push(fn); },
      removeListener() {},
    };
    window.__zdexEmit = (ev, v) => (listeners[ev] ?? []).forEach((f) => f(v));
    const info = { uuid: '00000000-0000-4000-8000-000000000001', name: 'Mock Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.zdex.mock' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
}

export function chromiumOptions() {
  return process.env.ZDEX_CHROMIUM ? { executablePath: process.env.ZDEX_CHROMIUM } : {};
}
