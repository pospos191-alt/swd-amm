// ZETAPHY security score badge (docs/future/immune-score.md): SecurityScore.breakdown(chainId, address), one eth_call
// per address, remembered for the visit (like audit.js). The score (0..1000) is computed live by the contract from
// on-chain facts only: the audit certificate, open post-certificate findings, circuit-breaker monitoring and trips,
// Neuro's score, confirmed exploits, vaccine matches and threat flags. An input for risk limits, never "safe".
import { h } from './dom.js';

const ADDR = /^0x[0-9a-f]{40}$/;
/** keccak256('breakdown(uint64,address)')[0..4] (checked in test/unit.test.js). */
export const SEL_BREAKDOWN = '0x15c4ec89';

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const uint = (hex, i) => BigInt(`0x${word(hex, i) || '0'}`);

/** The eth_call data of breakdown(chainId, address). */
export const breakdownCall = (chainId, address) =>
  `${SEL_BREAKDOWN}${BigInt(chainId).toString(16).padStart(64, '0')}${String(address).slice(2).toLowerCase().padStart(64, '0')}`;

const FIELDS = ['score', 'certificate', 'neuro', 'monitoring', 'history', 'penalty', 'cap', 'level', 'certExpires', 'openFindings', 'exploits', 'vaccineMatch'];
const FLAGS = ['flagged', 'held', 'tripped', 'degraded'];

/** Decodes the Breakdown struct (16 static words). -> { state: 'ok', score, certificate, …, flagged, held, tripped, degraded } */
export function decodeBreakdown(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 2 + 16 * 64) throw new Error('bad score data');
  const out = { state: 'ok' };
  FIELDS.forEach((f, i) => { out[f] = Number(uint(hex, i)); });
  FLAGS.forEach((f, i) => { out[f] = uint(hex, FIELDS.length + i) !== 0n; });
  if (out.score > 1000) throw new Error('bad score data');
  return out;
}

/** single(method, params) -> result. Returns { lookup(address) -> Promise<{ state: 'ok', … } | { state: 'unset' | 'error' }> }. */
export function createScore({ single, contract, chainId }) {
  const cache = new Map();
  function lookup(address) {
    const a = String(address ?? '').toLowerCase();
    if (!contract || !ADDR.test(String(contract).toLowerCase())) return Promise.resolve({ state: 'unset' });
    if (!ADDR.test(a)) return Promise.resolve({ state: 'error' });
    if (!cache.has(a)) {
      cache.set(a, single('eth_call', [{ to: contract, data: breakdownCall(chainId, a) }, 'latest']).then(decodeBreakdown)
        .catch(() => { cache.delete(a); return { state: 'error' }; }));
    }
    return cache.get(a);
  }
  return { lookup };
}

let current = null;
export const setScore = (x) => { current = x; };
export const getScore = () => current;

/** The badge class for a score: high scores ok, middling plain, low a warning, capped near zero bad. */
export const scoreClass = (s) => (s >= 700 ? 'badge-ok' : s >= 400 ? null : s > 150 ? 'badge-warn' : 'badge-bad');

/** "Security 812/1000" after an address or token title (nothing while loading, unset or on an error). */
export function scoreBadge(address, { t }) {
  const el = h('span', { class: 'score-slot' });
  if (!current) return el;
  current.lookup(address).then((r) => {
    if (r.state !== 'ok') return;
    const extra = r.held ? ` · ${t('secScoreHeld')}` : r.flagged ? ` · ${t('secScoreFlagged')}` : '';
    const tip = t('secScoreTip', { cert: r.certificate, neuro: r.neuro, mon: r.monitoring, hist: r.history, pen: r.penalty, cap: r.cap });
    el.append(h('span', { class: ['badge', scoreClass(r.score), 'score-badge'].filter(Boolean), title: tip }, `${t('secScore', { score: r.score })}${extra}`));
  });
  return el;
}
