#!/usr/bin/env node
// Builds dist/: the hub at the root and every app under its own path, so the
// hub shows them in same-origin frames (one look, shared wallet storage).
//   node build.mjs            -> dist/
//   node build.mjs --check    -> also verify every page's local scripts/styles exist
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hubSeoFiles, INDEXNOW_KEY } from './seo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'dist');

// app path in the hub -> source folder
export const APPS = {
  wallet: 'zetaphy-wallet',
  swap: 'zetaphy-dex/web',
  nft: 'zetaphy-nft/web',
  explorer: 'zetaphy-explorer',
  'neuro/web': 'zetaphy-neuro/web',
  'neuro/src': 'zetaphy-neuro/src', // the Neuro page imports ../src/*.js
  'neuro/ai': 'zetaphy-neuro/ai', // and ../ai/*.js (AI analyst, bring your own model)
  'neuro/graph': 'zetaphy-neuro/graph', // money-flow graph (web/flow.js imports ../graph/*.js)
  'neuro/agent': 'zetaphy-neuro/agent', // investigator + watch list (../agent/*.js)
  'neuro/ml': 'zetaphy-neuro/ml', // federated-learning panel (web/fl-panel.js: ../ml/model.js, ../ml/fl/*.js, model + head + deployment record)
};
// per app: folders that are build inputs, not served (the wallet serves vendor/pqwallet.js, built from src/)
const SKIP_IN = { wallet: new Set(['src']),
  // the browser needs the model, its features and fl/; training, red team, datasets and on-chain export stay out
  'neuro/ml': new Set(['train', 'redteam', 'dao', 'onchain', 'detectors', 'lib', 'cli.js', 'metrics.json']) };
// never shipped: tooling, tests, docs, per-site Vercel files
// (robots.txt, sitemap.xml and the IndexNow key belong to each app's own site, not to its copy in the hub)
const SKIP = new Set(['node_modules', 'test', 'scripts', 'package.json', 'package-lock.json', 'vercel.json', 'README.md', 'README.th.md', '.gitignore', 'data',
  'robots.txt', 'sitemap.xml', `${INDEXNOW_KEY}.txt`]);
const HUB_FILES = ['index.html', 'walletbar.js', 'wallet-safety.js', 'wallet-safety-i18n.js', 'wallet-safety.css', 'ledger.js', 'vendor/ledger-hid.js', 'validators.html', 'validators.css', 'validators.js', 'forecasts.html', 'forecasts.css', 'forecasts.js', 'forecasts-i18n.js', 'ceremony.html', 'ceremony.css', 'ceremony.js', 'ceremony-i18n.js', 'ceremony-core.js', 'vendor/snarkjs.min.js', 'hub.css', 'hub.js', 'i18n.js', 'chainlib.js', 'pages.js', 'pages-i18n.js', 'mine.js', 'mine-core.js', 'mine-worker.js',
  'work.js', 'work-i18n.js', 'work-core.js', 'work-worker.js', 'fuzz-core.js', 'fuzz-hook.js', 'vendor/evm.js', 'bounties/vulnerable-vault.json', 'bounties/sample-scan.json', 'agents.js', 'agents-lib.js', 'agents-i18n.js', 'intent-core.js', 'assist.js', 'assist-i18n.js', 'govassist.js', 'presign.js', 'presign-probe.js', 'pqattest.js', 'embed.css', 'logo.svg', 'favicon.svg', 'og.png', 'about/about.css', 'flow.js', 'flow-i18n.js', 'aimap.js'];

/** The node and the contract addresses (public data only) the hub's pages read. `files`: {path: json} in place of the repo's (tests). */
export function hubConfig(cfg, files = null) {
  const read = (f) => { if (files && f in files) return files[f]; try { return JSON.parse(readFileSync(join(ROOT, f), 'utf8')); } catch { return null; } };
  const out = {};
  for (const st of Object.values(read('zetaphy-launch/state/77390.json')?.steps ?? {})) Object.assign(out, st.out ?? {});
  // useful work (docs/future/useful-work.md): `zetaphy deploy-useful-work` writes its own deployment file (testnet only)
  const uw = read('zetaphy-network/deployments/useful-work-77390.json');
  if (uw?.chainId === 77390) for (const [k, v] of Object.entries(uw.contracts ?? {})) out[k] ??= v;
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const contracts = Object.fromEntries(['neuroJobs', 'neuroControl', 'threatRegistry', 'threatReports', 'rewardVault', 'stableGateway', 'computeMarket', 'oracle', 'neuroIdentity',
    'usefulWork', 'bugBounty', 'workerReputation', 'usefulIssuance', 'riskForecasts', 'foresight', 'detectorPool', 'dataDao', 'arena', 'intentExecutor', 'labelRegistry', 'vouchRegistry', 'agentRegistry', 'agentPolicyWallet',
    'timelock', 'neuroAttest', 'neuroAnchor', 'neuroOracleSender', 'hackInsurance']
    .filter((k) => isAddr(out[k])).map((k) => [k, out[k]]));
  if (Number.isInteger(out.timelockBlock) && contracts.timelock) contracts.timelockBlock = out.timelockBlock;
  const dex = read('zetaphy-dex/web/deployments.json')?.contracts ?? {};
  const nft = read('zetaphy-nft/web/deployments.json') ?? {};
  return {
    node: cfg.node || '',
    contracts,
    dex: Object.fromEntries(['factory', 'router', 'dlmmFactory', 'dlmmRouter'].filter((k) => isAddr(dex[k])).map((k) => [k, dex[k]])),
    nft: Object.fromEntries(['factory', 'marketplace'].filter((k) => isAddr(nft[k] ?? nft.contracts?.[k])).map((k) => [k, nft[k] ?? nft.contracts[k]])),
    tokens: chainTokens(read),
    saphan: saphanRoutes(read),
    saphanTokens: saphanTokenRoutes(read),
    immune: immuneMirrors(read),
  };
}

/**
 * The Neuro cross-chain oracle (docs/future/crosschain-assist.md, item 18): the sender on ZETAPHY and the NeuroOracle
 * mirror on each chain of saphan-chains.json, from zetaphy-chain/hyperlane/neuro-oracle.json (written by the
 * neuro-oracle workflow once deployed), with each chain's first https RPC so the hub can measure coverage. Public data only.
 */
export function immuneMirrors(read) {
  const t = read('zetaphy-chain/hyperlane/saphan-chains.json');
  const d = read('zetaphy-chain/hyperlane/neuro-oracle.json');
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isAddr(d?.sender)) return { sender: null, mirrors: [] };
  const mirrors = Object.entries(d.receivers ?? {}).filter(([name, r]) => isAddr(r?.oracle) && t?.chains?.[name]).map(([name, r]) => {
    const c = t.chains[name];
    return { name, displayName: String(c.displayName).slice(0, 40), chainId: c.chainId, oracle: r.oracle, rpc: (c.rpc ?? []).find((u) => /^https:\/\/[^\s"<>]+$/.test(u)) ?? '' };
  }).filter((m) => m.rpc);
  return { sender: d.sender, mirrors };
}

/**
 * ZETAPHY Saphan's EVM routes (Hyperlane): every source chain of zetaphy-chain/hyperlane/saphan-chains.json with
 * its deployment from saphan-routes.json, so a chain added to the table shows up (as planned until deployed).
 * The same shape as zetaphy-network/src/saphan.js hubRoutes(). Public data only; anything malformed is left out.
 */
export function saphanRoutes(read) {
  const t = read('zetaphy-chain/hyperlane/saphan-chains.json');
  const routes = read('zetaphy-chain/hyperlane/saphan-routes.json')?.routes ?? {};
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const out = [];
  for (const [name, c] of Object.entries(t?.chains ?? {})) {
    if (!/^[a-z0-9]{1,31}$/.test(name) || !Number.isInteger(c?.chainId) || typeof c.displayName !== 'string' || !/^[\w.-]{1,12}$/.test(c.token?.symbol ?? '')) continue;
    const r = routes[name];
    const deployed = isAddr(r?.origin?.lockbox) && isAddr(r?.zetaphy?.bridgedToken);
    out.push({
      name, displayName: c.displayName.slice(0, 40), chainId: c.chainId, symbol: c.token.symbol,
      explorer: /^https:\/\/[^\s"<>]+$/.test(c.explorer ?? '') ? c.explorer.replace(/\/$/, '') : '',
      state: !deployed ? 'planned' : r.state === 'OPEN' ? 'open' : 'closed',
      twoWay: deployed && isAddr(r.zetaphy.hyperlaneOutbox),
      ...(deployed ? { lockbox: r.origin.lockbox, token: r.zetaphy.bridgedToken } : {}),
    });
  }
  return out;
}

/**
 * ZETAPHY Saphan's token routes: tokens born on ZETAPHY (the `tokens` of saphan-chains.json) and, per destination
 * chain, the state of their route from saphan-routes.json `tokens` (planned / closed / open). A token that cannot move
 * (transferable: false, e.g. BZTPHY) is listed with no destinations. The same shape as zetaphy-network/src/saphan.js
 * hubTokenRoutes(). Public data only; anything malformed is left out.
 */
export function saphanTokenRoutes(read) {
  const t = read('zetaphy-chain/hyperlane/saphan-chains.json');
  const deployed = read('zetaphy-chain/hyperlane/saphan-routes.json')?.tokens ?? {};
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const sym = (s) => typeof s === 'string' && /^[\w.-]{1,12}$/.test(s);
  const out = [];
  for (const [key, k] of Object.entries(t?.tokens ?? {})) {
    if (key === 'about' || !/^[a-z0-9]{1,15}$/.test(key) || !isAddr(k?.address) || !sym(k.symbol) || !sym(k.synthetic?.symbol) || typeof k.displayName !== 'string') continue;
    const destinations = (Array.isArray(k.destinations) && k.transferable !== false ? k.destinations : []).filter((d) => typeof t.chains?.[d]?.displayName === 'string').map((name) => {
      const r = deployed[key]?.[name];
      const live = isAddr(r?.zetaphy?.vault) && isAddr(r?.destination?.synthetic);
      return { name, displayName: t.chains[name].displayName.slice(0, 40), state: !live ? 'planned' : r.state === 'OPEN' ? 'open' : 'closed',
        ...(live ? { vault: r.zetaphy.vault, token: r.destination.synthetic } : {}) };
    });
    out.push({ key, symbol: k.symbol, synthetic: k.synthetic.symbol, displayName: k.displayName.slice(0, 40), address: k.address,
      native: k.native === true, transferable: k.transferable !== false, destinations });
  }
  return out;
}

/** ZETAPHY-chain tokens the wallet bar shows when the account holds them (public addresses only), with their Saphan token routes. */
export function chainTokens(read) {
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const sym = (s) => (typeof s === 'string' && /^[\w.-]{1,12}$/.test(s) ? s : undefined);
  const out = [];
  const routes = saphanTokenRoutes(read);
  const saphanOf = (address) => routes.find((r) => !r.native && r.address.toLowerCase() === address.toLowerCase())?.destinations
    .map((d) => ({ chain: d.displayName, symbol: routes.find((r) => r.address.toLowerCase() === address.toLowerCase()).synthetic, state: d.state }));
  const add = (address, symbol, decimals) => {
    if (!isAddr(address) || out.some((t) => t.address.toLowerCase() === address.toLowerCase())) return;
    const s = saphanOf(address);
    out.push({ address, ...(sym(symbol) ? { symbol } : {}), ...(Number.isInteger(decimals) ? { decimals } : {}), ...(s?.length ? { saphan: s } : {}) });
  };
  add(read('zetaphy-chain/rewards/points-testnet.json')?.points, 'BZTPHY');
  // tokens of the Saphan token table (not the native coin: the wallet bar shows it already)
  for (const r of routes) if (!r.native) add(r.address, r.symbol);
  add(read('zetaphy-chain/hyperlane/bridge-testnet.json')?.zetaphy?.bridgedToken);
  for (const r of saphanRoutes(read)) if (r.token) add(r.token, r.symbol, 18);
  for (const t of read('zetaphy-dex/web/deployments.json')?.tokens ?? []) add(t.address, t.symbol, t.decimals);
  return out;
}

/**
 * The prebuilt-binary release for the current setup-node.sh: zetaphyd-<first 12 hex of its sha256>, the tag
 * .github/workflows/release-zetaphyd.yml publishes it under.
 */
export function releaseTag(root = ROOT) {
  return `zetaphyd-${createHash('sha256').update(readFileSync(join(root, 'zetaphy-chain/setup-node.sh'))).digest('hex').slice(0, 12)}`;
}
/** validators.html with its download buttons pointing at releaseTag() (so they never go stale). */
export const withRelease = (html, tag) => html.replace(/\/releases\/download\/zetaphyd-[0-9a-f]{12}\//g, `/releases/download/${tag}/`);

export function build() {
  // built in a private folder, then swapped in with renames: test files that build at the same time never see a
  // half-copied dist/ (node --test runs files in parallel)
  const dir = `${OUT}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  for (const f of HUB_FILES) cpSync(join(HERE, f), join(dir, f));
  // search engines: "What is ZETAPHY?" in 8 languages, robots.txt, sitemap.xml, IndexNow key (seo.mjs)
  for (const [f, c] of Object.entries(hubSeoFiles())) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  writeFileSync(join(dir, 'validators.html'), withRelease(readFileSync(join(HERE, 'validators.html'), 'utf8'), releaseTag()));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'zetaphy-explorer/config.json'), 'utf8'));
  writeFileSync(join(dir, 'hub-config.json'), `${JSON.stringify(hubConfig(cfg), null, 2)}\n`);
  for (const [path, src] of Object.entries(APPS)) {
    const from = join(ROOT, src);
    const top = (p) => p.slice(from.length + 1).split(/[\\/]/)[0];
    cpSync(from, join(dir, path), { recursive: true, filter: (p) => !SKIP.has(top(p)) && !SKIP_IN[path]?.has(top(p)) });
  }
  for (let i = 0; ; i++) {
    const old = `${OUT}.old-${process.pid}-${Date.now()}-${i}`;
    try { renameSync(OUT, old); } catch { /* no dist/ yet */ }
    try { renameSync(dir, OUT); rmSync(old, { recursive: true, force: true }); break; } catch (e) { rmSync(old, { recursive: true, force: true }); if (i > 20) throw e; }
  }
  return OUT;
}

/** Every local <script src> / <link href> in the built pages exists. */
export function check(out = OUT) {
  const missing = [];
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(out).filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (/^(https?:|mailto:|data:)/.test(ref) || ref.startsWith('?') || ref === '') continue;
      const target = ref.startsWith('/') ? join(out, ref) : join(dirname(f), ref);
      if (!existsSync(target)) missing.push(`${f.slice(out.length + 1)}: ${ref}`);
    }
  }
  return missing;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
  const missing = check();
  if (missing.length) { console.error(`missing files:\n  ${missing.join('\n  ')}`); process.exit(1); }
  console.log(`dist/ built: hub + ${Object.keys(APPS).join(', ')}`);
}
