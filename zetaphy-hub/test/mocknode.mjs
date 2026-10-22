// A fake ZETAPHY node for the browser test: answers the few RPC / REST calls the hub makes.
const now = Date.now();
const H = 123456;
const PROPOSER = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
const CONS_KEY = 'q0nZ0R2v9mKk6o3J0eTqvPq8m0D5YQ0wq1m3dW2h8nE=';
export const VALOPER = 'zetaphyvaloper1dt6hlsmr8nwlmepl0yqdhfp22qhn6gj9x3j6zk';
const blocks = Array.from({ length: 20 }, (_, i) => ({
  header: { height: String(H - i), time: new Date(now - i * 5000).toISOString(), proposer_address: PROPOSER }, num_txs: String(i % 3),
}));
const validators = [
  { operator_address: VALOPER, consensus_pubkey: { key: CONS_KEY }, jailed: false, tokens: '1000000000000000000000000', description: { moniker: 'zetaphy-gcp-1', details: 'Google Cloud e2-micro' }, commission: { commission_rates: { rate: '0.100000000000000000' } } },
  { operator_address: 'zetaphyvaloper1q2w3e4r5t6y7u8i9o0p1a2s3d4f5g6h7j8k9l0', consensus_pubkey: { key: 'x' }, jailed: false, tokens: '250000000000000000000000', description: { moniker: 'community-1' }, commission: { commission_rates: { rate: '0.050000000000000000' } } },
];
export function answer(url, body) {
  const u = new URL(url);
  const p = u.pathname;
  if (p === '/' || p === '') {
    const { method, id } = JSON.parse(body || '{}');
    const r = { eth_chainId: '0x12e4e', eth_blockNumber: `0x${H.toString(16)}`, eth_getBalance: '0x3635c9adc5dea00000', zetaphy_faucet: { txHash: `0x${'ab'.repeat(32)}`, amount: '0x8ac7230489e80000' } }[method];
    return r === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'not mocked' } } : { jsonrpc: '2.0', id, result: r };
  }
  if (p === '/rpc/status') return { result: { sync_info: { latest_block_height: String(H), latest_block_time: blocks[0].header.time } } };
  if (p === '/rpc/blockchain') return { result: { last_height: String(H), block_metas: blocks } };
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
