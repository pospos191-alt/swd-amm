// Parametric hack insurance, testnet only (docs/future/crosschain-assist.md, item 32): Neuro's deterministic
// forensic replay. A claim on HackInsurance names a chain, a covered target, the exploit's transaction hashes and a
// block range. This module turns that into a report every runner can recompute bit for bit:
//
//   1. fetch the original transactions and receipts from the chain (they must lie in [fromBlock, toBlock], and
//      toBlock must be `confirmations` blocks behind the head: a load-balanced public RPC may not have the newest
//      blocks yet, and the newest blocks may still reorg);
//   2. fork the chain at fromBlock - 1 with anvil (foundry pinned, FOUNDRY_VERSION) and replay ONLY those
//      transactions, in chain order, each in a block with its original number, timestamp, base fee and coinbase;
//      every other transaction of the range is left out on purpose (the report is "what these transactions did");
//   3. diff the target's balances: native, every ERC-20 given and every ERC-20 a replayed transaction moved to or
//      from the target (Transfer logs); before = the fork state, after = the state after the replay;
//   4. price the deltas in wei of the chain's native coin, only from explicitly given prices or from on-chain data
//      read at the fork state (a ZetaphyOracle: price(token) / price(native asset), both USD with 18 decimals);
//      anything else is listed as unpriced and counts zero;
//   5. loss = max(0, -(sum of the priced deltas)); the report is canonical JSON (canonicalJson) and its hash is
//      keccak256 of those bytes: the `reportHash` HackInsurance.fileClaim / vote take, with `loss`.
//
// The report holds no wall clock, path, host or tool output that could differ between two honest runs: the same
// inputs, the same chain data and the same pinned anvil give the same bytes and the same hash.
import { AbiCoder, Interface, keccak256, toUtf8Bytes, getAddress, id as topicId } from 'ethers';

export const REPLAY_KIND = 'zetaphy.insurance.replay';
export const REPLAY_VERSION = 1;
/** The foundry release every runner uses (the same pin as the workflows' foundry-toolchain). */
export const FOUNDRY_VERSION = 'v1.2.3';
export const TRANSFER_TOPIC = topicId('Transfer(address,address,uint256)');
export const MAX_TXS = 16; // HackInsurance.MAX_TXS
const abi = AbiCoder.defaultAbiCoder();
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
const ORACLE = new Interface(['function price(address asset) view returns (uint256 value, uint256 updatedAt)']);
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const lower = (a) => getAddress(a).toLowerCase();

// ---------------------------------------------------------------- canonical JSON and the hashes

/**
 * Canonical JSON: object keys sorted (code-unit order), no whitespace, every integer a decimal string (bigint or a
 * safe integer number), strings ASCII only, no undefined / NaN / floats. The same value always gives the same bytes.
 */
export function canonicalJson(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return `"${v.toString()}"`;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`canonical JSON: ${v} is not a safe integer`);
    return `"${String(v)}"`;
  }
  if (typeof v === 'string') {
    if (!/^[\x20-\x7e]*$/.test(v)) throw new Error('canonical JSON: strings are printable ASCII only');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => {
      if (v[k] === undefined) throw new Error(`canonical JSON: ${k} is undefined`);
      return `${canonicalJson(k)}:${canonicalJson(v[k])}`;
    }).join(',')}}`;
  }
  throw new Error(`canonical JSON: cannot encode a ${typeof v}`);
}

/** keccak256 of the report's canonical JSON: HackInsurance's reportHash. */
export const reportHash = (report) => keccak256(toUtf8Bytes(canonicalJson(report)));

/** HackInsurance.targetKey / ThreatRegistry.addressKey. */
export const targetKeyOf = (chainId, target) => keccak256(abi.encode(['string', 'uint256', 'address'], ['zetaphy.threat.address', BigInt(chainId), getAddress(target)]));

/** HackInsurance.evidenceHash (with block.chainid = chainId). */
export const evidenceHashOf = (chainId, targetKey, txHashes, fromBlock, toBlock) =>
  keccak256(abi.encode(['uint256', 'bytes32', 'bytes32[]', 'uint64', 'uint64'], [BigInt(chainId), targetKey, txHashes, BigInt(fromBlock), BigInt(toBlock)]));

// ---------------------------------------------------------------- the request

const uint = (v, what) => {
  const s = String(v ?? '');
  if (!/^[0-9]{1,30}$/.test(s)) throw new Error(`${what}: a whole number`);
  return BigInt(s);
};

/**
 * Checks and normalizes what is replayed: { chainId, target, txHashes, fromBlock, toBlock, tokens, prices, oracle, hardfork }.
 * prices: { <token>: <wei of native per whole token> }; oracle: { address, nativeAsset } (a ZetaphyOracle) or null.
 */
export function normalizeRequest(r) {
  const chainId = uint(r.chainId, 'chainId');
  if (chainId === 0n) throw new Error('chainId: above 0');
  if (!ADDR.test(String(r.target ?? ''))) throw new Error('target: a 0x address');
  const txHashes = [].concat(r.txHashes ?? []).map((h) => String(h).toLowerCase());
  if (txHashes.length < 1 || txHashes.length > MAX_TXS) throw new Error(`txHashes: 1 to ${MAX_TXS}`);
  for (const h of txHashes) if (!HEX32.test(h)) throw new Error(`txHashes: ${h} is not a 0x + 64 hex transaction hash`);
  if (new Set(txHashes).size !== txHashes.length) throw new Error('txHashes: a hash is listed twice');
  const fromBlock = uint(r.fromBlock, 'fromBlock'), toBlock = uint(r.toBlock, 'toBlock');
  if (fromBlock < 1n || fromBlock > toBlock) throw new Error('fromBlock: at least 1 and not after toBlock');
  const tokens = [...new Set([].concat(r.tokens ?? []).map((t) => { if (!ADDR.test(String(t))) throw new Error(`tokens: ${t} is not an address`); return lower(t); }))].sort();
  const prices = {};
  for (const [t, w] of Object.entries(r.prices ?? {})) {
    if (!ADDR.test(t)) throw new Error(`prices: ${t} is not an address`);
    prices[lower(t)] = uint(w, `price of ${t}`).toString();
  }
  let oracle = null;
  if (r.oracle) {
    if (!ADDR.test(String(r.oracle.address ?? '')) || !ADDR.test(String(r.oracle.nativeAsset ?? ''))) throw new Error('oracle: { address, nativeAsset } (0x addresses)');
    oracle = { address: lower(r.oracle.address), nativeAsset: lower(r.oracle.nativeAsset) };
  }
  const hardfork = r.hardfork == null ? null : String(r.hardfork);
  if (hardfork != null && !/^[a-z]{1,20}$/.test(hardfork)) throw new Error('hardfork: a name such as cancun or prague');
  return { chainId, target: lower(r.target), txHashes, fromBlock, toBlock, tokens, prices, oracle, hardfork };
}

// ---------------------------------------------------------------- the report (pure)

/** Tokens a replayed transaction moved to or from the target (ERC-20 Transfer logs: 3 topics). */
export function tokensMoved(results, target) {
  const t = '0x' + '00'.repeat(12) + target.slice(2).toLowerCase();
  const out = new Set();
  for (const r of results) for (const l of r.logs ?? []) {
    if (l.topics?.length === 3 && l.topics[0].toLowerCase() === TRANSFER_TOPIC && (l.topics[1].toLowerCase() === t || l.topics[2].toLowerCase() === t)) out.add(lower(l.address));
  }
  return [...out].sort();
}

/**
 * Builds the report from what was observed. `obs`: { fork: { block, hash, timestamp }, txs: [{ hash, block, index,
 * timestamp, from, to, status, replayStatus }], assets: [{ asset: 'native' | 0x…, decimals, before, after,
 * price: null | { source, weiPerToken } }] }. Values are bigints or decimal strings.
 */
export function buildReport(req, obs) {
  const r = normalizeRequest(req);
  const targetKey = targetKeyOf(r.chainId, r.target);
  const assets = obs.assets.map((a) => {
    const before = BigInt(a.before), after = BigInt(a.after), delta = after - before;
    const decimals = a.decimals == null ? null : Number(a.decimals);
    const price = a.price ? { source: a.price.source, weiPerToken: BigInt(a.price.weiPerToken).toString() } : null;
    // value of the delta in wei of the native coin, truncated toward zero
    const valueDelta = price && decimals != null ? (delta * BigInt(price.weiPerToken)) / 10n ** BigInt(decimals) : null;
    return { asset: a.asset === 'native' ? 'native' : lower(a.asset), decimals: decimals == null ? null : String(decimals),
      before: before.toString(), after: after.toString(), delta: delta.toString(), price, valueDelta: valueDelta == null ? null : valueDelta.toString() };
  }).sort((x, y) => (x.asset === 'native' ? -1 : y.asset === 'native' ? 1 : x.asset < y.asset ? -1 : x.asset > y.asset ? 1 : 0));
  const net = assets.reduce((s, a) => s + (a.valueDelta == null ? 0n : BigInt(a.valueDelta)), 0n);
  const txs = obs.txs.map((t) => ({ hash: t.hash.toLowerCase(), block: String(t.block), index: String(t.index), timestamp: String(t.timestamp),
    from: lower(t.from), to: t.to ? lower(t.to) : null, status: t.status ? 'success' : 'reverted', replay: t.replayStatus ? 'success' : 'reverted' }));
  return {
    kind: REPLAY_KIND,
    version: String(REPLAY_VERSION),
    engine: { tool: 'anvil', foundry: FOUNDRY_VERSION, hardfork: r.hardfork ?? 'default' },
    chainId: r.chainId.toString(),
    target: r.target,
    targetKey,
    txHashes: r.txHashes,
    fromBlock: r.fromBlock.toString(),
    toBlock: r.toBlock.toString(),
    evidenceHash: evidenceHashOf(r.chainId, targetKey, r.txHashes, r.fromBlock, r.toBlock),
    fork: { block: String(obs.fork.block), hash: obs.fork.hash.toLowerCase(), timestamp: String(obs.fork.timestamp) },
    txs,
    matchesOriginal: txs.every((t) => t.status === t.replay),
    pricing: { explicit: r.prices, oracle: r.oracle },
    assets,
    unpriced: assets.filter((a) => a.valueDelta == null && a.delta !== '0').map((a) => a.asset),
    loss: (net < 0n ? -net : 0n).toString(),
  };
}

/** Checks a report read back from a file: shape and its own hashes. { ok, hash, problems }. */
export function checkReport(report) {
  const problems = [];
  if (report?.kind !== REPLAY_KIND || report?.version !== String(REPLAY_VERSION)) problems.push(`not a ${REPLAY_KIND} v${REPLAY_VERSION} report`);
  let hash = null;
  try { hash = reportHash(report); } catch (e) { problems.push(e.message); }
  try {
    const key = targetKeyOf(report.chainId, report.target);
    if (key !== report.targetKey) problems.push('targetKey does not match chainId and target');
    if (evidenceHashOf(report.chainId, key, report.txHashes, report.fromBlock, report.toBlock) !== report.evidenceHash) problems.push('evidenceHash does not match the evidence');
  } catch (e) { problems.push(`evidence: ${e.message}`); }
  return { ok: problems.length === 0, hash, problems };
}

/** The request a report was made from (to recompute it). */
export const requestOf = (report) => ({
  chainId: report.chainId, target: report.target, txHashes: report.txHashes, fromBlock: report.fromBlock, toBlock: report.toBlock,
  tokens: report.assets.filter((a) => a.asset !== 'native').map((a) => a.asset), prices: report.pricing?.explicit ?? {},
  oracle: report.pricing?.oracle ?? null, hardfork: report.engine?.hardfork === 'default' ? null : report.engine?.hardfork,
});

// ---------------------------------------------------------------- the replay (source + engine)

/**
 * Replays and reports. `source`: the chain (chainId(), blockNumber(), tx(hash), block(n)); `engine`: a fork of it
 * at fromBlock - 1 (start, snapshot, revert, balance, call, replay, stop): anvilEngine() or a test engine.
 * Returns { report, hash, loss }.
 */
export async function runReplay(request, { source, engine, confirmations = 12 }) {
  const r = normalizeRequest(request);
  const chainId = BigInt(await source.chainId());
  if (chainId !== r.chainId) throw new Error(`the RPC is chain ${chainId}, not ${r.chainId}`);
  const head = BigInt(await source.blockNumber());
  if (r.toBlock + BigInt(confirmations) > head) throw new Error(`toBlock ${r.toBlock} is less than ${confirmations} blocks behind the head (${head}): wait, the newest blocks may not be on every RPC yet`);
  const txs = [];
  for (const h of r.txHashes) {
    const t = await source.tx(h);
    if (!t) throw new Error(`transaction ${h} is not on chain ${r.chainId}`);
    if (BigInt(t.blockNumber) < r.fromBlock || BigInt(t.blockNumber) > r.toBlock) throw new Error(`transaction ${h} is in block ${t.blockNumber}, outside ${r.fromBlock}..${r.toBlock}`);
    txs.push(t);
  }
  txs.sort((a, b) => (BigInt(a.blockNumber) === BigInt(b.blockNumber) ? Number(a.transactionIndex) - Number(b.transactionIndex) : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1));
  const forkBlock = r.fromBlock - 1n;
  const fb = await source.block(forkBlock);
  const fork = { block: forkBlock, hash: fb.hash, timestamp: BigInt(fb.timestamp) };
  try {
    const started = await engine.start({ forkBlock, hardfork: r.hardfork });
    if (started?.hash && started.hash.toLowerCase() !== fb.hash.toLowerCase()) throw new Error(`the fork's block ${forkBlock} is ${started.hash}, the chain's is ${fb.hash}`);
    // pass 1: replay, then read the after-state of every asset (given + moved)
    const snap = await engine.snapshot();
    const results = await engine.replay(txs);
    const tokens = [...new Set([...r.tokens, ...tokensMoved(results, r.target)])].sort();
    const after = { native: await engine.balance(r.target) };
    for (const t of tokens) after[t] = await erc20Balance(engine, t, r.target);
    // back to the fork state: the before-state, decimals and prices (on-chain prices before the exploit)
    await engine.revert(snap);
    const assets = [{ asset: 'native', decimals: 18, before: await engine.balance(r.target), after: after.native, price: { source: 'native', weiPerToken: 10n ** 18n } }];
    let nativeUsd = null;
    if (r.oracle) nativeUsd = await oraclePrice(engine, r.oracle.address, r.oracle.nativeAsset);
    for (const t of tokens) {
      const decimals = await erc20Decimals(engine, t);
      let price = null;
      if (r.prices[t] != null) price = { source: 'explicit', weiPerToken: BigInt(r.prices[t]) };
      else if (r.oracle && nativeUsd) {
        const usd = await oraclePrice(engine, r.oracle.address, t);
        if (usd != null) price = { source: 'oracle', weiPerToken: (usd * 10n ** 18n) / nativeUsd };
      }
      assets.push({ asset: t, decimals, before: (await erc20Balance(engine, t, r.target)) ?? 0n, after: after[t] ?? 0n, price });
    }
    const report = buildReport(r, {
      fork,
      txs: txs.map((t, i) => ({ hash: t.hash, block: t.blockNumber, index: t.transactionIndex, timestamp: t.timestamp, from: t.from, to: t.to, status: t.status, replayStatus: results[i].status })),
      assets,
    });
    return { report, hash: reportHash(report), loss: BigInt(report.loss) };
  } finally {
    await engine.stop?.();
  }
}

async function erc20Balance(engine, token, who) {
  const out = await engine.call(token, ERC20.encodeFunctionData('balanceOf', [who]));
  try { return out ? ERC20.decodeFunctionResult('balanceOf', out)[0] : 0n; } catch { return 0n; }
}
async function erc20Decimals(engine, token) {
  const out = await engine.call(token, ERC20.encodeFunctionData('decimals', []));
  try { const d = Number(ERC20.decodeFunctionResult('decimals', out)[0]); return d <= 36 ? d : null; } catch { return null; }
}
/** ZetaphyOracle.price(asset) (USD, 18 decimals) or null when it refuses (stale, paused, tripped, unknown). */
async function oraclePrice(engine, oracle, asset) {
  const out = await engine.call(oracle, ORACLE.encodeFunctionData('price', [asset]));
  try { const v = out ? ORACLE.decodeFunctionResult('price', out)[0] : 0n; return v > 0n ? v : null; } catch { return null; }
}

// ---------------------------------------------------------------- JSON-RPC: the source chain and anvil

let rpcId = 0;
/** A minimal JSON-RPC client (fetch). `url` may be a comma-separated list: the first one answering is used per call. */
export function rpcClient(url, { timeoutMs = 30000 } = {}) {
  const urls = String(url).split(',').map((u) => u.trim()).filter(Boolean);
  return async function send(method, params = []) {
    let last;
    for (const u of urls) {
      try {
        const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
        const j = await res.json();
        if (j.error) { const e = new Error(`${method}: ${j.error.message}`); e.rpc = j.error; throw e; }
        return j.result;
      } catch (e) { if (e.rpc) throw e; last = e; }
    }
    throw new Error(`${method}: no RPC answered (${last?.message ?? 'none given'})`);
  };
}

const hex = (n) => '0x' + BigInt(n).toString(16);

/** The chain to replay, read over JSON-RPC: original transactions with their receipt status and block. */
export function rpcSource(url) {
  const send = rpcClient(url);
  return {
    chainId: async () => BigInt(await send('eth_chainId')),
    blockNumber: async () => BigInt(await send('eth_blockNumber')),
    block: async (n) => {
      const b = await send('eth_getBlockByNumber', [hex(n), false]);
      if (!b) throw new Error(`block ${n} not found`);
      return { hash: b.hash, timestamp: BigInt(b.timestamp), baseFeePerGas: b.baseFeePerGas ?? null, miner: b.miner };
    },
    async tx(h) {
      const [t, rc] = await Promise.all([send('eth_getTransactionByHash', [h]), send('eth_getTransactionReceipt', [h])]);
      if (!t || !rc || t.blockNumber == null) return null;
      const b = await this.block(BigInt(t.blockNumber));
      return { hash: t.hash, from: t.from, to: t.to ?? null, input: t.input ?? t.data ?? '0x', value: t.value, gas: t.gas, type: t.type,
        gasPrice: t.gasPrice, maxFeePerGas: t.maxFeePerGas ?? null, maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? null,
        accessList: t.accessList ?? null, blockNumber: BigInt(t.blockNumber), transactionIndex: Number(BigInt(t.transactionIndex)),
        status: BigInt(rc.status ?? '0x1') === 1n, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas, miner: b.miner };
    },
  };
}

/**
 * A fork with anvil (foundry FOUNDRY_VERSION; another version is refused unless allowOtherVersion, because its
 * report could differ). Blocks are mined by hand (--no-mining, --order fifo), so each original block is rebuilt
 * with its own transactions in their own order, number, timestamp, base fee and coinbase.
 */
export function anvilEngine({ forkUrl, anvil = 'anvil', allowOtherVersion = false, spawnFn, log = () => {} }) {
  let proc = null, send = null;
  const engine = {
    async start({ forkBlock, hardfork }) {
      const { spawn, execFileSync } = await import('node:child_process');
      const version = String(execFileSync(anvil, ['--version'], { encoding: 'utf8' }));
      const want = FOUNDRY_VERSION.slice(1);
      if (!new RegExp(`\\b${want.replace(/\./g, '\\.')}\\b`).test(version) && !allowOtherVersion) {
        throw new Error(`anvil is "${version.split('\n')[0].trim()}", not foundry ${FOUNDRY_VERSION}: install the pinned version (foundryup --install ${FOUNDRY_VERSION}) so every runner gets the same report`);
      }
      const port = await freePort();
      const args = ['--fork-url', String(forkUrl).split(',')[0], '--fork-block-number', String(forkBlock), '--port', String(port), '--host', '127.0.0.1',
        '--no-mining', '--order', 'fifo', '--retries', '10', '--fork-retry-backoff', '1000', '--timeout', '60000', '--silent'];
      if (hardfork) args.push('--hardfork', hardfork);
      proc = (spawnFn ?? spawn)(anvil, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      proc.stderr?.on('data', (d) => { err += d; });
      send = rpcClient(`http://127.0.0.1:${port}`, { timeoutMs: 120000 });
      for (let i = 0; ; i++) {
        try { await send('eth_chainId'); break; } catch (e) {
          if (proc.exitCode != null || i > 120) throw new Error(`anvil did not start: ${err.trim().split('\n').pop() || e.message}`);
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      const b = await send('eth_getBlockByNumber', [hex(forkBlock), false]);
      log(`anvil fork at block ${forkBlock} (${b?.hash})`);
      return { hash: b?.hash ?? null };
    },
    snapshot: () => send('evm_snapshot'),
    async revert(id) { if (!(await send('evm_revert', [id]))) throw new Error('anvil refused to revert to the snapshot'); },
    balance: async (a) => BigInt(await send('eth_getBalance', [a, 'latest'])),
    async call(to, data) { try { return await send('eth_call', [{ to, data }, 'latest']); } catch { return null; } },
    async replay(txs) {
      const out = [];
      let i = 0;
      while (i < txs.length) {
        const blockNo = BigInt(txs[i].blockNumber);
        const group = txs.filter((t) => BigInt(t.blockNumber) === blockNo);
        const latest = await send('eth_getBlockByNumber', ['latest', false]);
        const gap = blockNo - BigInt(latest.number) - 1n;
        const ts = BigInt(group[0].timestamp);
        if (gap < 0n) throw new Error(`cannot rebuild block ${blockNo}: the fork is already at ${BigInt(latest.number)}`);
        // empty blocks up to the original number, at the last timestamp (anvil allows equal timestamps), then the block itself
        if (gap > 0n) {
          await send('evm_setNextBlockTimestamp', [hex(BigInt(latest.timestamp) < ts ? BigInt(latest.timestamp) + 1n : BigInt(latest.timestamp))]);
          await send('anvil_mine', [hex(gap), '0x0']);
        }
        if (group[0].miner) await send('anvil_setCoinbase', [group[0].miner]);
        if (group[0].baseFeePerGas != null) await send('anvil_setNextBlockBaseFeePerGas', [group[0].baseFeePerGas]);
        await send('evm_setNextBlockTimestamp', [hex(ts)]);
        const hashes = [];
        for (const t of group) {
          await send('anvil_impersonateAccount', [t.from]);
          const tx = { from: t.from, data: t.input, value: t.value, gas: t.gas };
          if (t.to) tx.to = t.to;
          if (t.maxFeePerGas != null) { tx.maxFeePerGas = t.maxFeePerGas; tx.maxPriorityFeePerGas = t.maxPriorityFeePerGas ?? '0x0'; } else tx.gasPrice = t.gasPrice;
          if (t.accessList?.length) tx.accessList = t.accessList;
          hashes.push(await send('eth_sendTransaction', [tx]));
          await send('anvil_stopImpersonatingAccount', [t.from]);
        }
        await send('evm_mine');
        for (const h of hashes) {
          const rc = await send('eth_getTransactionReceipt', [h]);
          if (!rc || BigInt(rc.blockNumber) !== blockNo) throw new Error(`the replay of a block-${blockNo} transaction did not land in block ${blockNo}`);
          out.push({ status: BigInt(rc.status) === 1n, logs: rc.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) });
        }
        i += group.length;
      }
      return out;
    },
    async stop() { if (proc && proc.exitCode == null) { proc.kill('SIGTERM'); await new Promise((res) => { proc.once('exit', res); setTimeout(res, 3000); }); } },
  };
  return engine;
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

// ---------------------------------------------------------------- the committee vote

/**
 * What a runner votes on a claim, from its own recomputed report. Approve only if every check passes; the vote then
 * restates the claim's report hash and loss (HackInsurance counts anything else as a rejection).
 * claim: { evidenceHash, reportHash, loss }, cover: { target (key), end (unix seconds) }, insuranceChainId.
 */
export function voteDecision({ claim, cover, insuranceChainId, report, hash }) {
  const reasons = [];
  if (String(report.chainId) !== String(insuranceChainId)) reasons.push(`the report is for chain ${report.chainId}; HackInsurance covers chain ${insuranceChainId}`);
  if (report.targetKey.toLowerCase() !== String(cover.target).toLowerCase()) reasons.push("the report's target is not the covered target");
  if (report.evidenceHash.toLowerCase() !== String(claim.evidenceHash).toLowerCase()) reasons.push("the report's evidence (transactions, blocks) is not the claim's");
  if (!report.matchesOriginal) reasons.push('the replay does not reproduce the original transactions (a status differs)');
  const late = report.txs.filter((t) => BigInt(t.timestamp) > BigInt(cover.end));
  if (late.length) reasons.push(`${late.length} transaction(s) after the cover's end`);
  if (BigInt(report.loss) === 0n) reasons.push('the replay shows no loss');
  if (hash.toLowerCase() !== String(claim.reportHash).toLowerCase()) reasons.push(`report hash ${hash} differs from the claim's ${claim.reportHash}`);
  if (BigInt(report.loss) !== BigInt(claim.loss)) reasons.push(`loss ${report.loss} differs from the claim's ${claim.loss}`);
  return { approve: reasons.length === 0, reportHash: hash, loss: BigInt(report.loss), reasons };
}
