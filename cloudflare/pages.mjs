#!/usr/bin/env node
// Stages a ZETAPHY site for Cloudflare Pages (free plan: static files are not
// metered, unlike Vercel functions). Each site's vercel.json stays the source of
// truth; this turns it into Cloudflare's _headers and _redirects files.
//
//   node cloudflare/pages.mjs stage <site> <outDir>   copy the site + write _headers/_redirects
//   node cloudflare/pages.mjs list                    the site names, one per line
//
// Used by .github/workflows/cf-pages.yml. Tests: cloudflare/pages.test.mjs.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * dir: the Vercel project's root directory; out: what Vercel serves from it (after
 * build, run by the workflow); project: the Cloudflare Pages project; domain: its
 * custom domain (set once in the Cloudflare dashboard).
 */
export const SITES = {
  hub: { dir: 'zetaphy-hub', out: 'dist', build: true, project: 'zetaphy-hub', domain: 'app.sawasdeecoin.com' },
  wallet: { dir: 'zetaphy-wallet', out: '.', project: 'zetaphy-wallet', domain: 'wallet.sawasdeecoin.com' },
  swap: { dir: 'zetaphy-dex/web', out: '.', project: 'zetaphy-swap', domain: 'swap.sawasdeecoin.com' },
  nft: { dir: 'zetaphy-nft/web', out: '.', project: 'zetaphy-nft', domain: 'nft.sawasdeecoin.com' },
  explorer: { dir: 'zetaphy-explorer', out: '.', project: 'zetaphy-explorer', domain: 'explorer.sawasdeecoin.com' },
  neuro: { dir: 'zetaphy-neuro', out: '.', project: 'zetaphy-neuro', domain: 'neuro.sawasdeecoin.com' },
};

// Never uploaded: Vercel's own config, function sources (api/: served by Vercel as
// functions, not as files) and anything a .vercelignore leaves out.
const ALWAYS_SKIP = ['vercel.json', '.vercelignore', 'api/', 'node_modules/', '.gitignore'];

// ---------------------------------------------------------------- headers

/**
 * A vercel.json header source -> { path, except } in Cloudflare's syntax.
 * Only the shapes the ZETAPHY sites use; anything else throws, so a new pattern
 * is never silently mistranslated.
 */
export function cfPath(source) {
  if (source === '/(.*)') return { path: '/*', except: [] };
  const neg = /^\/\(\(\?!(.+)\)\.\*\)$/.exec(source);
  if (neg) {
    const except = neg[1].split('|').map((p) => {
      if (!/^[\w\\.-]+\$$/.test(p)) throw new Error(`unsupported exclusion in ${source}`);
      return '/' + p.slice(0, -1).replace(/\\\./g, '.');
    });
    return { path: '/*', except };
  }
  if (/^\/[\w./-]*$/.test(source)) return { path: source, except: [] };
  throw new Error(`unsupported header source ${source}`);
}

/**
 * Cloudflare Pages serves /x.html at /x (it redirects to the short form), so a
 * rule for one file also has to name the address the browser ends up on.
 */
export function aliases(path) {
  if (path.endsWith('/index.html')) return [path, path.slice(0, -'index.html'.length)];
  if (path.endsWith('.html')) return [path, path.slice(0, -'.html'.length)];
  return [path];
}

/**
 * vercel.json headers -> _headers text. Vercel: every matching rule applies and a
 * later rule wins for the same header. Cloudflare: every matching rule applies and
 * the same header from two rules is JOINED (two CSPs would both be enforced). A
 * "! Name" line removes a catch-all header, but only inside the one block of that
 * path that also sets its own value (checked with `wrangler pages dev`: a second
 * block for the same path is ignored). So: the catch-all rule, then ONE block per
 * specific path with its detaches (an exclusion, or a header it sets itself) and
 * its own headers.
 */
export function toHeaders(vercel) {
  const rules = (vercel.headers ?? []).map((r) => ({ ...cfPath(r.source), headers: r.headers }));
  const all = rules.filter((r) => r.path === '/*');
  const specific = rules.filter((r) => r.path !== '/*');
  if (all.length > 1) throw new Error('more than one catch-all header rule');
  const allKeys = all.flatMap((a) => a.headers.map((h) => h.key));
  const paths = new Map(); // path -> { detach: Set, set: Map(lower key -> line) }
  const entry = (p) => { if (!paths.has(p)) paths.set(p, { detach: new Set(), set: new Map() }); return paths.get(p); };
  for (const r of all) for (const x of r.except) for (const p of aliases(x)) for (const k of r.headers.map((h) => h.key)) entry(p).detach.add(k);
  for (const r of specific) {
    for (const p of aliases(r.path)) {
      const e = entry(p);
      for (const h of r.headers) {
        if (allKeys.some((k) => k.toLowerCase() === h.key.toLowerCase())) e.detach.add(h.key);
        e.set.set(h.key.toLowerCase(), `${h.key}: ${h.value}`); // a later Vercel rule wins
      }
    }
  }
  const out = [];
  for (const r of all) out.push('/*', ...r.headers.map((h) => `  ${h.key}: ${h.value}`), '');
  for (const [p, e] of paths) out.push(p, ...[...e.detach].map((k) => `  ! ${k}`), ...[...e.set.values()].map((l) => '  ' + l), '');
  for (const line of out) if (line.length > 2000) throw new Error('_headers line over 2000 characters');
  return out.join('\n');
}

// -------------------------------------------------------------- redirects

const cfTarget = (s) => s.replace(/:(\w+)\*/g, ':splat');
const cfSource = (s) => s.replace(/\/:(\w+)\*$/, '/*');

/**
 * vercel.json redirects (and rewrites to another site, which Cloudflare's static
 * files cannot proxy: they become 307 redirects, method kept) -> _redirects text.
 */
export function toRedirects(vercel) {
  const lines = [];
  for (const r of vercel.redirects ?? []) lines.push(`${cfSource(r.source)} ${cfTarget(r.destination)} ${r.permanent ? 308 : 307}`);
  for (const r of vercel.rewrites ?? []) {
    if (!/^https:\/\//.test(r.destination)) throw new Error(`unsupported internal rewrite ${r.source}`);
    lines.push(`${cfSource(r.source)} ${cfTarget(r.destination)} 307`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

// ------------------------------------------------------------------ files

const NOT_FOUND = '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><h1>404: not found</h1><p><a href="/">Home</a></p></html>\n';

function ignoreList(siteDir) {
  const f = join(siteDir, '.vercelignore');
  const extra = existsSync(f) ? readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
  return [...ALWAYS_SKIP, ...extra];
}

/** Whether a site-relative path is left out by an ignore entry ("test", "test/", "package.json"). */
export function ignored(rel, list) {
  return list.some((e) => {
    const name = e.replace(/^\//, '').replace(/\/$/, '');
    return rel === name || rel.startsWith(name + '/');
  });
}

/** Tracked files only (what Vercel's Git deploy sees); for a built site, its whole output folder. */
function filesOf(site) {
  const s = SITES[site];
  const base = join(ROOT, s.dir, s.out);
  if (s.build) {
    if (!existsSync(base)) throw new Error(`${relative(ROOT, base)} is missing: build ${s.dir} first`);
    return null;
  }
  const tracked = execFileSync('git', ['ls-files', '-z', '--', s.dir], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const list = ignoreList(join(ROOT, s.dir));
  return tracked.map((f) => relative(s.dir, f)).filter((rel) => !ignored(rel, list));
}

export function stage(site, outDir) {
  const s = SITES[site];
  if (!s) throw new Error(`unknown site ${site}; one of: ${Object.keys(SITES).join(', ')}`);
  const vercel = JSON.parse(readFileSync(join(ROOT, s.dir, 'vercel.json'), 'utf8'));
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const base = join(ROOT, s.dir, s.out);
  const files = filesOf(site);
  if (files === null) {
    cpSync(base, outDir, { recursive: true, filter: (src) => !ignored(relative(base, src), ALWAYS_SKIP) });
  } else {
    for (const rel of files) {
      const src = join(ROOT, s.dir, rel);
      if (!statSync(src).isFile()) continue;
      mkdirSync(dirname(join(outDir, rel)), { recursive: true });
      cpSync(src, join(outDir, rel));
    }
  }
  for (const own of ['_headers', '_redirects']) if (existsSync(join(outDir, own))) throw new Error(`${s.dir} already has ${own}`);
  // Without a top-level 404.html Cloudflare answers every unknown path with
  // index.html (single-page-app mode); Vercel answers 404. Keep Vercel's behavior.
  if (!existsSync(join(outDir, '404.html'))) writeFileSync(join(outDir, '404.html'), NOT_FOUND);
  writeFileSync(join(outDir, '_headers'), toHeaders(vercel));
  const redirects = toRedirects(vercel);
  if (redirects) writeFileSync(join(outDir, '_redirects'), redirects);
  return { project: s.project, domain: s.domain };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, site, out] = process.argv.slice(2);
  if (cmd === 'list') console.log(Object.keys(SITES).join('\n'));
  else if (cmd === 'stage' && site && out) {
    const r = stage(site, resolve(out));
    console.log(`staged ${site} -> ${out} (Cloudflare Pages project ${r.project}, ${r.domain})`);
  } else {
    console.error('usage: node cloudflare/pages.mjs stage <site> <outDir> | list');
    process.exit(2);
  }
}
