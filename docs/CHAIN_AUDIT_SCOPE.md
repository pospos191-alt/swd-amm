# ZETAPHY chain — audit scope

What an auditor of the ZETAPHY chain needs to look at. The base is the
published Cosmos EVM `v0.7.3` (commit `c3ae9067a7eadcdea55a5192226916deb44c71c4`,
Cosmos SDK v0.54, ibc-go v11, CometBFT). ZETAPHY adds the patches embedded at
the end of `zetaphy-chain/setup-node.sh`; nothing else in the node differs
from upstream except the bech32 prefix (`zetaphy`).

Reproduce the exact source:

```bash
git clone --depth 1 --branch v0.7.3 https://github.com/cosmos/evm.git src
bash zetaphy-chain/setup-node.sh --patch-source "$PWD/src"
cp -r zetaphy-chain/fork-tests/. src/          # the patches' tests
```

## In scope (ZETAPHY code, ~1,800 lines)

| Area | Files (in the patched tree) | What to check |
|---|---|---|
| ML-DSA-44 account keys | `crypto/mldsa44/*`, `crypto/codec/*.go`, `ante/sigverify.go` | signature verification (pure ML-DSA, empty context, over SIGN_MODE_DIRECT bytes); address = sha256("zetaphy/mldsa44\0" ‖ key)[:20] and collisions with other key types; hand-written protobuf (`keys.pb.go`, runtime descriptor); gas per verification (30,000) vs CPU |
| Public JSON-RPC methods | `evmd/zetaphy_rpc.go` | `zetaphy_pqAccount`, `zetaphy_sendCosmosTx` (64 KB cap, decode before broadcast), `zetaphy_faucet` (key file, rate limits, nonce handling) on the public port 8545 |
| PQ accounts calling the EVM | `evmd/zetaphy_pqcall.go` (`MsgEVMCall`, registered in `evmd/app.go`) | signer = `sender` via the runtime descriptor; `msg.sender` = the signer's 0x address (or a locked owner, `as_owner`); the account sequence is not bumped twice on contract creation; value transfer and state undone on revert; EVM gas charged to the Cosmos gas meter (not internal: normal refund cap and minimum gas); 10M gas cap; interaction with authz `MsgExec` |
| Quantum lock | `evmd/zetaphy_pqguard.go` (`pqLockAnte` after the upstream ante chain, `pqTxSigners` incl. fee payer, EVM post-tx hook on `0x…5051`, `MsgQuantumLock`, genesis export), `as_owner` in `zetaphy_pqcall.go`, `mempool/zetaphy_lock.go` (refusal at submission), panic recovery in `mempool/recheck_pool.go`, ecrecover also on the state-override path | every path a locked ECDSA key could still act through (EVM txs, Cosmos txs, authz `MsgExec`, fee grants, ICA/IBC); controller must be an on-chain ML-DSA-44 account; hook only on successful top-level txs; contract creation nonce handling |
| ML-DSA vote signatures | `setPQVoteHandlers`, `MsgPQVoteKey`, `PQVoteKeyCmd` in `zetaphy_pqguard.go`; `vote_extensions_enable_height` in genesis | liveness (a rejected precommit can stall a height: the node exits instead of signing with an unregistered key); key replacement needs the old key's signature unless the validator is jailed; `validator_owner` for a locked operator; extensions of validators without a key must be empty or signature-sized; registrations at the initial height race with optimistic execution (not handled; validators register after start); message binds chain id, height, block hash; validators without a key are not checked; blocksync and light clients do not check ML-DSA |
| Fee burn | `evmd/zetaphy_feeburn.go`, wiring in `evmd/app.go` | burns 50% of the fee collector every block; rounding, other denoms, panics that would halt the chain |
| ML-DSA precompile | `precompiles/mldsa/*`, `precompiles/types/*`, `x/vm/types/precompiles.go` | input parsing, gas vs CPU, read-only, no panics |
| IBC rate limits | `x/ratelimit/*` (ibc-apps rate-limiting v10.7.0, hash-pinned) + `ZETAPHY_RL_PATCH`; wiring in `evmd/app.go` | the ibc-go v11 port (middleware setters, pointer receivers, ack/timeout of non-ICS-20 packets passed through, no x/params); both IBC v1 and v2 stacks and the ICS-20 precompile send path go through it |

## Node setup (operational, also in scope)

`zetaphy-chain/setup-node.sh`: genesis allocation (1,000,000,000 ZETAPHY, no
inflation), key handling (genesis mnemonics and the faucet key stay on the
node), public ports (8545, 26656, 80/443 via Caddy), JSON-RPC limits, JOIN
mode (genesis and peer fetched over https from another node) and
`--become-validator`.

## Out of scope

Upstream Cosmos SDK / CometBFT / Cosmos EVM / ibc-go code that ZETAPHY does
not modify, and the EVM contracts in `zetaphy-network/contracts` (separate
scope, see that folder's README).

## Already done (free)

- Unit and fuzz tests (`zetaphy-chain/fork-tests`), the full ibc-go transfer
  test suite with the rate limiter in the stack, and real-chain devnet tests
  (`zetaphy-network/test/devnet.pq.integration.js`) in CI on every change.
- gosec on the ZETAPHY packages in CI; govulncheck and an upstream-drift
  build weekly (`.github/workflows/zetaphy-chain-upstream.yml`).
- Internal adversarial reviews (October 2026), the second one of the
  quantum lock and vote signatures: a fee-payer bypass and a node crash on
  malformed txs were found and fixed, with regression tests in
  `fork-tests/evmd/zetaphy_pqguard_test.go`. Not a substitute for an
  independent audit.
