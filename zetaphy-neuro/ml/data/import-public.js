#!/usr/bin/env node
// Imports free, permissively licensed public labelled lists and turns them
// into training rows by reading each contract with Neuro itself (read-only,
// free public RPCs). Every source records where it came from and its licence;
// a source whose licence text is not a permissive one we recognise is skipped.
//
//   node ml/data/import-public.js [--max 200] [--no-rpc] [--out ml/data/out/public.jsonl]
//
// --no-rpc (or an RPC that cannot be reached) still downloads and checks the
// lists and writes the manifest, but produces no rows: features need the code.
//
// Sources considered and NOT used (no licence file = all rights reserved, or
// copyleft): christoftorres/HoneyBadger (honeypot list; no LICENSE),
// CRPWarner/RugPull (rug-pull list; no LICENSE), Uniswap/default-token-list
// (GPL-3.0). Add a source only after reading its licence.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readRows } from '../lib/live.js';

const RAW = 'https://raw.githubusercontent.com';
export const SOURCES = [
  {
    key: 'forta-malicious',
    repo: 'forta-network/labelled-datasets',
    url: `${RAW}/forta-network/labelled-datasets/main/labels/1/malicious_smart_contracts.csv`,
    licenseUrl: `${RAW}/forta-network/labelled-datasets/main/LICENSE`,
    expectLicense: 'MIT',
    chain: 'eth',
    label: 1,
    weight: 0.5,
    note: 'Ethereum contracts tagged exploit / heist / phish-hack on Etherscan (via Luabase). Attack contracts, not tokens: they teach "malicious contract", not "rug token".',
    parse: (text) => csvColumn(text, 'contract_address'),
  },
  {
    key: 'ethereum-lists-tokens',
    repo: 'ethereum-lists/tokens',
    // One JSON file per token; the GitHub contents API lists them (no key, 60 requests/hour is plenty).
    url: 'https://api.github.com/repos/ethereum-lists/tokens/contents/tokens/eth',
    licenseUrl: `${RAW}/ethereum-lists/tokens/master/LICENSE`,
    expectLicense: 'MIT',
    chain: 'eth',
    label: 0,
    weight: 0.5,
    note: 'Community-curated Ethereum token list. Listed is not proof of safe: a weak benign label.',
    parse: (text) => JSON.parse(text).map((e) => e.name?.replace(/\.json$/, '')).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? '')),
  },
];

const PERMISSIVE = [
  ['MIT', /^\s*(the\s+)?MIT License/i],
  ['Apache-2.0', /Apache License,?\s+Version 2\.0/i],
  ['BSD', /BSD (2|3)-Clause|Redistribution and use in source and binary forms/i],
  ['CC0-1.0', /CC0 1\.0|Creative Commons Zero/i],
  ['ISC', /^\s*ISC License/i],
  ['Unlicense', /This is free and unencumbered software released into the public domain/i],
];
/** SPDX-ish id of a licence text, or null when it is not one we accept. */
export function permissiveLicense(text) {
  for (const [id, re] of PERMISSIVE) if (re.test(String(text ?? '').slice(0, 2000))) return id;
  return null;
}

/** Values of one column of a simple CSV (no quoted commas in that column). */
export function csvColumn(text, column) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift()?.split(',').map((h) => h.trim()) ?? [];
  const i = head.indexOf(column);
  if (i < 0) return [];
  return [...new Set(lines.map((l) => l.split(',')[i]?.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a ?? '')))];
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'zetaphy-neuro-ml-importer', accept: 'application/vnd.github+json, text/plain, */*' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Deterministic pick of up to `max` items (sorted, then every k-th). */
export function spread(list, max) {
  const s = [...list].sort();
  if (s.length <= max) return s;
  const step = s.length / max;
  return Array.from({ length: max }, (_, i) => s[Math.floor(i * step)]);
}

export async function importPublic({ max = 200, rpc = true, log = () => {} } = {}) {
  const manifest = [];
  const rows = [];
  for (const src of SOURCES) {
    const entry = { key: src.key, repo: src.repo, url: src.url, licenseUrl: src.licenseUrl, chain: src.chain, label: src.label, note: src.note };
    try {
      const lic = permissiveLicense(await get(src.licenseUrl));
      entry.license = lic;
      if (!lic || lic !== src.expectLicense) { entry.skipped = `licence is ${lic ?? 'not recognised as permissive'}`; manifest.push(entry); continue; }
      const addrs = src.parse(await get(src.url));
      entry.listed = addrs.length;
      const pick = spread(addrs, max);
      entry.picked = pick.length;
      if (!rpc) { entry.rows = 0; entry.skipped = 'no RPC (--no-rpc): list checked, no rows'; manifest.push(entry); continue; }
      const items = pick.map((address) => ({ address, label: src.label, id: `pub-${src.key}-${address.toLowerCase()}`, src: `public:${src.key}`, license: lic, weight: src.weight }));
      const r = await readRows(items, { chain: src.chain, log });
      entry.rows = r.rows.length;
      entry.readErrors = r.errors.length;
      if (!r.rows.length && r.errors.length) entry.skipped = `no rows: ${r.errors[0].error}`;
      rows.push(...r.rows);
    } catch (e) {
      entry.skipped = String(e.message).slice(0, 200);
    }
    manifest.push(entry);
  }
  return { rows, manifest };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = arg('out', new URL('./out/public.jsonl', import.meta.url).pathname);
  const { rows, manifest } = await importPublic({ max: Number(arg('max', 200)), rpc: !process.argv.includes('--no-rpc'), log: (m) => console.error(m) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  writeFileSync(out.replace(/\.jsonl$/, '-sources.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log(JSON.stringify(manifest.map((m) => ({ key: m.key, license: m.license, listed: m.listed, rows: m.rows ?? 0, skipped: m.skipped })), null, 1));
}
