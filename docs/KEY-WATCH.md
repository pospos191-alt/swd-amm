**English** | [ภาษาไทย](KEY-WATCH.th.md)

# Key watch: notice a stolen key while there is still time to veto

Every admin action on ZETAPHY waits in a timelock (48 h), and every bridge release waits a delay a guardian can veto.
That only protects us if someone **notices** in time. Key watch is a free, read-only watcher that turns the first sign of a
stolen key into a GitHub issue, so GitHub emails and app-notifies the owner within about 15 minutes.

- Workflow: [`.github/workflows/key-watch.yml`](../.github/workflows/key-watch.yml), every 15 minutes (and by hand: Actions → key-watch → Run workflow)
- Script: [`zetaphy-network/scripts/key-watch.js`](../zetaphy-network/scripts/key-watch.js)
- Watch list: [`zetaphy-network/key-watch.json`](../zetaphy-network/key-watch.json)
- Tests: `cd zetaphy-network && node --test test/keywatch.test.js`

Free: public RPCs only, no secrets, no paid service. The only token is the workflow's built-in `GITHUB_TOKEN` with
`issues: write`. Testnets only.

## What is watched

Chains: **ZETAPHY testnet** (77390, `https://rpc.sawasdeecoin.com`), **Sepolia**, **Base Sepolia**, **Arbitrum Sepolia**.
RPCs and explorers come from [`zetaphy-chain/hyperlane/saphan-chains.json`](../zetaphy-chain/hyperlane/saphan-chains.json)
(several RPCs per chain: the next one is tried when one fails).

| Who | Where | What raises an alert |
|---|---|---|
| Deployer `0x6af57fC3…2A245` | every chain | any new transaction (nonce goes up), a balance drop |
| ZETAPHY Hyperlane validator `0x80b654fd…5019Bc` | every chain | any new transaction, a balance drop |
| Guardian multisig owners `0xeBc7EAcf…99d1b`, `0x6138233a…3b5ec` | every chain | any new transaction, a balance drop |
| ZetaphyTimelock `0x731db924…90340` | ZETAPHY | `CallScheduled`, `CallExecuted`, `Cancelled`, `MinDelayChange`, `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` |
| Guardian multisig `0x5bcC8290…17Eb5` | ZETAPHY | `Proposed`, `Confirmed`, `Executed` |
| BridgeGuard, BridgeAirlock, HyperlaneLane, NeuroLane | ZETAPHY | `Paused`/`Unpaused`, `Vetoed`, `Tripped`/`Untripped`, `GovernanceSet`, `GuardianSet`, `VetoerSet`, `MarkerSet`, `LaneSet`, `IsmSet`, `ThresholdSet`, `RouteSet`, limit and delay changes, balance drop |
| NeuroControl, ThreatRegistry, RewardVault, StableGateway, NeuroIdentity, ZetaphyOracle, PythRelay, DEX / DLMM factories, NFT marketplace | ZETAPHY | the same governance / guardian / pause events, `FeedPaused`, `CircuitBreakerTripped`, `OwnershipTransferred`, `Upgraded` |
| HyperlaneLockBox v1 `0xc0081832…b23c6` (closed route) | Sepolia | `Paused`/`Unpaused`, `ReleaseVetoed`, `VetoLifted`, `IsmSet`, `GuardianSet`, `DailyLimitSet`, …, balance drop |
| Saphan v2 routes (lockbox, its multisig and timelock; token vaults and synthetics) | each chain | added **automatically** from [`saphan-routes.json`](../zetaphy-chain/hyperlane/saphan-routes.json) once the saphan-route workflow deploys them; nothing is watched there before that |

Event names are exactly those in `zetaphy-network/contracts/*.sol` and OpenZeppelin 5.4 (TimelockController,
AccessControl, Ownable, Pausable). Ordinary traffic (bridge transfers, `Transfer`, `Poked`, …) is not alerted.

Severity: **CRITICAL** = a watched key signed a transaction, a timelock call was scheduled, a role, owner, governance,
guardian, lane or ISM changed, a veto was lifted. **HIGH** = pause/unpause, veto, executed/cancelled calls, limit changes,
balance drops, multisig proposals. **WARNING** = the watcher fell far behind and skipped blocks.

**Validators (optional).** With `"rest"` (the node's Cosmos REST, e.g. `https://rpc.sawasdeecoin.com/rest`) and
`"validators"` (`zetaphyvaloper1…`) set under `chains.zetaphy`, it also alerts when a validator is jailed or its bonded
status changes, and on every new gov proposal. That matters: on ZETAPHY the timelock's proposer is the **gov module**, and
a gov proposal's `MsgEVMCall` logs are not visible through `eth_getLogs`, so a new proposal is the earliest sign.

**ZETAPHY is paused until 1 Nov 2026.** `quietUntil` keeps the watcher silent about it until then; after that, an
unreachable chain gives one notice a day at most (see below).

## How alerts reach you

- All alerts of a run go into **one open issue labelled `security-alert`**: a comment on it, or a new issue if none is
  open. GitHub notifies the owner (email / app; check *Settings → Notifications → Participating and @mentions /
  Watching* and that you watch this repository).
- Each alert carries a hidden marker (`<!-- key-watch:… -->`), so the same event is never posted twice, even if the
  saved state is lost. Close the issue once handled; the next alert opens a new one.
- Each alert has explorer links (address, tx, block), who sent the transaction, the decoded arguments and, for
  `CallScheduled`, **the time it becomes executable**: your deadline.
- A chain no RPC answers for over an hour gets **at most one comment a day** in a separate issue labelled
  `key-watch-health` ("key-watch can't reach X").
- First run (or after the cache is evicted): a baseline is taken, nothing is alerted. Start with a look back:
  *Run workflow* with `lookback` = blocks to rescan.

The state (last block, nonces, balances, what was reported) lives in the Actions cache (`key-watch-state-*`). It is
saved only after a successful run: if posting the alert failed, the next run finds the same alerts again.

> Note: if this repository is public, these issues are public. They only contain public chain data about addresses
> that are already committed here.

## Adding or changing what is watched

Edit [`zetaphy-network/key-watch.json`](../zetaphy-network/key-watch.json) in a pull request:

```json
{ "address": "0x…", "label": "what it is", "kind": "eoa" }
```

- `everyChain`: keys watched on every chain (deployer, validator, multisig owners).
- `chains.<name>.watch`: one chain only. `kind`: `eoa` (nonce + balance), `timelock`, `multisig`, `bridge`, `contract`
  (events + balance).
- **Planned transactions** from a watched key (a deploy, a multisig confirmation): set `"expectNonceUpTo": N` on that
  entry first (the nonce the key will reach), or `"allowOutgoing": true` for a key that sends routinely (then only balance
  drops alert). Better: keep them alerting and just acknowledge the alert in the issue.
- A new chain: add it to `saphan-chains.json` (RPC, explorer) and an entry under `chains` here.
- Thresholds in `defaults`: `balanceDropPct` (10), `balanceDropMin` (0.05 native coin), `confirmations`, `logChunk`,
  `maxBlocksPerRun`, `rpcDownNoticeHours` (24), `rpcDownGraceMinutes` (60).
- Check locally (read-only, prints instead of posting): `cd zetaphy-network && node scripts/key-watch.js --dry-run`.

## When an alert fires

First: **was it you?** Planned deploys, a multisig confirmation you made, a timelock call the team proposed: reply in
the issue and close it. If not, assume the key is stolen and act in this order. Do not paste keys or seed phrases
anywhere (chat, issues, commits).

1. **Stop the money first (guardian, no delay).** Guardian actions only reduce risk, so they never wait:
   - pause the bridge: `zetaphy bridge pause` (BridgeGuard; airlock and lanes follow), the lockbox / token vault:
     `pause()` from its guardian multisig;
   - veto a queued release: `BridgeAirlock.veto(id, reason)`, `HyperlaneLockBoxV2.veto(id)`, `SaphanTokens.veto(id)` —
     the id is in the alert (`ReleaseQueued` / `Queued`) or on the explorer;
   - pause NeuroControl (`zetaphy neuro send pause`), a price feed (`zetaphy oracle pause <asset>`).
   On ZETAPHY the guardian is the multisig `0x5bcC8290…`: one owner proposes, the second confirms.
2. **Cancel the scheduled call before its ready time.** `zetaphy timelock status <id>` shows it;
   `zetaphy timelock cancel <id>` prints the call for whoever holds `CANCELLER_ROLE`: on ZETAPHY the gov module (a gov
   proposal: start it **at once**, voting takes time), on a source chain its SimpleMultisig. If cancelling cannot finish
   before the ready time, the pauses of step 1 still hold: only governance unpauses.
3. **Rotate the key.**
   - Deployer / any repository-secret key (`ZETAPHY_DEPLOYER_KEY`, `ZETAPHY_VALIDATOR_KEY`, monitor keys): make a new
     key offline, replace the repository secret, move what is left out of the old address. It should hold no roles (the
     launch handed everything to the timelock); check with `zetaphy timelock status`.
   - Hyperlane validator: new key → add it to `zetaphyValidators` in `saphan-chains.json`, then governance sets the new
     ISM on every lockbox / lane (the old key can sign false releases until then: keep the routes paused).
   - A multisig owner: the other owners pause; replace the owner through a new multisig + governance (SimpleMultisig
     owners are fixed); `GuardianSet` / timelock role changes then wait the delay.
4. **Write it down**: what happened, which keys, what was paused; then unpause through governance once safe.

## Limits

- Polling every 15 minutes (GitHub may delay scheduled runs by several minutes): a fast thief can move a hot key's
  balance before you read the email. The protection is the delays: timelock 48 h, bridge release delays. The watcher
  only makes sure you hear about it in time.
- A schedule runs on the default branch only; it starts once this workflow is merged there.
- Public RPCs limit `eth_getLogs`; ranges are scanned in chunks (`logChunk`). A failed chunk is retried next run.
- More than `maxLagBlocks` behind (e.g. after a long outage): it jumps ahead and posts a WARNING with the skipped range.
