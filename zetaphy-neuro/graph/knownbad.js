// Links to addresses Neuro already knows about:
//   - ZETAPHY ThreatRegistry (the "vaccine"): isAddressFlagged(chainId, address),
//     the same view zetaphy-network/src/vaccine.js, the wallet and the snap read
//   - Neuro's own past results ("memory"): addresses whose earlier Neuro check
//     or investigation reported a high level, kept in this browser / process
//   - an optional fixed list passed by the caller (e.g. a runner's local list)
// A link is a fact about what another check said, with its reference; it is
// never a judgement of the person behind the address.
import { BudgetError, lc, selector, word, addrWord, dataWord } from './util.js';
import { ZETAPHY } from './sources.js';

const SEL_ADDR_FLAGGED = selector('isAddressFlagged(uint256,address)');
/** ThreatRegistry.Reason names (zetaphy-network/src/vaccine.js REASONS). */
export const REGISTRY_REASONS = ['none', 'cannot-sell-in-simulation', 'unlimited-mint', 'owner-can-block-transfers',
  'owner-can-move-holder-funds', 'same-name-as-known-token', 'sweeps-approved-tokens', 'other'];

/**
 * Neuro's memory of its own results: remember(chain, address, { level, ref }),
 * recall(chain, address). Backed by graph/cache.js (IndexedDB / localStorage /
 * memory). Entries expire after 180 days.
 */
export function createVerdictMemory(cache, { ttlMs = 180 * 24 * 3600_000 } = {}) {
  const key = (chain, a) => `verdict:${chain}:${lc(a)}`;
  return {
    async remember(chain, address, { level, ref = null, at = Date.now() }) {
      if (!['high', 'medium', 'low', 'info', 'good'].includes(level)) return;
      await cache.set(key(chain, address), { level, ref: ref ? String(ref).slice(0, 80) : null, at }, ttlMs);
    },
    recall: (chain, address) => cache.get(key(chain, address)),
  };
}

/**
 * @param {object} p
 * @param {{call: Function}|null} p.registryRpc  EVM client on ZETAPHY (null = registry off)
 * @param {string} [p.registry]                  ThreatRegistry address
 * @param {number|null} p.chainId                EVM chain id of the addresses (null: not EVM, registry skipped)
 * @param {string} p.chain                       chain key (for memory)
 * @param {ReturnType<createVerdictMemory>|null} [p.memory]
 * @param {Map<string,{reason?:string, ref?:string}>|null} [p.list]
 * @param {number} [p.maxRegistryCalls=30]
 */
export function createKnownBad({ registryRpc = null, registry = ZETAPHY.threatRegistry, chainId = null, chain, memory = null, list = null, maxRegistryCalls = 30 }) {
  let calls = 0;
  let registryDown = false;
  const notes = [];
  const done = new Map();

  async function one(addr) {
    const a = lc(addr);
    if (list?.has(a)) return { source: 'list', ...list.get(a) };
    if (memory) {
      try {
        const m = await memory.recall(chain, a);
        if (m?.level === 'high') return { source: 'memory', level: m.level, ref: m.ref, at: m.at };
      } catch { /* memory is optional */ }
    }
    if (registryRpc && chainId != null && /^0x[0-9a-f]{40}$/.test(a) && !registryDown && calls < maxRegistryCalls) {
      calls++;
      try {
        const out = await registryRpc.call('eth_call', [{ to: registry, data: '0x' + SEL_ADDR_FLAGGED + word(chainId) + addrWord(a) }, 'latest']);
        if (dataWord(out, 0) !== 0n) {
          const n = Number(dataWord(out, 1));
          return { source: 'registry', reason: REGISTRY_REASONS[n] ?? 'other', ref: registry };
        }
      } catch (e) {
        if (e instanceof BudgetError) throw e;
        registryDown = true; // e.g. the ZETAPHY RPC is paused: carry on without it
        notes.push('registry-unavailable');
      }
    }
    return null;
  }

  return {
    notes,
    /** addresses -> Map(addr -> {source, reason?, level?, ref?}) for the known ones. */
    async check(addresses) {
      const out = new Map();
      for (const addr of addresses) {
        const a = lc(addr);
        if (!done.has(a)) done.set(a, await one(a));
        if (done.get(a)) out.set(a, done.get(a));
      }
      return out;
    },
  };
}
