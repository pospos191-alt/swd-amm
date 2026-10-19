// Chains Neuro tier 1 reads. All endpoints are free public RPCs; the reader
// tries them in order and moves on if one fails.

// `kind` picks the reader: 'evm' (Solidity contracts) or 'solana' (SPL tokens).
export const CHAINS = {
  eth: {
    kind: 'evm',
    id: 1,
    name: 'Ethereum',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    explorer: 'https://etherscan.io/address/',
  },
  bsc: {
    kind: 'evm',
    id: 56,
    name: 'BNB Chain',
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorer: 'https://bscscan.com/address/',
  },
  base: {
    kind: 'evm',
    id: 8453,
    name: 'Base',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org/address/',
  },
  arbitrum: {
    kind: 'evm',
    id: 42161,
    name: 'Arbitrum One',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io/address/',
  },
  sol: {
    kind: 'solana',
    // Mainnet-beta genesis hash: an endpoint for any other cluster is refused.
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    name: 'Solana',
    rpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    explorer: 'https://solscan.io/account/',
  },
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Base58, 32 bytes: 32 to 44 characters, no 0, O, I or l.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Is `address` well-formed for this chain? (Solana also checks it decodes to 32 bytes in the reader.) */
export function isChainAddress(chainKey, address) {
  const c = CHAINS[chainKey];
  if (!c || typeof address !== 'string') return false;
  return c.kind === 'solana' ? SOLANA_ADDRESS.test(address) : EVM_ADDRESS.test(address);
}
