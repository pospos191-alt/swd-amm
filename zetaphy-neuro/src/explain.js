// Turns findings into plain language. Template-based, so explaining costs
// $0 and gives the same words every time. One file per language in
// src/lang/; a key a language lacks falls back to English.

import * as en from './lang/en.js';
import * as zh from './lang/zh.js';
import * as es from './lang/es.js';
import * as ko from './lang/ko.js';
import * as ja from './lang/ja.js';
import * as ru from './lang/ru.js';
import * as vi from './lang/vi.js';
import * as th from './lang/th.js';
import * as id from './lang/id.js';

/** Languages in menu order: code -> { NAME, LEVEL, UI, T }. */
export const LANGS = { en, zh, es, ko, ja, ru, vi, th, id };

// What the token is comes first, then the most serious findings, the caveat last.
const IDENTITY = new Set([
  'no-code', 'erc20', 'not-erc20',
  'sol-token', 'sol-not-found', 'sol-not-token',
  'sui-coin', 'sui-not-found', 'sui-not-coin', 'sui-package',
  'apt-token', 'apt-not-found', 'apt-not-token', 'apt-package',
  'ton-jetton', 'ton-not-found', 'ton-not-jetton',
  'cw20-token', 'cw-contract', 'cw-not-found', 'tf-token', 'eip7702',
  'btc-rune', 'btc-not-found', 'stylus-read',
  'near-token', 'near-contract', 'near-not-found', 'near-no-contract',
  'sn-token', 'sn-contract', 'sn-not-found',
]);
// Findings that show a name, symbol or label taken from the chain.
const NAMED = new Set(['erc20', 'sol-token', 'sui-coin', 'apt-token', 'ton-jetton', 'cw20-token', 'cw-contract', 'tf-token', 'btc-rune', 'near-token', 'sn-token', 'sol-idl']);
const CAVEAT = new Set(['bytecode-only', 'sol-caveat', 'move-caveat', 'ton-caveat', 'cw-caveat', 'near-caveat', 'sn-caveat', 'btc-caveat']);
const ORDER = { high: 0, medium: 1, low: 2, good: 3, info: 4 };
// Who issued it (or that it copies someone) belongs right under what it is.
const ISSUER = new Set(['known-issuer', 'lookalike']);
// Resemblance is softer evidence than a direct finding: after those of the same severity.
const SOFTER = new Set(['similar-flagged', 'similar-reference']);
const rank = (f) => (IDENTITY.has(f.id) ? -2 : ISSUER.has(f.id) ? -1 : CAVEAT.has(f.id) ? 9 : (ORDER[f.severity] ?? 5) + (SOFTER.has(f.id) ? 0.5 : 0));

/** Picks a supported language code ('en' if unknown). */
export const pickLang = (lang) => (LANGS[lang] ? lang : 'en');

/** UI strings for a language, with English filling any gap. */
export function uiText(lang) {
  const L = LANGS[pickLang(lang)].UI;
  return { ...en.UI, ...L, m: { ...en.UI.m, ...L.m } };
}

/** Report -> { title, level, lines: [{id, severity, text}] } in the chosen language.
 * Wording only: the finding ids and severities (what verdict.js hashes) are untouched. */
export function explain(report, lang = 'en') {
  const L = LANGS[pickLang(lang)];
  const sorted = [...report.analysis.findings].sort((a, b) => rank(a) - rank(b));
  const ui = uiText(lang);
  const lines = sorted.map((f) => {
    const fn = L.T[f.id] ?? en.T[f.id] ?? (() => f.id);
    const p = f.params ?? {};
    let text = fn(p);
    // Names and symbols are written by whoever deployed the contract: say so,
    // so they never read as Neuro's own claim.
    if (NAMED.has(f.id) && (p.name || p.symbol || p.label)) text += ` ${ui.asWritten}`;
    return { id: f.id, severity: f.severity, text };
  });
  const level = report.analysis.level;
  return { title: L.LEVEL[level] ?? en.LEVEL[level], level, lines };
}

/** A transaction report's path (src/tx.js) as lines in the chosen language. */
export function explainPath(report, lang = 'en') {
  if (!report.path?.length) return [];
  const L = LANGS[pickLang(lang)];
  const KINDS = ['call', 'create', 'token', 'nft', 'approve', 'approveAll'];
  const text = (id, p) => (Object.hasOwn(L.T, id) ? L.T[id] : en.T[id])(p);
  return [...report.path.filter((e) => KINDS.includes(e.kind)).map((e) => text(`path-${e.kind}`, e)), text('path-note', {})];
}
