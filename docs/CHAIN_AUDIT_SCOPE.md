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

## In scope (ZETAPHY code, ~1,300 lines)

| Area | Files (in the patched tree) | What to check |
|---|---|---|
| ML-DSA-44 account keys | `crypto/mldsa44/*`, `crypto/codec/*.go`, `ante/sigverify.go` | signature verification (pure ML-DSA, empty context, over SIGN_MODE_DIRECT bytes); address = sha256(key)[:20] and collisions with other key types; hand-written protobuf (`keys.pb.go`, runtime descriptor); gas per verification (30,000) vs CPU |
| Public JSON-RPC methods | `evmd/zetaphy_rpc.go` | `zetaphy_pqAccount`, `zetaphy_sendCosmosTx` (64 KB cap, decode before broadcast), `zetaphy_faucet` (key file, rate limits, nonce handling) on the public port 8545 |
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
- An internal adversarial review (October 2026). Not a substitute for an
  independent audit.
