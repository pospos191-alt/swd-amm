// Money-flow data for CosmWasm contracts (Osmosis, Neutron, ZETAPHY's x/wasm)
// from the chain's REST (LCD): contract info, account sequence, tx search.
import { BudgetError } from './util.js';

const searchPaths = (query, limit) => [
  `/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_ASC&pagination.limit=${limit}`, // SDK 0.50+
  `/cosmos/tx/v1beta1/txs?events=${query}&order_by=ORDER_BY_ASC&pagination.limit=${limit}`, // older SDKs
];
const eventsOf = (tx) => tx.events ?? (tx.logs ?? []).flatMap((l) => l.events ?? []);
const attr = (ev, k) => (ev.attributes ?? []).find((a) => a.key === k)?.value;

export function createCosmosProvider({ rest }) {
  const notes = [];
  const note = (n) => { if (!notes.includes(n)) notes.push(n); };

  async function search(query, limit = 10) {
    for (const p of searchPaths(query, limit)) {
      try {
        const r = await rest.get(p);
        if (r) return r.tx_responses ?? [];
      } catch (e) { if (e instanceof BudgetError) throw e; }
    }
    note('tx-search-unavailable');
    return [];
  }

  async function creation(contract) {
    const info = await rest.get(`/cosmwasm/wasm/v1/contract/${contract}`);
    const creator = info?.contract_info?.creator;
    if (!creator) return null;
    const [tx] = await search(`instantiate._contract_address='${contract}'`, 1);
    return { deployer: creator, creator, tx: tx?.txhash ?? null, block: tx ? Number(tx.height) : null, source: 'rest' };
  }

  async function funderOf(addr) {
    for (const tx of await search(`transfer.recipient='${addr}'`, 5)) {
      for (const ev of eventsOf(tx)) {
        if (ev.type !== 'transfer' || attr(ev, 'recipient') !== addr) continue;
        const sender = attr(ev, 'sender');
        if (sender && sender !== addr) return { funder: sender, tx: tx.txhash, value: String(attr(ev, 'amount') ?? ''), block: Number(tx.height) || null };
      }
    }
    return null;
  }

  async function profile(addr) {
    let contract = false;
    try { contract = !!(await rest.get(`/cosmwasm/wasm/v1/contract/${addr}`))?.contract_info; } catch (e) { if (e instanceof BudgetError) throw e; }
    let nonce = 0;
    try {
      const a = (await rest.get(`/cosmos/auth/v1beta1/accounts/${addr}`))?.account;
      nonce = Number(a?.sequence ?? a?.base_account?.sequence ?? 0);
      if (a && /ModuleAccount/.test(a['@type'] ?? '')) contract = true;
    } catch (e) { if (e instanceof BudgetError) throw e; }
    return { contract, nonce, hub: contract || nonce >= 2_000 };
  }

  /** CW20 receivers from the contract's first executions (mint / transfer / send). */
  async function earlyReceivers(contract, _from, { limit = 20, exclude = new Set() } = {}) {
    const seen = new Map();
    for (const tx of await search(`wasm._contract_address='${contract}'`, 30)) {
      for (const ev of eventsOf(tx)) {
        if (ev.type !== 'wasm' || attr(ev, '_contract_address') !== contract) continue;
        const action = attr(ev, 'action');
        if (!['mint', 'transfer', 'send', 'transfer_from', 'send_from'].includes(action)) continue;
        const to = attr(ev, 'recipient') ?? attr(ev, 'to');
        if (!to || exclude.has(to) || seen.has(to) || seen.size >= limit) continue;
        seen.set(to, { addr: to, amount: String(attr(ev, 'amount') ?? '0'), tx: tx.txhash, block: Number(tx.height) || null, minted: action === 'mint' });
      }
    }
    return { receivers: [...seen.values()], mints: [], minted: '0', logsRead: seen.size, complete: false };
  }

  const none = async () => null;
  return { kind: 'cosmwasm', creation, funderOf, profile, earlyReceivers, findPair: none, liquidity: none, lpHolding: none, priorContracts: async () => [], notes };
}
