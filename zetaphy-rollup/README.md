**English** | [ภาษาไทย](README.th.md)

# ZETAPHY Rollup — a second, separate chain (OP Stack L2 on Sepolia), zero-baht plan

A **new chain**, not a migration: the existing ZETAPHY Cosmos chain
(chain id 77390) keeps running untouched. This one is an OP Stack rollup
that posts its data to Ethereum Sepolia.

- Chain ID `77391`; gas token is bridged Sepolia test ETH (no value).
- Everything free: an Oracle Cloud Always Free VM, publicnode's free Sepolia
  RPC + beacon endpoints, faucet Sepolia ETH for the L1 contract deployment
  and the batcher/proposer, Caddy + Let's Encrypt + sslip.io for https.
- [`setup-rollup.sh`](./setup-rollup.sh) (fits Oracle's 32 KB cloud-init
  paste limit) builds op-geth / op-node / op-batcher / op-proposer /
  op-deployer from commit-pinned sources, generates the four keys on the
  machine, waits until you send faucet ETH to the printed admin address,
  deploys the L1 contracts with op-deployer (`standard-overrides`, reusing
  the audited OPCM implementations already on Sepolia), then runs the chain
  behind https. Progress log: `/var/log/zrollup-setup.log`.
- Deposit L1→L2 by sending Sepolia ETH straight to the printed
  OptimismPortal address (also served at `https://<host>/zrollup/l1-addresses.json`).
- Read-only replicas: run the same script with `JOIN=<sequencer host>`;
  they derive the chain from Sepolia alone, no P2P and no trust in the
  sequencer machine.

Status: the script follows the pinned versions above; its syntax and the
embedded `zrkeytool` helper are tested, but it has not yet done a full
end-to-end run on a real VM (that needs Oracle + faucet ETH). It is safe to
re-run; op-deployer resumes from its own `state.json`.

Testnet only. No keys or secrets are in this repository.
