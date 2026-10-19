// Local server for the web page: node scripts/serve.js [port]
// Serves web/ and src/ (the page imports ../src/*.js) and a local
// /api/usage backed by memory, so the whole page works without Vercel.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUsage, memoryStore } from '../server/usage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };
const port = Number(process.argv[2] ?? 8080);
const store = memoryStore();
const DEV_SECRET = 'local-dev-secret-not-for-production';

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 4096) throw new Error('body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);

  if (path === '/api/usage') {
    try {
      const out = await handleUsage({
        method: req.method,
        query: Object.fromEntries(url.searchParams),
        body: req.method === 'POST' ? await readBody(req) : undefined,
        ip: req.socket.remoteAddress,
        ua: String(req.headers['user-agent'] ?? ''),
        origin: req.headers.origin,
        host: req.headers.host,
      }, store, DEV_SECRET);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) }).end(JSON.stringify(out.json ?? {}));
    } catch {
      res.writeHead(400).end();
    }
    return;
  }

  // The page links ./app.js and ../src/*, so it must be served from /web/.
  if (path === '/' || path === '/web') {
    res.writeHead(302, { location: '/web/' + url.search }).end();
    return;
  }
  const rel = path === '/web/' ? '/web/index.html' : path;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT) || !(rel.startsWith('/web/') || rel.startsWith('/src/'))) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`Neuro ZETAPHY: http://localhost:${port}/`));
