**English** | [ภาษาไทย](README.th.md)

# ZETAPHY EVOLVE — new chain, option 2 (Rollup) from the shared-security doc, zero baht

The shared-security document (Oct 27, 2026) recommends, within option 2,
**Evolve on Celestia**: still our own chain, free on testnet, one sequencer
machine. This folder implements that as a **brand-new chain** — ZETAPHY
(77390) is untouched — with its own gas coin, unlike the OP Stack trial in
[`zetaphy-rollup/`](../zetaphy-rollup/README.md) whose gas is bridged ETH.

- Architecture: ev-node `v1.3.0` single sequencer (commit-pinned build) +
  ev-reth `v0.7.0` docker image (amd64/arm64) as the EVM execution layer +
  a celestia-node `v0.34.4` light node (SHA-256-pinned) on **Mocha**
  (mocha-5) as the DA layer — all on one free Oracle A1 VM.
- Chain ID `77392`; 1,000,000,000 ZEVO minted to an owner key at genesis
  (plus 1,000,000 to `OWNER_EVM_ADDRESS` if set). Lazy mode (1 s blocks
  under load, one block per 60 s when idle) keeps the faucet TIA lasting.
- [`setup-evolve.sh`](./setup-evolve.sh) (~18 KB, fits Oracle's 32 KB
  cloud-init paste) does everything; the one manual step is sending free
  Mocha TIA (web faucets or Discord `$request`, 10 TIA/week) to the
  printed `celestia1…` address. Log: `/var/log/zevolve-setup.log`.
- Replicas: `JOIN=<sequencer host>` re-derives the whole chain from
  Celestia alone (reading DA costs no TIA) — the verification model the
  document describes.
- Per the document, this is the infrastructure for its step 3 ("try
  Evolve"); the full path — ZETAPHY's Cosmos EVM on ev-abci, keeping the
  ML-DSA/Q-day chain rules — remains the 8–14 person-week port it
  estimates (ev-abci is beta on Cosmos SDK v0.50). Known limits carried
  over from the document: single sequencer, non-PQ header signatures, no
  fraud/validity proofs yet.

Status: flag names were checked against the pinned sources; the script's
bash syntax, the embedded key tool, and the generated genesis are tested.
Not yet run end-to-end on a real VM. Safe to re-run; finished steps are
skipped.

Testnet only. Coins have no value. No keys or secrets are in this repository.
