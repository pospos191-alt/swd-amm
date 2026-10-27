// ZETAPHY chain activity: how many transactions of each kind the chain has
// had (this month and since genesis), for the Neuro page and the explorer.
// Not in src/: it changes no verdict and is not part of the skill id.
//
// It asks the node for counts only: CometBFT tx_search with per_page=1 returns
// `total_count` and a single transaction, so a refresh costs a few dozen small
// requests whatever the chain's size. The PQ finality certificate that every
// block carries is left out. A refresh runs at most every REFRESH_SEC (a daily
// Vercel cron, or the first page view after that), so the node's free outbound
// data is not spent on page views.
//
// Stored in the counter's store (server/store.js: D1 or Redis) as numbers:
//   neuro:cs:t:<kind>            since genesis (or the oldest indexed block)
//   neuro:cs:m:<YYYY-MM>:<kind>  that month
//   neuro:cs:ms:<YYYY-MM>        first block of that month (found once)
//   neuro:cs:height, neuro:cs:at the last refresh (block, unix seconds)

export const CERT = '/zetaphy.pq.v1.MsgPQCertificate';
// Hyperlane Mailbox on ZETAPHY (zetaphy-chain/hyperlane/agent-config.json):
// messages from other chains are delivered by EVM transactions to it.
export const MAILBOX = '0x0f1C59C6e98c88E1ddc2Ff98Bee11dadA07fEaCe';

// Each kind: message types it counts, and EVM transactions to these addresses
// (`ethereum_tx.recipient`, checksummed). CometBFT queries have no OR, so each
// message type is counted on its own: a rare transaction with two message types
// of one kind (say delegate + withdraw rewards) counts twice. "all" is exact.
export const KINDS = {
  transfers: { actions: ['/cosmos.bank.v1beta1.MsgSend', '/cosmos.bank.v1beta1.MsgMultiSend'] },
  staking: {
    actions: ['/cosmos.staking.v1beta1.MsgDelegate', '/cosmos.staking.v1beta1.MsgUndelegate', '/cosmos.staking.v1beta1.MsgBeginRedelegate',
      '/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation', '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward'],
  },
  crossChain: { actions: ['/ibc.applications.transfer.v1.MsgTransfer', '/ibc.core.channel.v1.MsgRecvPacket'], recipients: [MAILBOX] },
  // all EVM transactions except the cross-chain deliveries above (counted there)
  evm: { actions: ['/cosmos.evm.vm.v1.MsgEthereumTx', '/zetaphy.pq.v1.MsgEVMCall'], minusRecipients: [MAILBOX] },
  governance: { actions: ['/cosmos.gov.v1.MsgSubmitProposal', '/cosmos.gov.v1.MsgVote', '/cosmos.gov.v1.MsgVoteWeighted', '/cosmos.gov.v1.MsgDeposit', '/cosmos.gov.v1beta1.MsgVote'] },
};
export const NAMES = ['all', ...Object.keys(KINDS)];

export const REFRESH_SEC = 6 * 3600;
const P = 'neuro:cs:';

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const quote = (v) => `'${String(v).replace(/'/g, '')}'`;

/**
 * A minimal CometBFT JSON-RPC client.
 * @param {string} url e.g. https://rpc.sawasdeecoin.com/rpc/
 */
export function cometClient(url, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  let id = 0;
  return async function call(method, params) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`comet HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error('comet: ' + String(j.error.message ?? 'error').slice(0, 80));
      return j.result;
    } finally {
      clearTimeout(t);
    }
  };
}

/** How many transactions in [lo, hi] match `cond` (a CometBFT query, or '' for all). */
async function count(comet, cond, lo, hi) {
  const q = [`tx.height>=${lo}`, `tx.height<=${hi}`, ...(cond ? [cond] : [])].join(' AND ');
  const r = await comet('tx_search', { query: q, prove: false, page: '1', per_page: '1', order_by: 'desc' });
  const n = Number(r?.total_count);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('comet: bad total_count');
  return n;
}

/** Counts of every kind in [lo, hi]. */
export async function countRange(comet, lo, hi) {
  if (hi < lo) return Object.fromEntries(NAMES.map((k) => [k, 0]));
  const c = (cond) => count(comet, cond, lo, hi);
  const sum = async (conds) => {
    let n = 0;
    for (const x of conds) n += await c(x); // one at a time: the node is small
    return n;
  };
  const action = (a) => `message.action=${quote(a)}`;
  const to = (a) => `ethereum_tx.recipient=${quote(a)}`;
  const out = { all: Math.max(0, (await c('')) - (await c(action(CERT)))) };
  for (const [k, d] of Object.entries(KINDS)) {
    const plus = await sum([...d.actions.map(action), ...(d.recipients ?? []).map(to)]);
    const minus = await sum((d.minusRecipients ?? []).map(to));
    out[k] = Math.max(0, plus - minus);
  }
  return out;
}

/** The first block at or after `ms` (UTC milliseconds), by binary search over block times. */
export async function firstBlockAt(comet, ms, earliest, latest) {
  const timeOf = async (h) => Date.parse((await comet('header', { height: String(h) }))?.header?.time);
  if ((await timeOf(earliest)) >= ms) return earliest;
  if ((await timeOf(latest)) < ms) return latest + 1;
  let lo = earliest; // time < ms
  let hi = latest; // time >= ms
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await timeOf(mid)) >= ms) hi = mid; else lo = mid;
  }
  return hi;
}

/** Recounts and stores everything. Returns what it stored. */
export async function refresh(store, comet, { now = () => Date.now() } = {}) {
  const st = await comet('status', {});
  const latest = Number(st?.sync_info?.latest_block_height);
  const earliest = Math.max(1, Number(st?.sync_info?.earliest_block_height) || 1);
  if (!Number.isSafeInteger(latest) || latest < 1) throw new Error('comet: bad status');
  const t = now();
  const month = monthOf(t);
  let [ms] = await store.pipeline([['GET', `${P}ms:${month}`]]);
  ms = ms == null ? null : Number(ms);
  if (!ms) {
    const d = new Date(t);
    ms = await firstBlockAt(comet, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), earliest, latest);
    await store.pipeline([['SET', `${P}ms:${month}`, ms]]);
  }
  // the two windows side by side (two requests at a time keeps the refresh well under the function's time limit)
  const [total, thisMonth] = await Promise.all([countRange(comet, 1, latest), countRange(comet, ms, latest)]);
  await store.pipeline([
    ...NAMES.map((k) => ['SET', `${P}t:${k}`, total[k]]),
    ...NAMES.map((k) => ['SET', `${P}m:${month}:${k}`, thisMonth[k]]),
    ['SET', `${P}height`, latest],
    ['SET', `${P}at`, Math.floor(t / 1000)],
  ]);
  return { month, height: latest, total, thisMonth };
}

/** What is stored, for the page. */
export async function read(store, { now = () => Date.now() } = {}) {
  const month = monthOf(now());
  const keys = [...NAMES.map((k) => `${P}t:${k}`), ...NAMES.map((k) => `${P}m:${month}:${k}`), `${P}height`, `${P}at`];
  const v = await store.pipeline(keys.map((k) => ['GET', k]));
  const num = (x) => (x == null ? null : Number(x));
  const pick = (off) => Object.fromEntries(NAMES.map((k, i) => [k, num(v[off + i]) ?? 0]));
  const at = num(v[2 * NAMES.length + 1]);
  return {
    month,
    height: num(v[2 * NAMES.length]),
    updatedAt: at ? new Date(at * 1000).toISOString() : null,
    total: pick(0),
    thisMonth: pick(NAMES.length),
  };
}

/**
 * GET /api/chain-stats. Refreshes first when the numbers are older than
 * REFRESH_SEC and this caller wins the hourly lock (so concurrent views or
 * repeated calls start at most one refresh an hour).
 */
export async function handleChainStats(req, store, comet, { now = () => Date.now() } = {}) {
  const headers = { 'access-control-allow-origin': '*' };
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, json: { error: 'method' }, headers: { ...headers, allow: 'GET' } };
  if (!store) return { status: 200, json: { enabled: false }, headers: { ...headers, 'cache-control': 'no-store' } };
  let data = await read(store, { now });
  let stale = !data.updatedAt || Date.parse(data.updatedAt) < now() - REFRESH_SEC * 1000;
  if (stale && comet) {
    const hour = Math.floor(now() / 3_600_000);
    const [n] = await store.pipeline([['INCR', `${P}lock:${hour}`], ['EXPIRE', `${P}lock:${hour}`, 7200]]);
    if (n === 1) {
      try {
        await refresh(store, comet, { now });
        data = await read(store, { now });
        stale = false;
      } catch { /* node unreachable (or its data allowance used up): keep the last numbers */ }
    }
  }
  return {
    status: 200,
    json: { enabled: true, ...data, stale },
    headers: { ...headers, 'cache-control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600' },
  };
}
