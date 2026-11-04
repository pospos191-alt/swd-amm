**English** | [ภาษาไทย](invariant-firewall.th.md)

# Invariant firewall and the certificate rule

Testnet only. Nothing here holds or pays real money, and none of it has been audited by an outside firm.

This page covers two parts of the SS tier of the [open audit network](audit-network.md):

- **SS1, the invariant firewall.** A protected contract's invariants act as post-conditions. They are checked
  after every transaction that goes through it. A transaction that breaks one is reverted as a whole. An
  attacker who finds a bug still cannot keep what the bug would give them.
- **SS2, the certificate as a chain rule.** A contract that holds value above a threshold needs a live
  certificate from `AuditCertificate`. Without one (none, expired, revoked, or the code changed) its outflows
  are capped per day.

Both are opt-in. A protocol joins by registering itself. Governance is the `ZetaphyTimelock`: it sets bounded
parameters and nothing else. There is no new admin key.

| Piece | Where | Status |
|---|---|---|
| Registry, checks, chain-layer list, certificate rule, attested invariant sets | `zetaphy-network/contracts/InvariantFirewall.sol` | real, tested |
| What a protocol adds: `firewalled` modifier, `_firewallOutflow`, `_firewallRegister` | `zetaphy-network/contracts/Firewalled.sol` | real, tested |
| Tests (12): exploits stopped, fail-closed checks, bounds and delays, chain-layer registry, certificate rule, attestations, the real `AuditCertificate`, `CircuitBreaker` side by side | `zetaphy-network/test/firewall.test.js`, fixtures in `test/helpers/FirewallKit.sol` | real |
| Node-level check after every EVM transaction (in the patched node, off by default) | `zetaphy-chain/setup-node.sh` patch (`evmd/zetaphy_firewall.go`, `zetaphy_firewall_core.go`), fork tests in `zetaphy-chain/fork-tests/evmd/zetaphy_firewall*_test.go` | real, compiled, fork-tested; switched on by upgrade + governance ([CHAIN-FIREWALL.md](../CHAIN-FIREWALL.md)) |

## SS1: invariants as post-conditions (contract layer)

```
protocol (its own contract) ── InvariantFirewall.register(protocolGovernance)
protocol governance ────────── addInvariant(protocol, checker, gasLimit, name)   immediate; must hold now
                                proposeRemoval / proposeOptOut                      wait POLICY_DELAY (2 days)

user ── protocol.withdraw(…)  [firewalled]
          │  body runs (pays, books, calls out, maybe re-enters)
          ▼  the outermost firewalled call returns
        InvariantFirewall.enforce(protocol)  ── for each invariant: checker.holds(protocol), STATICCALL, gas cap
          │  all true  → the transaction goes on
          ▼  any not true → revert InvariantViolated(protocol, checker, name): the whole transaction is undone
```

An **invariant checker** is any contract with `holds(address protocol) view returns (bool)`. For example,
"the vault holds at least what it owes": `protocol.balance >= IVault(protocol).totalDeposits()`.

**What counts as a violation (fail-closed).** Each of these makes the transaction revert:
- the checker returns `false`;
- it reverts;
- it runs out of its own gas cap;
- it returns anything other than exactly 32 bytes encoding `true` (for example 64 bytes, `2`, or nothing).

Before each check, the firewall makes sure it can hand the checker its whole gas cap (the 63/64 rule plus a
margin). If it cannot, it reverts with `InsufficientGas`. So giving a protected call too little gas can never
turn a check into a pass. The test calls the bug with every gas amount from 30k to 400k in 10k steps, and not
one of them gets money out.

**Re-entrant calls are checked once.** `Firewalled` counts the depth of firewalled calls in transient storage
(EIP-1153). Only the outermost call checks. An invariant is a property of the state *between* calls, not
in the middle of one. A smart wallet that deposits again from its `receive()` while being paid passes. A
re-entrant drain fails, because the state it leaves at the end is insolvent. Both are tested.

**Bounds** (constants: governance cannot widen them):

| Rule | Value |
|---|---|
| Invariants per protocol | at most 8 |
| Gas cap per check | 5,000 .. 500,000 |
| Adding an invariant | immediate (stricter), only by the protocol's governance, only if it holds now |
| Removing an invariant, opting out | after `POLICY_DELAY` = 2 days, announced in public, can be cancelled |
| Who can add or remove a protocol's invariants | only that protocol's governance. The timelock cannot. |

The delay matters. A stolen protocol key cannot quietly drop an invariant right before an exploit. The removal
sits in public for two days, and the invariant is enforced the whole time.

**Integrating** (see `FwVault` in `test/helpers/FirewallKit.sol`):

```solidity
import {Firewalled, IInvariantFirewall} from "./Firewalled.sol";

contract Vault is Firewalled {
    constructor(IInvariantFirewall fw, address dao) Firewalled(fw) { _firewallRegister(dao); }

    function withdraw(uint256 amount) external firewalled {
        balances[msg.sender] -= amount;
        totalDeposits -= amount;
        _firewallOutflow(address(0), amount);   // SS2: the certificate rule
        payable(msg.sender).transfer(amount);
    }
}
```

**What it costs.** One `STATICCALL` per invariant after the outermost protected call. The test bounds the
overhead with one invariant below 40,000 gas. Each checker's own work comes on top, within its cap.

**Limit of the contract layer.** Only calls that enter the contract through a `firewalled` function are
checked. A token that an approved spender pulls with `transferFrom` straight on the token contract never runs
the protocol's code. The chain layer (below) covers that case.

## SS1: the chain layer (in the node, off by default)

The node code, how it is switched on, its tests and the upgrade runbook are in [docs/CHAIN-FIREWALL.md](../CHAIN-FIREWALL.md),
which is authoritative where it differs from the design notes below.

The contract layer depends on the protocol calling `enforce`. The chain layer makes the node do it. After every
successful EVM transaction (and every `MsgEVMCall`), the node reads `InvariantFirewall.chainCheck()` on the
state the transaction left. If a protocol on the chain-layer list now has a broken invariant that held before
the transaction, the transaction fails. It makes no difference which contract the attacker went through.

How it would work in the patched `evmd`:

- **Hook.** cosmos/evm already reverts the whole transaction when a `PostTxProcessing` hook returns an error
  (`x/vm/keeper/state_transition.go`). ZETAPHY's `pqHooks` is that hook (quantum lock, threat gate, immune
  system). The firewall adds one call to it: `firewallPostTx`. `MsgEVMCall` gets the same call. A failed message
  discards its state.
- **The call.** It is read-only, from the module address `zetaphy-firewall`, with `CHAIN_CALL_GAS` = 3,000,000
  gas, done the same way `ModelVersionAt` reads `ModelEpochs`. The answer must be exactly
  `(address[] protocols, uint256 brokenMask)` with at most 8 protocols, and it is decoded strictly
  (`firewallDecode`).
- **Check points.** The node records which protocols are broken at the start of each block (`BeginBlocker`),
  and again after each transaction that passes. A transaction is reverted only for a protocol that is broken now
  and was **not** broken at the last check point, which means this transaction broke it. A protocol that broke
  in another way (time passed, a non-EVM message, a checker that changed its answer) does not block every
  transaction on the chain.
- **Fails open, on purpose.** If the firewall contract cannot be read (no code, a revert, out of gas, a
  malformed answer), the node emits `zetaphy_firewall_error` and lets the transaction through, so a broken
  registry cannot halt the chain. `InvariantFirewall` keeps a correct registry inside its gas: at most 8
  protocols (`MAX_CHAIN`), at most 2,000,000 gas of checks in all (`CHAIN_GAS_BUDGET`), a cap on each check, and
  `InsufficientGas`. The test runs `chainCheck` at the full budget and it stays under `CHAIN_CALL_GAS`. The
  contract layer stays fail-closed.
- **Who is on the list.** The protocol's governance asks (`requestChain`). The timelock approves
  (`approveChain`), within `MAX_CHAIN` and the gas budget. The timelock can drop a protocol at once
  (`dropChain`), for example because of node load. That protocol's contract-layer invariants still apply.
  Otherwise a protocol leaves only by opting out, which is delayed.
- **Switch.** It is off until a governance proposal sets `security-proposal invariant-firewall <address>` (a
  `MsgSetFuture` kind; store key `0x31`, check point `0x32`). `{"address":""}` turns it off. It only works on
  a chain with v5 active.
- **Cost.** `PostTxProcessing` hooks do not charge gas in cosmos/evm. Every EVM transaction makes the node do up
  to `CHAIN_CALL_GAS` of EVM work. That is why each protocol needs the timelock's approval and the budget is a
  constant.

**Status:** the prototype described here is now real node code (compiled, fork-tested, off until the
`zetaphy-firewall` upgrade and a governance vote). See [docs/CHAIN-FIREWALL.md](../CHAIN-FIREWALL.md).

## SS2: the certificate as a chain rule

For every asset the timelock lists with a value threshold (`setThreshold(asset, threshold)`, at most 8 assets;
`address(0)` is the native coin), the firewall applies this rule to every registered protocol. Suppose the
protocol holds at least the threshold of that asset and has no live certificate. A certificate is not live when
there is none, it expired, it was revoked, its code hash was revoked, or the contract's code changed (exactly
`AuditCertificate.isCertified`). Then the protocol may pay out at most `uncertifiedBps` of its balance per day.
`uncertifiedBps` is 10% by default, and the timelock can set it between 1% and 50%.

- `Firewalled._firewallOutflow(asset, amount)` before each payment calls `recordOutflow`. Above the cap it reverts
  with `OutflowLimited(protocol, asset, used, cap)`. `outflowLeft(protocol, asset)` tells a UI how much is left
  today.
- The cap is `uncertifiedBps` × the highest balance seen at an outflow that day. A large deposit raises the day's
  high mark. But its own withdrawal is an outflow and counts in full, so inflating the balance (for example with
  a flash loan) never lets more of the *rest* out. Tested: deposit 5,000, try to take 5,000 back, refused.
- Every recorded outflow of the day counts, including those made while certified. A certificate that lapses
  during the day does not open a fresh allowance.
- A live certificate lifts the cap at once. Revocation or expiry brings it back at once. This is tested with
  the real `AuditCertificate`: the vault's exact runtime code goes through the audit flow, is certified, and the
  cap applies again after `validity`.
- A protocol below the threshold is not limited.

**What it costs honest users.** While uncertified, a protocol holding a lot of value pays out slowly. Users of
an unaudited, high-value contract wait days for large withdrawals. That is the point of the rule, and the
reason it is opt-in on testnet.

**Chain-layer enforcement of SS2 is not built.** A protocol that registers but never calls `_firewallOutflow`
is not capped. Enforcing it at the node would mean the node compares native balances before and after each
transaction for registered protocols. It would use the same hook and check points as above, and is left as
design.

## Invariant sets attested by certificates

`attest(protocol, requestId)` (anyone may call it) records the hash of the protocol's current invariant set:
the checker addresses, the checkers' code hashes, their gas caps and names, in order. It succeeds only while the
protocol holds a live certificate issued for audit request `requestId` **and every checker** holds a live
certificate. The invariants are code too, and they need the same audit.
`isAttested(protocol)` stays true only while all of these hold:
- the set is unchanged (adding, removing or replacing an invariant ends it);
- the protocol's certificate is live and under the **same** audit request;
- every checker's certificate is live.

Integrators and the hub can require `isAttested` the way `AuditVerified` requires `isCertified`.

## CircuitBreaker together

[CircuitBreaker](self-healing.md) and the firewall do different jobs:
- the firewall **refuses** a transaction that breaks an invariant;
- CircuitBreaker **pauses** listed selectors and **holds** outflows over its caps.

A protocol can use both (`FwVault` inherits `Firewalled` and `CircuitBreakable`). The test shows that an
outflow CircuitBreaker holds keeps the books solvent, so the firewall lets it through. The trip then pauses
deposits, and the firewall still refuses the bug. A reverted violation carries
`InvariantViolated(protocol, checker, name)` in its revert data. A Neuro runner that sees repeated attempts can
use that as evidence for a CircuitBreaker trip (the existing k-of-n runner path). Nothing on-chain trips
automatically from a revert, because a revert leaves no state behind.

## Threat model and limits

- **The firewall enforces the invariants, not the absence of bugs.** A bug that keeps every invariant true still
  works. In the test, skimming exactly a donated surplus passes, because solvency still holds. Write invariants
  about what must never happen: solvency, supply conservation, debt ≤ collateral.
- **Wrong or weak checkers.** A checker that always returns true protects nothing. That is why
  `attest` asks for the checkers' own certificates.
- **Griefing a protocol with its own checker.** A checker that starts failing blocks the protocol's own
  firewalled functions until its governance removes it, and removal is delayed by 2 days. A checker that does
  not hold cannot be added, but its answer can change later. Keep checkers to pure views of the protected
  contract.
- **Bypassing the contract layer.** Possible through paths that never enter a `firewalled` function (token
  allowances, `selfdestruct` sends). The chain layer covers these once it is in the node.
- **Governance.** The timelock cannot add or remove anyone's invariants, cannot move funds (the firewall holds
  none), and only sets the bounded certificate-rule parameters and the chain-layer list.
- **Transient storage.** solc warns that EIP-1153 can break composability. `firewalled` restores the depth on
  every exit, so the slot is 0 again when the outermost call returns or reverts.

## Static analysis

On `InvariantFirewall.sol` and `Firewalled.sol` (solc 0.8.26, optimizer, cancun):
- **Slither 0.11.6**: no High or Medium findings. The rest are informational: calls in a loop (certificate
  reads), timestamps, assembly (the capped `STATICCALL`), loop and event style, and unused helpers in the
  abstract `Firewalled`.
- **Aderyn**: no High findings, 7 Low (style: literals, loops, cached lengths).

Every external call the firewall makes is a static (view) call, and every state change comes before it
(`addInvariant`, `recordOutflow`, `attest`). The repository's audit gate (`audit/`, `.github/workflows/audit.yml`) runs both.

## What is missing

- **Not deployed.** There is no deploy script entry yet. The constructor is
  `InvariantFirewall(AuditCertificate, ZetaphyTimelock, uncertifiedBps)`.
- **The chain layer is off by default.** It needs the `zetaphy-firewall` upgrade and a governance vote ([CHAIN-FIREWALL.md](../CHAIN-FIREWALL.md)).
- **No UI.** The hub and the explorer do not show protected protocols or attestations yet. Any UI text must
  come in all 8 hub languages.
- **Not audited**: these contracts have not been through the open audit process, or any other, yet.
