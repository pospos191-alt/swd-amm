// SWD holder snapshot on Solana: every token account of the SWD mint
// (SPL Token and Token-2022), summed per wallet owner. Read-only RPC.

const PROGRAMS = {
  spl: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Pure: RPC getProgramAccounts (jsonParsed) results -> sorted holders. */
export function sumHolders(accountsByProgram, mint, exclude = new Set()) {
  const byOwner = new Map();
  for (const accounts of accountsByProgram) {
    for (const a of accounts) {
      const info = a.account?.data?.parsed?.info;
      if (!info || info.mint !== mint) continue; // never trust the filter alone
      const amount = BigInt(info.tokenAmount?.amount ?? '0');
      if (amount === 0n || exclude.has(info.owner)) continue;
      byOwner.set(info.owner, (byOwner.get(info.owner) ?? 0n) + amount);
    }
  }
  return [...byOwner].map(([owner, amount]) => ({ owner, amount }))
    .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : x.owner < y.owner ? -1 : 1));
}

async function rpc(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function takeSnapshot({ mint, rpcUrl, exclude = [], fetchImpl = globalThis.fetch }) {
  if (!BASE58.test(mint)) throw new Error('mint must be a Solana address');
  const slot = await rpc(rpcUrl, 'getSlot', [{ commitment: 'finalized' }], fetchImpl);
  const lists = [];
  for (const program of Object.values(PROGRAMS)) {
    lists.push(await rpc(rpcUrl, 'getProgramAccounts', [program, {
      encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: slot,
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
    }], fetchImpl));
  }
  const holders = sumHolders(lists, mint, new Set(exclude));
  return { mint, slot, takenAt: new Date().toISOString(), holders: holders.map((h) => ({ owner: h.owner, amount: h.amount.toString() })) };
}
