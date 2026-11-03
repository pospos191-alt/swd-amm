# Spec: HyperlaneLockBoxV2

Drafted by zetaphy-spec 1.0.0 (deterministic heuristics only, no AI).
Source: `zetaphy-network/contracts/HyperlaneLockBoxV2.sol`, source hash `0x1857f9672e961ca191bd4239aa21309a98491e31757d733494b0073e4af27ed8`.

**Review this file before anything is proven.** A heuristic guess is a draft: approve what the contract must do, reject what it
should not, add what is missing. Proofs are only as good as the properties: a property that is proven but says the wrong thing proves nothing useful.

Approved by **spec demo (Najaso)** on 2026-11-03; spec hash `0x1542bbf1088ba970120ba87651798d515a93477b641ef7b2cb9b5e555172e35a`.

## Harness

Status: **reviewed**

- reviewed: MockMailbox (contracts/MockMailbox.sol, fee 0) and SpecIsm, which accepts every message (the worst case: any release message, any receiver, any amount)
- the handler records every successful lock amount and every successful claim amount (sumLocked / sumReleased)
- release delay 0 so a release can be claimed in the step after its message; the daily limit is 10 ETH; the setup locks 5 ETH from 0xB0B (counted in sumLocked)

```solidity
mailbox = new MockMailbox(11155111);
t = new HyperlaneLockBoxV2(ISaphanMailbox(address(mailbox)), 77390, 77390, bytes32(uint256(0x1a2e)), OUTBOX, address(0),
    ISaphanIsm(address(new SpecIsm())), address(0x6070), address(0x6A2D), 10 ether, 0);
vm.deal(address(this), 5 ether);
t.lock{value: 5 ether}(address(0xB0B), 5 ether);
sumLocked = 5 ether;
```

Sequences: depth 2, steps: `lock`, `handle`, `claim`, `pause`, `veto`.

## Properties

| Id | Kind | Origin | Status | Confidence | Title |
|---|---|---|---|---|---|
| `access-handle` | access | heuristic | **approved** | high | only mailbox can call handle |
| `access-pause` | access | heuristic | **approved** | high | only governance or a guardian can call pause |
| `access-veto` | access | heuristic | **approved** | high | only governance or a guardian can call veto |
| `access-lowerDailyLimit` | access | heuristic | **approved** | high | only governance or a guardian can call lowerDailyLimit |
| `access-raiseReleaseDelay` | access | heuristic | **approved** | high | only governance or a guardian can call raiseReleaseDelay |
| `access-unpause` | access | heuristic | **approved** | high | only governance can call unpause |
| `access-liftVeto` | access | heuristic | **approved** | high | only governance can call liftVeto |
| `access-setDailyLimit` | access | heuristic | **approved** | high | only governance can call setDailyLimit |
| `access-setReleaseDelay` | access | heuristic | **approved** | high | only governance can call setReleaseDelay |
| `access-setInterchainSecurityModule` | access | heuristic | **approved** | high | only governance can call setInterchainSecurityModule |
| `access-setGuardian` | access | heuristic | **approved** | high | only governance can call setGuardian |
| `access-setGovernance` | access | heuristic | **approved** | high | only governance can call setGovernance |
| `monotonic-nonce` | monotonic | heuristic | **approved** | high | nonce never decreases |
| `monotonic-received` | monotonic | heuristic | **approved** | high | received never decreases |
| `backing-locked` | invariant | heuristic | **approved** | high | the contract always holds at least locked in ETH |
| `pause-noloss` | pause-noloss | heuristic | **approved** | high | pausing loses nothing |
| `paused-blocks-lock` | paused-blocks | heuristic | **approved** | high | lock is stopped while paused |
| `paused-blocks-claim` | paused-blocks | heuristic | **approved** | high | claim is stopped while paused |
| `cei-lock` | cei | heuristic | **approved** | high | lock: no storage write after an external call |
| `cei-claim` | cei | heuristic | **approved** | high | claim: no storage write after an external call |
| `locked-never-below-releases` | invariant | human | **approved** | reviewer | releases never exceed locks, and locked is exactly locks minus releases |
| `daily-limit` | post | human | **approved** | reviewer | a claim never takes the day's releases over the daily limit |
| `claim-pays-from-locked` | post | human | **approved** | reviewer | a claim reduces locked by exactly the ETH that left |

### `access-handle`: only mailbox can call handle

For every caller that is not `mailbox()`, and for all arguments (and any ETH sent), `handle` reverts.

*Why drafted:* handle (line 204) reverts on a comparison of msg.sender with mailbox.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-pause`: only governance or a guardian can call pause

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `pause` reverts.

*Why drafted:* pause (line 252) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-veto`: only governance or a guardian can call veto

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `veto` reverts.

*Why drafted:* veto (line 255) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-lowerDailyLimit`: only governance or a guardian can call lowerDailyLimit

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `lowerDailyLimit` reverts.

*Why drafted:* lowerDailyLimit (line 263) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-raiseReleaseDelay`: only governance or a guardian can call raiseReleaseDelay

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `raiseReleaseDelay` reverts.

*Why drafted:* raiseReleaseDelay (line 269) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-unpause`: only governance can call unpause

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `unpause` reverts.

*Why drafted:* unpause (line 277) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-liftVeto`: only governance can call liftVeto

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `liftVeto` reverts.

*Why drafted:* liftVeto (line 279) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setDailyLimit`: only governance can call setDailyLimit

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setDailyLimit` reverts.

*Why drafted:* setDailyLimit (line 286) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setReleaseDelay`: only governance can call setReleaseDelay

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setReleaseDelay` reverts.

*Why drafted:* setReleaseDelay (line 288) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setInterchainSecurityModule`: only governance can call setInterchainSecurityModule

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setInterchainSecurityModule` reverts.

*Why drafted:* setInterchainSecurityModule (line 295) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setGuardian`: only governance can call setGuardian

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setGuardian` reverts.

*Why drafted:* setGuardian (line 301) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setGovernance`: only governance can call setGovernance

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setGovernance` reverts.

*Why drafted:* setGovernance (line 303) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `monotonic-nonce`: nonce never decreases

No call, by anyone, with any arguments, makes `nonce` smaller (it is only ever increased: lock).

*Why drafted:* every write of nonce is += or ++.

*Proof scope:* every function that writes nonce, any caller and arguments, from any state reachable in prover.depth-1 steps

### `monotonic-received`: received never decreases

No call, by anyone, with any arguments, makes `received` smaller (it is only ever increased: handle).

*Why drafted:* every write of received is += or ++.

*Proof scope:* every function that writes received, any caller and arguments, from any state reachable in prover.depth-1 steps

### `backing-locked`: the contract always holds at least locked in ETH

After any sequence of calls (by anyone, with any arguments), the contract's ETH balance is at least `locked`: what it owes is always backed (lock add, claim pay out).

*Why drafted:* locked grows in payable lock and shrinks where ETH is sent (claim).

*Proof scope:* bounded: every sequence of prover.depth calls over harness.steps from the setup state (Halmos); unbounded where the SMTChecker proves it; fuzzed by forge

```solidity
address(t).balance >= t.locked()
```

### `pause-noloss`: pausing loses nothing

`pause` and `unpause` change no balance and no public state except `paused`: the contract's ETH and every public number, address and flag are the same before and after.

*Why drafted:* pause writes paused.

*Proof scope:* from any state reachable in prover.depth-1 steps; public no-argument getters and the ETH balance (mappings are covered by the AST fact that pause writes only the flag)

### `paused-blocks-lock`: lock is stopped while paused

Once `pause` ran, `lock` reverts for every caller and argument.

*Why drafted:* lock reverts on paused.

*Proof scope:* any caller and arguments, after a pause from any state reachable in prover.depth-1 steps

### `paused-blocks-claim`: claim is stopped while paused

Once `pause` ran, `claim` reverts for every caller and argument.

*Why drafted:* claim reverts on paused.

*Proof scope:* any caller and arguments, after a pause from any state reachable in prover.depth-1 steps

### `cei-lock`: lock: no storage write after an external call

`lock` makes external calls (dispatch with ETH line 186, dispatch with ETH line 185, call with ETH line 190); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

### `cei-claim`: claim: no storage write after an external call

`claim` makes external calls (call with ETH line 240); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

### `locked-never-below-releases`: releases never exceed locks, and locked is exactly locks minus releases

After any sequence of locks, release messages (forged or not: the ISM here accepts everything), claims, pauses and vetoes, the ETH paid out by claims is at most the ETH locked, and `locked` equals locked minus paid. Even a compromised ISM can only release this route's own deposits.

*Why drafted:* HyperlaneLockBoxV2's header: 'within what this contract holds for locks (`locked`: locks minus releases), so even a forged message can never take more than this route's own deposits'.

*Proof scope:* bounded: every sequence of 2 calls over lock, handle (any message), claim, pause, veto from the setup state (5 ETH locked) (Halmos); fuzzed by forge

```solidity
h.released() <= h.lockedTotal() && t.locked() == h.lockedTotal() - h.released()
```

### `daily-limit`: a claim never takes the day's releases over the daily limit

After any successful claim, `releasedToday` is at most `dailyLimit`.

*Why drafted:* claim reverts with OverLimit when releasedToday + amount > dailyLimit.

*Proof scope:* any caller and claim, after any 1 call from the setup state (Halmos)

```solidity
t.releasedToday() <= t.dailyLimit()
```

### `claim-pays-from-locked`: a claim reduces locked by exactly the ETH that left

After any successful claim, `locked` went down by exactly as much as the contract's ETH balance.

*Why drafted:* claim: locked -= amount, then pays amount.

*Proof scope:* any caller and claim, after any 1 call from the setup state (Halmos)

```solidity
old(t.locked()) - t.locked() == old(address(t).balance) - address(t).balance
```

## Notes for the reviewer (not properties)

- **unguarded** `lock`: changes nonce, locked, transferIds and anyone can call it: intended?
- **unguarded** `claim`: changes day, releasedToday, releases, locked and anyone can call it: intended?

