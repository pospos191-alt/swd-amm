# ZETAPHY testnet bridge: NOT AUDITED

**This bridge has not been audited.** It runs on the ZETAPHY testnet (EVM chain id 77390) with test coins only.
Test coins have no real value. Do not send anything of value to it.

`zetaphy bridge open --testnet` records this page as the bridge's "audit" on the testnet. It is a notice, not an audit.

What testnet mode relaxes, and only on the public ZETAPHY testnet (chain id 77390 and its genesis block):
- Audit: this notice instead of an audit report.
- Neuro runners: as few as 1 (normally at least 10).
- Guardian and governance multisigs: 2 owners are enough (normally at least 3). The threshold is still at least 2.
- Daily limit: at most 100 tokens (lower than the normal starter cap of 1,000).

Everything else still applies: 2+ independent lanes, no deployer key in any role, the on-chain hard cap and its 7-day raise delay, pause by a guardian.

**Mainnet requires a real audit and every gate.** `--testnet` is refused on any other chain.

## EVM routes v2 (both directions, several source chains)

The same notice covers the Saphan v2 routes (docs/SAPHAN-MULTICHAIN.md): Sepolia, Base Sepolia and Arbitrum Sepolia
to ZETAPHY and back. `zetaphy bridge open --testnet` opens a route's way back (its `HyperlaneOutbox`, an
outbound-only route of the guard) together with the way in, with the same daily limit. On each source chain the
lockbox releases only after a delay, within a daily limit and its own locked balance, and its guardian can pause
or veto a release at once.
