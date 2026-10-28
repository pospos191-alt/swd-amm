// On-chain knowledge for the AI analyst (retrieval, "RAG" without a server):
// reads what the ZETAPHY chain already records about code and contracts into a
// small local index, then looks up the contract being analysed and hands the
// hits to ai/context.js as an extra, clearly labelled evidence source.
//
// Sources (event logs, read with eth_getLogs in windows; incremental: the index
// remembers the last block it read):
//   - ThreatRegistry: Flagged / Cleared / Protected per key, and every Voted
//     (runner, flag, reason, reportHash, uri). Keys are the vaccine's: the code
//     fingerprint (fp1), codeKey(extcodehash) and addressKey(chainId, address).
//   - NeuroJobs: JobRequested (chain, target) + Finalized (verdict): past network
//     verdicts on the same target, and whether that verdict equals the verdict of
//     the report on screen (same rules + same code = same verdict, src/verdict.js).
//
// Trust: these are records other runners wrote, not Neuro's rules. They may be
// stale, wrong or (the uri strings) written by anyone who could vote: the uri
// goes to the model only inside the untrusted fences, everything else as
// labelled on-chain facts with CHAIN<n> evidence ids. They never change the level.

import { keccak256 } from '../src/keccak.js';
import { toHex, fromHex } from './browser/manifest.js';
import { readWord, wordUint, wordAddress, readString } from './browser/rpc.js';

const enc = new TextEncoder();
const kHex = (bytes) => '0x' + toHex(keccak256(bytes));
export const topicOf = (sig) => kHex(enc.encode(sig));
export const TOPICS = {
  voted: topicOf('Voted(bytes32,address,bool,uint8,bytes32,string)'),
  flagged: topicOf('Flagged(bytes32,uint8)'),
  cleared: topicOf('Cleared(bytes32)'),
  protected: topicOf('Protected(bytes32,bool)'),
  jobRequested: topicOf('JobRequested(uint256,bytes32,string,uint256)'),
  finalized: topicOf('Finalized(uint256,bytes32)'),
};
export const REASONS = ['none', 'cannot-sell-in-simulation', 'unlimited-mint', 'owner-can-block-transfers',
  'owner-can-move-holder-funds', 'same-name-as-known-token', 'sweeps-approved-tokens', 'other'];

// ---- the vaccine's keys (as ThreatRegistry.codeKey / addressKey compute them) ----
const word = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const strWords = (s) => { const h = toHex(enc.encode(s)); return word((h.length / 2).toString(16)) + h.padEnd(64 * Math.ceil(h.length / 64), '0'); };
/** keccak256(abi.encode("zetaphy.threat.code", codeHash)) */
export const codeKey = (codeHashHex) => kHex(fromHex(word('40') + word(codeHashHex) + strWords('zetaphy.threat.code')));
/** keccak256(abi.encode("zetaphy.threat.address", chainId, address)) */
export const addressKey = (chainId, address) => kHex(fromHex(word('60') + word(BigInt(chainId).toString(16)) + word(String(address).toLowerCase()) + strWords('zetaphy.threat.address')));
export const codeHashOf = (codeHex) => kHex(fromHex(codeHex));
/** 'fp1:<hex>' -> the bytes32 key */
export const fingerprintKey = (fp) => (/^fp1:[0-9a-f]{64}$/.test(String(fp)) ? '0x' + String(fp).slice(4) : null);
const chainKey = (name) => '0x' + toHex(enc.encode(String(name))).padEnd(64, '0'); // encodeBytes32String

const MAX_EVIDENCE = 5;
const MAX_KEYS = 50_000;

export function createKnowledgeIndex(saved = null) {
  const s = saved && saved.v === 1 ? saved : { v: 1, lastBlock: {}, threat: {}, jobs: {}, targets: {} };
  const entry = (k) => (s.threat[k] ??= { flagged: false, reason: 0, votes: 0, protected: false, block: 0, evidence: [] });

  function applyThreatLog(l) {
    const key = l.topics[1];
    const block = Number(BigInt(l.blockNumber));
    if (!key || Object.keys(s.threat).length >= MAX_KEYS && !s.threat[key]) return;
    const e = entry(key);
    const t = l.topics[0];
    if (t === TOPICS.flagged) { e.flagged = true; e.reason = Number(wordUint(readWord(l.data, 0))); e.block = block; }
    else if (t === TOPICS.cleared) { e.flagged = false; e.reason = 0; e.block = block; }
    else if (t === TOPICS.protected) { e.protected = wordUint(readWord(l.data, 0)) === 1n; if (e.protected) { e.flagged = false; e.reason = 0; } e.block = block; }
    else if (t === TOPICS.voted) {
      const flag = wordUint(readWord(l.data, 0)) === 1n;
      e.votes++;
      if (flag) {
        const uri = readString(l.data, Number(wordUint(readWord(l.data, 3)))).slice(0, 200);
        e.evidence.unshift({ runner: wordAddress(l.topics[2].replace(/^0x/, '')), reason: Number(wordUint(readWord(l.data, 1))), reportHash: '0x' + readWord(l.data, 2), uri, block });
        e.evidence.length = Math.min(e.evidence.length, MAX_EVIDENCE);
      }
    }
  }

  function applyJobLog(l) {
    const id = BigInt(l.topics[1]).toString();
    const block = Number(BigInt(l.blockNumber));
    if (l.topics[0] === TOPICS.jobRequested) {
      const chain = l.topics[2];
      const target = readString(l.data, Number(wordUint(readWord(l.data, 0)))).toLowerCase().slice(0, 120);
      s.jobs[id] = { ...(s.jobs[id] ?? {}), chain, target, block };
      const k = `${chain}:${target}`;
      (s.targets[k] ??= []).includes(id) || s.targets[k].push(id);
      if (s.targets[k].length > 20) s.targets[k].shift();
    } else if (l.topics[0] === TOPICS.finalized) {
      s.jobs[id] = { ...(s.jobs[id] ?? {}), verdict: '0x' + readWord(l.data, 0), finalBlock: block };
    }
  }

  /**
   * Reads new logs from `reader` (ai/browser/rpc.js createReader) for the given
   * contracts, from the last block read (or fromBlock) to the chain head, in
   * windows of `step` blocks (public nodes cap eth_getLogs ranges).
   */
  async function sync(reader, { threatRegistry, neuroJobs, fromBlock = 0, toBlock, step = 500, maxWindows = 400 } = {}) {
    const head = toBlock ?? Number(BigInt(await reader.call('eth_blockNumber', [])));
    let windows = 0;
    for (const [addr, topics, apply] of [[threatRegistry, [TOPICS.voted, TOPICS.flagged, TOPICS.cleared, TOPICS.protected], applyThreatLog], [neuroJobs, [TOPICS.jobRequested, TOPICS.finalized], applyJobLog]]) {
      if (!addr) continue;
      const a = addr.toLowerCase();
      let from = Math.max(fromBlock, (s.lastBlock[a] ?? fromBlock - 1) + 1);
      while (from <= head && windows < maxWindows) {
        const to = Math.min(head, from + step - 1);
        const logs = await reader.call('eth_getLogs', [{ address: addr, topics: [topics], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        const sorted = [...logs].sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex ?? 0) - BigInt(y.logIndex ?? 0)));
        for (const l of sorted) { try { apply(l); } catch { /* a malformed log is skipped */ } }
        s.lastBlock[a] = to;
        from = to + 1;
        windows++;
      }
    }
    return { head, windows, complete: windows < maxWindows };
  }

  /**
   * What the chain records about one report's contract.
   * @param {object} report  Neuro report (chain, chainId, address, fingerprint)
   * @param {{code?:string, verdict?:string}} [o]  runtime code (for codeKey), this report's verdict (src/verdict.js)
   */
  function lookup(report, { code = null, verdict = null } = {}) {
    const threat = [];
    const add = (kind, key) => { const e = key && s.threat[key]; if (e && (e.flagged || e.votes || e.protected)) threat.push({ kind, key, ...e }); };
    add('fingerprint', fingerprintKey(report?.fingerprint));
    if (report?.chainId != null && /^0x[0-9a-fA-F]{40}$/.test(String(report?.address ?? ''))) add('address', addressKey(report.chainId, report.address));
    if (code && /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2) add('code', codeKey(codeHashOf(code)));
    const verdicts = [];
    if (report?.chain && report?.address) {
      for (const id of s.targets[`${chainKey(report.chain)}:${String(report.address).toLowerCase()}`] ?? []) {
        const j = s.jobs[id];
        if (j?.verdict) verdicts.push({ jobId: id, verdict: j.verdict, block: j.finalBlock, ...(verdict ? { sameAsThisReport: j.verdict.toLowerCase() === verdict.toLowerCase() } : {}) });
      }
    }
    return { threat, verdicts: verdicts.slice(-5), syncedTo: s.lastBlock };
  }

  return { sync, lookup, toJSON: () => s, applyThreatLog, applyJobLog };
}
