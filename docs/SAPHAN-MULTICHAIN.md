# ZETAPHY Saphan: EVM routes v2 (many source chains, both directions)

**Testnets only, not audited.** Sepolia, Base Sepolia and Arbitrum Sepolia <-> the ZETAPHY testnet (77390),
over Hyperlane. Test coins only (docs/BRIDGE-TESTNET.md).

The first route (v1, `bridge-testnet.json`) went one way only: Sepolia -> ZETAPHY, with a lockbox that cannot
release. v2 adds the way back, more source chains, and a chain table so the next chain is a config entry plus a
workflow run.

The reverse direction, tokens born on ZETAPHY (first the native coin) going out to these chains and back, is in
docs/SAPHAN-TOKENS.md: the same chain table (`tokens`), workflow (`token = <key>`), validators and relayer.

## Design

```
 source chain X (Sepolia / Base Sepolia / Arbitrum Sepolia / ...)          ZETAPHY (77390)
 ─────────────────────────────────────────────                           ─────────────────────────────────────────────
 HyperlaneLockBoxV2(X) ── lock: Hyperlane message ─────────────────────▶ HyperlaneLane(X)        ┐
   ▲  ISM: OUR validators for origin ZETAPHY        (ISM(X) on ZETAPHY:   NeuroLane(X) (runners) ┼▶ BridgeAirlock(X) ─▶ BridgeGuard(X) mints token(X)
   │  (multisig, threshold from the table)           Hyperlane's own                              ┘   2+ independent lanes, quarantine,
   │  delay, daily limit, veto, pause, backing       validator for X)                                  vetoes, markers, ThreatRegistry
   │                                                                                                    daily limits, hard cap, pause
   └── release: Hyperlane message ◀─────────────────────────────────────── HyperlaneOutbox(X) ◀── BridgeGuard(X) burns token(X)
                                                                            (outbound-only route of guard X)
 roles on X: SimpleMultisig(X) = guardian and proposer of ZetaphyTimelock(X) = governance (48 h)
```

One **stack per source chain**: every source chain X has its own lockbox on X and, on ZETAPHY, its own
`BridgeGuard` (and so its own bridged token: `sepETH`, `baseETH`, `arbETH`), `BridgeAirlock`, `NeuroLane`,
`HyperlaneLane` and `HyperlaneOutbox`. The inbound contracts are the v1 ones, unchanged; `zetaphy deploy-bridge
--hyperlane-outbox` adds the outbox.

### Why one token per source chain (not one shared ETH)

A shared token with per-origin accounting would let anything that mints it (a hole in any one route) burn it
toward any other route, and the other route's lockbox would pay out ETH that its own users locked. With one
token per source chain:

- a forged mint on route A creates only `token(A)`; only `HyperlaneOutbox(A)` can burn it (its guard's
  outbound route), and that outbox can only address `HyperlaneLockBoxV2(A)` (immutable);
- `HyperlaneLockBoxV2(B)` accepts releases only from origin ZETAPHY **and** sender `HyperlaneOutbox(B)`, with a
  body naming ZETAPHY's chain id and that outbox as the source and B's chain id and this lockbox as the destination;
- each lockbox pays at most its own `locked` (everything locked there minus everything released there), so even
  a forged release that passed every check above cannot take ETH locked on another chain, or more than its own;
- each guard has its own daily limits and hard cap; pausing one route leaves the others alone.

The cost: three tokens instead of one (a DEX pool can still pair them). Tests:
`zetaphy-network/test/saphan.test.js` ("two source chains are isolated", "backing").

### Inbound (source chain X -> ZETAPHY): unchanged defence in depth

`HyperlaneLockBoxV2.lock(to, amount)` sends the v1 message (same 192-byte body, same `Locked` event) through X's
Mailbox with X's merkle tree hook, and records the lock's transfer id (`transferIds(n)`). On ZETAPHY:

- `HyperlaneLane(X)` names its own ISM: a multisig ISM of Hyperlane's validators for X (from the chain table;
  made by ZETAPHY's `StaticMessageIdMultisigIsmFactory`, no timelock action on the Mailbox's default ISM needed);
- the lane accepts only origin X and sender `HyperlaneLockBoxV2(X)` and attests to `BridgeAirlock(X)`;
- NeuroLane(X) runners watch the lockbox (`zetaphy bridge watch --source-rpc <X> --lockbox <lockbox>`), a second,
  independent lane; the airlock needs both, then the quarantine, then `BridgeGuard(X)` mints within its limits.

### Outbound (ZETAPHY -> source chain X): new

1. `HyperlaneOutbox(X).send(to, amount)` (msg.value = `quoteSend`, 0 on ZETAPHY): `BridgeGuard(X).outbound`
   burns the caller's `token(X)` through the guard's **outbound-only** route (daily limit, hard cap, pause,
   ThreatRegistry hold), then the outbox dispatches a 256-byte release through ZETAPHY's Mailbox.
2. Our validator(s) sign ZETAPHY's checkpoint; the relayer delivers it to X's Mailbox.
3. X's Mailbox asks `HyperlaneLockBoxV2(X).interchainSecurityModule()`: a `StaticMessageIdMultisigIsm` of **our**
   validators for origin ZETAPHY (threshold from the table), made by X's own Hyperlane factory. Never the
   Mailbox default; never zero.
4. `handle()` checks the Mailbox, origin domain 77390, sender = the outbox, every body field, replays; then
   **queues** the release (`ReleaseQueued`). It never pays at once and never refuses for a limit or a pause.
5. After `releaseDelay` (1 h in the table) anyone calls `claim(id)`: paid to the receiver if not vetoed, not
   paused, within the daily release limit (else it waits for the next day) and within `locked`.

Guardians (the multisig on X) act at once but only reduce risk: `pause`, `veto(id)`, `lowerDailyLimit`,
`raiseReleaseDelay`. Governance (the timelock on X) changes the ISM, raises limits, lifts vetoes, unpauses.

`BridgeGuard` gained one thing for this: `setOutboundRoute` (an id that only burns; `inbound()` and
`releaseHeld()` refuse it, so it never mints and needs no airlock; enabling it still needs the audit on record
and a daily limit within the hard cap; an id keeps its kind). `zetaphy bridge open` enables it together with the
inbound route (same daily limit); `zetaphy bridge close` closes both.

### What is checked where

| Threat | Stopped by |
|---|---|
| A message from another origin domain or sender | Lane / lockbox `WrongOrigin`, `WrongSender` (tests and the dry run) |
| A replayed message | The Mailbox (`already delivered`), lane `Replay`, lockbox `Replay` |
| Our validator key stolen (outbound) | Release delay + guardian veto, daily release limit, `locked` (this route only), pause; more validators and a higher threshold in the table |
| Hyperlane's validator for X wrong (inbound) | The second lane (NeuroLane) must agree, quarantine, vetoes, guard limits (as v1) |
| A message of route A sent to route B | Sender and body (source, destination) checks; B's backing only |
| A hole on ZETAPHY minting token(A) | Only A's outbox burns it; only A's lockbox releases for it, within A's limits and backing |

## The chain table: adding a chain

`zetaphy-chain/hyperlane/saphan-chains.json` (checked by `zetaphy-network/src/saphan.js chainProblems`):

- `chains.<name>`: chain id, Hyperlane domain, Mailbox, MerkleTreeHook, ValidatorAnnounce and
  StaticMessageIdMultisigIsmFactory from the Hyperlane registry
  ([hyperlane-registry@fd1acc2](https://github.com/hyperlane-xyz/hyperlane-registry/tree/fd1acc240ea812d1ae76cd81a9872c0b526c020a/chains),
  `chains/<name>/addresses.yaml`, `metadata.yaml`); Hyperlane's default validators for that origin
  ([hyperlane-monorepo@1aadbba `typescript/sdk/src/consts/multisigIsm.ts`](https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/1aadbba0696ecf96ed4c06f78c978d08db22c0ad/typescript/sdk/src/consts/multisigIsm.ts):
  `0x3c659e0f…6e7c`, threshold 1, for all three); RPCs, explorer, token name/symbol, limits, faucet ETH.
- `zetaphyValidators`: our validator(s) for origin ZETAPHY and the threshold (empty until the owner adds the
  address of `ZETAPHY_VALIDATOR_KEY`; the deploy refuses while it is empty).
- `origin`: owners and threshold of each source chain's multisig (default: the ZETAPHY guardian multisig's two
  owners, 2-of-2) and the timelock delay (48 h).

A new chain: copy an entry with the registry's addresses and validators, add the agent config entry
(`hyperlane registry agent-config --chains ...` with the pinned CLI, as `hyperlane-core` does) and the name to the
`chain` choices of `.github/workflows/saphan-route.yml`, then run that workflow (check, dry_run, deploy). The hub's
Saphan page lists every chain of the table (planned / closed / open) from `hub-config.json`.

Deployed routes are written by the workflow to `zetaphy-chain/hyperlane/saphan-routes.json`; the relayer and the
hub read that file.

## Our validator for origin ZETAPHY, without a machine

The way back needs a Hyperlane validator that signs ZETAPHY's checkpoints, and a place the relayer can read them.

| Option | Cost | Babysitting | Data out of the node (800 MB/month cap) | Verdict |
|---|---|---|---|---|
| On the GCP e2-micro node, local RPC | free | always on; a second container next to the node on 1 GB RAM (OOM risk for the node); setup-node changes | ~0 for the validator; checkpoints still have to reach the relayer | no |
| In GitHub Actions, checkpoints in a public GCS bucket (free tier: 5 GB, 5k writes/month in US regions) | free | a GCP project, a bucket, a service account key (or workload identity) as secrets | same as below | later, if others should relay |
| **In GitHub Actions, checkpoints in the Actions cache, read by the relayer in the same job** | **free** | **none: one secret** | **see below** | **chosen** |

`hyperlane-relayer.yml` starts our validator (pinned `agents-v2.3.0` image, `localStorage` checkpoint syncer
at `/checkpoints`, announced as `file:///checkpoints`) next to the relayer only while a release waits
(`outbox.nonce()` on ZETAPHY > `lockbox.received()` on the source chain), and keeps the validator's database and
checkpoints in the Actions cache. The relayer mounts the same folder read-only (`HYP_ALLOWLOCALCHECKPOINTSYNCERS`).
Nobody else can read these checkpoints, which is fine: only our relayer relays these routes. If the cache is
evicted (7 days unused), the validator re-reads ZETAPHY's merkle tree from the Mailbox's start block and signs
again: slower once, not unsafe.

Egress estimate for the node (JSON-RPC answers of ~0.3-0.5 KB with headers; the agents poll about every 5 s):

- gate, every 15 min: one `nonce()` per two-way route on ZETAPHY: 3 x 2,880 x 0.4 KB ≈ **3.5 MB/month**, plus one
  `delivered()` per v2 lock for 2 days after it (≈ 80 KB per lock);
- an active 8-minute run: relayer ≈ 0.25 MB, validator ≈ 0.15 MB; a transfer usually needs 1-3 runs: **≈ 1-1.5 MB
  per transfer** each way;
- once (and after a cache eviction): the validator reads ZETAPHY from the Mailbox's start in 499-block steps:
  ≈ 0.5-1 MB;
- v1 Sepolia lockbox: unchanged (runs for ~2 days after a lock: up to ~80 MB per lock).

So about 4 MB/month idle and ~2-3 MB per round trip: hundreds of test transfers a month fit in the cap.

## What the owner does after 2026-11-01 (the ZETAPHY RPC is back)

Secrets and keys (names only; values never in the repository):

1. `ZETAPHY_DEPLOYER_KEY`: exists (deployer `0x6af57fC3633dD0F7907f7900dbd4A2822F43a245`; also the relayer's signer).
2. **New** `ZETAPHY_VALIDATOR_KEY`: a fresh secp256k1 key, made in a cloud shell (e.g. Google Cloud Shell:
   `openssl rand -hex 32`), never on a shared screen or in a chat. Copy it straight into a secret of the environment
   `testnet-automation` (Settings → Environments; [SECRETS-HARDENING.md](SECRETS-HARDENING.md)),
   keep a copy offline, then clear the shell (`history -c; clear`). Run Actions -> **saphan-route** (`mode = check`): it prints the key's address.
3. Put that address in `saphan-chains.json` -> `zetaphyValidators.validators` (threshold 1; add more validators and
   raise the threshold later) and merge.

Test coins (free faucets; see `faucets` per chain in the table):

| Account | Chain | Amount | For |
|---|---|---|---|
| deployer | Sepolia | 0.1 ETH | multisig, timelock, ISM, lockbox (~6M gas) + paying releases (~0.25M gas each) |
| deployer | Base Sepolia | 0.02 ETH | the same (cheap) |
| deployer | Arbitrum Sepolia | 0.02 ETH | the same (cheap) |
| deployer | ZETAPHY | a few ZETAPHY | ISMs and the bridge contracts (testnet faucet) |
| validator | ZETAPHY | 1 ZETAPHY | its one-time announce |

Workflow runs, in this order:

1. **saphan-route**, `chain = sepolia`, `mode = dry_run` (works today), then `mode = deploy`. It pushes
   `saphan/sepolia` with the addresses: open the pull request and merge it.
2. The same for `basesepolia`, then `arbitrumsepolia`, each **after** the previous pull request is merged (each
   deploy writes `saphan-routes.json` from main).
3. For each route: the timelock proposals `deploy-bridge` printed (protect the bridge's keys in the
   ThreatRegistry), then NeuroLane runners: `zetaphy bridge watch --source-rpc <chain RPC> --lockbox <lockbox>`
   (with that route's airlock and lane), then `zetaphy bridge open --testnet --audit-report <docs/BRIDGE-TESTNET.md
   url> --audit-sha256 <hex>` with that route's guard and airlock (through the timelock, 48 h). It enables the
   inbound and the outbound route. Then set the route's `state` to `"OPEN"` in `saphan-routes.json` (the hub shows it).
4. **hyperlane-relayer** needs nothing: it picks the routes up from `saphan-routes.json` on main. Run it by hand
   once with `validator = yes` to make the validator announce itself.

The v1 route (`bridge-testnet.json`, Sepolia `HyperlaneLockBox` `0xc008…23c6`, never opened, no release path)
stays as it is and is still relayed; do not open it: the Sepolia v2 route replaces it.

## Verified, and not

- `npm test` in zetaphy-network (contracts on a local EVM with a test Mailbox that checks a message-id multisig
  ISM with real signatures: wrong origin, wrong sender, replay, cross-route messages and tokens, over-limit,
  paused, vetoed, ISM refusals, backing) and zetaphy-hub (including the browser test).
- `scripts/saphan-dryrun.js` against **real Hyperlane contracts** (Mailbox, MerkleTreeHook,
  StaticMessageIdMultisigIsmFactory deployed by `@hyperlane-xyz/cli@45.0.1` on two local chains): lock -> deliver
  -> mint, burn -> deliver -> claim, and the refusals. The workflow's dry run does the same with an anvil fork of
  the real source chain (not run here: no access to public RPCs from the build machine).
- Not run here: the Hyperlane agents themselves (validator writing checkpoints in Actions, the relayer with four
  chains); the deploy against the real testnets.
