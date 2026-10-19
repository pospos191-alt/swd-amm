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
};

// Symbols a scammer copies. Compared case-insensitively, ignoring spaces,
// dots and dashes, so "U S D T", "usdt" and "USD-T" all count.
const norm = (s) => String(s ?? '').toUpperCase().replace(/[\s.\-_]/g, '');

/** Official entry for this exact chain + address, or null. */
export function knownToken(chain, address) {
  const a = String(address).toLowerCase();
  return (KNOWN_TOKENS[chain] ?? []).find((t) => t.address.toLowerCase() === a) ?? null;
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
