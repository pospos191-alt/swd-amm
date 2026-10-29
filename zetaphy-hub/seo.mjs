#!/usr/bin/env node
// Search engines: the "What is ZETAPHY?" pages (8 languages), robots.txt, sitemap.xml and the IndexNow key for
// every ZETAPHY site. One source for all of them:
//   build.mjs                -> the hub's (dist/about/, dist/robots.txt, dist/sitemap.xml, dist/<key>.txt)
//   node seo.mjs --write     -> the other sites' robots.txt, sitemap.xml and key file (committed; a test checks them)
//   node seo.mjs --indexnow  -> tells Bing, Yandex, Seznam and Naver (IndexNow) about every page, after a deploy
// Google reads sitemap.xml through robots.txt; Search Console speeds it up (zetaphy-hub/README.md).
import { writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABOUT } from './about-content.mjs';
import { LANG_CODES } from './i18n.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const ORIGIN = {
  hub: 'https://app.sawasdeecoin.com',
  neuro: 'https://neuro.sawasdeecoin.com',
  swap: 'https://swap.sawasdeecoin.com',
  wallet: 'https://wallet.sawasdeecoin.com',
  nft: 'https://nft.sawasdeecoin.com',
  explorer: 'https://explorer.sawasdeecoin.com',
};
export const REPO_URL = 'https://github.com/pospos191-alt/swd-amm';
// IndexNow (indexnow.org): a public key; the file <key>.txt on each site proves the site is ours. Not a secret.
export const INDEXNOW_KEY = '064679038019a2fde97fc74c5983f6aa';

/** Static sites other than the hub: folder served at the site's root, and its pages. */
export const SITES = {
  neuro: { dir: 'zetaphy-neuro', pages: ['/web/', '/web/stats.html'] },
  swap: { dir: 'zetaphy-dex/web', pages: ['/'] },
  wallet: { dir: 'zetaphy-wallet', pages: ['/'] },
  nft: { dir: 'zetaphy-nft/web', pages: ['/'] },
  explorer: { dir: 'zetaphy-explorer', pages: ['/'] },
};

/** about/ path of a language: English at about/, the others at about/<lang>.html. */
export const aboutPath = (lang) => (lang === 'en' ? '/about/' : `/about/${lang}.html`);
export const HUB_PAGES = ['/', ...LANG_CODES.map(aboutPath), '/validators.html', '/forecasts.html'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

// Line icons (24×24, currentColor) for the about pages' cards and diagrams.
const ICON = {
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5h-4a1.5 1.5 0 0 0 0 3h3a1.5 1.5 0 0 1 0 3h-4M12 7.5V9M12 15.5V17"/>',
  flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-1.5-2-1.5-3C7.5 10 6 12.5 6 15a6 6 0 0 0 6 6z"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 15h9"/>',
  grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  image: '<path d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4"/><circle cx="15.5" cy="9" r="1.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  server: '<path d="M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 3.5 5 3.5 8s-1 5.5-3.5 8c-2.5-2.5-3.5-5-3.5-8s1-5.5 3.5-8z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
  graph: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  chart: '<path d="M4 20h16M7 16v-4M12 16V8M17 16V9"/>',
  spark: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  paste: '<path d="M9 3h6v3H9zM7 4.5H5V21h14V4.5h-2M8 11h8M8 15h5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};
const icon = (k, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
// per section, per item (same order in every language; a test checks the counts)
export const ITEM_ICONS = [['coin', 'flame', 'clock', 'flask'], ['grid', 'key', 'swap', 'image', 'search', 'server'], ['globe', 'chat', 'play', 'graph', 'chart', 'spark', 'shield', 'eye']];
const FLOW_ICONS = ['paste', 'search', 'play', 'shield'];

/** Three blocks in a row, each with its transactions and its post-quantum certificate. */
const blockFigure = (b) => `<figure class="chainfig">
<div class="blocks" role="img" aria-label="${esc(`${b.label}: ${b.tx}; ${b.cert}, ${b.sig}`)}">
${['N', 'N+1', 'N+2'].map((n) => `<div class="blk"><div class="blk-h">#${n}</div><div class="blk-r">${icon('list')}<span>${esc(b.tx)}</span></div><div class="blk-r pq">${icon('shield')}<span>${esc(b.cert)}</span></div></div>`).join('<span class="link" aria-hidden="true"></span>')}
</div>
<figcaption>${esc(b.label)}: ${esc(b.cert)}, ${esc(b.sig)}</figcaption>
</figure>`;

/** Neuro's four steps. */
const flowFigure = (f) => `<figure class="flowfig">
<figcaption>${esc(f.h)}</figcaption>
<ol class="flow">
${f.steps.map((t, i) => `<li><span class="n">${i + 1}</span>${icon(FLOW_ICONS[i], 'ic big')}<span>${esc(t)}</span></li>`).join('\n')}
</ol>
</figure>`;

export const robotsTxt = (origin) => `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;

/** sitemap.xml; `alternates`: {path: [[hreflang, path], …]} for pages in several languages. */
export function sitemapXml(origin, pages, alternates = {}) {
  const url = (p) => {
    const alt = (alternates[p] ?? []).map(([l, q]) => `\n    <xhtml:link rel="alternate" hreflang="${l}" href="${origin}${q}"/>`).join('');
    return `  <url>\n    <loc>${origin}${p}</loc>${alt}\n  </url>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${pages.map(url).join('\n')}\n</urlset>\n`;
}

const aboutAlternates = () => [...LANG_CODES.map((l) => [l, aboutPath(l)]), ['x-default', aboutPath('en')]];
export const hubSitemap = () => sitemapXml(ORIGIN.hub, HUB_PAGES, Object.fromEntries(LANG_CODES.map((l) => [aboutPath(l), aboutAlternates()])));

/** A feature card: icon, name (the text before ": ") and what it does. */
const card = (text, ic) => {
  const i = text.indexOf(': ');
  const [name, rest] = i > 0 && i < 40 ? [text.slice(0, i), text.slice(i + 2)] : ['', text];
  return `<li>${icon(ic)}<div>${name ? `<b>${esc(name)}</b>` : ''}<span>${esc(rest)}</span></div></li>`;
};

/** One "What is ZETAPHY?" page: static HTML, no script (the JSON-LD block is data). */
export function aboutPage(lang) {
  const c = ABOUT[lang];
  const self = `${ORIGIN.hub}${aboutPath(lang)}`;
  const href = (l) => (l === 'en' ? './' : `./${l}.html`);
  const names = { en: 'English', th: 'ไทย', zh: '中文', es: 'Español', ko: '한국어', ja: '日本語', ru: 'Русский', vi: 'Tiếng Việt' };
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${ORIGIN.hub}/#site`, name: 'ZETAPHY', url: `${ORIGIN.hub}/` },
      { '@type': 'WebPage', name: c.title, description: c.description, url: self, inLanguage: lang, isPartOf: { '@id': `${ORIGIN.hub}/#site` } },
      { '@type': 'SoftwareApplication', name: 'Neuro ZETAPHY', applicationCategory: 'SecurityApplication', operatingSystem: 'Web',
        url: `${ORIGIN.neuro}/web/`, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
      { '@type': 'SoftwareSourceCode', name: 'ZETAPHY', codeRepository: REPO_URL },
    ],
  };
  const figure = [blockFigure(c.block), null, flowFigure(c.flow)];
  const sections = c.sections.map((s, n) => `<section>
<h2>${esc(s.h)}</h2>
${s.p ? `<p>${esc(s.p)}</p>\n` : ''}${figure[n] ? `${figure[n]}\n` : ''}${s.items ? `<ul class="cards">\n${s.items.map((t, k) => card(t, ITEM_ICONS[n][k])).join('\n')}\n</ul>\n` : ''}${s.note ? `<p class="note">${esc(s.note)}</p>\n` : ''}${s === c.sections.at(-1) ? `<p><a href="${REPO_URL}">github.com/pospos191-alt/swd-amm</a></p>\n` : ''}</section>`).join('\n');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(c.title)}</title>
<meta name="description" content="${esc(c.description)}">
<link rel="canonical" href="${self}">
${aboutAlternates().map(([l, p]) => `<link rel="alternate" hreflang="${l}" href="${ORIGIN.hub}${p}">`).join('\n')}
<meta property="og:type" content="website">
<meta property="og:site_name" content="ZETAPHY">
<meta property="og:title" content="${esc(c.title)}">
<meta property="og:description" content="${esc(c.description)}">
<meta property="og:url" content="${self}">
<meta property="og:image" content="${ORIGIN.hub}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="./about.css">
<script type="application/ld+json">${ld(data)}</script>
</head>
<body>
<header>
<a class="brand" href="../"><img src="../logo.svg" alt="" width="32" height="32"><span>ZETAPHY</span></a>
<nav aria-label="${esc(c.langs)}">${LANG_CODES.map((l) => (l === lang ? `<b>${names[l]}</b>` : `<a href="${href(l)}" hreflang="${l}" lang="${l}">${names[l]}</a>`)).join(' ')}</nav>
</header>
<main>
<h1>${esc(c.h1)}</h1>
<p class="lead">${esc(c.lead)}</p>
<p class="cta"><a class="btn" href="../">${esc(c.open)}</a> <a class="btn alt" href="${ORIGIN.neuro}/web/">${esc(c.check)}</a></p>
${sections}
</main>
<footer><p>${esc(c.testnet)}</p></footer>
</body>
</html>
`;
}

/** {relative path: content} of the hub's search files, written into dist/ by build.mjs. */
export function hubSeoFiles() {
  return {
    ...Object.fromEntries(LANG_CODES.map((l) => [aboutPath(l).slice(1).replace(/\/$/, '/index.html'), aboutPage(l)])),
    'robots.txt': robotsTxt(ORIGIN.hub),
    'sitemap.xml': hubSitemap(),
    [`${INDEXNOW_KEY}.txt`]: INDEXNOW_KEY,
  };
}

/** {repo path: content} of the other sites' search files (committed). */
export function siteSeoFiles() {
  const out = {};
  for (const [k, s] of Object.entries(SITES)) {
    out[`${s.dir}/robots.txt`] = robotsTxt(ORIGIN[k]);
    out[`${s.dir}/sitemap.xml`] = sitemapXml(ORIGIN[k], s.pages);
    out[`${s.dir}/${INDEXNOW_KEY}.txt`] = INDEXNOW_KEY;
  }
  return out;
}

/** Every page of every site, by host, for IndexNow. */
export function allUrls() {
  return { hub: HUB_PAGES.map((p) => ORIGIN.hub + p), ...Object.fromEntries(Object.entries(SITES).map(([k, s]) => [k, s.pages.map((p) => ORIGIN[k] + p)])) };
}

async function indexNow() {
  for (const [k, urlList] of Object.entries(allUrls())) {
    const host = new URL(ORIGIN[k]).host;
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${ORIGIN[k]}/${INDEXNOW_KEY}.txt`, urlList }),
    });
    console.log(`${host}: ${res.status} (${urlList.length} pages)`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) for (const [p, c] of Object.entries(siteSeoFiles())) writeFileSync(join(ROOT, p), c);
  else if (process.argv.includes('--indexnow')) await indexNow();
  else { console.error('usage: node seo.mjs --write | --indexnow'); process.exit(2); }
}
