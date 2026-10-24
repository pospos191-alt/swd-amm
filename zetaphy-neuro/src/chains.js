// Chains Neuro tier 1 reads. All endpoints are free public RPCs; the reader
// tries them in order and moves on if one fails.

// `kind` picks the reader: 'evm' (any EVM bytecode), 'solana' (SPL tokens),
// 'sui' and 'aptos' (Move), 'ton' (jettons).
import { isSuiInput, SUI_MAINNET } from './sui.js';
import { isAptosInput, APTOS_MAINNET } from './aptos.js';
import { isTonAddress } from './ton.js';
import { isCosmwasmInput } from './cosmwasm.js';
import { isNearAccount } from './near.js';
import { isRuneInput } from './bitcoin.js';
import { isStarknetAddress, SN_MAIN } from './starknet.js';

export const CHAINS = {
  eth: {
    kind: 'evm',
    id: 1,
    name: 'Ethereum',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    explorer: 'https://etherscan.io/address/',
    explorerTx: 'https://etherscan.io/tx/',
    native: 'ETH',
    // `dex`: the chain's main Uniswap-V2-style DEX, used by the trade
    // simulation (src/honeypot.js). scripts/live-check.js verifies it on
    // chain: code present, router.factory() and router.WETH() match.
    dex: {
      name: 'Uniswap V2', factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', native: 'WETH', amountIn: '10000000000000000', // 0.01 ETH
    },
  },
  bsc: {
    kind: 'evm',
    id: 56,
    name: 'BNB Chain',
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
    explorer: 'https://bscscan.com/address/',
    explorerTx: 'https://bscscan.com/tx/',
    native: 'BNB',
    dex: {
      name: 'PancakeSwap V2', factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', native: 'WBNB', amountIn: '50000000000000000', // 0.05 BNB
    },
  },
  base: {
    kind: 'evm',
    id: 8453,
    name: 'Base',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
    explorer: 'https://basescan.org/address/',
    explorerTx: 'https://basescan.org/tx/',
    native: 'ETH',
    dex: {
      name: 'Uniswap V2', factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      weth: '0x4200000000000000000000000000000000000006', native: 'WETH', amountIn: '10000000000000000', // 0.01 ETH
    },
  },
  arbitrum: {
    kind: 'evm',
    id: 42161,
    name: 'Arbitrum One',
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io/address/',
    explorerTx: 'https://arbiscan.io/tx/',
    native: 'ETH',
    dex: {
      name: 'Uniswap V2', factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', native: 'WETH', amountIn: '10000000000000000', // 0.01 ETH
    },
  },
  // ZETAPHY's own EVM (testnet). No DEX is configured, so no trade simulation.
  zetaphy: {
    kind: 'evm',
    id: 77390,
    name: 'ZETAPHY (testnet)',
    rpcs: ['https://rpc.sawasdeecoin.com'],
    explorer: 'https://explorer.sawasdeecoin.com/#/address/',
    explorerTx: 'https://explorer.sawasdeecoin.com/#/tx/',
    native: 'ZETAPHY',
  },
  sol: {
    kind: 'solana',
    // Mainnet-beta genesis hash: an endpoint for any other cluster is refused.
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    name: 'Solana',
    rpcs: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'],
    explorer: 'https://solscan.io/account/',
  },
  sui: {
    kind: 'sui',
    chainIdentifier: SUI_MAINNET,
    name: 'Sui',
    rpcs: ['https://graphql.mainnet.sui.io/graphql'],
    // A coin type opens as /coin/, a package id as /object/.
    explorer: 'https://suiscan.xyz/mainnet/coin/',
    explorerObject: 'https://suiscan.xyz/mainnet/object/',
  },
  aptos: {
    kind: 'aptos',
    id: APTOS_MAINNET,
    name: 'Aptos',
    rpcs: ['https://api.mainnet.aptoslabs.com/v1'],
    explorer: 'https://explorer.aptoslabs.com/coin/',
    explorerObject: 'https://explorer.aptoslabs.com/account/',
  },
  osmosis: {
    kind: 'cosmwasm',
    chainId: 'osmosis-1',
    prefix: 'osmo',
    name: 'Osmosis',
    rpcs: ['https://lcd.osmosis.zone', 'https://rest.cosmos.directory/osmosis'],
    explorer: 'https://www.mintscan.io/osmosis/address/',
  },
  neutron: {
    kind: 'cosmwasm',
    chainId: 'neutron-1',
    prefix: 'neutron',
    name: 'Neutron',
    rpcs: ['https://rest-kralum.neutron-1.neutron.org', 'https://rest.cosmos.directory/neutron'],
    explorer: 'https://www.mintscan.io/neutron/address/',
  },
  near: {
    kind: 'near',
    chainId: 'mainnet',
    name: 'NEAR',
    rpcs: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org', 'https://near.lava.build'],
    explorer: 'https://nearblocks.io/address/',
  },
  starknet: {
    kind: 'starknet',
    chainId: SN_MAIN,
    name: 'Starknet',
    rpcs: ['https://rpc.starknet.lava.build', 'https://starknet.drpc.org', 'https://api.zan.top/public/starknet-mainnet'],
    explorer: 'https://voyager.online/contract/',
  },
  bitcoin: {
    kind: 'bitcoin',
    name: 'Bitcoin (Runes)',
    rpcs: ['https://ordinals.com'],
    explorer: 'https://ordinals.com/rune/',
  },
  ton: {
    kind: 'ton',
    name: 'TON',
    rpcs: ['https://tonapi.io'],
    explorer: 'https://tonviewer.com/',
  },
};

/**
 * ZETAPHY's own CosmWasm contracts (x/wasm next to its EVM, stage 7): a
 * chain config for readContract's opts.chainConfig. ZETAPHY has no fixed
 * public REST address (each node serves its own, e.g. https://<node>/rest),
 * so the caller passes the node(s); the reader checks their chain id.
 * EVM contracts on ZETAPHY are read with {kind: 'evm', ...} as before.
 */
export function zetaphyCosmwasmChain(rpcs, chainId = 'zetaphy_77390-1') {
  return { kind: 'cosmwasm', chainId, prefix: 'zetaphy', name: 'ZETAPHY (CosmWasm)', rpcs, explorer: null };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Base58, 32 bytes: 32 to 44 characters, no 0, O, I or l.
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Is `address` well-formed for this chain? (Solana also checks it decodes to 32 bytes in the reader.) */
export function isChainAddress(chainKey, address) {
  const c = CHAINS[chainKey];
  if (!c || typeof address !== 'string') return false;
  switch (c.kind) {
    case 'solana': return SOLANA_ADDRESS.test(address);
    case 'sui': return isSuiInput(address);
    case 'aptos': return isAptosInput(address);
    case 'ton': return isTonAddress(address);
    case 'cosmwasm': return isCosmwasmInput(address, c.prefix);
    case 'near': return isNearAccount(address);
    case 'starknet': return isStarknetAddress(address);
    case 'bitcoin': return isRuneInput(address);
    default: return EVM_ADDRESS.test(address);
  }
}

/** Explorer link for a transaction (EVM chains), or null. */
export function explorerTxUrl(chainKey, hash) {
  const c = CHAINS[chainKey];
  return c?.explorerTx ? c.explorerTx + hash : null;
}

/** Explorer link for a report's address on its chain. */
export function explorerUrl(chainKey, address) {
  const c = CHAINS[chainKey];
  if (!c) return null;
  // A factory denom has no page of its own: open its creator.
  if (c.kind === 'cosmwasm' && address.startsWith('factory/')) return c.explorer + address.split('/')[1];
  if (c.kind === 'sui' || c.kind === 'aptos') {
    return (address.includes('::') ? c.explorer : c.explorerObject) + encodeURIComponent(address);
  }
  return c.explorer + address;
}
