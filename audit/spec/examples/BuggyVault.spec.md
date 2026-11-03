# Spec: BuggyVault

Drafted by zetaphy-spec 1.0.0 (deterministic heuristics only, no AI).
Source: `audit/spec/fixtures/BuggyVault.sol`, source hash `0x7448f88190a4409f2e65f3e9126f3a54670fa6095509bb93d0fb44e0fa97d7ee`.

**Review this file before anything is proven.** A heuristic guess is a draft: approve what the contract must do, reject what it
should not, add what is missing. Proofs are only as good as the properties: a property that is proven but says the wrong thing proves nothing useful.

Approved by **spec demo (Najaso)** on 2026-11-03; spec hash `0x54dfb5789ef15da9c42229acc413862e73c278e14dee789579f19aee00bd2f85`.

## Harness

Status: **drafted**


```solidity
t = new BuggyVault(address(0x1000));
```

Sequences: depth 2, steps: `deposit`, `withdraw`, `emergencyWithdraw`, `pause`, `unpause`, `setGovernance`, `warp`.

## Properties

| Id | Kind | Origin | Status | Confidence | Title |
|---|---|---|---|---|---|
| `access-pause` | access | heuristic | **approved** | high | only governance can call pause |
| `access-unpause` | access | heuristic | **approved** | high | only governance can call unpause |
| `access-setGovernance` | access | heuristic | **approved** | high | only governance can call setGovernance |
| `monotonic-deposits` | monotonic | heuristic | **approved** | medium | deposits never decreases |
| `conservation-balanceOf-totalDeposits` | conservation | heuristic | **approved** | medium | totalDeposits moves exactly with the balanceOf it sums |
| `conservation-balanceOf-deposits` | conservation | heuristic | **rejected** | medium | deposits moves exactly with the balanceOf it sums |
| `backing-totalDeposits` | invariant | heuristic | **approved** | high | the contract always holds at least totalDeposits in ETH |
| `pause-noloss` | pause-noloss | heuristic | **approved** | high | pausing loses nothing |
| `paused-blocks-deposit` | paused-blocks | heuristic | **approved** | high | deposit is stopped while paused |
| `cei-withdraw` | cei | heuristic | **approved** | high | withdraw: no storage write after an external call |
| `cei-emergencyWithdraw` | cei | heuristic | **approved** | high | emergencyWithdraw: no storage write after an external call |

### `access-pause`: only governance can call pause

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `pause` reverts.

*Why drafted:* pause (line 50) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-unpause`: only governance can call unpause

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `unpause` reverts.

*Why drafted:* unpause (line 55) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setGovernance`: only governance can call setGovernance

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setGovernance` reverts.

*Why drafted:* setGovernance (line 60) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `monotonic-deposits`: deposits never decreases

No call, by anyone, with any arguments, makes `deposits` smaller (it is only ever increased: deposit).

*Why drafted:* every write of deposits is += or ++.

*Proof scope:* every function that writes deposits, any caller and arguments, from any state reachable in prover.depth-1 steps

### `conservation-balanceOf-totalDeposits`: totalDeposits moves exactly with the balanceOf it sums

Every call changes `totalDeposits` by exactly the total change of `balanceOf` over the accounts it touches (the caller and every address argument): nothing is created or lost in between. Transfers leave `totalDeposits` unchanged.

*Why drafted:* balanceOf and totalDeposits are written together in deposit, withdraw.

*Proof scope:* every function that writes either, any caller and arguments, from any state reachable in prover.depth-1 steps

### `conservation-balanceOf-deposits`: deposits moves exactly with the balanceOf it sums

Every call changes `deposits` by exactly the total change of `balanceOf` over the accounts it touches (the caller and every address argument): nothing is created or lost in between. Transfers leave `deposits` unchanged.

*Why drafted:* balanceOf and deposits are written together in deposit.

*Proof scope:* every function that writes either, any caller and arguments, from any state reachable in prover.depth-1 steps

### `backing-totalDeposits`: the contract always holds at least totalDeposits in ETH

After any sequence of calls (by anyone, with any arguments), the contract's ETH balance is at least `totalDeposits`: what it owes is always backed (deposit add, withdraw pay out).

*Why drafted:* totalDeposits grows in payable deposit and shrinks where ETH is sent (withdraw).

*Proof scope:* bounded: every sequence of prover.depth calls over harness.steps from the setup state (Halmos); unbounded where the SMTChecker proves it; fuzzed by forge

```solidity
address(t).balance >= t.totalDeposits()
```

### `pause-noloss`: pausing loses nothing

`pause` and `unpause` change no balance and no public state except `paused`: the contract's ETH and every public number, address and flag are the same before and after.

*Why drafted:* pause writes paused.

*Proof scope:* from any state reachable in prover.depth-1 steps; public no-argument getters and the ETH balance (mappings are covered by the AST fact that pause writes only the flag)

### `paused-blocks-deposit`: deposit is stopped while paused

Once `pause` ran, `deposit` reverts for every caller and argument.

*Why drafted:* deposit reverts on paused.

*Proof scope:* any caller and arguments, after a pause from any state reachable in prover.depth-1 steps

### `cei-withdraw`: withdraw: no storage write after an external call

`withdraw` makes external calls (call with ETH line 37); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

### `cei-emergencyWithdraw`: emergencyWithdraw: no storage write after an external call

`emergencyWithdraw` makes external calls (call with ETH line 46); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

## Notes for the reviewer (not properties)

- **unguarded** `deposit`: changes balanceOf, totalDeposits, deposits and anyone can call it: intended?
- **unguarded** `withdraw`: changes balanceOf, totalDeposits and anyone can call it: intended?
- **unguarded** `emergencyWithdraw`: changes balanceOf and anyone can call it: intended?

