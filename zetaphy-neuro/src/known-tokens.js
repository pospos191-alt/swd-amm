// Official contracts of widely used tokens on each chain.
//
// Why: a regulated stablecoin like USDT legitimately lets its issuer mint,
// freeze and upgrade. Flagging that as "high risk" with no context makes
// Neuro look broken. For an exact official address we say who the issuer is
// and lower those powers to "low" (trust in the issuer, not the code).
//
// The flip side is a strong scam signal: a token on the same chain that uses
// one of these symbols (USDT, USDC, ...) at a DIFFERENT address is flagged
// as a possible fake.
//
// Addresses are stored with their EIP-55 checksum; test/known-tokens.test.js
// fails on any typo. Only add a token after checking its address on the
// issuer's own site AND the chain's explorer.

export const KNOWN_TOKENS = {
  eth: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', issuer: 'Tether', kind: 'stablecoin' },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', issuer: 'Sky (MakerDAO)', kind: 'stablecoin' },
    { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', issuer: 'WETH9 contract', kind: 'wrapped' },
  ],
  bsc: [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', issuer: 'Tether (Binance-Peg)', kind: 'stablecoin' },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', issuer: 'Circle (Binance-Peg)', kind: 'stablecoin' },
    { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', issuer: 'Paxos (Binance-Peg)', kind: 'stablecoin' },
    { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', issuer: 'BNB Chain', kind: 'wrapped' },
  ],
  base: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', symbol: 'USDbC', issuer: 'Base bridge (bridged USDC)', kind: 'bridged' },
    { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', issuer: 'Base (OP Stack)', kind: 'wrapped' },
  ],
  arbitrum: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', symbol: 'USDC.e', issuer: 'Arbitrum bridge (bridged USDC)', kind: 'bridged' },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', issuer: 'Tether', kind: 'stablecoin' },
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', issuer: 'Arbitrum', kind: 'wrapped' },
    { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', issuer: 'Arbitrum Foundation', kind: 'governance' },
  ],
  // Solana mint addresses are base58 and case-sensitive.
  sol: [
    { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', issuer: 'Tether', kind: 'stablecoin' },
    { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', issuer: 'Solana (wrapped SOL)', kind: 'wrapped' },
  ],
  // Move chains: coin types and Fungible Asset objects, addresses in their
  // 64-digit form (test/known-tokens.test.js checks the format).
  sui: [
    { address: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI', symbol: 'SUI', issuer: 'Sui (native coin)', kind: 'native' },
    { address: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN', symbol: 'USDC', issuer: 'Wormhole (bridged USDC)', kind: 'bridged' },
    { address: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN', symbol: 'USDT', issuer: 'Wormhole (bridged USDT)', kind: 'bridged' },
  ],
  aptos: [
    { address: '0x0000000000000000000000000000000000000000000000000000000000000001::aptos_coin::AptosCoin', symbol: 'APT', issuer: 'Aptos (native coin)', kind: 'native' },
    { address: '0x000000000000000000000000000000000000000000000000000000000000000a', symbol: 'APT', issuer: 'Aptos (native coin)', kind: 'native' },
    { address: '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b', symbol: 'USDt', issuer: 'Tether', kind: 'stablecoin' },
    { address: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDT', symbol: 'USDT', issuer: 'LayerZero (bridged USDT)', kind: 'bridged' },
    { address: '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC', symbol: 'USDC', issuer: 'LayerZero (bridged USDC)', kind: 'bridged' },
  ],
  // NEAR: account IDs (lowercase).
  near: [
    { address: 'usdt.tether-token.near', symbol: 'USDt', issuer: 'Tether', kind: 'stablecoin' },
    { address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', issuer: 'Circle', kind: 'stablecoin' },
    { address: 'wrap.near', symbol: 'wNEAR', issuer: 'NEAR (wrapped NEAR)', kind: 'wrapped' },
  ],
  // Starknet: 64-digit hex.
  starknet: [
    { address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', symbol: 'STRK', issuer: 'Starknet', kind: 'native' },
    { address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', symbol: 'ETH', issuer: 'StarkGate (bridged ETH)', kind: 'bridged' },
  ],
  // TON: raw form (workchain:hash) for matching, `display` for people.
  ton: [
    { address: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe', display: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', symbol: 'USDT', issuer: 'Tether', kind: 'stablecoin' },
  ],
};

// Symbols a scammer copies. Compared case-insensitively, ignoring spaces,
// dots and dashes, so "U S D T", "usdt" and "USD-T" all count.
const norm = (s) => String(s ?? '').toUpperCase().replace(/[\s.\-_]/g, '');

/** Official entry for this exact chain + address, or null. */
export function knownToken(chain, address) {
  // EVM, Move and raw TON hex are case-insensitive; Solana base58 is not.
  const hexy = (x) => x.startsWith('0x') || /^-?\d:/.test(x);
  const same = (x) => (hexy(x) ? x.toLowerCase() === String(address).toLowerCase() : x === address);
  return (KNOWN_TOKENS[chain] ?? []).find((t) => same(t.address)) ?? null;
}

/**
 * If `symbol` imitates an official token on this chain but `address` is not
 * that token, returns the official entry being imitated; else null.
 */
export function lookalikeOf(chain, address, symbol) {
  const s = norm(symbol);
  if (!s || knownToken(chain, address)) return null;
  return (KNOWN_TOKENS[chain] ?? []).find((t) => norm(t.symbol) === s) ?? null;
}
