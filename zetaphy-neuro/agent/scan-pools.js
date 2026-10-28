// Scheduled scan (GitHub Actions, .github/workflows/neuro-alerts.yml): finds
// pools created on the ZETAPHY DEX and DLMM factories in the last couple of
// hours (PairCreated events), investigates each new token (agent/pipeline.js)
// and opens a GitHub issue labelled `neuro-alert` for a high result.
//
// No server and no state: each run looks back NEURO_LOOKBACK_SECONDS (default
// 2 h, the workflow runs hourly, so runs overlap) and dedupes against the
// issues already labelled neuro-alert. Throttled: at most NEURO_MAX_ALERTS
// issues a run and 10 a day; at most NEURO_MAX_POOLS tokens investigated.
//
// Stays quiet: before NEURO_ALERTS_FROM (the ZETAPHY RPC is paused until
// 2026-11-01) it prints one line and exits 0; if the RPC cannot be reached
// it prints one line and exits 0. It never opens an issue about itself.
//
//   node agent/scan-pools.js [--dry-run]
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), NEURO_RPC, NEURO_ALERTS_FROM,
//        NEURO_LOOKBACK_SECONDS, NEURO_MAX_POOLS, NEURO_MAX_ALERTS
import { fileURLToPath } from 'node:url';
import { createEvmClient } from '../graph/clients.js';
import { ZETAPHY } from '../graph/sources.js';
import { TOPIC, lc, topicAddr, toNum, hexBlock, dataWord, createBudget } from '../graph/util.js';
import { investigate } from './pipeline.js';
import { planAlerts, issueFor, ALERT_LABEL } from './alerts.js';

const ZETAPHY_CHAIN = { kind: 'evm', id: ZETAPHY.chainId, name: 'ZETAPHY (testnet)', rpcs: [ZETAPHY.rpc], dex: ZETAPHY.dex };
const EXPLORER = 'https://explorer.sawasdeecoin.com/#/';

/** New tokens from PairCreated logs of both factories: [{ token, pair, block, tx, factory }]. */
export function newTokensFromLogs(logs, { baseTokens = ZETAPHY.baseTokens } = {}) {
  const base = new Set(baseTokens.map(lc));
  const out = [];
  const seen = new Set();
  for (const l of logs) {
    const t0 = lc(l.topics?.[0]);
    let a; let b; let pair;
    if (t0 === TOPIC.pairCreated) { a = topicAddr(l.topics[1]); b = topicAddr(l.topics[2]); pair = topicAddr('0x' + dataWord(l.data, 0).toString(16)); }
    else if (t0 === TOPIC.dlmmPairCreated) { a = topicAddr(l.topics[1]); b = topicAddr(l.topics[2]); pair = topicAddr('0x' + dataWord(l.data, 0).toString(16)); }
    else continue;
    for (const token of [a, b]) {
      if (base.has(token) || seen.has(token)) continue;
      seen.add(token);
      out.push({ token, pair, block: toNum(l.blockNumber), tx: lc(l.transactionHash), factory: lc(l.address) });
    }
  }
  return out;
}

/** GitHub REST with the workflow's GITHUB_TOKEN (issues: write only). */
export function githubClient({ token, repo, fetchImpl = globalThis.fetch }) {
  const api = async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'zetaphy-neuro-alerts', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    async alertIssues(pages = 3) {
      const out = [];
      for (let page = 1; page <= pages; page++) {
        const rows = await api('GET', `/issues?labels=${ALERT_LABEL}&state=all&per_page=100&page=${page}`) ?? [];
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },
    async ensureLabel() {
      if (await api('GET', `/labels/${ALERT_LABEL}`)) return;
      await api('POST', '/labels', { name: ALERT_LABEL, color: 'b60205', description: "Neuro's scheduled scan found a high result for a new token" });
    },
    createIssue: (issue) => api('POST', '/issues', issue),
  };
}

const explorer = (_chain, v, kind) => (kind === 'tx' ? `${EXPLORER}tx/${v}` : `${EXPLORER}address/${v}`);

/**
 * One scan. Returns { status, pools, reports, created, skipped } (status:
 * 'paused' | 'rpc-unavailable' | 'done'). Everything injectable for tests.
 */
export async function scanPools({
  env = process.env, now = Date.now(), log = console.log, dryRun = false, fetchImpl = globalThis.fetch,
  rpc = null, github = null, investigateFn = investigate,
} = {}) {
  const from = Date.parse(env.NEURO_ALERTS_FROM ?? '2026-11-01T00:00:00Z');
  if (Number.isFinite(from) && now < from) {
    log(`neuro-alerts: paused until ${new Date(from).toISOString().slice(0, 10)} (ZETAPHY RPC paused); nothing to do`);
    return { status: 'paused', pools: [], reports: [], created: [], skipped: [] };
  }
  const budget = createBudget({ maxRequests: 200, timeMs: 5 * 60_000 });
  const client = rpc ?? createEvmClient([env.NEURO_RPC || ZETAPHY.rpc], ZETAPHY.chainId, { fetchImpl, budget });
  let logs;
  try {
    const head = toNum(await client.call('eth_blockNumber', []));
    const back = Math.min(head, 1000);
    const [h, old] = [await client.call('eth_getBlockByNumber', [hexBlock(head), false]), await client.call('eth_getBlockByNumber', [hexBlock(head - back), false])];
    const blockTime = back > 0 ? Math.max(0.5, (toNum(h?.timestamp) - toNum(old?.timestamp)) / back) : 2;
    const lookback = Math.ceil(Number(env.NEURO_LOOKBACK_SECONDS ?? 7200) / blockTime);
    const fromBlock = Math.max(0, head - lookback);
    logs = [];
    for (const [address, topic] of [[ZETAPHY.dex.factory, TOPIC.pairCreated], [ZETAPHY.dlmmFactory, TOPIC.dlmmPairCreated]]) {
      for (let f = fromBlock; f <= head; f += 10_000) {
        logs.push(...(await client.call('eth_getLogs', [{ address, topics: [topic], fromBlock: hexBlock(f), toBlock: hexBlock(Math.min(head, f + 9_999)) }]) ?? []));
      }
    }
  } catch (e) {
    log(`neuro-alerts: ZETAPHY RPC unavailable (${String(e?.message ?? e).slice(0, 120)}); skipping quietly`);
    return { status: 'rpc-unavailable', pools: [], reports: [], created: [], skipped: [] };
  }
  const pools = newTokensFromLogs(logs).slice(0, Number(env.NEURO_MAX_POOLS ?? 10));
  log(`neuro-alerts: ${pools.length} new token(s) in new pools`);
  const reports = [];
  for (const p of pools) {
    try {
      const r = await investigateFn({ chain: 'zetaphy', address: p.token, chainConfig: ZETAPHY_CHAIN, dex: ZETAPHY.dex }, {
        graphOptions: { fetchImpl, maxRequests: 150, timeMs: 45_000 },
        readOptions: { fetchImpl },
      });
      reports.push(r);
      log(`neuro-alerts: ${p.token} level=${r.level} score=${r.score} confidence=${r.confidence}`);
    } catch (e) {
      log(`neuro-alerts: ${p.token} not investigated (${String(e?.message ?? e).slice(0, 120)})`);
    }
  }
  const gh = github ?? (env.GITHUB_TOKEN && env.GITHUB_REPOSITORY ? githubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl }) : null);
  if (!gh) { log('neuro-alerts: no GITHUB_TOKEN / GITHUB_REPOSITORY: report only'); dryRun = true; }
  const existing = gh ? await gh.alertIssues() : [];
  const plan = planAlerts(reports, existing, { now, maxPerRun: Number(env.NEURO_MAX_ALERTS ?? 3) });
  for (const s of plan.skipped) if (s.reason !== 'below-threshold') log(`neuro-alerts: ${s.key} not opened (${s.reason})`);
  const created = [];
  if (plan.create.length && !dryRun) await gh.ensureLabel();
  for (const r of plan.create) {
    const issue = issueFor(r, { explorer });
    if (dryRun) { log(`neuro-alerts: [dry run] would open "${issue.title}"`); created.push({ dryRun: true, title: issue.title }); continue; }
    const out = await gh.createIssue(issue);
    created.push({ number: out?.number, title: issue.title });
    log(`neuro-alerts: opened #${out?.number}`);
  }
  return { status: 'done', pools, reports, created, skipped: plan.skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  scanPools({ dryRun: process.argv.includes('--dry-run') }).then(() => process.exit(0), (e) => {
    // Never fail loudly on the chain's or GitHub's hiccups: one line, exit 0.
    console.log(`neuro-alerts: stopped (${String(e?.message ?? e).slice(0, 200)})`);
    process.exit(0);
  });
}
