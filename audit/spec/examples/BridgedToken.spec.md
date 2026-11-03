# Spec: BridgedToken

Drafted by zetaphy-spec 1.0.0 (deterministic heuristics only, no AI).
Source: `zetaphy-network/contracts/BridgeGuard.sol`, source hash `0xdfcdf6edd9ab2bf501327a82e8ecf54eebe85c1e397ed5130f1c6a66e727970b`.

**Review this file before anything is proven.** A heuristic guess is a draft: approve what the contract must do, reject what it
should not, add what is missing. Proofs are only as good as the properties: a property that is proven but says the wrong thing proves nothing useful.

Approved by **spec demo (Najaso)** on 2026-11-03; spec hash `0x16fa6f25ebef38fc4ba0026d70928fd3a8362e2019511182c766469ab3b93edb`.

## Harness

Status: **drafted**


```solidity
t = new BridgedToken("T", "T", 1, address(0x1000));
```

Sequences: depth 2, steps: `mint`, `burn`, `approve`, `transfer`, `transferFrom`, `warp`.

## Properties

| Id | Kind | Origin | Status | Confidence | Title |
|---|---|---|---|---|---|
| `access-mint` | access | heuristic | **approved** | high | only guard can call mint |
| `access-burn` | access | heuristic | **approved** | high | only guard can call burn |
| `conservation-balanceOf-totalSupply` | conservation | heuristic | **approved** | high | totalSupply moves exactly with the balanceOf it sums |

### `access-mint`: only guard can call mint

For every caller that is not `guard()`, and for all arguments (and any ETH sent), `mint` reverts.

*Why drafted:* mint (line 36) reverts on a comparison of msg.sender with guard.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `access-burn`: only guard can call burn

For every caller that is not `guard()`, and for all arguments (and any ETH sent), `burn` reverts.

*Why drafted:* burn (line 37) reverts on a comparison of msg.sender with guard.

*Proof scope:* all callers outside the set, all arguments, from the setup state

### `conservation-balanceOf-totalSupply`: totalSupply moves exactly with the balanceOf it sums

Every call changes `totalSupply` by exactly the total change of `balanceOf` over the accounts it touches (the caller and every address argument): nothing is created or lost in between. Transfers leave `totalSupply` unchanged.

*Why drafted:* balanceOf and totalSupply are written together in mint, burn.

*Proof scope:* every function that writes either, any caller and arguments, from any state reachable in prover.depth-1 steps

