// Local static server for the web page: node scripts/serve.js [port]
// Serves the package folder so web/index.html can import ../src/*.js.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };
const port = Number(process.argv[2] ?? 8080);

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // The page links ./app.js and ../src/*, so it must be served from /web/.
  if (path === '/' || path === '/web') {
    res.writeHead(302, { location: '/web/' + new URL(req.url, 'http://x').search }).end();
    return;
  }
  if (path === '/web/') path = '/web/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || !(path.startsWith('/web/') || path.startsWith('/src/'))) {
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
