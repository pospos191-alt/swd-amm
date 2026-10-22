// A fake ZETAPHY node for the browser test: answers the few RPC / REST calls the hub makes.
const now = Date.now();
const H = 123456;
const PROPOSER = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
const CONS_KEY = 'q0nZ0R2v9mKk6o3J0eTqvPq8m0D5YQ0wq1m3dW2h8nE=';
export const VALOPER = 'zetaphyvaloper1dt6hlsmr8nwlmepl0yqdhfp22qhn6gj9x3j6zk';
const meta = (h) => ({ header: { height: String(h), time: new Date(now - (H - h) * 5000 - (h % 7) * 300).toISOString(), proposer_address: PROPOSER }, num_txs: String(h % 4) });
const blocks = Array.from({ length: 20 }, (_, i) => meta(H - i));
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const ad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const str = (t) => w(32) + w(t.length) + Buffer.from(t).toString('hex').padEnd(64, '0');
const PAIR = '0x7c39825a9a7b9decb641b4ef707fb521882fb67c', ZT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', TUSD = '0x9d44ea6837938d4fef98367a7b5867cdca8de596';
const E18 = 10n ** 18n;
// eth_call answers by selector (and the address for token metadata)
function ethCall({ to, data }) {
  const sel = data.slice(0, 10), t = to.toLowerCase();
  if (sel === '0x574f2ba3') return `0x${w(t === '0x8a19ce6e8de30515f0434f8dc07a8dc9bae64134' ? 1 : 0)}`; // allPairsLength
  if (sel === '0x1e3dd18b') return `0x${ad(PAIR)}`;
  if (sel === '0x0dfe1681') return `0x${ad(ZT)}`;
  if (sel === '0xd21220a7') return `0x${ad(TUSD)}`;
  if (sel === '0x0902f1ac') return `0x${w(50000n * E18)}${w(500n * E18)}${w(0)}`;
  if (sel === '0x95d89b41') return `0x${str(t === ZT ? 'ZTPHY' : 'tUSD')}`;
  if (sel === '0x313ce567') return `0x${w(18)}`;
  if (sel === '0x299f3d98') return `0x${w(100n * E18)}`; // workerBond
  if (sel === '0x3da383ca') return `0x${w(3)}`; // activeWorkers
  if (sel === '0x66666aa9') return `0x${w(2500n * E18)}`; // rewardPool
  if (sel === '0x4c5d8a0f') return `0x${w(42)}`; // jobCount
  return '0x';
}
const validators = [
  { operator_address: VALOPER, consensus_pubkey: { key: CONS_KEY }, jailed: false, status: 'BOND_STATUS_BONDED', tokens: '1000000000000000000000000', description: { moniker: 'zetaphy-gcp-1', details: 'Google Cloud e2-micro' }, commission: { commission_rates: { rate: '0.100000000000000000' } } },
  { operator_address: 'zetaphyvaloper1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0', consensus_pubkey: { key: 'x' }, jailed: false, status: 'BOND_STATUS_BONDED', tokens: '250000000000000000000000', description: { moniker: 'community-1' }, commission: { commission_rates: { rate: '0.050000000000000000' } } },
];
export function answer(url, body) {
  const u = new URL(url);
  const p = u.pathname;
  if (p === '/' || p === '') {
    const { method, id, params } = JSON.parse(body || '{}');
    if (method === 'eth_call') return { jsonrpc: '2.0', id, result: ethCall(params[0]) };
    const r = { eth_chainId: '0x12e4e', eth_blockNumber: `0x${H.toString(16)}`, eth_getBalance: '0x3635c9adc5dea00000', zetaphy_faucet: { txHash: `0x${'ab'.repeat(32)}`, amount: '0x8ac7230489e80000' } }[method];
    return r === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'not mocked' } } : { jsonrpc: '2.0', id, result: r };
  }
  if (p === '/rpc/status') return { result: { sync_info: { latest_block_height: String(H), latest_block_time: blocks[0].header.time } } };
  if (p === '/rpc/blockchain') {
    const max = Number(u.searchParams.get('maxHeight') ?? H), min = Number(u.searchParams.get('minHeight') ?? max - 19);
    const out = []; for (let h = max; h >= min; h--) out.push(meta(h));
    return { result: { last_height: String(H), block_metas: out } };
  }
  if (p === '/rest/cosmos/bank/v1beta1/supply/by_denom') return { amount: { denom: 'azetaphy', amount: '999998750000000000000000000' } };
  if (p === '/rest/cosmos/auth/v1beta1/module_accounts') return { accounts: [{ name: 'bonded_tokens_pool', base_account: { address: 'zetaphy1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3e7v8zr' } }] };
  if (p === '/rest/cosmos/bank/v1beta1/denom_owners/azetaphy') return { denom_owners: [
    { address: 'zetaphy1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3e7v8zr', balance: { amount: '1250000000000000000000000' } },
    { address: 'zetaphy1dt6hlsmr8nwlmepl0yqdhfp22qhn6gj9x3j6zk', balance: { amount: '500000000000000000000000000' } },
    { address: 'zetaphy1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0', balance: { amount: '200000000000000000000000000' } },
  ] };
  if (p === '/rpc/validators') return { result: { validators: [{ address: PROPOSER, pub_key: { value: CONS_KEY } }] } };
  if (p === '/rest/cosmos/staking/v1beta1/validators') return { validators };
  if (p === '/rest/cosmos/staking/v1beta1/pool') return { pool: { bonded_tokens: '1250000000000000000000000', not_bonded_tokens: '0' } };
  if (p === '/rest/cosmos/staking/v1beta1/params') return { params: { unbonding_time: '1814400s', bond_denom: 'azetaphy' } };
  if (p.startsWith('/rest/cosmos/staking/v1beta1/delegations/')) return { delegation_responses: [{ delegation: { validator_address: VALOPER }, balance: { denom: 'azetaphy', amount: '500000000000000000000' } }] };
  if (p.includes('/rewards')) return { total: [{ denom: 'azetaphy', amount: '12345000000000000000.5' }] };
  if (p === '/rest/cosmos/gov/v1/proposals') return { proposals: [
    { id: '3', title: 'Turn on the IBC rate limit for Noble USDC', summary: 'Caps USDC in/out at 1% per 24 h', status: 'PROPOSAL_STATUS_VOTING_PERIOD', voting_end_time: new Date(now + 86400000).toISOString() },
    { id: '2', title: 'Register the Neuro skill "honeypot-sim"', status: 'PROPOSAL_STATUS_PASSED' },
    { id: '1', title: 'zetaphy-v2 upgrade', status: 'PROPOSAL_STATUS_PASSED' },
  ] };
  return null;
}
