# Hyperlane on ZETAPHY (ZETAPHY Saphan, EVM route)

Hyperlane has no deployment on ZETAPHY yet. These files let the `hyperlane-core`
workflow deploy it with the pinned `@hyperlane-xyz/cli@45.0.1`:

| File | What |
|---|---|
| `registry/chains/zetaphy/metadata.yaml` | ZETAPHY testnet for the Hyperlane registry (chain 77390, RPC, 500-block log range) |
| `core-config.yaml` | Mailbox, default ISM and hooks. Every owner is the ZETAPHY timelock (48 h, the gov module proposes) |
| `registry/chains/zetaphy/addresses.yaml` | written by the workflow after the deploy |
| `agent-config.json` | written by the workflow: the config for the relayer and validator |

Sepolia → ZETAPHY trusts Hyperlane's own Sepolia validator (`0x3c659e0f…6e7c`, threshold 1,
from hyperlane-monorepo `typescript/sdk/src/consts/multisigIsm.ts`). We run only a relayer for
that direction. ZETAPHY → Sepolia needs our own validator and a multisig ISM on Sepolia (later).

Run: Actions → **hyperlane-core** → Run workflow → `dry_run = yes` first (a local throwaway
chain, nothing sent), then `dry_run = no` on the testnet. Checked locally: the dry-run config
deploys, the Sepolia route lists that validator with threshold 1, and every owner is the timelock.

Testnet only: the bridge on top of this opens only with `zetaphy bridge open --testnet`
(docs/BRIDGE-TESTNET.md, not audited).
