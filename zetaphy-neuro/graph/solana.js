// Money-flow data for SPL tokens on Solana, from the public RPC only:
// getSignaturesForAddress (newest first, paged) and getTransaction (jsonParsed).
import { BudgetError } from './util.js';

const TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
const SYSTEM = '11111111111111111111111111111111';

const keyOf = (k) => (typeof k === 'string' ? k : k?.pubkey);

/**
 * @param {{call: Function}} p.rpc  graph/clients.js createSolanaClient
 * @param {number} [p.maxPages=3]   signature pages (1000 each) when looking for the oldest
 */
export function createSolanaProvider({ rpc, src = {}, maxPages = 3 }) {
  const notes = [];
  const note = (n) => { if (!notes.includes(n)) notes.push(n); };
  const busyAt = src.hubSignatures ?? 1000;
  const sigCount = new Map();

  /** Oldest signatures of an address (oldest first), and whether we reached the true start. */
  async function oldest(addr, want = 10) {
    let before;
    let all = [];
    let complete = false;
    for (let page = 0; page < maxPages; page++) {
      const rows = (await rpc.call('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}) }])) ?? [];
      all = all.concat(rows);
      if (page === 0) sigCount.set(addr, rows.length);
      if (rows.length < 1000) { complete = true; break; }
      before = rows[rows.length - 1].signature;
    }
    if (!complete) note('history-too-long');
    return { sigs: all.reverse().filter((s) => !s.err).slice(0, want), complete, total: all.length };
  }

  const getTx = (sig) => rpc.call('getTransaction', [sig, TX_OPTS], { cache: true });

  async function creation(mint) {
    const { sigs, complete } = await oldest(mint, 1);
    if (!sigs.length) return null;
    const tx = await getTx(sigs[0].signature);
    const payer = keyOf(tx?.transaction?.message?.accountKeys?.[0]);
    return payer ? { deployer: payer, creator: payer, tx: sigs[0].signature, block: tx.slot ?? sigs[0].slot ?? null, source: complete ? 'rpc' : 'rpc-oldest-seen' } : null;
  }

  /** The first SOL transfer into `addr` among its oldest transactions. */
  async function funderOf(addr) {
    try {
      const { sigs } = await oldest(addr, 5);
      for (const s of sigs) {
        const tx = await getTx(s.signature);
        const ixs = [...(tx?.transaction?.message?.instructions ?? []), ...(tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])];
        for (const ix of ixs) {
          const info = ix?.parsed?.info;
          if (ix?.programId === SYSTEM && ['transfer', 'createAccount', 'transferWithSeed'].includes(ix?.parsed?.type)
            && (info?.destination === addr || info?.newAccount === addr) && Number(info?.lamports) > 0) {
            return { funder: info.source, tx: s.signature, value: String(info.lamports), block: tx.slot ?? null };
          }
        }
      }
      return null;
    } catch (e) {
      if (e instanceof BudgetError) throw e;
      note('funding-lookup-failed');
      return null;
    }
  }

  /** Busy (≥ 1000 transactions in its first page) or a program: a hub. */
  async function profile(addr) {
    if (!sigCount.has(addr)) {
      const rows = (await rpc.call('getSignaturesForAddress', [addr, { limit: 1000 }])) ?? [];
      sigCount.set(addr, rows.length);
    }
    const info = await rpc.call('getAccountInfo', [addr, { encoding: 'base64' }]);
    const contract = !!info?.value?.executable;
    const n = sigCount.get(addr);
    return { contract, nonce: n, hub: contract || n >= busyAt };
  }

  /** Owners that received the mint in its first transactions (post token balances). */
  async function earlyReceivers(mint, _fromBlock, { limit = 20, exclude = new Set() } = {}) {
    const { sigs, complete } = await oldest(mint, 15);
    const seen = new Map();
    for (const s of sigs) {
      if (seen.size >= limit) break;
      const tx = await getTx(s.signature);
      const pre = new Map((tx?.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint).map((b) => [b.owner, BigInt(b.uiTokenAmount?.amount ?? 0)]));
      for (const b of tx?.meta?.postTokenBalances ?? []) {
        if (b.mint !== mint || !b.owner || exclude.has(b.owner)) continue;
        const gain = BigInt(b.uiTokenAmount?.amount ?? 0) - (pre.get(b.owner) ?? 0n);
        if (gain <= 0n || seen.has(b.owner)) continue;
        seen.set(b.owner, { addr: b.owner, amount: gain.toString(), tx: s.signature, block: tx.slot ?? null, minted: false });
        if (seen.size >= limit) break;
      }
    }
    return { receivers: [...seen.values()], mints: [], minted: '0', logsRead: sigs.length, complete };
  }

  const none = async () => null;
  return { kind: 'solana', creation, funderOf, profile, earlyReceivers, findPair: none, liquidity: none, lpHolding: none, priorContracts: async () => [], notes };
}
