# Hyperlane on ZETAPHY (ZETAPHY Saphan, EVM route)

Hyperlane has no deployment on ZETAPHY yet. These files let the `hyperlane-core`
workflow deploy it with the pinned `@hyperlane-xyz/cli@45.0.1`:

| File | What |
|---|---|
| `registry/chains/zetaphy/metadata.yaml` | ZETAPHY testnet for the Hyperlane registry (chain 77390, RPC, 500-block log range) |
| `core-config.yaml` | Mailbox, default ISM and hooks. Every owner is the ZETAPHY timelock (48 h, the gov module proposes) |
| `registry/chains/zetaphy/addresses.yaml` | the deployed addresses (Mailbox `0x0f1C59C6e98c88E1ddc2Ff98Bee11dadA07fEaCe`), from workflow run 39835974651 |
| `agent-config.json` | written by the workflow: the config for the relayer and validator |

Sepolia → ZETAPHY trusts Hyperlane's own Sepolia validator (`0x3c659e0f…6e7c`, threshold 1,
from hyperlane-monorepo `typescript/sdk/src/consts/multisigIsm.ts`). We run only a relayer for
that direction. ZETAPHY → Sepolia needs our own validator and a multisig ISM on Sepolia (later).

Deployed on the testnet on 2026-10-22. Running the workflow again never redeploys: it checks every
owner on chain (the interchain account router, which the CLI gives to the deployer, is handed to the
timelock) and writes `agent-config.json`.

Run: Actions → **hyperlane-core** → Run workflow → `dry_run = yes` first (a local throwaway
chain, nothing sent), then `dry_run = no` on the testnet. Checked locally: the dry-run config
deploys, the Sepolia route lists that validator with threshold 1, and every owner is the timelock.

Testnet only: the bridge on top of this opens only with `zetaphy bridge open --testnet`
(docs/BRIDGE-TESTNET.md, not audited).

## Agents on the Oracle VM (`setup-agents.sh`)

`sudo bash setup-agents.sh` installs Docker and the pinned agent image
(`agents-v2.3.0`, by digest), downloads `agent-config.json` pinned by commit and SHA-256,
makes the validator and relayer keys on the VM and starts the validator. It prints only the two
addresses. The relayer starts later with `RELAYER_SENDERS=<bridge lanes>`: it relays only
their messages. CI (`hyperlane-agents` workflow) runs the script on a local chain: announce,
a signed checkpoint, the relayer whitelist, and no key in the logs.

## The bridge on top (`bridge-testnet` workflow)

Sepolia ETH -> ZETAPHY, testnets only. The Sepolia `HyperlaneLockBox` locks ETH and dispatches to
the `HyperlaneLane` on ZETAPHY; `zetaphy deploy-bridge --testnet` deploys the ZETAPHY side CLOSED
(admin = the timelock, guardian = the 2-of-2 multisig, daily limit 1 sETH). If Hyperlane's Sepolia
gas paymaster does not quote ZETAPHY, the lockbox uses Sepolia's MerkleTreeHook alone and our own
relayer delivers (`setup-agents.sh start-relayer` with `RELAYER_SENDERS=<the lockbox>`).
Run: Actions -> **bridge-testnet** -> `check`, then `dry_run` (local copies of both chains), then `deploy`.

## Saphan v2: more source chains, both directions (`saphan-route` workflow)

`saphan-chains.json` is the chain table (Sepolia, Base Sepolia, Arbitrum Sepolia: addresses from the Hyperlane
registry, default validators from the Hyperlane monorepo, both pinned by commit in the file). Each source chain gets
its own stack: a `HyperlaneLockBoxV2` on the source chain (locks; releases after a delay, behind a multisig ISM of
OUR validator(s) for origin ZETAPHY), and on ZETAPHY its own guard, bridged token, airlock, lanes and a
`HyperlaneOutbox` (the way back). `agent-config.json` now also lists `basesepolia` and `arbitrumsepolia` (made with
the pinned CLI from the registry). Deployed routes go to `saphan-routes.json`. The `hyperlane-relayer` workflow
relays every route both ways and runs our validator (`ZETAPHY_VALIDATOR_KEY`) only while a release waits, with its
checkpoints in the Actions cache. Design, egress estimate and the owner's steps: docs/SAPHAN-MULTICHAIN.md.

## Saphan token routes: tokens born on ZETAPHY going out (`saphan-route` with `token = <key>`)

The `tokens` section of `saphan-chains.json` lists tokens created on ZETAPHY (the native coin through its ERC-20
precompile, `zZETAPHY` on the other side; BZTPHY listed but not movable) and their destination chains. Per token and
destination: a `ZetaphyTokenVault` on ZETAPHY (escrow) and a `SaphanSyntheticToken` on the destination (minted only
by that vault's messages, verified by our validators). Deployed routes go to `saphan-routes.json` under `tokens`; the
relayer whitelists and relays them both ways. Design and the owner's steps: docs/SAPHAN-TOKENS.md.
