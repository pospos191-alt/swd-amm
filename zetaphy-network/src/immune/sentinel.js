// Sentinels: one per chain, polling FREE public endpoints (rpc.js: rate-limited, rotating) or a recorded fixture /
// the mock multi-chain (same `send` shape). Resumable: the cursor (next block / slot / height) is in `state`, saved
// by the caller after every tick (sentinel-state.json), so a restart or an endpoint outage loses nothing.
// Every finding comes with an evidence bundle (evidence.js) whose inputs let a runner re-run the verdict.
import { makeBundle, contentHash } from './evidence.js';
import { VaccineSet, deriveVaccine, codeHashOf } from './vaccines.js';
import { TOPICS, FLASH_TOPICS, KIND, cloneVerdict, flashLoanVerdict, OutflowMonitor, DrainerMonitor, taintVerdict,
  SolanaDrainerMonitor, wasmCloneVerdict, authzDrainerVerdict, base58Hex } from './detectors.js';

const hexN = (n) => '0x' + BigInt(n).toString(16);
const lower = (a) => String(a ?? '').toLowerCase();
const ZERO32 = '0x' + '00'.repeat(32);

/**
 * A finding + its bundle -> the report the runners vote on: { finding (ImmuneFinding fields), bundle, evidenceHash,
 * cid, vaccine (object | null) }. A confirmed exploit or drainer CONTRACT gets a vaccine derived from its code, so
 * the flag carries the detector for its clones.
 */
export function toReport(f, { detector, inputs, block = null, tx = null, observedAt, code = null, callPattern = null }) {
  let vaccine = null;
  if (code && code !== '0x' && [KIND.exploit, KIND.drainer].includes(f.kind)) {
    vaccine = deriveVaccine({ code, chainId: f.chainId, address: f.address, kind: f.kind, label: f.label.slice(0, 80), callPattern });
  }
  const finding = { chainId: f.chainId, subject: f.subject, codeHash: f.codeHash, kind: f.kind, severity: f.severity, everyChain: f.everyChain,
    ttl: f.ttl, vaccine: vaccine?.id ?? (f.vaccineId ?? ZERO32) };
  const bundle = makeBundle({ detector, chain: f.chainId, block, tx, inputs, finding: { ...finding, label: f.label, address: f.display ?? f.address }, observedAt });
  if (vaccine) bundle.vaccine = vaccine;
  const { evidenceHash, cid } = contentHash(bundle);
  return { finding: { ...finding, evidenceHash }, bundle, evidenceHash, cid, vaccine, label: f.label, address: f.display ?? f.address };
}

/** EVM sentinel. */
export class EvmSentinel {
  /**
   * @param o.chain      { key, id }; @param o.rpc { send, batch? }
   * @param o.vaccines   VaccineSet (shared: add() a vaccine and the next block is scanned with it)
   * @param o.flagged    Map lower address -> { severity, kind } (what the mirror / feed knows: taint tracking)
   * @param o.protocols  [{ address, name, tvl: {token: amount} }] watched for abnormal outflows
   * @param o.allowlist  spenders never treated as drainers (routers, Permit2, bridges)
   * @param o.state      { next } cursor; @param o.now () => seconds (simulation clock)
   */
  constructor({ chain, rpc, vaccines = new VaccineSet(), flagged = new Map(), protocols = [], allowlist = [], state = {}, maxBlocks = 20, lookback = 5, now = () => Date.now() / 1000 }) {
    Object.assign(this, { chain, rpc, vaccines, flagged, state, maxBlocks, lookback, now });
    this.outflow = new OutflowMonitor({ chainId: chain.id, protocols });
    this.drainer = new DrainerMonitor({ chainId: chain.id, allowlist });
    this.codes = new Map();
    this.seen = new Set();
    this.scannedCodes = new Map(); // address -> vaccine ids already checked (a new vaccine re-checks recent contracts)
    this.recent = [];              // recently deployed contracts [{address, code, block}] (re-scanned with new vaccines)
  }

  async code(addr) {
    const a = lower(addr);
    if (this.codes.has(a)) return this.codes.get(a);
    const c = lower(await this.rpc.send('eth_getCode', [a, 'latest']).catch(() => '0x')) || '0x';
    if (this.codes.size > 5000) this.codes.clear();
    this.codes.set(a, c);
    return c;
  }

  /** Polls once: up to maxBlocks blocks from the cursor. Returns the reports found. */
  async tick() {
    const head = Number(BigInt(await this.rpc.send('eth_blockNumber', [])));
    if (this.state.next == null) this.state.next = Math.max(0, head - this.lookback + 1);
    const out = [];
    for (let i = 0; i < this.maxBlocks && this.state.next <= head; i++) {
      const n = this.state.next;
      out.push(...await this.scanBlock(n));
      this.state.next = n + 1; // saved by the caller after the tick: a restart resumes here
    }
    return out;
  }

  async scanBlock(n) {
    const block = await this.rpc.send('eth_getBlockByNumber', [hexN(n), true]);
    if (!block) return [];
    let receipts = await this.rpc.send('eth_getBlockReceipts', [hexN(n)]).catch(() => null);
    if (!Array.isArray(receipts)) receipts = await Promise.all((block.transactions ?? []).map((t) => this.rpc.send('eth_getTransactionReceipt', [t.hash])));
    receipts = receipts.filter(Boolean);
    const at = Number(BigInt(block.timestamp ?? 0)) || this.now();
    const reports = [];
    const emit = (f, ctx) => {
      const k = `${f.subject}:${f.kind}`;
      if (this.seen.has(k)) return;
      this.seen.add(k);
      reports.push(toReport(f, { observedAt: at, block: n, ...ctx }));
    };

    // 1. new contracts -> every vaccine (clones)
    for (const r of receipts) {
      if (!r.contractAddress || r.status === '0x0') continue;
      const code = await this.code(r.contractAddress);
      this.recent.push({ address: lower(r.contractAddress), code, block: n });
      for (const x of this.scanWithVaccines(lower(r.contractAddress), code, n)) emit(x.f, x.ctx);
    }
    if (this.recent.length > 500) this.recent = this.recent.slice(-500);

    // 2. flash loan + price manipulation, per transaction
    const txBy = new Map((block.transactions ?? []).map((t) => [lower(t.hash), t]));
    for (const r of receipts) {
      if (!(r.logs ?? []).some((l) => FLASH_TOPICS[lower(l.topics?.[0])])) continue;
      const tx = txBy.get(lower(r.transactionHash)) ?? { hash: r.transactionHash, from: r.from, to: r.to };
      const toCode = tx.to ? await this.code(tx.to) : null;
      const inputs = { chainId: this.chain.id, tx: { hash: tx.hash, from: lower(tx.from), to: lower(tx.to) }, logs: r.logs.map(({ address, topics, data }) => ({ address: lower(address), topics: topics.map(lower), data: lower(data) })),
        toCode, toCodeHash: toCode && toCode !== '0x' ? codeHashOf(toCode) : null };
      for (const f of flashLoanVerdict(inputs)) emit(f, { detector: 'flashloan', inputs, tx: tx.hash, code: f.kind === KIND.exploit ? toCode : null, callPattern: { flashLoan: true, minSwaps: 2 } });
    }

    // 3. abnormal outflows from watched protocols (recipients' code fetched first)
    for (const r of receipts) for (const l of r.logs ?? []) {
      if (lower(l.topics?.[0]) === TOPICS.transfer && l.topics.length >= 3 && this.outflow.protocols.has('0x' + lower(l.topics[1]).slice(-40))) await this.code('0x' + lower(l.topics[2]).slice(-40));
    }
    for (const res of this.outflow.block(receipts, (a) => this.codes.get(lower(a)) ?? '0x')) {
      for (const f of res.findings) emit(f, { detector: 'outflow', inputs: res.inputs, code: f.kind === KIND.exploit ? this.codes.get(f.address) : null });
    }

    // 4. drainer approvals (spenders' code fetched first)
    for (const r of receipts) for (const l of r.logs ?? []) {
      const t0 = lower(l.topics?.[0]);
      if ((t0 === TOPICS.approval || t0 === TOPICS.approvalForAll) && l.topics.length === 3) await this.code('0x' + lower(l.topics[2]).slice(-40));
    }
    for (const res of this.drainer.block(n, block.transactions ?? [], receipts, (a) => this.codes.get(lower(a)) ?? '0x', (a) => { const c = this.codes.get(lower(a)); return c && c !== '0x' ? codeHashOf(c) : null; })) {
      for (const f of res.findings) emit(f, { detector: 'drainer', inputs: res.inputs, code: f.address === res.inputs.spender && res.inputs.spenderCode !== '0x' ? res.inputs.spenderCode : null });
    }

    // 5. taint: funds leaving a flagged attacker / drainer (native value and ERC-20 transfers)
    if (this.flagged.size) {
      const moves = [];
      for (const t of block.transactions ?? []) if (t.to && BigInt(t.value ?? 0) > 0n) moves.push({ from: lower(t.from), to: lower(t.to), value: BigInt(t.value).toString(), token: null, tx: t.hash });
      for (const r of receipts) for (const l of r.logs ?? []) if (lower(l.topics?.[0]) === TOPICS.transfer && l.topics.length === 3) moves.push({ from: '0x' + lower(l.topics[1]).slice(-40), to: '0x' + lower(l.topics[2]).slice(-40), value: BigInt(l.data === '0x' ? 0 : l.data).toString(), token: lower(l.address), tx: r.transactionHash });
      for (const m of moves) {
        const fl = this.flagged.get(m.from);
        if (!fl || this.flagged.has(m.to)) continue;
        const inputs = { chainId: this.chain.id, flagged: { address: m.from, severity: fl.severity, kind: fl.kind }, transfer: { to: m.to, value: m.value, token: m.token, tx: m.tx }, toCode: await this.code(m.to), minValue: '0' };
        for (const f of taintVerdict(inputs)) emit(f, { detector: 'taint', inputs, tx: m.tx });
      }
    }
    return reports;
  }

  /** Matches one contract against every vaccine it was not checked against yet. -> [{f, ctx}] */
  scanWithVaccines(address, code, n) {
    const done = this.scannedCodes.get(address) ?? new Set();
    const out = [];
    for (const v of this.vaccines.list()) {
      if ((v.vm ?? 'evm') !== 'evm' || done.has(v.id)) continue;
      done.add(v.id);
      if (v.source?.address === address && Number(v.source?.chainId) === Number(this.chain.id)) continue; // the original itself
      const inputs = { chainId: this.chain.id, address, code, codeHash: codeHashOf(code), vaccine: v.id };
      const fs = cloneVerdict({ ...inputs, vaccine: v });
      for (const f of fs) out.push({ f, ctx: { detector: 'clone', inputs } });
    }
    this.scannedCodes.set(address, done);
    return out;
  }

  /** A vaccine arrived with a flag: add it and re-scan the recent deployments with it at once. */
  vaccinate(v) {
    if (!this.vaccines.add(v)) return [];
    const reports = [];
    for (const c of this.recent) for (const x of this.scanWithVaccines(c.address, c.code, c.block)) {
      const k = `${x.f.subject}:${x.f.kind}`;
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      reports.push(toReport(x.f, { observedAt: this.now(), block: c.block, ...x.ctx }));
    }
    return reports;
  }
}

/** Solana sentinel (getSlot / getBlock jsonParsed): SPL token drainers. */
export class SolanaSentinel {
  constructor({ chain, rpc, state = {}, maxSlots = 20, allowlist = [], now = () => Date.now() / 1000 }) {
    Object.assign(this, { chain, rpc, state, maxSlots, now });
    this.monitor = new SolanaDrainerMonitor({ chainId: chain.id, allowlist });
    this.seen = new Set();
  }
  async tick() {
    const head = Number(await this.rpc.send('getSlot', [{ commitment: 'confirmed' }]));
    if (this.state.next == null) this.state.next = head;
    const out = [];
    for (let i = 0; i < this.maxSlots && this.state.next <= head; i++) {
      const slot = this.state.next;
      const block = await this.rpc.send('getBlock', [slot, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, transactionDetails: 'full', rewards: false }]).catch(() => null); // skipped slot
      this.state.next = slot + 1;
      if (!block) continue;
      for (const res of this.monitor.block(slot, block)) for (const f of res.findings) {
        if (this.seen.has(f.subject)) continue;
        this.seen.add(f.subject);
        out.push(toReport(f, { detector: 'sol-drainer', inputs: res.inputs, block: slot, observedAt: Number(block.blockTime ?? this.now()) }));
      }
    }
    return out;
  }
}

/** Cosmos REST (LCD) as `send`: the pseudo-methods the Cosmos sentinel uses, so fixtures record them like JSON-RPC. */
export function lcdClient({ urls, fetchImpl = globalThis.fetch, limiter = null }) {
  let at = 0;
  const get = async (path) => {
    for (let i = 0; i < urls.length * 2; i++) {
      if (limiter) await limiter.take();
      try {
        const r = await fetchImpl(urls[at % urls.length] + path, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) { at++; if (i === urls.length * 2 - 1) throw e; }
    }
    return null;
  };
  return {
    async send(method, params = []) {
      if (method === 'cosmos_latestHeight') return (await get('/cosmos/base/tendermint/v1beta1/blocks/latest'))?.block?.header?.height;
      if (method === 'cosmos_txsAt') return (await get(`/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`tx.height=${params[0]}`)}&pagination.limit=100`))?.tx_responses ?? [];
      if (method === 'wasm_codeInfo') return (await get(`/cosmwasm/wasm/v1/code/${params[0]}`))?.code_info ?? null;
      throw new Error(`unknown method ${method}`);
    },
  };
}

/** Osmosis / CosmWasm sentinel: instantiations of codes matching a wasm vaccine; authz send grants to one grantee. */
export class CosmosSentinel {
  constructor({ chain, rpc, vaccines = new VaccineSet(), state = {}, maxHeights = 10, window = 600, now = () => Date.now() / 1000 }) {
    Object.assign(this, { chain, rpc, vaccines, state, maxHeights, window, now });
    this.grants = [];
    this.seen = new Set();
    this.checksums = new Map();
  }
  async tick() {
    const head = Number(await this.rpc.send('cosmos_latestHeight', []));
    if (this.state.next == null) this.state.next = head;
    const out = [];
    const emit = (f, detector, inputs, h, at) => { if (this.seen.has(f.subject)) return; this.seen.add(f.subject); out.push(toReport(f, { detector, inputs, block: h, observedAt: at })); };
    for (let i = 0; i < this.maxHeights && this.state.next <= head; i++) {
      const h = this.state.next;
      const txs = await this.rpc.send('cosmos_txsAt', [h]);
      this.state.next = h + 1;
      for (const t of txs ?? []) {
        if (t.code) continue;
        const at = Date.parse(t.timestamp ?? '') / 1000 || this.now();
        for (const ev of t.events ?? []) {
          if (ev.type !== 'instantiate') continue;
          const attr = Object.fromEntries((ev.attributes ?? []).map((a) => [a.key, a.value]));
          const contract = attr._contract_address; const codeId = attr.code_id;
          if (!contract || !codeId) continue;
          if (!this.checksums.has(codeId)) this.checksums.set(codeId, lower((await this.rpc.send('wasm_codeInfo', [codeId]))?.data_hash ?? ''));
          const checksum = this.checksums.get(codeId);
          const hit = this.vaccines.scan(checksum, 'cosmwasm');
          if (!hit) continue;
          const inputs = { chainId: this.chain.id, contract, codeId, checksum, vaccine: hit.vaccine.id };
          for (const f of wasmCloneVerdict({ ...inputs, vaccine: hit.vaccine })) emit(f, 'wasm-clone', inputs, h, at);
        }
        for (const m of t.tx?.body?.messages ?? []) {
          if (m['@type'] !== '/cosmos.authz.v1beta1.MsgGrant') continue;
          const a = m.grant?.authorization ?? {};
          this.grants.push({ granter: m.granter, grantee: m.grantee, msg: a['@type'] === '/cosmos.authz.v1beta1.GenericAuthorization' ? a.msg : a['@type'], height: h, tx: t.txhash });
        }
      }
      this.grants = this.grants.filter((g) => g.height > h - this.window);
      for (const grantee of new Set(this.grants.map((g) => g.grantee))) {
        const inputs = { chainId: this.chain.id, grantee, grants: this.grants.filter((g) => g.grantee === grantee).map(({ grantee: _g, ...g }) => g), minVictims: 3 };
        for (const f of authzDrainerVerdict(inputs)) emit(f, 'authz-drainer', inputs, h, this.now());
      }
    }
    return out;
  }
}

export { base58Hex };
