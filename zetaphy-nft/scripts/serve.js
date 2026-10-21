// Local server: node scripts/serve.js [port]
// Serves web/ with the same security headers as web/vercel.json, so local runs
// and the browser test see the real CSP. Only files under web/ with a known type.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
const headers = Object.fromEntries(vercel.headers[0].headers.filter((h) => h.key !== 'Strict-Transport-Security').map((h) => [h.key, h.value]));
const port = Number(process.argv[2] ?? 8091);

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = path === '/' ? 'index.html' : path.slice(1);
  const file = normalize(join(ROOT, rel));
  const type = TYPES[extname(file)];
  if (!file.startsWith(ROOT) || !type || rel === 'vercel.json' || rel.split(sep).some((p) => p.startsWith('.'))) { res.writeHead(404, headers).end('not found'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'content-type': type, 'cache-control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404, headers).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`ZETAPHY NFT on http://localhost:${port}/`));
