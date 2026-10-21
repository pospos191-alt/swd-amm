// ThreatRegistry status of an address (the "vaccine" read side, the same views
// and keys as zetaphy-network/src/vaccine.js, which the wallet and snap use):
// the address itself, its code byte for byte, its Neuro fingerprint (fp1), and
// the code a proxy forwards to (EIP-1167 / EIP-1967 / beacon, best effort).
// A flag states a reproducible fact about code, never intent (docs/LEGAL.md).
import {
  threatQueries, readThreat, threatKey, detailQueries, readEvidence, readResponse, proxyTargets, PROXY_DEPTH, reasonText, REASONS,
} from '../vendor/zetaphy-lib.js';

/**
 * call(method, params) is the EVM JSON-RPC. Returns
 *   { state: 'unset' } (no registry configured)
 *   { state: 'clean' | 'flagged', checked: [{ target, via }], flags: [Flag] }
 *   { state: 'error', error } (the registry could not be read: nothing is claimed)
 * Flag: { target, via (proxy it was found behind, or null), what ('address' | 'code' | 'fingerprint'),
 *         key, enforced, reason, reasonName, reasonText {th,en}, evidence, responses: [...] }
 */
export async function checkThreats(call, { registry, chainId, address, code, maxDetails = 3 }) {
  if (!registry) return { state: 'unset' };
  const flags = []; const checked = [];
  const queue = [{ target: address.toLowerCase(), code, via: null, depth: 0 }];
  const seen = new Set();
  const ethCall = (data) => call('eth_call', [{ to: registry, data }, 'latest']);
  try {
    while (queue.length) {
      const item = queue.shift();
      if (seen.has(item.target)) continue;
      seen.add(item.target);
      let c = item.code;
      if (c == null) c = await call('eth_getCode', [item.target, 'latest']);
      if (typeof c !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(c)) throw new Error('eth_getCode: not hex');
      checked.push({ target: item.target, via: item.via });
      const qs = threatQueries(chainId, item.target, c);
      const answers = await Promise.all(qs.flatMap((q) => [ethCall(q.warn), ethCall(q.enforced)]));
      qs.forEach((q, i) => {
        const r = readThreat(answers[2 * i], answers[2 * i + 1]);
        if (r.flagged) {
          flags.push({ target: item.target, via: item.via, what: q.what, key: threatKey(q.what, chainId, item.target, c),
            enforced: r.enforced, reason: r.reason, reasonName: REASONS[r.reason] ?? `#${r.reason}`, reasonText: reasonText(r.reason) });
        }
      });
      if (c !== '0x' && item.depth < PROXY_DEPTH) {
        let next = [];
        try { next = await proxyTargets(call, item.target, c); } catch { next = []; }
        for (const t of next) queue.push({ target: t.toLowerCase(), code: null, via: item.target, depth: item.depth + 1 });
      }
    }
  } catch (e) {
    return { state: 'error', error: String(e?.message ?? e).slice(0, 300) };
  }
  // The evidence and the responses of the parties behind each flag (best effort).
  for (const f of flags.slice(0, maxDetails)) {
    const q = detailQueries(f.key);
    try { f.evidence = readEvidence(await ethCall(q.evidence)); } catch { f.evidence = null; }
    f.responses = [];
    for (const r of q.responses) {
      let resp;
      try { resp = readResponse(await ethCall(r)); } catch { break; }
      if (!resp.text) break;
      f.responses.push(resp);
    }
  }
  return { state: flags.length ? 'flagged' : 'clean', checked, flags };
}
