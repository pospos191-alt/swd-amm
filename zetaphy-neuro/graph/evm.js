// Money-flow data for EVM chains (Ethereum, BNB Chain, Base, Arbitrum, ZETAPHY).
// Each function returns facts with their evidence (transaction hashes) or
// null / [] when the free sources cannot say; it never guesses.
import { bech32Encode, bech32Decode } from '../src/bech32.js';
import { BudgetError, TOPIC, ZERO, DEAD, lc, toBig, toNum, hexBlock, topicAddr, dataWord, addrWord, selector, isEvmAddress } from './util.js';

const SEL = { getPair: selector('getPair(address,address)'), totalSupply: selector('totalSupply()'), balanceOf: selector('balanceOf(address)') };
const hexToBytes = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Normalised log: { address, topics, data, block, tx, index }. */
const normLog = (l) => ({
  address: lc(l.address), topics: (l.topics ?? []).filter((t) => t != null).map(lc), data: l.data ?? '0x',
  block: toNum(l.blockNumber), tx: lc(l.transactionHash), index: toNum(l.logIndex),
});

/**
 * @param {object} p
 * @param {{call: Function, supports?: Function}} p.rpc        graph/clients.js createEvmClient
 * @param {{get: Function}|null} [p.blockscout]                 graph/clients.js createBlockscout
 * @param {{get: Function}|null} [p.cosmos]                     Cosmos REST of the same chain (ZETAPHY)
 * @param {object} p.src                                        graph/sources.js sourcesFor(...)
 * @param {number} [p.maxLogChunks=12]                          RPC log windows per query
 */
export function createEvmProvider({ rpc, blockscout = null, cosmos = null, src, maxLogChunks = 12 }) {
  const range = src.logRange ?? 5_000;
  let latestP = null;
  const latest = () => (latestP ??= rpc.call('eth_blockNumber', []).then(toNum));
  const getTx = (h) => rpc.call('eth_getTransactionByHash', [h], { cache: true });
  const rethrowBudget = (e) => { if (e instanceof BudgetError) throw e; };
  const notes = [];
  const note = (n) => { if (!notes.includes(n)) notes.push(n); };

  /** Logs of `address` with topic0, from `fromBlock` on, at most `max` of them (oldest first). */
  async function logs({ address, topic0, fromBlock, max = 500, extraTopics = [] }) {
    if (blockscout) {
      try {
        const params = { module: 'logs', action: 'getLogs', address, fromBlock: Math.max(0, fromBlock ?? 0), toBlock: 'latest', topic0 };
        const rows = await blockscout.get(params);
        return { logs: rows.map(normLog).sort((a, b) => a.block - b.block || a.index - b.index).slice(0, max), complete: rows.length < 1000 };
      } catch (e) { rethrowBudget(e); note('blockscout-logs-failed'); }
    }
    const head = await latest();
    let from = fromBlock ?? Math.max(0, head - range * maxLogChunks);
    const out = [];
    let chunks = 0;
    while (from <= head && chunks < maxLogChunks && out.length < max) {
      const to = Math.min(from + range - 1, head);
      const rows = await rpc.call('eth_getLogs', [{ address, topics: [topic0, ...extraTopics], fromBlock: hexBlock(from), toBlock: hexBlock(to) }], { cache: to < head - 64 });
      out.push(...(rows ?? []).map(normLog));
      from = to + 1;
      chunks++;
    }
    if (from <= head) note('logs-window-limited');
    return { logs: out.sort((a, b) => a.block - b.block || a.index - b.index).slice(0, max), complete: from > head && out.length < max };
  }

  /** Who deployed `token`: { deployer, creator, tx, block, source } or null. */
  async function creation(token) {
    if (blockscout) {
      try {
        const [r] = await blockscout.get({ module: 'contract', action: 'getcontractcreation', contractaddresses: token });
        if (r?.txHash) {
          const tx = await getTx(r.txHash);
          return { deployer: lc(tx?.from ?? r.contractCreator), creator: lc(r.contractCreator), tx: lc(r.txHash), block: tx ? toNum(tx.blockNumber) : null, source: 'blockscout' };
        }
      } catch (e) { rethrowBudget(e); note('blockscout-creation-failed'); }
    }
    // RPC only: the first block with code (binary search; needs historical state).
    try {
      const head = await latest();
      const has = async (b) => { const c = await rpc.call('eth_getCode', [token, hexBlock(b)], { cache: b < head - 64 }); return !!c && c !== '0x'; };
      if (!(await has(head))) return null;
      let lo = 0; let hi = head;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid + 1; }
      const block = lo;
      // The creation transaction: the first log the token emitted in that block, else a receipt naming it.
      const [first] = (await rpc.call('eth_getLogs', [{ address: token, fromBlock: hexBlock(block), toBlock: hexBlock(block) }], { cache: true })) ?? [];
      if (first?.transactionHash) {
        const tx = await getTx(first.transactionHash);
        return { deployer: lc(tx?.from), creator: lc(tx?.to ?? tx?.from), tx: lc(first.transactionHash), block, source: 'rpc' };
      }
      const blk = await rpc.call('eth_getBlockByNumber', [hexBlock(block), false], { cache: true });
      for (const h of (blk?.transactions ?? []).slice(0, 25)) {
        const rc = await rpc.call('eth_getTransactionReceipt', [h], { cache: true });
        if (lc(rc?.contractAddress) === token) return { deployer: lc(rc.from), creator: lc(rc.from), tx: lc(h), block, source: 'rpc' };
      }
      return { deployer: null, creator: null, tx: null, block, source: 'rpc' };
    } catch (e) {
      rethrowBudget(e);
      note('creation-unknown');
      return null;
    }
  }

  /** The origin EOA of a transaction (who signed it). */
  const originOf = async (hash) => lc((await getTx(hash))?.from ?? '') || null;

  async function funderViaCosmos(addr) {
    if (!cosmos || !src.bech32) return null;
    const b = bech32Encode(src.bech32, hexToBytes(addr));
    for (const q of ['query', 'events']) {
      try {
        const r = await cosmos.get(`/cosmos/tx/v1beta1/txs?${q}=transfer.recipient='${b}'&order_by=ORDER_BY_ASC&pagination.limit=5`);
        for (const tx of r?.tx_responses ?? []) {
          const events = tx.events ?? (tx.logs ?? []).flatMap((l) => l.events ?? []);
          for (const ev of events) {
            if (ev.type !== 'transfer') continue;
            const attrs = ev.attributes ?? [];
            for (let i = 0; i < attrs.length; i++) {
              if (attrs[i].key !== 'recipient' || attrs[i].value !== b) continue;
              const sender = attrs.slice(Math.max(0, i - 2), i + 3).find((a) => a.key === 'sender')?.value;
              if (!sender) continue;
              let funder;
              try { funder = bytesToHex(bech32Decode(sender).bytes); } catch { continue; }
              if (funder.length !== 42) continue; // a module account with a longer address: skip
              return { funder, tx: String(tx.txhash ?? '').toLowerCase(), block: Number(tx.height) || null, value: String(attrs.find((a) => a.key === 'amount')?.value ?? ''), source: 'cosmos' };
            }
          }
        }
        if (r) return null;
      } catch (e) { rethrowBudget(e); }
    }
    note('cosmos-funding-unavailable');
    return null;
  }

  /** The first native-coin transfer into `addr`: { funder, tx, value, block, via? } or null. */
  async function funderOf(addr) {
    if (blockscout) {
      try {
        const opts = { address: addr, sort: 'asc', page: 1, offset: 50 };
        const txs = await blockscout.get({ module: 'account', action: 'txlist', ...opts });
        const ext = txs.find((t) => lc(t.to) === addr && toBig(t.value) > 0n && t.isError !== '1');
        const ints = await blockscout.get({ module: 'account', action: 'txlistinternal', ...opts });
        const int = ints.find((t) => lc(t.to) === addr && toBig(t.value) > 0n && t.isError !== '1');
        const blockOf = (t) => (t ? Number(t.blockNumber) : Infinity);
        if (ext && blockOf(ext) <= blockOf(int)) return { funder: lc(ext.from), tx: lc(ext.hash), value: String(ext.value), block: Number(ext.blockNumber) };
        if (int) {
          const hash = lc(int.transactionHash ?? int.hash);
          // Sent by a contract (a disperser, a bridge): the trail continues at whoever called it.
          return { funder: (await originOf(hash)) ?? lc(int.from), tx: hash, value: String(int.value), block: Number(int.blockNumber), via: lc(int.from) };
        }
        return null;
      } catch (e) { rethrowBudget(e); note('blockscout-funding-failed'); }
    }
    if (rpc.supports?.('trace_filter') !== false) {
      try {
        const traces = await rpc.call('trace_filter', [{ toAddress: [addr], fromBlock: '0x0', toBlock: 'latest', count: 25 }], { cache: true });
        const t = (traces ?? []).find((x) => !x.error && x.type === 'call' && toBig(x.action?.value) > 0n);
        if (t) {
          const internal = (t.traceAddress ?? []).length > 0;
          return {
            funder: internal ? (await originOf(t.transactionHash)) ?? lc(t.action.from) : lc(t.action.from),
            tx: lc(t.transactionHash), value: toBig(t.action.value).toString(), block: Number(t.blockNumber), ...(internal ? { via: lc(t.action.from) } : {}),
          };
        }
        if (traces) return null;
      } catch (e) { rethrowBudget(e); }
    }
    const c = await funderViaCosmos(addr);
    if (c) return c;
    if (!cosmos) note('funding-source-unavailable');
    return null;
  }

  /** { contract, nonce, hub }: a busy sender or a contract is a hub (see walk.js). */
  async function profile(addr) {
    const [code, nonceHex] = [await rpc.call('eth_getCode', [addr, 'latest']), await rpc.call('eth_getTransactionCount', [addr, 'latest'])];
    const contract = !!code && code !== '0x';
    const nonce = toNum(nonceHex);
    return { contract, nonce, hub: contract || nonce >= (src.hubNonce ?? 5_000) };
  }

  /**
   * The first wallets that received the token (from creation on): the mint
   * receivers and the first transfer receivers, in order.
   */
  async function earlyReceivers(token, fromBlock, { limit = 20, exclude = new Set() } = {}) {
    const { logs: rows, complete } = await logs({ address: token, topic0: TOPIC.transfer, fromBlock, max: 400 });
    const seen = new Map();
    const mints = [];
    let minted = 0n;
    for (const l of rows) {
      if (l.address !== token || l.topics.length < 3) continue;
      const from = topicAddr(l.topics[1]); const to = topicAddr(l.topics[2]);
      const v = dataWord(l.data, 0);
      if (from === ZERO) { minted += v; mints.push({ to, amount: v.toString(), tx: l.tx, block: l.block }); }
      if (DEAD.has(to) || to === token || exclude.has(to)) continue;
      const r = seen.get(to);
      if (r) { r.amount = (BigInt(r.amount) + v).toString(); continue; }
      if (seen.size >= limit) continue;
      seen.set(to, { addr: to, amount: v.toString(), tx: l.tx, block: l.block, minted: from === ZERO, from });
    }
    return { receivers: [...seen.values()], mints: mints.slice(0, 20), minted: minted.toString(), logsRead: rows.length, complete };
  }

  /** The V2-style pool of token/native on the chain's DEX, or null. */
  async function findPair(token) {
    const dex = src.dex;
    if (!dex) return null;
    try {
      const w = await rpc.call('eth_call', [{ to: dex.factory, data: '0x' + SEL.getPair + addrWord(token) + addrWord(dex.weth) }, 'latest']);
      const pair = topicAddr(w);
      return pair === ZERO ? null : { pair, dex: dex.name };
    } catch (e) { rethrowBudget(e); return null; }
  }

  /**
   * Liquidity added and removed in a V2-style pool, per provider, from the LP
   * token's own Transfer events and the pool's Burn events.
   */
  async function liquidity(pair, fromBlock) {
    const { logs: transfers, complete } = await logs({ address: pair, topic0: TOPIC.transfer, fromBlock, max: 600 });
    const { logs: burns } = await logs({ address: pair, topic0: TOPIC.burn, fromBlock, max: 300 });
    const providers = new Map();
    const P = (a) => { if (!providers.has(a)) providers.set(a, { addr: a, added: 0n, removed: 0n, burned: 0n, addTxs: [], removeTxs: [], receivers: [], firstAddBlock: null, lastRemoveBlock: null }); return providers.get(a); };
    const sentToPair = new Map(); // tx -> [{from, value}]
    let totalAdded = 0n; let totalRemoved = 0n; let totalBurned = 0n;
    for (const l of transfers) {
      if (l.topics.length < 3) continue;
      const from = topicAddr(l.topics[1]); const to = topicAddr(l.topics[2]);
      const v = dataWord(l.data, 0);
      if (from === ZERO && to !== ZERO) {
        const p = P(to); p.added += v; totalAdded += v; p.firstAddBlock ??= l.block;
        if (p.addTxs.length < 5) p.addTxs.push(l.tx);
      } else if (to === pair) {
        if (!sentToPair.has(l.tx)) sentToPair.set(l.tx, []);
        sentToPair.get(l.tx).push({ from, value: v });
      } else if (DEAD.has(to) && from !== pair && from !== ZERO) {
        const p = P(from); p.burned += v; totalBurned += v;
      }
    }
    for (const b of burns) {
      const sent = sentToPair.get(b.tx);
      if (!sent) continue;
      const to = b.topics.length >= 3 ? topicAddr(b.topics[2]) : null;
      for (const s of sent) {
        const p = P(s.from); p.removed += s.value; totalRemoved += s.value;
        p.lastRemoveBlock = Math.max(p.lastRemoveBlock ?? 0, b.block);
        if (p.removeTxs.length < 5 && !p.removeTxs.includes(b.tx)) p.removeTxs.push(b.tx);
        if (to && !p.receivers.includes(to) && p.receivers.length < 5) p.receivers.push(to);
      }
      sentToPair.delete(b.tx);
    }
    const list = [...providers.values()].map((p) => ({ ...p, added: p.added.toString(), removed: p.removed.toString(), burned: p.burned.toString() }));
    return { pair, providers: list, totalAdded: totalAdded.toString(), totalRemoved: totalRemoved.toString(), totalBurned: totalBurned.toString(), complete };
  }

  /** LP tokens `who` holds now and the pool's total supply (decimal strings). */
  async function lpHolding(pair, who) {
    try {
      const [bal, total] = [
        await rpc.call('eth_call', [{ to: pair, data: '0x' + SEL.balanceOf + addrWord(who) }, 'latest']),
        await rpc.call('eth_call', [{ to: pair, data: '0x' + SEL.totalSupply }, 'latest']),
      ];
      return { balance: toBig(bal).toString(), total: toBig(total).toString() };
    } catch (e) { rethrowBudget(e); return null; }
  }

  /** Other contracts this deployer created (most recent first, at most `limit`). */
  async function priorContracts(deployer, { exclude = new Set(), limit = 8 } = {}) {
    if (!blockscout) { note('prior-contracts-unavailable'); return []; }
    try {
      const txs = await blockscout.get({ module: 'account', action: 'txlist', address: deployer, sort: 'desc', page: 1, offset: 200 });
      const out = [];
      for (const t of txs) {
        const c = lc(t.contractAddress);
        if (!isEvmAddress(c) || (t.to && t.to !== '') || exclude.has(c) || t.isError === '1') continue;
        out.push({ addr: c, tx: lc(t.hash), block: Number(t.blockNumber) });
        if (out.length >= limit) break;
      }
      return out;
    } catch (e) { rethrowBudget(e); note('prior-contracts-failed'); return []; }
  }

  return { kind: 'evm', creation, funderOf, profile, earlyReceivers, findPair, liquidity, lpHolding, priorContracts, logs, notes };
}
