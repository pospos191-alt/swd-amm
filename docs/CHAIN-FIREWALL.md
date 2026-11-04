**English** | [ภาษาไทย](CHAIN-FIREWALL.th.md)

# Invariant firewall in the node (chain layer)

Testnet only. Nothing here holds or pays real money, and none of it has been audited by an outside firm.

The [invariant firewall](future/invariant-firewall.md) (SS1) lets a protocol register invariant checkers
(`holds(address) view returns (bool)`) in `InvariantFirewall`. The contract layer (`Firewalled.enforce`) only
protects calls that enter the protocol through a `firewalled` function. **The node layer described here checks the
invariants after every EVM transaction, whatever path the transaction took**, and reverts it if it broke one.
The invariant becomes a chain rule instead of an opt-in modifier.

| Piece | Where | Status |
|---|---|---|
| Node code: hook, registry reads, checker calls, check points, switch, upgrade | `evmd/zetaphy_firewall.go` in `zetaphy-chain/setup-node.sh` (`ZETAPHY_PQ_PATCH`) | real, compiled, in the node |
| Pure logic: strict decoding, bounds, budget, answer rule, newly-broken rule | `evmd/zetaphy_firewall_core.go` (same patch) | real, unit-tested |
| Wiring: `pqHooks.PostTxProcessing`, `MsgEVMCall`, `BeginBlocker`, `MsgSetFuture` kind, genesis, CLI, `zetaphyEarlyUpgrades` | `zetaphy_pqguard.go`, `zetaphy_pqcall.go`, `app.go`, `zetaphy_future.go`, `zetaphy_upgrade.go`, `zetaphy_seccli.go`, `zetaphy_upgradeguard.go` (same patch) | real |
| Fork tests (13): the real `InvariantFirewall` + a vault with a buggy withdraw | `zetaphy-chain/fork-tests/evmd/zetaphy_firewall_test.go`, `zetaphy_firewall_core_test.go`, `testdata/firewall/` | real, in CI |
| Governance command | `gov.sh invariant-firewall <0x… \| ->` | real |

It replaces the prototype that was under `zetaphy-chain/prototypes/invariant-firewall` (never compiled). The prototype
called `chainCheck()` and let the contract run the checkers; the node now reads the registry and calls each
checker itself, so the gas caps, the bounds and the fail-closed rule are enforced by consensus code, not only by
the contract.

## What the node does

```
EVM tx (or MsgEVMCall) succeeds ──► pqHooks.PostTxProcessing / evmCall: firewallPostTx(ctx)
   │  off (no upgrade height, or no contract set)? → nothing
   ▼
 STATICCALL InvariantFirewall.chainProtocols()                 200,000 gas, at most 8 protocols
 for each protocol p, in registry order:
   STATICCALL invariantsOf(p)                                   200,000 gas, at most 8, caps 5,000..500,000
   caps fit in what is left of 2,000,000?  no → p is broken
   for each checker: STATICCALL checker.holds(p) with exactly its cap,
                     from the module address "zetaphy-firewall"
                     anything but 32 bytes encoding true → p is broken (stop at the first)
   ▼
 p broken now and NOT broken at the last check point? → error ErrInvariantFirewall (codespace zetaphy, 40):
                                                         x/vm discards the whole tx (state, logs)
 otherwise → this state is the new check point
```

- **Fail-closed per checker.** `false`, a revert, running out of its cap, 64 bytes, `2`, or no return data:
  each is a violation. The same rule as `InvariantFirewall._holds`.
- **Bounded.** At most 8 protocols, at most 8 invariants each, each cap 5,000..500,000 gas, all caps of one check
  together at most 2,000,000 gas (`CHAIN_GAS_BUDGET`). A protocol whose registry entry breaks a bound counts as
  broken. Worst case per transaction: 9 reads of 200,000 gas plus 2,000,000 gas of checks.
- **Deterministic.** Fixed gas for every call, no wall clock (block time and height come from the header), no
  map iteration (every loop is over a slice in registry order), a cache of the state that is never written back,
  an infinite gas meter and no KV gas (only the EVM gas above counts), no tracer. Every validator gets the same
  answer. `TestFirewallDeterministic` runs the same check on copies of the same state and compares results, error
  text and store hashes.
- **Check points.** The node records the protocols that are broken at the start of each block (`BeginBlocker`,
  after the bridge breaker) and after each transaction that passes (store key `0x32`). Only a protocol that this
  transaction broke reverts it. A protocol that broke some other way (time passed, a non-EVM message, a checker
  that changed its answer) does not block every transaction on the chain. Each check point emits
  `zetaphy_firewall_broken` (protocol, reason) for it.
- **The registry fails open.** If `chainProtocols()` itself cannot be read (no contract, revert, out of gas, a
  malformed answer), the node emits `zetaphy_firewall_error` and lets the transaction through. A broken registry
  must not halt the chain. Everything per protocol and per checker stays fail-closed.
- **"Every transaction that touched a registered protocol".** The node checks the chain-layer protocols after
  **every** successful EVM transaction, not only those that called them. A transaction can drain a protocol without
  calling it (a token pulled with `transferFrom` by an approved spender), so "touched" cannot be decided from the
  call target. The budget above bounds the cost.

### Who decides what is checked

Only protocols on the `InvariantFirewall` chain-layer list: the protocol's governance asks (`requestChain`), the
`ZetaphyTimelock` approves (`approveChain`) within `MAX_CHAIN` and `CHAIN_GAS_BUDGET`, and can drop one at once
(`dropChain`). The node reads that list; it has no list of its own. A protocol's invariants are added and removed
only by its governance (removal waits 2 days), exactly as on the contract layer.

## How it is switched on (off by default)

Two steps, both by governance. A binary swap alone changes nothing.

1. **The code path: the `zetaphy-firewall` software upgrade.** Its handler sets store key `0x33` to the upgrade
   height + 1. Below that height the new binary runs blocks exactly as the old one (the hook returns at once and
   the `invariant-firewall` kind is refused), so replaying old blocks gives the same state. It adds no store and is
   on `zetaphyEarlyUpgrades`: the release may be installed before the vote passes and the chain does not stop
   (the 2026-10-29 lesson). It needs v5 (`zetaphy-v5`), which the testnet has. A new chain can put `0x33` = 1 in
   `app_state.zetaphypq` instead.
2. **The contract: `gov.sh invariant-firewall <InvariantFirewall 0x…>`** (`MsgSetFuture` kind
   `invariant-firewall`, `{"address":"0x…"}`, store key `0x31`). Governance only; the address must hold code. The
   first check point is taken at once. `gov.sh invariant-firewall -` (`{"address":""}`) turns it off again and
   clears the check point. A genesis may set `0x31` (20 bytes) as well.

`firewallOn` = v5 active and height ≥ `0x33` and `0x31` set. The genesis export keeps `0x31` and `0x33` (as 1) and
drops the check point `0x32`.

## Tests

`zetaphy-chain/fork-tests/evmd/zetaphy_firewall_test.go` deploys the real `InvariantFirewall` (solc 0.8.26,
optimizer 200, cancun: `testdata/firewall/InvariantFirewall.bin`) and `ChainVault`, a vault with a buggy
`withdrawBuggy` that does **not** use `Firewalled`, with a solvency invariant and a configurable checker:

| Test | What it shows |
|---|---|
| `TestFirewallDrainReverted` | off: the bug drains the vault. On: the draining tx fails with `ErrInvariantFirewall`, names the vault and the `solvent` checker, and nothing leaves the vault. A healthy withdraw and unrelated calls pass. The Ethereum-tx path (`PostTxProcessing`) reverts the same state; a failed tx is not checked. Switched off: the bug works again. |
| `TestFirewallFailClosed` | false, revert, out of gas, 64 bytes, `2`, nothing, and "would pass with more gas than its cap": each is a violation. A protocol broken outside the EVM before the block does not block other txs (and is reported); healed and broken again by a tx: reverted. Dropped by the timelock: no longer checked. |
| `TestFirewallRegistryFailsOpen` | a registry that burns all its gas: `zetaphy_firewall_error`, txs go through. |
| `TestFirewallDeterministic` | same state → same list, same verdicts, same reasons, same error text; checking writes nothing (EVM and zetaphypq store hash unchanged). |
| `TestFirewallSwitch` | governance only, a contract only, unknown JSON fields refused; before the upgrade the kind is refused and an address in the store is ignored; the upgrade sets H+1; genesis export/validation; the CLI. |
| `TestFirewallUpgradeEarlyBinary` | the release with the handler runs before the voted height without stopping; the handler runs at the height; still off until governance names a contract. |
| `TestFirewallSelectors`, `TestFirewallRegistryDecode` | the node's selectors and decoders against the real contract's answers; a checker with no code is a violation. |
| `zetaphy_firewall_core_test.go` (5) | strict decoding (sizes, offsets, duplicates, zero addresses, > 8 entries, caps 4,999 / 500,001 / 2³²), the answer rule, the 2,000,000 budget, the newly-broken rule, the stored set. |

Run (as CI does, job "zetaphy-chain (patched node + PQ devnet)" and the arm64 job):

```bash
bash zetaphy-chain/setup-node.sh --patch-source "$SRC" && cp -r zetaphy-chain/fork-tests/. "$SRC/"
cd "$SRC/evmd" && go test -tags=test -run 'EVMCall|PQ|QDay|Threat|Security|Wasm|Future|Immune|Breaker|Guard|Anomaly|AI|Upgrade|ModelAt|Firewall' .
```

## Upgrade runbook: the testnet node `zetaphy-node-0`

The testnet runs one validator on the GCP VM `zetaphy-node-0` (Ubuntu 24.04, systemd services `zetaphyd` and
`zetaphy-rpc-guard`, Caddy in front, node user `zetaphy`, data in `/home/zetaphy/.zetaphy`, binary
`/usr/local/bin/zetaphyd`). Run these yourself; nothing here was run against the live node.

Legend: **[read]** changes nothing. **[CHANGES FILES]** writes files on the VM. **[CHANGES CHAIN]** sends a
transaction. Replace `<ZONE>`, `<H>`, `<ID>`, `<FW>` and `<COMMIT>` (the commit on `main` with this change).

### 0. Before you start

- This change is merged to `main`, and the published copy of `setup-node.sh` matches `cloud-init.sh` (run
  `zetaphy-chain/pack-cloud-init.sh` and publish `public/` to `pospos191-alt/zetaphy-chain`, as for every
  `setup-node.sh` change).
- An `InvariantFirewall` is deployed (SS1 contracts; constructor `InvariantFirewall(AuditCertificate,
  ZetaphyTimelock, uncertifiedBps)`); its address is `<FW>`. Turning the node layer on is pointless before at least
  one protocol is approved for the chain layer.

### 1. Connect and look **[read]**

```bash
gcloud compute ssh zetaphy-node-0 --zone <ZONE>                        # from your computer or Cloud Shell
systemctl status zetaphyd zetaphy-rpc-guard caddy --no-pager | head -30  # [read]
/usr/local/bin/zetaphyd version                                         # [read]
curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height   # [read] current height
/usr/local/bin/zetaphyd q upgrade plan --node tcp://127.0.0.1:26657     # [read] must be "no upgrade scheduled"
df -h / && free -m                                                      # [read] the build needs ~6 GB of disk
```

### 2. Back up **[CHANGES FILES]**

```bash
# [CHANGES FILES] keep the running binary for the rollback
sudo cp -a /usr/local/bin/zetaphyd /usr/local/bin/zetaphyd.pre-firewall
# [CHANGES CLOUD] a disk snapshot (from your computer / Cloud Shell; it costs a little storage)
gcloud compute disks snapshot zetaphy-node-0 --zone <ZONE> --snapshot-names zetaphy-pre-firewall-$(date +%Y%m%d)
```

### 3. Build the new binary on the VM **[CHANGES FILES]**

The same steps as `setup-node.sh` step 4 (pinned Cosmos EVM commit, then the ZETAPHY patches, then `make install`),
in a separate folder, as the node user. It does not touch the running node.

```bash
sudo -u zetaphy -H bash -c '
set -euo pipefail
GO=$(command -v go || echo /usr/local/go/bin/go)
export PATH=$(dirname "$GO"):$PATH GOTOOLCHAIN=go1.25.9
[ "$(free -m | awk "/Mem:/{print \$2}")" -lt 3000 ] && export GOFLAGS=-p=1 GOGC=50   # small VM: one compile at a time
src=$HOME/src/evm-firewall
rm -rf "$src"                                                                         # [CHANGES FILES] (only this folder)
git clone -q --depth 1 --branch v0.7.3 https://github.com/cosmos/evm.git "$src"
[ "$(git -C "$src" rev-parse HEAD)" = c3ae9067a7eadcdea55a5192226916deb44c71c4 ]
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/zetaphy/<COMMIT>/zetaphy-chain/setup-node.sh -o $HOME/setup-node-firewall.sh
grep -q "ZetaphyFirewallUpgradeName = \"zetaphy-firewall\"" $HOME/setup-node-firewall.sh
cd "$src" && bash $HOME/setup-node-firewall.sh --patch-source "$src"
make install                                                                          # -> $HOME/go/bin/evmd
$HOME/go/bin/evmd version
'
```

On an e2-micro this takes an hour or more (it uses swap). Alternatively, once the `release-zetaphyd` workflow
has built the release for that `setup-node.sh`, `sudo zetaphy-validator update` installs it (SHA-256 checked)
instead of steps 3 and 4.

### 4. Install it **[CHANGES FILES]** (restarts the node; the chain goes on)

`zetaphy-firewall` may run early, so the new binary can go in before the vote. Below the upgrade height it
produces exactly the same blocks as the old one.

```bash
sudo install -m 755 /home/zetaphy/go/bin/evmd /usr/local/bin/zetaphyd                # [CHANGES FILES]
sudo systemctl restart zetaphyd zetaphy-rpc-guard                                     # restarts the node
sleep 20; curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height   # [read] must keep rising
journalctl -u zetaphyd -n 50 --no-pager | grep -iE "panic|error|CONSENSUS FAILURE" || echo ok   # [read]
```

### 5. Vote the upgrade **[CHANGES CHAIN]**

Voting takes 600 s and blocks come every ~5 s, so `H` must be at least ~150 blocks ahead; 300 is safe.

```bash
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/zetaphy/main/zetaphy-chain/gov.sh -o /tmp/gov.sh   # [CHANGES FILES] /tmp only
H=$(( $(curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height) + 300 )); echo "H=$H"
sudo -u zetaphy -H bash -c "cd ~ && bash /tmp/gov.sh propose-upgrade zetaphy-firewall $H 'Node-level invariant firewall (off until voted)'"   # [CHANGES CHAIN]
sudo -u zetaphy -H bash -c 'cd ~ && bash /tmp/gov.sh vote <ID> yes'                    # [CHANGES CHAIN]
# after block H:
/usr/local/bin/zetaphyd q upgrade applied zetaphy-firewall --node tcp://127.0.0.1:26657   # [read] shows H
```

`gov.sh propose-upgrade` refuses the name until a release on `main` has it and is built; if you built it yourself
(step 3) before the release exists, prefix `FORCE=1`.

### 6. Switch the firewall on **[CHANGES CHAIN]**

```bash
sudo -u zetaphy -H bash -c 'cd ~ && bash /tmp/gov.sh invariant-firewall <FW>'          # [CHANGES CHAIN] proposal
sudo -u zetaphy -H bash -c 'cd ~ && bash /tmp/gov.sh vote <ID> yes'                    # [CHANGES CHAIN]
# after the vote ends: the check points report what is broken (nothing, ideally) and any registry error  [read]
h=$(curl -s localhost:26657/status | jq -r .result.sync_info.latest_block_height)
curl -s "localhost:26657/block_results?height=$h" | jq '[.result.finalize_block_events[]? | select(.type|startswith("zetaphy_firewall"))]'
```

A transaction the firewall refuses shows as failed with `invariant firewall` and the protocol and checker in its
error (`raw_log` / `eth_getTransactionReceipt` status 0).

### Rollback

- **Turn it off (any time, no binary change)** **[CHANGES CHAIN]**: `gov.sh invariant-firewall -`, then
  `gov.sh vote <ID> yes`. This is the normal way back.
- **Before the upgrade height H** (binary installed, upgrade not applied yet) **[CHANGES FILES]**: the old binary
  still works:
  ```bash
  sudo install -m 755 /usr/local/bin/zetaphyd.pre-firewall /usr/local/bin/zetaphyd && sudo systemctl restart zetaphyd zetaphy-rpc-guard
  ```
  If the upgrade proposal already passed, the old binary stops at H with `UPGRADE "zetaphy-firewall" NEEDED`;
  cancel the plan first by a governance `MsgCancelUpgrade` proposal, or put the new binary back before H.
- **After H**: the old binary cannot run the chain any more (the applied upgrade's handler is missing from it).
  Keep the new binary and turn the firewall off as above. Only if the new binary itself fails (crash, app-hash
  error), stop `zetaphyd`, restore the disk snapshot from step 2 and the old binary; blocks made after the snapshot
  are lost (single-validator testnet).
- Clean up when done **[CHANGES FILES]**: `sudo -u zetaphy rm -rf /home/zetaphy/src/evm-firewall /home/zetaphy/setup-node-firewall.sh`.

## Limits

- **Not every path is an EVM transaction.** CosmWasm, bank and IBC messages are not checked. If one of them breaks
  a protocol, the next EVM transaction in the same block is reverted (the protocol was fine at the check point),
  until the next block's check point. Bounded to one block, but it is a griefing window if such a path exists.
- **`eth_estimateGas` / `eth_call` do not run the hook**, so wallets cannot see a firewall revert in advance; the
  transaction fails on chain and pays its gas.
- **Cost.** `PostTxProcessing` hooks do not charge gas in cosmos/evm. Every EVM transaction makes the node do up
  to ~3.8M gas of read-only EVM work while the firewall is on. That is why the timelock approves each protocol.
- **Weak or wrong checkers** protect nothing; a checker that changes its answer by itself only blocks the
  transactions of the block in which it changes (the check point absorbs it next block). See the threat model in
  [future/invariant-firewall.md](future/invariant-firewall.md).
- **Not audited.**
