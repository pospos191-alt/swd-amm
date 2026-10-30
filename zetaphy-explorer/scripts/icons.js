// node scripts/icons.js: renders logo.svg to icon-192.png and icon-512.png (the web app
// manifest's install icons) with Playwright's Chromium. Run once when the logo changes;
// the PNGs are committed (Vercel serves the folder as it is).
import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(ROOT + 'logo.svg', 'utf8');
const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }));
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // a solid background (maskable-safe): the logo at 80 % in the middle
  await page.setContent(`<html><body style="margin:0;background:#0b0d14;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg style="width:${size * 0.8}px;height:${size * 0.8}px" `)}</body></html>`);
  await writeFile(`${ROOT}icon-${size}.png`, await page.screenshot({ omitBackground: false }));
  await page.close();
}
await browser.close();
console.log('icon-192.png, icon-512.png written');
