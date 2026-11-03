# ZETAPHY Saphan Gateway: call a contract on another chain (testnet)

**Testnets only, not audited, not deployed yet.** The Gateway sits on top of each Saphan EVM route
(docs/SAPHAN-MULTICHAIN.md: Sepolia, Base Sepolia, Arbitrum Sepolia <-> ZETAPHY 77390, over Hyperlane). It lets one
transaction move a route's ETH **and** call a contract on the other side, with an automatic refund when the call fails.

Source of truth: `zetaphy-network/contracts/SaphanGateway.sol` (contracts) and `zetaphy-network/src/saphangateway.js`
(call formats, hashes, deposit addresses, the executor's plan). Tests: `zetaphy-network/test/saphangateway.test.js`.

## What it does

Two contracts per source chain X: `SaphanSourceGateway` on X and `ZetaphyGateway` on ZETAPHY. Neither changes the
route under them (lockbox, lanes, airlock, guard, outbox): the Gateway is just one more user of the route.

| Direction | You call | What happens |
|---|---|---|
| X -> ZETAPHY | `SaphanSourceGateway.depositAndCall(...)` on X, paying the amount + `quoteDeposit(amount)` in ETH | The ETH is locked in the route's lockbox. After the route's usual checks, token(X) (`sepETH`, `baseETH`, `arbETH`) is minted on ZETAPHY. An executor then runs the call: your target receives the tokens and `onSaphanCall(...)`. |
| ZETAPHY -> X | `ZetaphyGateway.withdrawAndCall(...)` on ZETAPHY, after approving token(X); `msg.value` = `quoteWithdraw(amount)` in ZTPHY | token(X) is burned through the route's outbox. After the lockbox's delay the ETH is paid out on X. An executor then runs the call: your target receives the ETH with `onSaphanCall(...)`. |

**Refunds.** If the call fails (the target reverts or runs out of its `gasLimit`), nothing is lost:

- X -> ZETAPHY: the tokens go back to `revertTo` on X through the route's outbox (as ETH, after the lockbox's
  delay). With `callOnRevert`, the refund also calls `revertTo.onSaphanRevert(sender, nonce, revertMessage)` on X;
  if that call fails too, the ETH is kept for `revertTo` (`SaphanSourceGateway.claim()`).
- If the way back is closed (the outbound route is closed, paused, over its daily limit, or held), the tokens stay on
  ZETAPHY for `abortTo`, who takes them with `ZetaphyGateway.claimAborted()`.
- ZETAPHY -> X: the ETH is kept for `revertTo` on X (`owed[revertTo]`), who takes it with
  `SaphanSourceGateway.claim()`. It is a pull, not a push: the Gateways only ever pay ETH to their caller.

**Gas abstraction.** The caller sets `maxFee`. The executor that runs the call is paid exactly `maxFee` out of the
amount that moved: in token(X) on ZETAPHY, in ETH on X. The user never needs the destination chain's gas coin; the
executor pays the gas and is paid back from the transfer.

```
 source chain X                                                     ZETAPHY (77390)
 ──────────────                                                     ───────────────
 user ── depositAndCall(target, data, amount, maxFee, ...) ──┐
 SaphanSourceGateway: h = hash(call)                         │
   lockbox.lock(to = depositAddress(h)) ── Hyperlane ────────┼──▶ 2 lanes + quarantine + Neuro + limits
                                                             │    BridgeGuard(X) mints token(X) to depositAddress(h)
                                                             │    executor ── ZetaphyGateway.execute(call)
                                                             │      CREATE2(salt = h) empties the address (once)
                                                             │      maxFee ─▶ executor
                                                             │      rest ─▶ target, target.onSaphanCall(...)
                                                             │      fails? ─▶ outbox ─▶ revertTo on X, or aborted[abortTo]
                                                             │
 lockbox pays depositAddress(h') after its delay ◀── Hyperlane ── outbox burns ◀── ZetaphyGateway.withdrawAndCall(...) ◀── user
 executor ── SaphanSourceGateway.execute(outCall)
   CREATE2(salt = h') empties the address (once)
   maxFee ─▶ executor; rest + target.onSaphanCall{value}(77390, sender, data)
   fails? ─▶ owed[revertTo] on X (claim())
```

## Design: why a derived deposit address is safe

The Gateway sends no message of its own. Each call is a struct (`InCall` X -> ZETAPHY, `OutCall` ZETAPHY -> X) with
every field of the call: chains, both Gateways, a nonce, the sender, target, amount, fee, gas limit, refund and abort
addresses, data. Its hash `h` (`keccak256(abi.encode(tag, call))`) is the CREATE2 salt of a tiny contract,
`SaphanDepositAddress`, owned by the destination Gateway. The route then moves the coins **to that address**, like any
transfer to any address.

- **The lanes attest the call.** The route's lanes (on ZETAPHY: Hyperlane's validators for X and the NeuroLane runners;
  on X: our validators for origin ZETAPHY) attest the receiver of the transfer, which is the deposit address, and so
  `h`, and so every field of the call. No extra message, signer or relayer is trusted.
- **No swap.** An executor only *hands in* the call. If it changes any field (target, amount, sender, data, fee),
  the hash and so the address change, and the new address holds nothing: `NotFunded`.
- **No replay.** Running a call deploys its deposit address with CREATE2; a second run of the same call fails
  (`BadCall`). An address is never deployed before its coins arrived, so a call cannot be "burned" early.
- **No starving.** Before the target runs, the Gateway checks there is gas for `gasLimit` plus what follows
  (`LowGas`); an executor cannot make the call fail on purpose to force a refund.
- **All or nothing.** The target's transfer and call run inside a self-call; a failure undoes both before the refund.
- **No new admin.** The deployer can only set the remote Gateway once (`setRemote`). The Gateways cannot mint, pause or
  move anything the route would not; the route's limits, quarantine, vetoes, ThreatRegistry holds and pause apply to
  every Gateway transfer as to any other.
- **The executor's fee is fixed.** It is exactly `maxFee`, chosen by the caller, never more. It is paid even when the
  call fails (the executor did the work). A refund back to X also needs the outbox's Mailbox fee, which the executor
  pays in ZTPHY; without it `execute` reverts (`Fee`), so an executor cannot push a user into abort by paying nothing.

What the Gateway does *not* add: speed. X -> ZETAPHY takes as long as a plain transfer on that route (two lanes,
quarantine); ZETAPHY -> X waits for the lockbox's release delay (1 h in the table) and its daily limit.

## Compared with ZetaChain's Gateway

The interface is deliberately close to ZetaChain's Gateway (as of 2026) (`depositAndCall`, `withdrawAndCall`, `revertAddress`,
`callOnRevert`, `abortAddress`, `revertMessage`), so its developers feel at home. The trust model is different:

| | ZetaChain Gateway | Saphan Gateway |
|---|---|---|
| Who attests a cross-chain call | ZetaChain's observer-signers (TSS: one key held in shares by its observer-signer validators) | The route's existing checks: two independent lanes, quarantine, Neuro vetoes, ThreatRegistry, daily limits (inbound); our validators + release delay + guardian veto (outbound) |
| New trust added | The TSS key and observers are the bridge | None: the call is bound to the deposit address the route already attests |
| Who runs the call | The protocol (observers) | Anyone (a permissionless executor), paid `maxFee` from the moved amount |
| Assets | Many: gas coins and ERC-20s of many chains (ZRC-20) | One per route: the route's ETH as token(X) |
| Abort | The abort address gets the tokens (and `onAbort` when it is a contract) | The tokens wait for `abortTo` (`claimAborted`), no call |

## Calling it from a contract

Two receiver interfaces (in `SaphanGateway.sol`). **A target must check that `msg.sender` is the Gateway**:
anyone can call `onSaphanCall` directly, and only the Gateway's call carries attested `sender` and coins.

On ZETAPHY (called from X):

```solidity
interface ISaphanCallee {
    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256 amount, bytes calldata data) external;
}

contract MyApp is ISaphanCallee {
    address public immutable gateway; // ZetaphyGateway of the route (one per source chain)
    constructor(address g) { gateway = g; }

    function onSaphanCall(uint256 srcChainId, address sender, address token, uint256 amount, bytes calldata data) external {
        require(msg.sender == gateway, "not the Gateway");
        // `amount` of `token` (token(X)) is already in this contract; `sender` called depositAndCall on chain `srcChainId`
    }
}
```

On a source chain X (called from ZETAPHY, and for refunds with `callOnRevert`):

```solidity
interface ISaphanReceiver {
    function onSaphanCall(uint256 srcChainId, address sender, bytes calldata data) external payable;      // srcChainId = 77390
    function onSaphanRevert(address sender, uint256 nonce, bytes calldata message) external payable;     // a refund; msg.value = the ETH back
}
```

Both must `require(msg.sender == <SaphanSourceGateway on X>)`. A contract that accepts calls from several routes
checks the Gateway of each (and `srcChainId`, `sender` if it trusts only some callers: both are part of the attested
call). A target gets at most `gasLimit` gas; if it reverts, the coins are refunded as above.

Making the calls (ethers; ABIs in `zetaphy-network/src/saphangateway.js`):

```js
// X -> ZETAPHY, on X
const fee = await sourceGateway.quoteDeposit(amount);
await sourceGateway.depositAndCall(target, data, amount, maxFee, gasLimit, revertTo, callOnRevert, abortTo, revertMessage,
  { value: amount + fee }); // revertTo / abortTo = 0x0: the caller

// ZETAPHY -> X, on ZETAPHY
await tokenX.approve(zetaphyGateway, amount);
await zetaphyGateway.withdrawAndCall(target, data, amount, maxFee, gasLimit, revertTo,
  { value: await zetaphyGateway.quoteWithdraw(amount) }); // revertTo is required
```

| Parameter | Meaning |
|---|---|
| `target`, `data` | The contract on the other chain and what to tell it |
| `amount` | ETH locked on X, or token(X) burned on ZETAPHY |
| `maxFee` | The executor's fee, taken from `amount` (at most `amount`) |
| `gasLimit` | Gas the target gets |
| `revertTo` | On X: who gets the refund when the call fails |
| `callOnRevert`, `revertMessage` | X -> ZETAPHY only: the refund calls `revertTo.onSaphanRevert(sender, nonce, revertMessage)` |
| `abortTo` | X -> ZETAPHY only: who may claim the tokens on ZETAPHY when the way back is closed |

Overpaid `msg.value` comes back to the caller. Coins someone else sends to a deposit address go to the call's target
with the call's own. `ZetaphyGateway.depositAddress(call)` / `SaphanSourceGateway.depositAddress(outCall)` and the JS
helpers `hashIn`, `hashOut`, `depositAddressOf` compute the addresses off-chain.

## Deploy and run the executor

Needs a deployed route: `routes.<chain>` in `zetaphy-chain/hyperlane/saphan-routes.json` (docs/SAPHAN-MULTICHAIN.md).

1. Actions -> **saphan-route**, `chain = <name>`, `mode = gateway` (manual run; environment `testnet-deploy`, key
   `ZETAPHY_DEPLOYER_KEY`, the deployer needs gas on both chains). It deploys `ZetaphyGateway` on ZETAPHY, then
   `SaphanSourceGateway` on X naming it, then `setRemote` once, and pushes `saphan-routes.json`
   `routes.<chain>.gateway = {zetaphy, source, zetaphyFrom, sourceFrom, workflowRun}` to the branch
   `saphan/<chain>-gateway`. Open the pull request and merge it; the hub's Saphan page then shows both addresses.
   It refuses a chain that has Gateways already.
2. Nothing to open: the Gateway works when its route is open. Routes deploy **closed** and open through governance
   timelocks (48 h on the source chains; docs/SAPHAN-MULTICHAIN.md).
3. Actions -> **saphan-route**, `mode = execute`: the executor, once. It reads `DepositAndCall` (on X) and
   `OutCallSent` (on ZETAPHY) of the last 5000 blocks, runs every call that is funded or due (it also asks the airlock
   to release a lock, or claims a due release on X, when nobody did), and lists why the others wait. The result is in
   the run's summary. Fees go to the deployer.

The same from a shell (in `zetaphy-network`; `KEYFILE` = a file holding the key; `ZETAPHY_RPC` / `ORIGIN_RPC` override
the RPCs of the table):

```
KEYFILE=<file> node scripts/saphan.js gateway-deploy  --chain sepolia
KEYFILE=<file> node scripts/saphan.js gateway-execute --chain sepolia [--blocks 5000] [--dry yes]
```

`--dry yes` only plans (no key needed). `--blocks` widens the look-back for older calls.

## Limits and what is not done yet

- Testnet only, not audited, test coins only. Nothing is deployed yet.
- Only the route's ETH (token(X) on ZETAPHY) moves. ERC-20s and the tokens born on ZETAPHY (docs/SAPHAN-TOKENS.md)
  are not supported by the Gateway.
- The executor is run by hand (`mode = execute`); no schedule or public executor yet. Anyone may run one: the fee is
  `maxFee`. Our executor runs every ready call whatever its fee (even 0).
- Our executor sends no ZTPHY for the Mailbox fee of a refund to X; that is fine while the fee on ZETAPHY is 0. If a
  fee is set, such a refund waits (`Fee`) until an executor pays it.
- A call older than the executor's look-back (`--blocks`) is not found unless the window is widened.
- The executor's fee is paid even when the call fails; refunds go through the route's limits and delays like any
  transfer, and wait or abort when the route is closed.
