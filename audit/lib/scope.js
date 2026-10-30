// Which Solidity files are audited, how their imports resolve, and how many
// lines they have. Two modes:
//  - this repository: audit/scope.json lists the projects (and why some files
//    are excluded);
//  - any other directory (`run.sh --target <dir>`): the projects are found by
//    walking the tree, skipping dependencies, tests, mocks and scripts.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'out', 'cache', 'artifacts', 'build', 'dist', 'coverage',
  'test', 'tests', 'mock', 'mocks', 'script', 'scripts', 'vendor', 'forge-std', 'crytic-export', 'audit']);
const SKIP_FILE = /(\.t\.sol|\.s\.sol|^Mock.*\.sol|.*Mock\.sol)$/;

/** All .sol files under dir (relative to base), sorted; skipDirs applies below the top. */
export function walkSol(base, rel, skip = SKIP_DIRS) {
  const out = [];
  const abs = join(base, rel);
  if (!existsSync(abs)) return out;
  for (const f of readdirSync(abs).sort()) {
    const p = rel ? posix.join(rel, f) : f;
    const st = statSync(join(base, p));
    if (st.isDirectory()) { if (!skip.has(f) && !f.startsWith('.')) out.push(...walkSol(base, p, skip)); } else if (f.endsWith('.sol')) out.push(p);
  }
  return out;
}

/** Remappings of a foreign project: remappings.txt and foundry.toml. */
function foreignRemappings(root) {
  const r = [];
  const txt = join(root, 'remappings.txt');
  if (existsSync(txt)) r.push(...readFileSync(txt, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  const toml = join(root, 'foundry.toml');
  if (existsSync(toml)) {
    const m = readFileSync(toml, 'utf8').match(/remappings\s*=\s*\[([\s\S]*?)\]/);
    if (m) r.push(...[...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
  }
  return [...new Set(r)];
}

/**
 * The audit scope.
 * @param {string} target  repository / directory root (absolute)
 * @param {object|null} config  audit/scope.json, or null to discover
 * @returns {{mode:string, projects:Array<{name,root,files:string[],excluded:Object,remappings:string[],settings:object}>, config:object|null}}
 */
export function loadScope(target, config) {
  if (config) {
    const projects = config.projects.map((p) => {
      const root = join(target, p.root);
      const files = p.src.flatMap((s) => walkSol(root, s, new Set(['node_modules', '.git']))).filter((f, i, a) => a.indexOf(f) === i);
      return { name: p.name, root: p.root, files, excluded: p.exclude ?? {}, remappings: p.remappings ?? [], settings: p.settings ?? {} };
    });
    return { mode: 'repo', projects, config };
  }
  const files = walkSol(target, '');
  const excluded = {};
  for (const f of files) if (SKIP_FILE.test(posix.basename(f))) excluded[f] = 'test/mock/script file (by name)';
  return {
    mode: 'target',
    projects: files.length ? [{ name: posix.basename(target) || 'target', root: '.', files, excluded, remappings: foreignRemappings(target), settings: { optimizer: { enabled: true, runs: 200 } } }] : [],
    config: null,
  };
}

/** Resolves an import as solc would with these remappings; falls back to node_modules/ and lib/. */
export function resolveImport(projectRoot, fromFile, path, remappings) {
  if (path.startsWith('.')) return posix.normalize(posix.join(posix.dirname(fromFile), path));
  let best = null;
  for (const r of remappings) {
    const [ctxPrefix, target] = r.split('=');
    const prefix = ctxPrefix.includes(':') ? ctxPrefix.split(':')[1] : ctxPrefix;
    if (path.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, target };
  }
  if (best) return posix.normalize(best.target + path.slice(best.prefix.length));
  for (const c of [path, `node_modules/${path}`, `lib/${path}`]) if (existsSync(join(projectRoot, c))) return c;
  // foundry-style lib/<name>/src: "forge-std/Test.sol" -> lib/forge-std/src/Test.sol
  const [head, ...rest] = path.split('/');
  for (const c of [`lib/${head}/src/${rest.join('/')}`, `lib/${head}/${rest.join('/')}`]) if (existsSync(join(projectRoot, c))) return c;
  return path;
}

/** Every source a compile of `files` needs: {sourceKey: {content}}, keys as the project's own build uses. */
export function sourceClosure(projectRoot, files, remappings) {
  const sources = {};
  const missing = [];
  // solc's source unit name: a relative import joins the importer's unit name;
  // anything else is the import path itself. The file on disk is that name
  // after the remappings.
  const visit = (key) => {
    if (sources[key] || missing.includes(key)) return;
    const abs = join(projectRoot, resolveImport(projectRoot, '', key, remappings));
    if (!existsSync(abs)) { missing.push(key); return; }
    const content = readFileSync(abs, 'utf8');
    sources[key] = { content };
    for (const m of content.matchAll(/^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']\s*;/gm)) {
      const imp = m[1];
      visit(imp.startsWith('.') ? posix.normalize(posix.join(posix.dirname(key), imp)) : imp);
    }
  };
  for (const f of files) visit(f);
  return { sources, missing };
}

/** Code lines: not blank, not only a comment. */
export function countLoc(text) {
  let n = 0; let block = false;
  for (let l of text.split('\n')) {
    l = l.trim();
    if (block) { const e = l.indexOf('*/'); if (e < 0) continue; block = false; l = l.slice(e + 2).trim(); }
    if (l.startsWith('/*')) { if (!l.includes('*/')) { block = true; continue; } l = l.slice(l.indexOf('*/') + 2).trim(); }
    if (!l || l.startsWith('//')) continue;
    n++;
  }
  return n;
}

export const relTo = (a, b) => relative(a, b).split('\\').join('/');
export { dirname };
