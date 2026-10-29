// Local server: node scripts/serve.js [port]
// Serves the static site with the same security headers as vercel.json (CSP
// included), so local runs and the browser tests see the real policy.
// EXPLORER_CONFIG=/path/to/config.json serves that file as /config.json.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PUBLIC = /^\/(index\.html|style\.css|favicon\.svg|config\.json|src\/[a-z0-9-]+\.js|src\/wallet-safety\.css|vendor\/zetaphy-lib\.js)$/;
const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
const csp = vercel.headers[0].headers.filter((h) => h.key !== 'Strict-Transport-Security')
  // upgrade-insecure-requests would turn http://localhost into https:// here
  .map((h) => (h.key === 'Content-Security-Policy' ? { ...h, value: h.value.replace(/;\s*upgrade-insecure-requests/, '') } : h));
const headers = Object.fromEntries(csp.map((h) => [h.key, h.value]));
const port = Number(process.argv[2] ?? 8095);

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rel = path === '/' ? '/index.html' : path;
  if (!PUBLIC.test(rel)) { res.writeHead(404, headers).end('not found'); return; }
  try {
    const file = rel === '/config.json' && process.env.EXPLORER_CONFIG ? process.env.EXPLORER_CONFIG : normalize(join(ROOT, rel));
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404, headers).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`ZETAPHY explorer on http://localhost:${port}/`));
