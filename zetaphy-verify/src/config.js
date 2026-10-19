// Where ZETAPHY launchers live. Add a factory address under its chain when
// the launcher is deployed there; nothing else needs to change.
//
// The workflow runs every 6 hours and each chain looks back ~8 hours, so a
// late or skipped run still overlaps the previous one.
//
// probeFactories: also try every known factory address on every chain.
// A launcher deployed by the same wallet at the same nonce (or with CREATE2)
// has the same address everywhere; the code must still match before use.

export const CONFIG = {
  // TokenDeployed(address,address), seen in the BNB Chain factory's code.
  eventSignature: 'TokenDeployed(address,address)',
  // keccak256 of the signature above (test/config.test.js checks it).
  eventTopic: '0xf9a44e6db3fb6e0eb31c4013bda8c662fecef1768dd2412270cc8f8821cbccf3',
  probeFactories: true,
  chains: {
    bsc: {
      chainId: 56,
      name: 'BNB Chain',
      rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
      factories: ['0xce1b4d160e13f11a9ad503f6b8cf0770e55d69da'],
      lookbackBlocks: 40000, // ~8 h at 0.75 s blocks
      logChunk: 2000,
    },
    base: {
      chainId: 8453,
      name: 'Base',
      rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
      factories: [],
      lookbackBlocks: 14400, // ~8 h at 2 s blocks
      logChunk: 2000,
    },
    arbitrum: {
      chainId: 42161,
      name: 'Arbitrum One',
      rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
      factories: [],
      lookbackBlocks: 120000, // ~8 h at 0.25 s blocks
      logChunk: 10000,
    },
    eth: {
      chainId: 1,
      name: 'Ethereum',
      rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
      factories: [],
      lookbackBlocks: 2400, // ~8 h at 12 s blocks
      logChunk: 1200,
    },
  },
};
