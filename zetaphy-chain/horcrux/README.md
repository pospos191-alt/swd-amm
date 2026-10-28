# Horcrux for a ZETAPHY validator (optional, testnet)

[ภาษาไทย](README.th.md)

[Horcrux](https://github.com/strangelove-ventures/horcrux) splits the validator's **ed25519 signing key**
(`priv_validator_key.json`) into 3 shards on 3 small machines (cosigners). Any 2 of them sign together;
no machine, the node included, holds the whole key any more. `setup-horcrux.sh` sets it up on free machines.

## Does it work with ZETAPHY? Yes, for the ed25519 key, with the limits below

Checked by reading the code (October 2026); **not yet run end to end on a ZETAPHY devnet**. The script's
steps are tested against stand-ins (`zetaphy-network/test/horcrux.test.js`). Try it on a spare validator first.

1. **What signs where.** ZETAPHY is cosmos/evm v0.7.3 on CometBFT v0.39.3 (Cosmos SDK v0.54.3). CometBFT signs
   proposals, prevotes and precommits with ed25519 through its PrivValidator, and since v0.38 it also signs each
   non-nil precommit's *vote extension* with the same key. That PrivValidator can be a remote signer
   (`priv_validator_laddr` in `config.toml`): this is what Horcrux plugs into.
2. **The post-quantum part stays on the node, and is unaffected.** The ZETAPHY patch (in `setup-node.sh`:
   `evmd/zetaphy_pqguard.go`, `evmd/zetaphy_pqcert.go`) signs `(chain id, height, block hash)` with ML-DSA-44
   inside the application: in ABCI `ExtendVote` (the signature *is* the vote extension) and, for the proposer's own
   certificate entry, in `PrepareProposal` (`pqOwnEntry`). Both read `config/pq_vote_key.seed` on the node. None of it
   goes through the PrivValidator, so Horcrux never sees the ML-DSA key and does not need it. The finality
   certificates (`MsgPQCertificate`) are built from the ML-DSA vote extensions and checked against the registered
   ML-DSA public keys; Horcrux only adds the ed25519 signature over those extension bytes, as the file key did.
   **A remote signer does not break the PQ certificates.**
3. **Protocol match.** Horcrux v3.3.2 (its latest release, 7 March 2025) is built on CometBFT v0.38.2 and
   threshold-signs vote extensions (`signer/threshold_validator.go`). CometBFT v0.39.3's remote-signer protocol
   (`proto/tendermint/privval/types.proto`) and the `Vote`, `CanonicalVote` and `CanonicalVoteExtension` messages it
   signs are the same as in v0.38.2 (compared: only formatting differs), so the two speak the same wire format.
4. **Why it is safe with ZETAPHY's extensions.** When asked again for the same height, round and step with the same
   vote bytes (a node restart, a second sentry), Horcrux returns the signatures it made the first time, including the
   extension signature, without comparing the extension. That is right only if the same block always gives the same
   extension. It does: ZETAPHY's ML-DSA signing is deterministic (`circl` `SignTo(..., randomized=false)`). Keep it so.
5. **The key file still matters a little.** Besides signing, the node reads `priv_validator_key.json` for its
   consensus *address* (`pqConsAddr`): `ExtendVote` uses it to pick the seed that matches the registered ML-DSA key
   (`pq_vote_key.seed`, or `.seed.old` while a new key is being registered), and `zetaphyd tx pq-vote-key` signs it into
   the key registration. And the node's start (`cosmos/evm` `server/start.go`) always loads that file, and makes a new
   random one if it is missing. So `switch` replaces it with a **stand-in**: a fresh private key that is never used,
   with the validator's address in its `address` field. CometBFT signs nothing with it while `priv_validator_laddr` is
   set; the ML-DSA code and `pq-vote-key` read the right address. (With the file simply deleted, votes would still be
   signed with `pq_vote_key.seed`, but changing the vote key later would sign the wrong address and be refused.)

## What it protects, and what it does not

| | With Horcrux |
|---|---|
| ed25519 signing key | split 2 of 3; one cosigner stolen or down changes nothing |
| double signing | Horcrux's cosigners agree (Raft) and keep a sign state; they never sign below the height `switch` gives them |
| ML-DSA-44 vote key (`pq_vote_key.seed`) | **still on the node**, like before |
| staking account (keyring) | **still on the node** (it pays fees for unjail and staking) |

Someone with root on the node can still sign ML-DSA votes and use the staking account, but cannot sign ed25519 votes
without 2 cosigners, and the chain needs both signatures on a vote, so the node alone can no longer sign as the validator.
The node needs 2 of 3 cosigners reachable to sign; each vote adds a few network round trips (fine within one region;
blocks are ~5 s apart).

## Limits

- Switch only **after** the node is a validator and its ML-DSA vote key is registered (`zetaphy-validator status`).
  Becoming a validator uses `zetaphyd comet show-validator`, which after the switch shows the stand-in's public key.
  `horcrux address zetaphy_77390-1 zetaphy` on a cosigner shows the real one.
- One sentry node (the validator node itself). More sentries would each need the same `pq_vote_key.seed`; the script
  does not set that up.
- Horcrux's last release is from March 2025. Before using it, check for a newer one and re-pin it here (version and
  both SHA-256, from the release's `horcrux_sha256.txt`).
- Testnet only, like everything here. For real money this needs a devnet test in CI first.

## Machines (free)

Oracle Cloud Always Free, in one account: VM.Standard.A1.Flex (Arm, 4 OCPU and 24 GB in total, split as you like) and
2 × VM.Standard.E2.1.Micro (AMD, 1 GB).

| Machine | Shape |
|---|---|
| validator node (exists already) | A1, 1-2 OCPU, 6-12 GB |
| cosigner 1 | E2.1.Micro |
| cosigner 2 | E2.1.Micro |
| cosigner 3 | A1, 1 OCPU, 6 GB |

Four boot volumes of ~47 GB fit in the free 200 GB. Put all four in the **same VCN** and use their **private IPs**
(10.0.0.x) for `COSIGNERS` and `NODE_ADDR`: cosigner traffic then never leaves Oracle's network and no port is opened to
the internet. In the subnet's security list allow, from those private IPs only: TCP 2222 between the cosigners and
TCP 1234 from the cosigners to the node. The script also opens them in each machine's own firewall (Oracle's Ubuntu
images reject everything else).

Be honest about the trade-off: three cosigners in one Oracle account fall together if the account is taken over (its
password, an API key). Horcrux protects against one machine being broken into, not against the account. Use a strong
password and MFA on the Oracle account. A Google e2-micro as a cosigner is possible, but cosigners exchange messages
for every vote, across the internet then, and its free allowance is 1 GB of outgoing traffic a month (not measured;
likely more than that); stay on Oracle.

## Steps

Every command runs on the machine it names, in a browser SSH window or Oracle Cloud Shell; never on your own computer.
Get the script on each machine:

```bash
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/zetaphy-chain/horcrux/setup-horcrux.sh -o setup-horcrux.sh
```

0. **Back up** `priv_validator_key.json` offline first (`sudo zetaphy-validator backup`). The switch shreds it from the
   node; that backup is the only way back to a single key file.
1. **Node:** `sudo COSIGNERS="10.0.0.11 10.0.0.12 10.0.0.13" NODE_ADDR=10.0.0.10 bash setup-horcrux.sh shard`
   installs Horcrux (pinned, SHA-256 checked), makes the 3 shards and the cosigners' encryption keys, and one bundle per
   cosigner in `/root/zetaphy-horcrux` (root only).
2. **For N = 1, 2, 3:** on the node `sudo bash setup-horcrux.sh bundle N`, copy from `BEGIN` to `END`; on cosigner N
   `sudo bash setup-horcrux.sh cosigner N` and paste. It takes only bundle N, installs Horcrux and a `horcrux` service
   (not started yet), and prints a check that must match the node's. A shard alone cannot sign, but treat it like a
   key: never paste it into a chat or a file on your computer.
3. **Node:** `sudo bash setup-horcrux.sh switch` stops the node and prints the height to start from (one above the last
   height its key signed).
4. **Each cosigner:** `sudo bash setup-horcrux.sh start HEIGHT` with that height. When 2 or 3 say `horcrux started`,
   type `started` on the node. It puts the stand-in key file in place, sets
   `priv_validator_laddr = "tcp://0.0.0.0:1234"`, opens 1234 to the cosigners only, starts the node and offers to shred
   the bundles.
5. **Check:** `sudo zetaphy-validator status` (the height goes up, the validator stays BONDED, not jailed) and on a
   cosigner `journalctl -u horcrux -f`.

**Back to a single key file:** stop Horcrux on **all** cosigners (`sudo systemctl disable --now horcrux`), put the
offline backup at `/root/priv_validator_key.json` on the node, then `sudo bash setup-horcrux.sh rollback`. It checks the
address, sets the node to sign from two heights above the last block (never a height the cosigners may have signed),
clears `priv_validator_laddr` and restarts. Then shred the shards on the cosigners.
