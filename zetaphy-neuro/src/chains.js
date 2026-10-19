// Chains Neuro tier 1 reads. All endpoints are free public RPCs; the reader
// tries them in order and moves on if one fails.

export const CHAINS = {
  bsc: {
    id: 56,
    name: 'BNB Chain',
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorer: 'https://bscscan.com/address/',
  },
  base: {
    id: 8453,
    name: 'Base',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org/address/',
  },
  arbitrum: {
    id: 42161,
    name: 'Arbitrum One',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io/address/',
  },
};
