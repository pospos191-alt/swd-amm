// What the pages ask the node, on top of rpc.js (queue + cache). Every read
// here is bounded: recent history comes from scanning the last N blocks in the
// browser (there is no indexer), in aligned chunks so finished chunks stay cached.
import { getVoteKeyEntry, voteKeyAt, verifyBlock, sha256, bytesToHex, protoFields, toChecksumHex, hexToBytes } from '../vendor/zetaphy-lib.js';
import { TTL } from './rpc.js';
import { decodeTx, txAddresses, txLabel, normalizeEvents, decodeCoin, TYPES } from './cosmos.js';
import { fromBase64, toBase64, anyAddressLower, toBig, DENOM } from './format.js';

const enc = new TextEncoder();
const qty = (n) => '0x' + BigInt(n).toString(16);
export const CHUNK = 50;

export function chainApi(api) {
  const comet = api.comet; const evm = api.evm; const rest = api.rest;
  // pqcert.js's (method, params) => result, through the same queue and cache.
  const cometFor = (ttl) => (method, params) => comet(method, params, ttl);

  async function status() {
    const s = await comet('status', {}, TTL.latest);
    return {
      chainId: String(s?.node_info?.network ?? ''),
      height: String(s?.sync_info?.latest_block_height ?? '0'),
      time: String(s?.sync_info?.latest_block_time ?? ''),
      catchingUp: !!s?.sync_info?.catching_up,
      moniker: String(s?.node_info?.moniker ?? ''),
      version: String(s?.node_info?.version ?? ''),
    };
  }

  /** A committed block never changes: cached for hours. */
  const block = (h) => comet('block', { height: String(h) }, TTL.forever);
  const blockResults = (h) => comet('block_results', { height: String(h) }, TTL.forever);

  /** Block metas of [min, max] (CometBFT /blockchain gives at most 20 per call). */
  async function blockMetas(min, max, latest) {
    const out = [];
    for (let hi = Number(max); hi >= Number(min); hi -= 20) {
      const lo = Math.max(Number(min), hi - 19);
      const r = await comet('blockchain', { minHeight: String(lo), maxHeight: String(hi) }, hi < Number(latest) ? TTL.forever : TTL.latest);
      for (const m of r?.block_metas ?? []) out.push(m);
    }
    return out.sort((a, b) => Number(b.header.height) - Number(a.header.height));
  }

  /** The validator set at a height (all pages): [{ address, power (BigInt), pubKey (base64) }]. */
  async function cometValidators(height) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const r = await comet('validators', { height: String(height), page: String(page), per_page: '100' }, TTL.forever);
      const vs = r?.validators ?? [];
      for (const v of vs) out.push({ address: String(v.address).toUpperCase(), power: BigInt(v.voting_power), pubKey: String(v.pub_key?.value ?? '') });
      if (!vs.length || out.length >= Number(r.total ?? 0)) break;
    }
    return out;
  }

  /** Staking module validators (monikers, operators, status), keyed by consensus pubkey (base64). */
  async function stakingValidators() {
    const r = await rest('cosmos/staking/v1beta1/validators?pagination.limit=300', TTL.minute);
    return (r?.validators ?? []).map((v) => ({
      operator: String(v.operator_address ?? ''),
      moniker: String(v.description?.moniker ?? ''),
      website: String(v.description?.website ?? ''),
      details: String(v.description?.details ?? ''),
      tokens: toBig(v.tokens) ?? 0n,
      jailed: !!v.jailed,
      status: String(v.status ?? ''),
      commission: String(v.commission?.commission_rates?.rate ?? ''),
      pubKey: String(v.consensus_pubkey?.key ?? ''),
    }));
  }

  /**
   * Validators with their monikers, power and PQ vote keys at `height`:
   * [{ address, power, moniker, operator, jailed, status, commission, voteKey: { registered, since } }].
   * Staking validators outside the active set are listed too (power 0).
   */
  async function validators(height, { withKeys = true } = {}) {
    const [active, staking] = await Promise.all([cometValidators(height), stakingValidators().catch(() => [])]);
    const byKey = new Map(staking.map((s) => [s.pubKey, s]));
    const consOf = (pk) => { try { return bytesToHex(sha256(fromBase64(pk)).subarray(0, 20)).toUpperCase(); } catch { return ''; } };
    const rows = active.map((v) => ({ ...v, ...(byKey.get(v.pubKey) ?? {}), address: v.address, power: v.power, active: true }));
    const seen = new Set(rows.map((r) => r.pubKey));
    for (const s of staking) if (!seen.has(s.pubKey)) rows.push({ ...s, address: consOf(s.pubKey), power: 0n, active: false });
    if (withKeys) {
      const rpc = cometFor(TTL.minute);
      await Promise.all(rows.map(async (r) => {
        if (!r.address) { r.voteKey = { registered: null }; return; }
        try {
          const e = await getVoteKeyEntry(rpc, r.address, height);
          r.voteKey = { registered: !!voteKeyAt(e, BigInt(height) + 1n), since: e ? e.since.toString() : null, rotated: !!e?.previousPubKey };
        } catch (err) { r.voteKey = { registered: null, error: String(err.message ?? err) }; }
      }));
    }
    return rows.sort((a, b) => (b.power > a.power ? 1 : b.power < a.power ? -1 : Number(b.tokens ?? 0n) - Number(a.tokens ?? 0n)));
  }

  /** Total supply of azetaphy (falls with the fee burn and the dEaD burn). */
  async function supply() {
    const r = await rest(`cosmos/bank/v1beta1/supply/by_denom?denom=${DENOM}`, TTL.latest);
    return toBig(r?.amount?.amount);
  }

  /** Supply at an earlier state (abci_query of bank SupplyOf at `height`); null when pruned or refused. */
  async function supplyAt(height) {
    const denom = enc.encode(DENOM);
    const req = '0a' + denom.length.toString(16).padStart(2, '0') + bytesToHex(denom);
    try {
      const r = await comet('abci_query', { path: '/cosmos.bank.v1beta1.Query/SupplyOf', data: req, height: String(height), prove: false }, TTL.forever);
      if (r?.response?.code) return null;
      const f = protoFields(fromBase64(r?.response?.value ?? ''));
      const coin = f.find((x) => x.field === 1 && x.wire === 2);
      return coin ? toBig(decodeCoin(coin.value).amount) : null;
    } catch { return null; }
  }

  const stakingPool = () => rest('cosmos/staking/v1beta1/pool', TTL.short).then((r) => ({ bonded: toBig(r?.pool?.bonded_tokens) ?? 0n, notBonded: toBig(r?.pool?.not_bonded_tokens) ?? 0n }));

  /** A Cosmos tx by its CometBFT hash (hex): { height, index, txResult, bytes, decoded } or null. */
  async function cosmosTx(hashHex) {
    let r;
    try { r = await comet('tx', { hash: toBase64(hexToBytes(hashHex)), prove: false }, TTL.forever); } catch (e) {
      if (/not found/i.test(e.message)) return null;
      throw e;
    }
    const bytes = fromBase64(r.tx);
    return { height: String(r.height), index: Number(r.index ?? 0), txResult: { ...r.tx_result, events: normalizeEvents(r.tx_result?.events) }, bytes, decoded: decodeTx(bytes) };
  }

  const ttlFound = (v) => (v ? TTL.forever : TTL.latest);
  const evmTx = (hash) => evm('eth_getTransactionByHash', [hash], ttlFound);
  const evmReceipt = (hash) => evm('eth_getTransactionReceipt', [hash], ttlFound);
  const ethCall = (to, data) => evm('eth_call', [{ to, data }, 'latest'], TTL.short);

  async function account(addr) {
    const [balance, nonce, code, pq] = await Promise.all([
      evm('eth_getBalance', [addr.hex, 'latest'], TTL.latest),
      evm('eth_getTransactionCount', [addr.hex, 'latest'], TTL.latest),
      evm('eth_getCode', [addr.hex, 'latest'], TTL.short),
      evm('zetaphy_pqAccount', [addr.bech32], TTL.latest).catch((e) => ({ error: e.message })),
    ]);
    return { balance: toBig(balance), nonce: toBig(nonce), code: typeof code === 'string' ? code : '0x', pq };
  }

  const bankBalances = (bech32) => rest(`cosmos/bank/v1beta1/balances/${encodeURIComponent(bech32)}?pagination.limit=50`, TTL.latest).then((r) => r?.balances ?? []);
  const delegations = (bech32) => rest(`cosmos/staking/v1beta1/delegations/${encodeURIComponent(bech32)}`, TTL.short).then((r) => r?.delegation_responses ?? []);

  // ---- recent history: the last N blocks, scanned here ----

  const decodedCache = new Map(); // CometBFT hash -> decoded tx (bounded below)

  function summarize(item) {
    let d = decodedCache.get(item.hash);
    if (!d) {
      d = decodeTx(fromBase64(item.tx));
      decodedCache.set(item.hash, d);
      if (decodedCache.size > 3000) decodedCache.delete(decodedCache.keys().next().value);
    }
    const evmMsg = d.messages.find((m) => m.typeUrl === TYPES.ethereumTx);
    const first = d.messages[0];
    const field = (m, ...names) => m?.fields.find((f) => names.includes(f.name))?.value;
    let from = ''; let to = ''; let value = null;
    if (evmMsg) {
      from = field(evmMsg, 'from') || ''; to = evmMsg.evm?.to ?? ''; value = evmMsg.evm?.value ?? null;
    } else if (first) {
      from = field(first, 'from', 'sender', 'delegator', 'signer', 'voter', 'depositor', 'proposer', 'authority', 'operator') || '';
      to = field(first, 'to', 'validator', 'controller') || '';
      const amt = field(first, 'amount');
      const coin = Array.isArray(amt) ? amt[0] : amt;
      if (coin?.denom === DENOM) value = toBig(coin.amount);
      const v = field(first, 'value');
      if (typeof v === 'string' && /^\d+$/.test(v)) value = BigInt(v);
    }
    const code = Number(item.tx_result?.code ?? 0);
    return {
      cometHash: item.hash.toUpperCase(),
      hash: evmMsg?.evmHash ?? item.hash.toUpperCase(),
      evm: !!evmMsg,
      height: String(item.height),
      index: Number(item.index ?? 0),
      certificate: d.isCertificate,
      label: evmMsg ? (evmMsg.evm?.to ? (evmMsg.evm.selector || 'transfer') : 'contract creation') : txLabel(d),
      zetaphy: d.messages.some((m) => m.zetaphy),
      from, to, value, ok: code === 0, code,
      addresses: txAddresses(d, anyAddressLower),
    };
  }

  /** One aligned chunk [lo, hi] of txs (node's tx_search over a height range), newest first. */
  async function chunkTxs(lo, hi, latest, maxPages = 4) {
    const ttl = hi < Number(latest) ? TTL.forever : TTL.latest;
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await comet('tx_search', { query: `tx.height>=${lo} AND tx.height<=${hi}`, prove: false, page: String(page), per_page: '100', order_by: 'desc' }, ttl);
      const txs = r?.txs ?? [];
      out.push(...txs);
      if (txs.length < 100 || out.length >= Number(r?.total_count ?? 0)) return { txs: out, complete: true };
    }
    return { txs: out, complete: false };
  }

  /** Fallback when the node's tx_search is off: blocks with txs, one by one (bounded). */
  async function chunkTxsByBlocks(lo, hi, latest, budget) {
    const metas = await blockMetas(lo, hi, latest);
    const out = []; let complete = true;
    for (const m of metas) {
      if (!Number(m.num_txs)) continue;
      if (budget.left-- <= 0) { complete = false; break; }
      const h = m.header.height;
      const [b, res] = await Promise.all([block(h), blockResults(h).catch(() => null)]);
      (b?.block?.data?.txs ?? []).forEach((tx, i) => {
        const hash = bytesToHex(sha256(fromBase64(tx))).toUpperCase();
        out.push({ hash, height: h, index: i, tx, tx_result: res?.txs_results?.[i] ?? {} });
      });
    }
    return { txs: out.reverse(), complete };
  }

  let txSearchOff = false;

  /**
   * The txs of the last `n` blocks up to `latest`, newest first: { from, to, txs: [summary], certificates, complete, mode }.
   * onProgress(done, total) after each chunk.
   */
  async function recentTxs(latest, n, { onProgress, maxBlockFetches = 40 } = {}) {
    const top = Number(latest); const from = Math.max(1, top - Number(n) + 1);
    const chunks = [];
    for (let k = Math.floor((top - 1) / CHUNK); k * CHUNK + CHUNK >= from && k >= 0; k--) {
      chunks.push([Math.max(from, k * CHUNK + 1), Math.min(top, k * CHUNK + CHUNK)]);
    }
    const all = []; let complete = true; const budget = { left: maxBlockFetches };
    for (const [i, [lo, hi]] of chunks.entries()) {
      // Ask for the whole aligned chunk (cache key stays the same as the window moves), keep what is in range.
      const alo = Math.floor((lo - 1) / CHUNK) * CHUNK + 1; const ahi = Math.min(top, alo + CHUNK - 1);
      let r;
      if (!txSearchOff) {
        try { r = await chunkTxs(alo, ahi, top); } catch (e) {
          if (/tx_search|indexing|disabled|not found|Method/i.test(e.message)) txSearchOff = true; else throw e;
        }
      }
      if (txSearchOff) r = await chunkTxsByBlocks(lo, hi, top, budget);
      complete &&= r.complete;
      for (const t of r.txs) if (Number(t.height) >= lo && Number(t.height) <= hi) all.push(t);
      onProgress?.(i + 1, chunks.length);
    }
    const summaries = all.map(summarize).sort((a, b) => Number(b.height) - Number(a.height) || b.index - a.index);
    return { from: String(from), to: String(top), txs: summaries.filter((s) => !s.certificate), certificates: summaries.filter((s) => s.certificate).length, complete, mode: txSearchOff ? 'blocks' : 'tx_search' };
  }

  /** ERC-20/721/1155 Transfer logs touching `addrLower` in [from, to] (eth_getLogs, two queries). */
  async function transferLogs(addrLower, from, to, topics) {
    const t = '0x' + addrLower.slice(2).padStart(64, '0');
    const range = { fromBlock: qty(from), toBlock: qty(to) };
    const qs = [
      { ...range, topics: [[topics.transfer], t] }, // ERC-20 / 721: from
      { ...range, topics: [[topics.transfer], null, t] }, // to
      // ERC-1155 (operator, from, to): from, to
      { ...range, topics: [[topics.transferSingle, topics.transferBatch], null, t] },
      { ...range, topics: [[topics.transferSingle, topics.transferBatch], null, null, t] },
    ];
    const res = await Promise.all(qs.map((q) => evm('eth_getLogs', [q], TTL.short).catch(() => [])));
    const seen = new Set(); const out = [];
    for (const l of res.flat()) {
      const k = `${l.transactionHash}:${l.logIndex}`;
      if (!seen.has(k)) { seen.add(k); out.push(l); }
    }
    return out.sort((a, b) => Number(BigInt(b.blockNumber ?? 0) - BigInt(a.blockNumber ?? 0)));
  }

  /** Transfer logs emitted by a token contract in [from, to]. */
  const tokenLogs = (token, from, to, topics) => evm('eth_getLogs', [{ address: token, fromBlock: qty(from), toBlock: qty(to), topics: [[topics.transfer, topics.transferSingle, topics.transferBatch]] }], TTL.short)
    .then((l) => (Array.isArray(l) ? l : []).sort((a, b) => Number(BigInt(b.blockNumber ?? 0) - BigInt(a.blockNumber ?? 0))));

  /** The ML-DSA-44 certificate check of block H (pqcert.js verifyBlock, keys from this node). */
  const verifyPQ = (h, opts = {}) => verifyBlock(cometFor(TTL.forever), String(h), opts);

  /** A block by its hash (hex). */
  const blockByHash = (hash) => comet('block_by_hash', { hash: toBase64(hexToBytes(hash)) }, TTL.forever);

  return {
    status, block, blockResults, blockMetas, validators, cometValidators, stakingValidators, supply, supplyAt, stakingPool,
    cosmosTx, evmTx, evmReceipt, ethCall, account, bankBalances, delegations, recentTxs, transferLogs, tokenLogs, verifyPQ, blockByHash,
    evmCall: (m, p) => evm(m, p, TTL.short),
    consToHex: (a) => toChecksumHex(hexToBytes(a)),
  };
}
