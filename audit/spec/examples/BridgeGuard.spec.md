# Spec: BridgeGuard

Drafted by zetaphy-spec 1.0.0 (deterministic heuristics only, no AI).
Source: `zetaphy-network/contracts/BridgeGuard.sol`, source hash `0xdfcdf6edd9ab2bf501327a82e8ecf54eebe85c1e397ed5130f1c6a66e727970b`.

**Review this file before anything is proven.** A heuristic guess is a draft: approve what the contract must do, reject what it
should not, add what is missing. Proofs are only as good as the properties: a property that is proven but says the wrong thing proves nothing useful.

Approved by **spec demo (Najaso)** on 2026-11-03; spec hash `0x3b2304ae07b3b33e437b22ef02e0ed645e24e4c20d655ec6a5cd032e3db0509f`.

## Harness

Status: **reviewed**

- reviewed: SpecAirlock stands in for BridgeAirlock (independentLanes() = 2); the hard cap is the starter 1000 tokens, route IN 600/day, route OUT 400/day
- inbound / outbound actions pick a route (IN or OUT) and a receiver among the actors, so the fuzzer reaches the limits too
- SpecThreats stands in for ThreatRegistry: the setup holds 0xA11CE and queues one held mint of 1 token to it (held[0]); the `unhold` step clears a hold, so releaseHeld can succeed (without it releaseHeld always reverted and its checks were vacuous: found by a deliberately false property)

```solidity
t = new BridgeGuard(address(this));
t.createToken("Bridged ETH", "bETH", 18);
t.setAudit("https://example.org/audit.pdf", bytes32(uint256(1)));
inAdapter = new SpecAirlock();
outAdapter = new SpecAirlock();
t.setRoute(IN, address(inAdapter), 600 ether, true);
t.setOutboundRoute(OUT, address(outAdapter), 400 ether, true);
threats = new SpecThreats();
t.setThreats(IContractThreats(address(threats)));
threats.set(address(0xA11CE), true);
vm.prank(address(inAdapter));
t.inbound(IN, address(0xA11CE), 1 ether); // queued: held[0]
t.setGuardian(address(0x6A2D), true);
t.setGovernance(address(0x6070));
```

Sequences: depth 2, steps: `inbound`, `outbound`, `releaseHeld`, `unhold`, `pause`, `unpause`, `lowerMaxDailyLimit`, `disableRoute`, `warp`.

## Properties

| Id | Kind | Origin | Status | Confidence | Title |
|---|---|---|---|---|---|
| `access-createToken` | access | heuristic | **approved** | high | only governance can call createToken |
| `access-setGovernance` | access | heuristic | **approved** | high | only governance can call setGovernance |
| `access-setGuardian` | access | heuristic | **approved** | high | only governance can call setGuardian |
| `access-setAudit` | access | heuristic | **approved** | high | only governance can call setAudit |
| `access-proposeMaxDailyLimit` | access | heuristic | **approved** | high | only governance can call proposeMaxDailyLimit |
| `access-cancelMaxDailyLimit` | access | heuristic | **approved** | high | only governance or a guardian can call cancelMaxDailyLimit |
| `access-lowerMaxDailyLimit` | access | heuristic | **approved** | high | only governance or a guardian can call lowerMaxDailyLimit |
| `access-disableRoute` | access | heuristic | **approved** | high | only governance or a guardian can call disableRoute |
| `access-setThreats` | access | heuristic | **approved** | high | only governance can call setThreats |
| `access-setRoute` | access | heuristic | **approved** | high | only governance can call setRoute |
| `access-setOutboundRoute` | access | heuristic | **approved** | high | only governance can call setOutboundRoute |
| `access-pause` | access | heuristic | **approved** | high | only governance or a guardian can call pause |
| `access-unpause` | access | heuristic | **approved** | high | only governance can call unpause |
| `access-dropHeld` | access | heuristic | **approved** | high | only governance can call dropHeld |
| `pause-noloss` | pause-noloss | heuristic | **approved** | high | pausing loses nothing |
| `paused-blocks-inbound` | paused-blocks | heuristic | **approved** | high | inbound is stopped while paused |
| `paused-blocks-releaseHeld` | paused-blocks | heuristic | **approved** | high | releaseHeld is stopped while paused |
| `paused-blocks-outbound` | paused-blocks | heuristic | **approved** | high | outbound is stopped while paused |
| `cei-inbound` | cei | heuristic | **approved** | high | inbound: no storage write after an external call |
| `cei-releaseHeld` | cei | heuristic | **approved** | high | releaseHeld: no storage write after an external call |
| `cei-outbound` | cei | heuristic | **approved** | high | outbound: no storage write after an external call |
| `cap-in` | post | human | **approved** | reviewer | no mint takes the day's inbound total over the hard cap |
| `cap-out` | post | human | **approved** | reviewer | no burn takes the day's outbound total over the hard cap |
| `route-limit-in` | post | human | **approved** | reviewer | a mint never takes route IN over its daily limit (or the cap, if lower) |
| `route-limit-out` | post | human | **approved** | reviewer | a burn never takes route OUT over its daily limit (or the cap, if lower) |
| `mint-is-bounded` | post | human | **approved** | reviewer | one inbound mints at most the route's limit |

### `access-createToken`: only governance can call createToken

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `createToken` reverts.

*Why drafted:* createToken (line 180) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setGovernance`: only governance can call setGovernance

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setGovernance` reverts.

*Why drafted:* setGovernance (line 192) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setGuardian`: only governance can call setGuardian

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setGuardian` reverts.

*Why drafted:* setGuardian (line 193) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setAudit`: only governance can call setAudit

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setAudit` reverts.

*Why drafted:* setAudit (line 213) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-proposeMaxDailyLimit`: only governance can call proposeMaxDailyLimit

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `proposeMaxDailyLimit` reverts.

*Why drafted:* proposeMaxDailyLimit (line 225) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-cancelMaxDailyLimit`: only governance or a guardian can call cancelMaxDailyLimit

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `cancelMaxDailyLimit` reverts.

*Why drafted:* cancelMaxDailyLimit (line 253) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-lowerMaxDailyLimit`: only governance or a guardian can call lowerMaxDailyLimit

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `lowerMaxDailyLimit` reverts.

*Why drafted:* lowerMaxDailyLimit (line 267) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-disableRoute`: only governance or a guardian can call disableRoute

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `disableRoute` reverts.

*Why drafted:* disableRoute (line 278) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setThreats`: only governance can call setThreats

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setThreats` reverts.

*Why drafted:* setThreats (line 289) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setRoute`: only governance can call setRoute

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setRoute` reverts.

*Why drafted:* setRoute (line 294) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-setOutboundRoute`: only governance can call setOutboundRoute

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `setOutboundRoute` reverts.

*Why drafted:* setOutboundRoute (line 312) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-pause`: only governance or a guardian can call pause

For every caller that is not `governance()` and not in `guardian`, and for all arguments (and any ETH sent), `pause` reverts.

*Why drafted:* pause (line 331) reverts on a comparison of msg.sender with governance, guardian.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-unpause`: only governance can call unpause

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `unpause` reverts.

*Why drafted:* unpause (line 338) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-dropHeld`: only governance can call dropHeld

For every caller that is not `governance()`, and for all arguments (and any ETH sent), `dropHeld` reverts.

*Why drafted:* dropHeld (line 380) reverts on a comparison of msg.sender with governance.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `pause-noloss`: pausing loses nothing

`pause` and `unpause` change no balance and no public state except `paused`: the contract's ETH and every public number, address and flag are the same before and after.

*Why drafted:* pause writes paused.

*Proof scope:* from any state reachable in prover.depth-1 steps; public no-argument getters and the ETH balance (mappings are covered by the AST fact that pause writes only the flag)

### `paused-blocks-inbound`: inbound is stopped while paused

Once `pause` ran, `inbound` reverts for every caller and argument.

*Why drafted:* inbound reverts on paused.

*Proof scope:* any caller and arguments, after a pause from any state reachable in prover.depth-1 steps

### `paused-blocks-releaseHeld`: releaseHeld is stopped while paused

Once `pause` ran, `releaseHeld` reverts for every caller and argument.

*Why drafted:* releaseHeld reverts on paused.

*Proof scope:* any caller and arguments, after a pause from any state reachable in prover.depth-1 steps

### `paused-blocks-outbound`: outbound is stopped while paused

Once `pause` ran, `outbound` reverts for every caller and argument.

*Why drafted:* outbound reverts on paused.

*Proof scope:* any caller and arguments, after a pause from any state reachable in prover.depth-1 steps

### `cei-inbound`: inbound: no storage write after an external call

`inbound` makes external calls (mint line 354); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

### `cei-releaseHeld`: releaseHeld: no storage write after an external call

`releaseHeld` makes external calls (mint line 374); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

### `cei-outbound`: outbound: no storage write after an external call

`outbound` makes external calls (burn line 395); every storage write happens before the first call.

*Why drafted:* a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).

*Proof scope:* static: the solc AST of the function, its modifiers and the internal functions it calls

### `cap-in`: no mint takes the day's inbound total over the hard cap

After any successful inbound or releaseHeld, `totalInToday` is at most `maxDailyLimit`: all routes together never mint more than the hard cap in a day.

*Why drafted:* BridgeGuard header: 'a hard cap, maxDailyLimit, over every route's daily limit and over all routes together per day'.

```solidity
t.totalInToday() <= t.maxDailyLimit()
```

### `cap-out`: no burn takes the day's outbound total over the hard cap

After any successful outbound, `totalOutToday` is at most `maxDailyLimit`.

*Why drafted:* the hard cap binds both directions.

```solidity
t.totalOutToday() <= t.maxDailyLimit()
```

### `route-limit-in`: a mint never takes route IN over its daily limit (or the cap, if lower)

After any successful inbound, route IN's minted-today is at most min(its daily limit, maxDailyLimit).

*Why drafted:* 'a daily limit per route and direction, so a hacked bridge can lose at most one day's limit'.

```solidity
h.inRoute() <= h.inLimit()
```

### `route-limit-out`: a burn never takes route OUT over its daily limit (or the cap, if lower)

After any successful outbound, route OUT's burned-today is at most min(its daily limit, maxDailyLimit).

*Why drafted:* per-route, per-direction limits.

```solidity
h.outRoute() <= h.outLimit()
```

### `mint-is-bounded`: one inbound mints at most the route's limit

A successful inbound raises the token's supply by at most the route's daily limit (capped).

*Why drafted:* the limit is checked before the mint.

```solidity
h.supply() - old(h.supply()) <= h.inLimit()
```

## Notes for the reviewer (not properties)

- **unguarded** `applyMaxDailyLimit`: changes maxDailyLimit, pendingMaxAt, pendingMaxDailyLimit, restoreMaxDailyLimit and anyone can call it: intended?
- **unguarded** `releaseHeld`: changes routes, totalDay, totalInToday, totalOutToday, held and anyone can call it: intended?

