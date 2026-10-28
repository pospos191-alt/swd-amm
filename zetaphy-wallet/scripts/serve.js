// Local server: node scripts/serve.js [port]
// Serves the static site with the same security headers as vercel.json, so
// local runs and the browser test see the real CSP.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC = new Set(['/index.html', '/app.js', '/wallets.js', '/security.js', '/vendor/common-passwords.js', '/style.css', '/logo.svg', '/favicon.svg', '/vendor/pqwallet.js']);
const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(vercel.headers[0].headers.filter((h) => h.key !== 'Strict-Transport-Security').map((h) => [h.key, h.value]));
const port = Number(process.argv[2] ?? 8090);

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const rel = path === '/' ? '/index.html' : path;
  if (!PUBLIC.has(rel)) { res.writeHead(404, headers).end('not found'); return; }
  try {
    let body = await readFile(normalize(join(ROOT, rel)));
    // WALLET_PLACEHOLDER_CONFIG=1 (the browser test): serve index.html as a fresh
    // checkout ships it, without the node RPC and ThreatRegistry the launch writes.
    if (rel === '/index.html' && process.env.WALLET_PLACEHOLDER_CONFIG === '1') {
      body = Buffer.from(String(body).replace(/(<meta name="zetaphy-(?:rpc|threat-registry)" content=")[^"]*"/g, '$1"'));
    }
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, headers).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`ZETAPHY wallet on http://localhost:${port}/`));
