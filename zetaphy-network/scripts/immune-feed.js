#!/usr/bin/env node
// Builds the open threat feed (src/immune/feed.js) from ZETAPHY's ImmuneRegistry: feed.json, feed.ndjson, rss.xml,
// atom.xml and, when IMMUNE_FEED_PQ_SEED is set (a 0x… 32-byte ML-DSA-44 seed: a testnet key, never a wallet key),
// snapshot.pq.json. Run by .github/workflows/immune-feed.yml, which pushes the files to the `immune-feed` branch.
//   node scripts/immune-feed.js [--out _immune-feed] [--rpc https://…] [--config ../zetaphy-chain/hyperlane/immune-network.json]
// Not deployed yet (registry null): an empty, honest feed ("not-deployed") is written, so links never 404.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRpc } from '../src/immune/rpc.js';
import { ZETAPHY } from '../src/immune/chains.js';
import { buildFeed, feedFiles, readRegistry } from '../src/immune/feed.js';
import { pqFromSeed } from '../src/pq.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const here = new URL('..', import.meta.url).pathname;

async function main() {
  const cfgPath = opt('--config', join(here, '../zetaphy-chain/hyperlane/immune-network.json'));
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  const out = opt('--out', '_immune-feed');
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  let items = []; let status = 'not-deployed';
  if (isAddr(cfg.registry)) {
    const rpc = createRpc({ urls: [opt('--rpc', ZETAPHY.rpc[0])], rps: ZETAPHY.rps });
    items = await readRegistry(rpc.send, cfg.registry);
    status = 'live';
  }
  const vdir = join(here, 'immune/vaccines');
  const vaccines = existsSync(vdir) ? readdirSync(vdir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(vdir, f), 'utf8'))) : [];
  const feed = buildFeed({ items, vaccines, source: { registry: cfg.registry ?? null, status, mirrors: Object.keys(cfg.mirrors ?? {}) } });
  const seed = process.env.IMMUNE_FEED_PQ_SEED;
  const key = seed && /^0x[0-9a-fA-F]{64}$/.test(seed) ? pqFromSeed(seed) : null;
  const files = await feedFiles(feed, { key, base: process.env.IMMUNE_FEED_BASE ?? cfg.feed?.url ?? '' });
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);
  console.log(`${out}: ${feed.items.length} key(s), ${feed.stats.flaggedNow} flagged now, ${feed.vaccines.length} vaccine(s), ${key ? `signed by ${key.keyHash}` : 'UNSIGNED (no IMMUNE_FEED_PQ_SEED)'}; registry ${status}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
