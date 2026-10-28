// Where the money-flow graph reads each chain from. Free, keyless sources
// only, that a browser may call directly (CORS) or a GitHub Actions job /
// runner machine may call without an account:
//   - the chain's public JSON-RPC (from src/chains.js): logs, nonces, code
//   - Blockscout's Etherscan-compatible API (keyless) where an official
//     instance exists: contract creation, first incoming transfer, logs
//   - ZETAPHY: its own RPC and its Cosmos REST (no explorer index needed)
//   - Solana: the public RPC (getSignaturesForAddress / getTransaction)
//   - CosmWasm chains: the chain's REST (contract info, tx search)
import { CHAINS } from '../src/chains.js';

/** ZETAPHY testnet contracts the graph knows (zetaphy-dex/web/deployments.json). */
export const ZETAPHY = {
  chainId: 77390,
  rpc: 'https://rpc.sawasdeecoin.com',
  rest: 'https://rpc.sawasdeecoin.com/rest',
  bech32: 'zetaphy',
  threatRegistry: '0xab5745b61f83975e68f6546be9f83651df12417f',
  dex: {
    name: 'ZETAPHY DEX', factory: '0x8a19ce6e8de30515f0434f8dc07a8dc9bae64134', router: '0x2d822d2d44424fbe6465faa776822ed464a6d2a8',
    weth: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', native: 'ZETAPHY', amountIn: '10000000000000000',
  },
  dlmmFactory: '0x69292d823d3e7ac66b7a84342ab3d46f968042ae',
  // Pair tokens that are never "the new token" of a pool.
  baseTokens: ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x9d44ea6837938d4fef98367a7b5867cdca8de596', '0x13f46517a41b0d8fc5a75b6d9df534cc61e7157d'],
};

/**
 * Per chain key: { kind, chainId?, rpcs, blockscout?, rest?, bech32?, dex?, logRange, hubNonce }.
 *   logRange: widest eth_getLogs block range the public RPC accepts
 *   hubNonce: an address that sent at least this many transactions is a busy
 *     service (exchange hot wallet, bridge relayer): a funding trail stops
 *     there and wallets funded by it are NOT grouped together
 */
export const GRAPH_SOURCES = {
  eth: { blockscout: 'https://eth.blockscout.com', logRange: 5_000, hubNonce: 5_000 },
  base: { blockscout: 'https://base.blockscout.com', logRange: 5_000, hubNonce: 5_000 },
  arbitrum: { blockscout: 'https://arbitrum.blockscout.com', logRange: 10_000, hubNonce: 5_000 },
  // No official keyless explorer API for BNB Chain: RPC only (logs, nonces,
  // trace_filter where offered); funding trails are often "unknown" there.
  bsc: { blockscout: null, logRange: 2_000, hubNonce: 5_000 },
  zetaphy: { blockscout: null, rest: [ZETAPHY.rest], bech32: ZETAPHY.bech32, dex: ZETAPHY.dex, logRange: 10_000, hubNonce: 2_000 },
  sol: { hubSignatures: 1000 },
  osmosis: {},
  neutron: {},
};

/** Full source config for a chain key, or null when the graph does not cover it. */
export function sourcesFor(chainKey, overrides = {}) {
  const c = CHAINS[chainKey];
  const g = GRAPH_SOURCES[chainKey];
  if (!c || !g) return null;
  const base = { key: chainKey, kind: c.kind, name: c.name, rpcs: c.rpcs, ...g };
  if (c.kind === 'evm') Object.assign(base, { chainId: c.id, dex: g.dex ?? c.dex ?? null });
  if (c.kind === 'solana') base.genesisHash = c.genesisHash;
  if (c.kind === 'cosmwasm') Object.assign(base, { rest: c.rpcs, bech32: c.prefix });
  return { ...base, ...overrides };
}

/** Chain kinds the graph can trace. */
export const graphSupported = (chainKey) => sourcesFor(chainKey) != null;
