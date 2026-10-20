// Turns findings into plain language. Template-based, so explaining costs
// $0 and gives the same words every time. One file per language in
// src/lang/; a key a language lacks falls back to English.

import * as th from './lang/th.js';
import * as en from './lang/en.js';
import * as zh from './lang/zh.js';
import * as ja from './lang/ja.js';
import * as ko from './lang/ko.js';
import * as vi from './lang/vi.js';
import * as id from './lang/id.js';

/** Languages in menu order: code -> { NAME, LEVEL, UI, T }. */
export const LANGS = { th, en, zh, ja, ko, vi, id };

// What the token is comes first, then the most serious findings, the caveat last.
const IDENTITY = new Set([
  'no-code', 'erc20', 'not-erc20',
  'sol-token', 'sol-not-found', 'sol-not-token',
  'sui-coin', 'sui-not-found', 'sui-not-coin', 'sui-package',
  'apt-token', 'apt-not-found', 'apt-not-token', 'apt-package',
  'ton-jetton', 'ton-not-found', 'ton-not-jetton',
  'cw20-token', 'cw-contract', 'cw-not-found', 'tf-token', 'eip7702',
]);
const CAVEAT = new Set(['bytecode-only', 'sol-caveat', 'move-caveat', 'ton-caveat', 'cw-caveat']);
const ORDER = { high: 0, medium: 1, low: 2, good: 3, info: 4 };
// Who issued it (or that it copies someone) belongs right under what it is.
const ISSUER = new Set(['known-issuer', 'lookalike']);
const rank = (f) => (IDENTITY.has(f.id) ? -2 : ISSUER.has(f.id) ? -1 : CAVEAT.has(f.id) ? 9 : ORDER[f.severity] ?? 5);

/** Picks a supported language code ('th' if unknown). */
export const pickLang = (lang) => (LANGS[lang] ? lang : 'th');

/** UI strings for a language, with English filling any gap. */
export function uiText(lang) {
  const L = LANGS[pickLang(lang)].UI;
  return { ...en.UI, ...L, m: { ...en.UI.m, ...L.m } };
}

/** Report -> { title, level, lines: [{id, severity, text}] } in the chosen language. */
export function explain(report, lang = 'th') {
  const L = LANGS[pickLang(lang)];
  const sorted = [...report.analysis.findings].sort((a, b) => rank(a) - rank(b));
  const lines = sorted.map((f) => {
    const fn = L.T[f.id] ?? en.T[f.id] ?? (() => f.id);
    return { id: f.id, severity: f.severity, text: fn(f.params ?? {}) };
  });
  const level = report.analysis.level;
  return { title: L.LEVEL[level] ?? en.LEVEL[level], level, lines };
}
