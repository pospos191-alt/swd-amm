// The investigator in the user's browser, while Neuro is open: a list of
// tokens the user follows (kept only in this browser's localStorage), each
// re-investigated every `intervalMs` (default 30 min), one at a time and
// only while the page is visible. When a result gets worse than the last
// one, `onChange` says so; nothing is sent anywhere.
//
// Other pages and panels (e.g. a wallet's holdings) can add tokens with
//   document.dispatchEvent(new CustomEvent('neuro:follow', { detail: { chain, address } }))
// which web/flow.js forwards to follow().
import { levelRank } from './pipeline.js';

const KEY = 'neuro-watch';
export const MAX_FOLLOWED = 25;
export const WATCH_INTERVAL_MS = 30 * 60_000;

const keyOf = (chain, address) => `${chain}:${/^0x/i.test(address) ? address.toLowerCase() : address}`;

/** The followed list. `storage`: a localStorage-like object (any call may throw). */
export function createWatchList({ storage = globalThis.localStorage, now = () => Date.now() } = {}) {
  let mem = [];
  const load = () => {
    try {
      const v = JSON.parse(storage?.getItem(KEY) ?? '[]');
      if (Array.isArray(v)) mem = v.filter((x) => x && typeof x.chain === 'string' && typeof x.address === 'string').slice(0, MAX_FOLLOWED);
    } catch { /* blocked or corrupt: keep what is in memory */ }
    return mem;
  };
  const save = () => { try { storage?.setItem(KEY, JSON.stringify(mem)); } catch { /* blocked: memory only */ } };
  load();
  return {
    list: () => load().map((x) => ({ ...x })),
    has: (chain, address) => load().some((x) => x.key === keyOf(chain, address)),
    follow(chain, address) {
      load();
      const key = keyOf(chain, address);
      if (mem.some((x) => x.key === key)) return false;
      if (mem.length >= MAX_FOLLOWED) mem.shift();
      mem.push({ key, chain, address, added: now(), checked: 0, level: null, prevLevel: null, reportHash: null });
      save();
      return true;
    },
    unfollow(chain, address) { load(); const key = keyOf(chain, address); mem = mem.filter((x) => x.key !== key); save(); },
    /** Records a result; returns true when it is worse than the previous one. */
    record(key, report) {
      load();
      const item = mem.find((x) => x.key === key);
      if (!item) return false;
      const worse = item.level != null && levelRank(report.level) > levelRank(item.level);
      Object.assign(item, { prevLevel: item.level, level: report.level, confidence: report.confidence, reportHash: report.reportHash, checked: now(), worse });
      save();
      return worse;
    },
    /** Items not checked within `intervalMs`, oldest check first. */
    due(intervalMs = WATCH_INTERVAL_MS) { return load().filter((x) => now() - (x.checked ?? 0) >= intervalMs).sort((a, b) => (a.checked ?? 0) - (b.checked ?? 0)); },
  };
}

/**
 * Runs due investigations one at a time.
 * @param {{list, investigate: (item) => Promise<object>, isVisible?: () => boolean, onChange?: (item, report, worse) => void,
 *          intervalMs?: number, tickMs?: number, setInterval?: Function, clearInterval?: Function}} p
 */
export function createWatcher({ list, investigate, isVisible = () => true, onChange = () => {}, intervalMs = WATCH_INTERVAL_MS, tickMs = 60_000,
  setInterval: si = globalThis.setInterval, clearInterval: ci = globalThis.clearInterval }) {
  let timer = null;
  let busy = false;
  async function runOne(item) {
    const report = await investigate(item);
    const worse = list.record(item.key, report);
    onChange(item, report, worse);
    return report;
  }
  async function tick() {
    if (busy || !isVisible()) return null;
    const [item] = list.due(intervalMs);
    if (!item) return null;
    busy = true;
    try { return await runOne(item); } catch {
      // Failed (offline, rate-limited): keep the last result, try again next interval.
      list.record(item.key, { level: item.level, confidence: item.confidence ?? 0, reportHash: item.reportHash });
      return null;
    } finally { busy = false; }
  }
  return {
    tick,
    start() { if (!timer) timer = si(() => { tick(); }, tickMs); tick(); },
    stop() { if (timer) ci(timer); timer = null; },
    async checkNow(key) {
      const item = list.list().find((x) => x.key === key);
      if (!item || busy) return null;
      busy = true;
      try { return await runOne(item); } finally { busy = false; }
    },
    get busy() { return busy; },
  };
}
