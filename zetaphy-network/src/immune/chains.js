// The chains the immune network's sentinels watch (docs/future/immune-network.md), with FREE public endpoints only
// (no keys, no paid APIs) and the numbers the propagation model uses. Public endpoints change and rate-limit: the
// sentinel rotates through `rpc`, stays under `rps` and resumes from its cursor after any outage.
//
//   id:       the chain's number in immune keys: the EVM chain id, the Hyperlane domain of a non-EVM chain
//             (Solana 1399811149 / devnet 1399811151, Osmosis 875), or our own number where none exists (osmo-test-5: 9875)
//   domain:   Hyperlane domain of the chain's ImmuneMirror (EVM) / mirror route (null: none planned)
//   block:    seconds per block (slot); finality: seconds until a sentinel treats an event as final (we act on
//             "latest" for speed and re-check at finality, see sentinel.js); mirror: how its mirror is reached
export const ZETAPHY = { key: 'zetaphy', name: 'ZETAPHY Testnet', kind: 'evm', id: 77390, domain: 77390, testnet: true, block: 5, finality: 5,
  rpc: ['https://rpc.sawasdeecoin.com'], rps: 4, mirror: 'home' };

export const CHAINS = [
  { key: 'eth', name: 'Ethereum', kind: 'evm', id: 1, domain: 1, block: 12, finality: 768, rps: 4,
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'], mirror: 'hyperlane' },
  { key: 'sepolia', name: 'Sepolia', kind: 'evm', id: 11155111, domain: 11155111, testnet: true, block: 12, finality: 768, rps: 4,
    rpc: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org', 'https://1rpc.io/sepolia'], mirror: 'hyperlane' },
  { key: 'bsc', name: 'BNB Smart Chain', kind: 'evm', id: 56, domain: 56, block: 0.75, finality: 2, rps: 4,
    rpc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'bsctestnet', name: 'BNB Testnet', kind: 'evm', id: 97, domain: 97, testnet: true, block: 0.75, finality: 2, rps: 4,
    rpc: ['https://bsc-testnet-rpc.publicnode.com', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'], mirror: 'hyperlane' },
  { key: 'base', name: 'Base', kind: 'evm', id: 8453, domain: 8453, block: 2, finality: 2, rps: 4,
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'basesepolia', name: 'Base Sepolia', kind: 'evm', id: 84532, domain: 84532, testnet: true, block: 2, finality: 2, rps: 4,
    rpc: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'arbitrum', name: 'Arbitrum One', kind: 'evm', id: 42161, domain: 42161, block: 0.25, finality: 1, rps: 4,
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'arbitrumsepolia', name: 'Arbitrum Sepolia', kind: 'evm', id: 421614, domain: 421614, testnet: true, block: 0.25, finality: 1, rps: 4,
    rpc: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia.drpc.org'], mirror: 'hyperlane' },
  { key: 'optimism', name: 'OP Mainnet', kind: 'evm', id: 10, domain: 10, block: 2, finality: 2, rps: 4,
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'opsepolia', name: 'OP Sepolia', kind: 'evm', id: 11155420, domain: 11155420, testnet: true, block: 2, finality: 2, rps: 4,
    rpc: ['https://sepolia.optimism.io', 'https://optimism-sepolia-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'polygon', name: 'Polygon PoS', kind: 'evm', id: 137, domain: 137, block: 2, finality: 5, rps: 4,
    rpc: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'amoy', name: 'Polygon Amoy', kind: 'evm', id: 80002, domain: 80002, testnet: true, block: 2, finality: 5, rps: 4,
    rpc: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy-bor-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'avalanche', name: 'Avalanche C-Chain', kind: 'evm', id: 43114, domain: 43114, block: 2, finality: 2, rps: 4,
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'fuji', name: 'Avalanche Fuji', kind: 'evm', id: 43113, domain: 43113, testnet: true, block: 2, finality: 2, rps: 4,
    rpc: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'], mirror: 'hyperlane' },
  { key: 'sol', name: 'Solana', kind: 'solana', id: 1399811149, domain: null, block: 0.4, finality: 13, rps: 2,
    rpc: ['https://api.mainnet-beta.solana.com'], mirror: 'documented' },
  { key: 'soldevnet', name: 'Solana Devnet', kind: 'solana', id: 1399811151, domain: null, testnet: true, block: 0.4, finality: 13, rps: 2,
    rpc: ['https://api.devnet.solana.com'], mirror: 'documented' },
  { key: 'osmosis', name: 'Osmosis', kind: 'cosmwasm', id: 875, domain: null, block: 2, finality: 2, rps: 2,
    rpc: ['https://lcd.osmosis.zone'], mirror: 'ibc' },
  { key: 'osmotest', name: 'Osmosis Testnet', kind: 'cosmwasm', id: 9875, domain: null, testnet: true, block: 2, finality: 2, rps: 2,
    rpc: ['https://lcd.osmotest5.osmosis.zone'], mirror: 'ibc' },
];

/** Every chain the network knows, ZETAPHY first. */
export const ALL = [ZETAPHY, ...CHAINS];
export const byKey = (k) => ALL.find((c) => c.key === k) ?? null;
export const byId = (id) => ALL.find((c) => String(c.id) === String(id)) ?? null;
export const evmChains = () => ALL.filter((c) => c.kind === 'evm');

/**
 * Seconds from "the flag is in ZETAPHY's registry" to "the mirror on `chain` answers it", for a Hyperlane route:
 * ZETAPHY finality (one block, CometBFT) + our validators sign the checkpoint (`sign`) + the relayer sees and submits
 * it (`relay`) + inclusion on the destination (one block). IBC (Osmosis): the relayer's packet (`ibc`) + one block.
 */
export function propagationSeconds(chain, { sign = 1, relay = 3, ibc = 8 } = {}) {
  if (chain.mirror === 'home') return 0;
  if (chain.mirror === 'hyperlane') return ZETAPHY.finality + sign + relay + chain.block;
  if (chain.mirror === 'ibc') return ZETAPHY.finality + ibc + chain.block;
  return null; // documented path only (Solana): consumers read the feed until a Sealevel mirror is deployed
}
