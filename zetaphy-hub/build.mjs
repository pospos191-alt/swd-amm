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
import { ALL as IMMUNE_CHAINS } from '../zetaphy-network/src/immune/chains.js';
import { simulate as immuneSimulate } from '../zetaphy-network/src/immune/propagate.js';

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
  'work.js', 'work-i18n.js', 'work-core.js', 'work-worker.js', 'fuzz-core.js', 'fuzz-hook.js', 'vendor/evm.js', 'bounties/vulnerable-vault.json', 'bounties/sample-scan.json', 'agents.js', 'agents-lib.js', 'agents-i18n.js', 'intent-core.js', 'assist.js', 'assist-i18n.js', 'govassist.js', 'presign.js', 'presign-probe.js', 'pqattest.js', 'embed.css', 'logo.svg', 'favicon.svg', 'og.png', 'about/about.css', 'flow.js', 'flow-i18n.js', 'aimap.js', 'aichain.js', 'aichain-i18n.js', 'offline.js', 'offline-core.js', 'offline-i18n.js', 'audit.js', 'audit-core.js', 'audit-i18n.js', 'vendor/qrcode.js', 'zearly.svg', 'zearly-256.png', 'zetaphy-256.png'];

/** The node and the contract addresses (public data only) the hub's pages read. `files`: {path: json} in place of the repo's (tests). */
export function hubConfig(cfg, files = null) {
  const read = (f) => { if (files && f in files) return files[f]; try { return JSON.parse(readFileSync(join(ROOT, f), 'utf8')); } catch { return null; } };
  const out = {};
  for (const st of Object.values(read('zetaphy-launch/state/77390.json')?.steps ?? {})) Object.assign(out, st.out ?? {});
  // useful work (docs/future/useful-work.md): `zetaphy deploy-useful-work` writes its own deployment file (testnet only)
  const uw = read('zetaphy-network/deployments/useful-work-77390.json');
  if (uw?.chainId === 77390) for (const [k, v] of Object.entries(uw.contracts ?? {})) out[k] ??= v;
  // the AI-map contracts (.github/workflows/ai-deploy.yml, zetaphy-network/src/aideploy.js)
  const ai = read('zetaphy-network/deployments/ai-77390.json');
  if (ai?.chainId === 77390) for (const [k, v] of Object.entries(ai.contracts ?? {})) out[k] ??= v;
  // offline trading (docs/future/offline-trading.md): zetaphy-network/scripts/offline-deploy.js writes its record (testnet only)
  const off = read('zetaphy-network/deployments/offline-77390.json');
  if (off?.chainId === 77390) for (const [k, v] of Object.entries(off.contracts ?? {})) out[k] ??= v;
  // the open audit network (docs/future/audit-network.md): `zetaphy deploy-audit` writes its record (testnet only)
  const au = read('zetaphy-network/deployments/audit-77390.json');
  if (au?.chainId === 77390) for (const [k, v] of Object.entries(au.contracts ?? {})) out[k] ??= v;
  const fl = read('zetaphy-neuro/ml/fl/deployment.json');
  if (fl?.chainId === 77390 && fl.rounds) out.federatedRounds ??= fl.rounds;
  const oracle = read('zetaphy-chain/hyperlane/neuro-oracle.json');
  if (oracle?.sender) out.neuroOracleSender ??= oracle.sender;
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const contracts = Object.fromEntries(['neuroJobs', 'neuroControl', 'threatRegistry', 'threatReports', 'rewardVault', 'stableGateway', 'computeMarket', 'oracle', 'neuroIdentity',
    'usefulWork', 'bugBounty', 'workerReputation', 'usefulIssuance', 'riskForecasts', 'foresight', 'detectorPool', 'dataDao', 'arena', 'intentExecutor', 'labelRegistry', 'vouchRegistry', 'agentRegistry', 'agentPolicyWallet',
    'timelock', 'neuroAttest', 'neuroAnchor', 'neuroOracleSender', 'hackInsurance',
    'modelRegistry', 'neuroScore', 'modelEpochs', 'signalBoard', 'webauthn', 'cosignCommittee', 'federatedRounds', 'zetaphyCheques', 'offlineOrders', 'auditNetwork', 'auditRunners', 'auditJudges', 'auditCertificate', 'circuitBreaker']
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
    immuneNet: immuneNetwork(read),
  };
}

/**
 * The immune network (docs/future/immune-network.md) for the Immunity tab and the pre-sign check: ImmuneRegistry on
 * ZETAPHY, the ImmuneMirror per chain (with the chain's first https RPC, from saphan-chains.json), the open feed's URL,
 * how many chains the sentinels watch, and the simulated median propagation (shown until mirrors measure it).
 * From zetaphy-chain/hyperlane/immune-network.json. Public data only; anything malformed is left out.
 */
export function immuneNetwork(read) {
  const d = read('zetaphy-chain/hyperlane/immune-network.json') ?? {};
  const t = read('zetaphy-chain/hyperlane/saphan-chains.json');
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const mirrors = Object.entries(d.mirrors ?? {}).filter(([name, m]) => /^[a-z0-9]{1,31}$/.test(name) && isAddr(m?.mirror) && t?.chains?.[name]).map(([name, m]) => {
    const c = t.chains[name];
    return { name, displayName: String(c.displayName).slice(0, 40), chainId: c.chainId, mirror: m.mirror, rpc: (c.rpc ?? []).find((u) => /^https:\/\/[^\s"<>]+$/.test(u)) ?? '' };
  }).filter((m) => m.rpc);
  const feedUrl = /^https:\/\/[^\s"<>]+$/.test(d.feed?.url ?? '') ? d.feed.url : null;
  return { registry: isAddr(d.registry) ? d.registry : null, mirrors, feedUrl, chains: IMMUNE_CHAINS.length, simMedian: immuneSimulate({ trials: 200, seed: 7 }).median };
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
  const add = (address, symbol, decimals, logo) => {
    if (!isAddr(address) || out.some((t) => t.address.toLowerCase() === address.toLowerCase())) return;
    const s = saphanOf(address);
    out.push({ address, ...(sym(symbol) ? { symbol } : {}), ...(Number.isInteger(decimals) ? { decimals } : {}), ...(logo ? { logo } : {}), ...(s?.length ? { saphan: s } : {}) });
  };
  add(read('zetaphy-chain/rewards/points-testnet.json')?.points, 'BZTPHY');
  add(read('zetaphy-chain/rewards/early-testnet.json')?.token, 'ZEARLY', 18, 'zearly-256.png'); // ZETAPHY Early (zetaphy-chain/rewards/EARLY.md)
  // tokens of the Saphan token table (not the native coin: the wallet bar shows it already)
  for (const r of routes) if (!r.native) add(r.address, r.symbol);
  add(read('zetaphy-chain/hyperlane/bridge-testnet.json')?.zetaphy?.bridgedToken);
  for (const r of saphanRoutes(read)) if (r.token) add(r.token, r.symbol, 18);
  for (const t of read('zetaphy-dex/web/deployments.json')?.tokens ?? []) add(t.address, t.symbol, t.decimals);
  return out;
}

/**
 * The ZETAPHY tokens as a standard token list (tokenlists.org schema; DEXs and wallets that take a list URL read it):
 * chain id 77390 on every token, its logo when it has one, the ZETAPHY network logo for the list.
 */
export function tokenList(tokens, origin = 'https://app.sawasdeecoin.com', version = { major: 1, minor: 0, patch: 0 }) {
  const NAME = { BZTPHY: 'ZETAPHY Testnet Reward Points', ZEARLY: 'ZETAPHY Early' };
  return {
    name: 'ZETAPHY',
    logoURI: `${origin}/zetaphy-256.png`,
    keywords: ['zetaphy', 'testnet'],
    version,
    tokens: tokens.filter((t) => t.symbol).map((t) => ({
      chainId: 77390, address: t.address, symbol: t.symbol, name: NAME[t.symbol] ?? t.symbol, decimals: t.decimals ?? 18,
      ...(t.logo ? { logoURI: `${origin}/${t.logo}` } : {}),
    })),
  };
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
  const hc = hubConfig(cfg);
  writeFileSync(join(dir, 'hub-config.json'), `${JSON.stringify(hc, null, 2)}\n`);
  writeFileSync(join(dir, 'tokenlist.json'), `${JSON.stringify({ ...tokenList(hc.tokens ?? []), timestamp: '2026-10-29T00:00:00.000Z' }, null, 2)}\n`);
  for (const [path, src] of Object.entries(APPS)) {
    const from = join(ROOT, src);
    const top = (p) => p.slice(from.length + 1).split(/[\\/]/)[0];
    cpSync(from, join(dir, path), { recursive: true, filter: (p) => !SKIP.has(top(p)) && !SKIP_IN[path]?.has(top(p)) });
  }
  writeServiceWorker(dir);
  for (let i = 0; ; i++) {
    const old = `${OUT}.old-${process.pid}-${Date.now()}-${i}`;
    try { renameSync(OUT, old); } catch { /* no dist/ yet */ }
    try { renameSync(dir, OUT); rmSync(old, { recursive: true, force: true }); break; } catch (e) { rmSync(old, { recursive: true, force: true }); if (i > 20) throw e; }
  }
  return OUT;
}

// ------------------------------------------------------------------ the offline app shell (sw.js)
// What the service worker keeps: the hub page, its own scripts, styles and icons, hub-config.json, and every module
// they import statically (e.g. wallet/wallets.js), plus what the Offline tab loads on demand (the QR encoder;
// keccak-256 and secp256k1 from the wallet's bundle). Never the big vendor bundles of other pages, never anything from the network.
const SHELL_SKIP = new Set(['vendor/snarkjs.min.js', 'vendor/evm.js', 'vendor/ledger-hid.js', 'og.png', 'zearly-256.png', 'zetaphy-256.png']);
const SHELL_EXTRA = ['wallet/vendor/pqwallet.js', 'hub-config.json'];
export function shellFiles(dir) {
  const own = HUB_FILES.filter((f) => /\.(js|css|svg)$/.test(f) && !SHELL_SKIP.has(f) && !/^(validators|forecasts|ceremony)/.test(f) && !/-worker\.js$/.test(f));
  const out = new Set([...own, ...SHELL_EXTRA]);
  const queue = [...out].filter((f) => f.endsWith('.js'));
  while (queue.length) {
    const f = queue.pop();
    let src;
    try { src = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const [, ref] of src.matchAll(/(?:^|[;\s}])(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|(?:^|[;\s])import\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      if (!ref) continue;
      const p = join(dirname(f), ref).replace(/\\/g, '/');
      if (p.startsWith('..') || out.has(p) || !existsSync(join(dir, p))) continue;
      out.add(p);
      queue.push(p);
    }
  }
  return ['./', ...[...out].sort()];
}
/** dist/sw.js from sw.js: the shell list and a version (hash of every shell file), so a new deploy replaces the old copy. */
export function writeServiceWorker(dir) {
  const files = shellFiles(dir);
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(f === './' ? readFileSync(join(dir, 'index.html')) : readFileSync(join(dir, f)));
  const src = readFileSync(join(HERE, 'sw.js'), 'utf8')
    .replace("'__VERSION__'", JSON.stringify(h.digest('hex').slice(0, 16)))
    .replace("['__SHELL__']", JSON.stringify(files));
  writeFileSync(join(dir, 'sw.js'), src);
  return files;
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
