// Search engines: "What is ZETAPHY?" pages, robots.txt, sitemap.xml, IndexNow key, share tags (seo.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';
import { ABOUT } from '../about-content.mjs';
import { LANG_CODES } from '../i18n.js';
import { ORIGIN, SITES, INDEXNOW_KEY, ITEM_ICONS, aboutPath, aboutPage, siteSeoFiles, allUrls } from '../seo.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(HERE, '..');

test('"What is ZETAPHY?" in all 8 languages, with the same sections and items as English', () => {
  assert.deepEqual(Object.keys(ABOUT).sort(), [...LANG_CODES].sort());
  const shape = (c) => c.sections.map((s) => [Boolean(s.p), s.items?.length ?? 0, Boolean(s.note)]);
  for (const l of LANG_CODES) {
    const c = ABOUT[l];
    for (const k of ['title', 'description', 'h1', 'lead', 'open', 'check', 'langs', 'testnet']) assert.ok(c[k]?.trim(), `${l}.${k}`);
    assert.deepEqual(shape(c), shape(ABOUT.en), l);
    c.sections.forEach((s, n) => assert.equal(s.items?.length ?? 0, ITEM_ICONS[n]?.length ?? 0, `${l}: one icon per card in section ${n}`));
    assert.equal(c.flow.steps.length, 4, `${l}: Neuro's four steps`);
    for (const k of ['label', 'tx', 'cert', 'sig']) assert.ok(c.block[k]?.trim(), `${l}.block.${k}`);
    assert.ok(c.description.length <= 200, `${l}: description fits a search result`);
    assert.doesNotMatch(JSON.stringify(c), /SAWASDEE COIN|guarantee|profit/i, l);
  }
});

test('about pages: static, canonical, every language linked, structured data parses', () => {
  for (const l of LANG_CODES) {
    const html = aboutPage(l);
    assert.match(html, new RegExp(`<html lang="${l}">`));
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN.hub}${aboutPath(l)}">`), l);
    for (const m of [...LANG_CODES, 'x-default']) assert.match(html, new RegExp(`hreflang="${m}" href="https://`), `${l} -> ${m}`);
    // one script element, the JSON-LD data block (split on its fixed start and end; no HTML parsing by regex)
    assert.equal(html.split('<script').length, 2, 'no script but the JSON-LD block');
    const open = '<script type="application/ld+json">';
    assert.ok(html.includes(open));
    const data = JSON.parse(html.split(open)[1].split('</script>')[0]);
    assert.ok(data['@graph'].some((n) => n['@type'] === 'SoftwareApplication' && n.offers.price === '0'));
    assert.doesNotMatch(html, /\sstyle="|\son[a-z]+="/, 'nothing the hub CSP would block');
    assert.ok(html.includes(ABOUT[l].testnet), 'testnet notice');
  }
});

test('hub dist/: about pages, robots.txt, sitemap.xml, IndexNow key, share image; app copies carry none of these', () => {
  const out = build();
  for (const l of LANG_CODES) assert.ok(existsSync(join(out, aboutPath(l).slice(1).replace(/\/$/, '/index.html'))), l);
  for (const f of ['about/about.css', 'og.png']) assert.ok(existsSync(join(out, f)), f);
  assert.equal(readFileSync(join(out, 'robots.txt'), 'utf8'), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN.hub}/sitemap.xml\n`);
  assert.equal(readFileSync(join(out, `${INDEXNOW_KEY}.txt`), 'utf8'), INDEXNOW_KEY);
  const sm = readFileSync(join(out, 'sitemap.xml'), 'utf8');
  for (const u of allUrls().hub) assert.ok(sm.includes(`<loc>${u}</loc>`), u);
  for (const p of ['wallet/robots.txt', 'swap/sitemap.xml', `explorer/${INDEXNOW_KEY}.txt`]) assert.ok(!existsSync(join(out, p)), `not in the hub: ${p}`);
});

test('the other sites: committed robots.txt, sitemap.xml and key match seo.mjs (node seo.mjs --write)', () => {
  for (const [p, c] of Object.entries(siteSeoFiles())) assert.equal(readFileSync(join(ROOT, p), 'utf8'), c, p);
});

test('every home page: description, canonical on its own domain, share card with an image that exists', () => {
  const pages = { hub: ['zetaphy-hub', '/', 'og.png'], neuro: ['zetaphy-neuro', '/web/', 'web/og.png'], ...Object.fromEntries(['swap', 'wallet', 'nft', 'explorer'].map((k) => [k, [SITES[k].dir, '/', 'og.png']])) };
  for (const [k, [dir, path, img]] of Object.entries(pages)) {
    const html = readFileSync(join(ROOT, dir, path === '/web/' ? 'web/index.html' : 'index.html'), 'utf8');
    assert.equal(html.match(/<meta name="description"/g)?.length, 1, `${k}: one description`);
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN[k]}${path}">`), `${k}: canonical`);
    assert.ok(html.includes(`<meta property="og:image" content="${ORIGIN[k]}/${img}">`), `${k}: og:image`);
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'), k);
    assert.ok(existsSync(join(ROOT, dir, img)), `${k}: ${img}`);
  }
});
