// Browser test: the visitor counter (count.js) and the "Don't count this device" page (count.html), under the
// hub's CSP. count.js never loads the analytics script off the production site or on an opted-out device;
// count.html toggles the opt-out and renders in 8 languages at phone width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { build } from '../build.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.CHROMIUM_PATH || undefined;
const vercel = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8'));
const CSP = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;

test('count.html toggles the opt-out in 8 languages; count.js stays off outside production', { timeout: 60_000 }, async () => {
  const dist = build();
  const site = await serve(dist, { headers: { 'Content-Security-Policy': CSP } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const page = await (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage();
    const errors = [];
    const insights = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', (r) => { if (r.url().includes('/_vercel/insights')) insights.push(r.url()); });

    await page.goto(`${site.url}count.html`);
    await page.waitForFunction(() => document.getElementById('toggle').textContent.length > 0);
    assert.equal(await page.textContent('#toggle'), "Don't count this device");
    await page.click('#toggle');
    assert.equal(await page.evaluate(() => localStorage.getItem('zp-nocount')), '1');
    assert.equal(await page.textContent('#state'), 'This device is NOT counted.');
    for (const l of ['zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th']) {
      await page.selectOption('#lang', l);
      for (const el of await page.$$('[data-t], #state, #toggle')) assert.ok((await el.textContent()).trim().length > 0, `${l}: empty text`);
    }
    assert.equal(await page.textContent('#toggle'), 'กลับมานับเครื่องนี้');
    await page.click('#toggle');
    assert.equal(await page.evaluate(() => localStorage.getItem('zp-nocount')), null);
    assert.equal(await page.textContent('#state'), 'เครื่องนี้ถูกนับอยู่');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll at phone width');

    await page.goto(site.url); // localhost: not the production site, so nothing is counted
    await page.waitForLoadState('load');
    assert.equal(await page.evaluate(() => !!document.querySelector('script[src="count.js"]')), true);
    assert.deepEqual(insights, []);
    assert.deepEqual(errors.filter((e) => !/Failed to load resource|ERR_|favicon/.test(e)), []);
  } finally {
    await browser.close();
    await site.close();
  }
});
