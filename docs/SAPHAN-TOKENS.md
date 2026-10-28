# ZETAPHY Saphan: token routes (tokens born on ZETAPHY going out, and back)

**Testnets only, not audited.** Tokens created on the ZETAPHY testnet (77390) travel to Sepolia, Base Sepolia and
Arbitrum Sepolia over Hyperlane and come back. Test coins only (docs/BRIDGE-TESTNET.md). This is the reverse of the
v2 ETH routes (docs/SAPHAN-MULTICHAIN.md), which bring ETH from those chains into ZETAPHY and back.

## Read this first

- **Bridging the native coin out locks it on ZETAPHY.** ZETAPHY you send to Base Sepolia is held by a contract on
  ZETAPHY (`ZetaphyTokenVault`); on Base Sepolia you get `zZETAPHY`. While it is out, those coins cannot be staked,
  used to vote or to pay gas on ZETAPHY. You get them back only by sending `zZETAPHY` back.
- **The synthetic token is worth exactly what its vault safely holds.** One `zZETAPHY` on chain X is a claim on one
  ZETAPHY locked in the vault for chain X, and nothing else. If that vault is drained or frozen, if our validators
  sign something false, or if ZETAPHY stops, `zZETAPHY` on X can be worth less or nothing. A failure on another chain
  does not touch X's vault (see "Isolation"), but nothing outside the vault backs the synthetic.
- **BZTPHY does not go out.** `ZetaphyPoints` (BZTPHY, `0x3cC2…D59d`) cannot be transferred or approved by design: it
  records who did the work, and balances at the freeze become mainnet ZETAPHY. No vault can take it, and a tradable
  copy elsewhere would defeat its purpose. It is listed in the table (`transferable: false`, no destinations) so the
  hub says so; the table check refuses a destination for it. It could go out only if governance changed that
  decision and made it transferable. The dry run uses a BZTPHY-like stand-in (18 decimals, transferable) instead.

## Design

```
 ZETAPHY (77390)                                                          destination chain X (Sepolia / Base Sepolia / ...)
 ──────────────────────────────────────────────                           ─────────────────────────────────────────────────
 ZetaphyTokenVault(token T, X)  ── lock: escrow T, Hyperlane message ───▶ SaphanSyntheticToken(T, X)  e.g. zZETAPHY
   ISM: Hyperlane's validator(s) for origin X      (ISM on X: OUR validators   ISM: OUR validators for origin ZETAPHY
   (the same ISM as the v2 HyperlaneLane of X)       for origin ZETAPHY)       (the same ISM as the v2 lockbox of X)
   release: delay + veto, daily limit, pause,                                  mint: delay + veto, daily limit,
   never more than locked for X, lock cap,                                     supply cap, pause
   ThreatRegistry holds
          ◀────────────── release: Hyperlane message ──────────────────────── sendBack(to, amount): burn
 roles on ZETAPHY: governance = ZETAPHY timelock (48 h), guardian = the guardian multisig
 roles on X:       governance = X's ZetaphyTimelock (48 h), guardian = X's SimpleMultisig (the v2 route's, reused)
```

Contracts: `zetaphy-network/contracts/SaphanTokens.sol` (pragma 0.8.26). Both ends share `SaphanTokenEndpoint`:

- **Sending** (`lock` on the vault, `sendBack` on the synthetic): the vault escrows the token (the synthetic burns
  it), then dispatches a 288-byte body through the local Mailbox to the one remote contract:
  `abi.encode(srcChainId, srcContract, srcNonce, sender, to, amount, dstChainId, dstContract, originToken)`.
  `originToken` is the token's address on ZETAPHY, the same on both ends. `msg.value` = `quote(to, amount)` (the
  Mailbox fee; 0 on ZETAPHY); anything above it is sent back.
- **Receiving** (`handle`, called by the Mailbox after the contract's own ISM verified the message): only from the
  Mailbox, from the remote domain and the remote contract (sender), with a body that names the remote chain and
  contract as the source, this chain and contract as the destination, and this route's origin token; each body
  once (`Replay`). It never pays at once: the payout is queued (`Queued`) and anyone `claim(id)`s it after `delay`,
  paid to the receiver, while not vetoed, not paused and within the daily limit (over it: wait for the next UTC day).
  A message is never refused for a limit or a pause: it is recorded, and nothing depends on the relayer retrying.
- **Deployed closed**: both ends start paused. Opening is governance's `unpause()` on both ends (both timelocks).
- **Roles**: governance (a timelock, 48 h) unpauses, lifts vetoes, raises limits and caps, changes the ISM;
  guardians (a multisig) only reduce risk, at once: `pause`, `veto(id)`, `lowerDailyLimit`, `raiseDelay`,
  `lowerLockCap` / `lowerSupplyCap`. The same split as `HyperlaneLockBoxV2`.

What each end adds:

- `ZetaphyTokenVault`: pays a release only within `locked` (everything locked in this vault minus everything released
  from it) and refuses a lock that would push `locked` over `lockCap`. Takes tokens with `transferFrom` and checks the
  balance went up by exactly the amount (`OddToken` otherwise: fee-on-transfer tokens are refused); a token call
  that reverts or returns `false` is refused (`TransferFailed`); tokens that return nothing (USDT style) work. Its
  constructor reads the token's `decimals()` and refuses a value other than the table's. With a ThreatRegistry
  set (the deploy sets ZETAPHY's), a held sender cannot lock and a release to a held receiver waits until the hold
  ends (`Held`), as `BridgeGuard`'s vaccine does. Tokens sent to the vault without `lock()` are not backing;
  governance may send only that excess on (`recoverExcess`). Re-entry from a token callback is refused.
- `SaphanSyntheticToken`: a plain ERC-20 (`name`, `symbol` from the table, the origin token's `decimals`), minted
  only by `claim` of a verified message, never above `supplyCap`; `sendBack` burns the caller's tokens.

Amounts are the same number on both sides (same decimals): 1 T locked = 1 zT minted.

### Isolation: one vault and one synthetic per (token, destination)

Not one vault per token shared by all chains: with a shared escrow, a forged burn on chain X (a hole in X's
synthetic, or X's validators) could release tokens that people locked for chain Y. With one vault per
(token, destination):

- `vault(T, Y)` accepts releases only from Y's domain and `synthetic(T, Y)`, verified by Y's validators; a message from
  X is refused by the ISM (X's validator signed it) and by the origin and sender checks;
- even a release that passed every check (Y's own validator lying) is paid at most `locked` of `vault(T, Y)`: what
  was locked for Y. The escrow for X is in another contract, out of reach;
- token A's messages name token A (`originToken`) and come from A's contracts: `vault(B, X)` refuses them
  (`WrongSender`, `WrongToken`);
- each pair has its own limits, caps, delay and pause.

Tests: `zetaphy-network/test/saphantokens.test.js` ("token A's messages cannot reach token B's vault or synthetic",
"destination X's burn cannot release destination Y's escrow").

### Trust: who is believed for what

| Direction | Verified by | If that is wrong | Bounded by |
|---|---|---|---|
| ZETAPHY -> X (mint) | OUR validators for origin ZETAPHY (`zetaphyValidators`, threshold from the table), a multisig ISM on X made by X's own Hyperlane factory | false mints of zT on X | mint delay + guardian veto, daily mint limit, supply cap, pause; zT minted without a lock is unbacked, so the vault is unaffected but zT holders on X lose |
| X -> ZETAPHY (release) | Hyperlane's validator(s) for origin X (from the table: threshold 1 on these testnets), a multisig ISM on ZETAPHY (the same as the v2 HyperlaneLane of X) | false releases from `vault(T, X)` | release delay + guardian veto, daily release limit, `locked` of this vault only, `lockCap`, pause |

The release path trusts Hyperlane's own validator for X **alone**. That is weaker than the v2 inbound path, where a
second independent lane (NeuroLane runners) must agree before anything is minted on ZETAPHY. Here the second line is
human: guardians must watch each `Queued` event on the vault against a matching `Sent` on X's synthetic during the
delay (1 h in the table) and `veto` a mismatch. An automatic watcher that vetoes mismatches (or a second lane for
releases) is not built yet; until it is, keep the daily limits and lock caps small (the table: 100 per day, 1,000 in
total, per destination) and the routes closed when nobody is watching.

### The native coin

The ZETAPHY native coin has an ERC-20 face at `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` (the erc20 module's
native precompile, set in the genesis by `zetaphy-chain/setup-node.sh`). The vault uses it like any ERC-20:
approve the vault on `0xEeee…EEeE`, then `lock`. `test/devnet.saphantokens.integration.js` runs this on a real
zetaphyd devnet with the same genesis: `decimals()` answers 18, `approve` + `transferFrom` from a contract work, the
balance check sees exactly the amount, the vault's native balance is the escrow, and a release pays native coins
back. Native coins sent straight to the vault are refused (it has no `receive`); coins that reach it some other way
(a Cosmos bank send) are not backing and only governance can move them on.

### Odd ERC-20s (generic tokens)

Refused at `lock`: fee-on-transfer, false-returning; refused at deploy: no `decimals()` or another value than the
table. Not supported, so governance must not add them: rebasing tokens, tokens with blocklists, pausable or
upgradeable tokens whose owner could move or freeze the vault's balance, tokens with transfer hooks to arbitrary
contracts (re-entry is refused, but the hook owner is trusted). The vault's backing is only as good as the token.

## The table: adding a token

`zetaphy-chain/hyperlane/saphan-chains.json` -> `tokens.<key>` (checked by `zetaphy-network/src/saphan.js
tokenProblems`, part of the chain table check):

- `address` (on ZETAPHY), `decimals` (the token's `decimals()`), `symbol`, `displayName`; `native: true` only for the
  precompile; `transferable: false` + `why` for a token that cannot move (then no destinations);
- `synthetic`: the name and symbol on the destinations (unique across the table);
- `destinations`: chain names of the table;
- `limits` (whole tokens, per destination): `lockCap`, `releaseDailyLimit`, `releaseDelay` (s), `mintDailyLimit`,
  `mintDelay` (s), `supplyCap`.

A new token = an entry here (governance reviews the pull request: is the token plain, who controls it) + a
saphan-route run per destination + both timelocks opening it. No code. Deployed routes are written by the workflow to
`saphan-routes.json` -> `tokens.<key>.<chain>` (`zetaphy.vault`, `destination.synthetic`, ISMs, roles, start blocks,
`state`); the relayer and the hub read them.

## Workflow and relayer

- **saphan-route** (`.github/workflows/saphan-route.yml`) with `token = <key>`: `check` (the chain as for v2 + the
  token on ZETAPHY), `dry_run` (an anvil fork of the chain + a local ZETAPHY with Hyperlane core from the pinned CLI;
  a stand-in for the token; `token = test` is the BZTPHY-like one), `deploy` (the chain's roles (the v2 route's
  multisig and timelock when deployed), our ISM; the vault on ZETAPHY; the synthetic exactly where the vault points;
  both closed; pushes `saphan/<token>-<chain>`). On pull requests the dry run does the ETH route and `token = test`.
- **hyperlane-relayer**: the whitelist adds each vault -> its chain and each synthetic -> ZETAPHY; the gate starts the
  relayer and our validator while a vault locked more than its synthetic recorded (vault `nonce()` on ZETAPHY >
  synthetic `received()`), and the relayer alone while a synthetic sent back more than its vault recorded (Hyperlane's
  validator for X signs those). ZETAPHY is asked one `nonce()` per token route per run (plus `received()` only when
  the synthetic's count moved): with three routes ≈ 3.5 MB/month more of the node's egress (docs/SAPHAN-MULTICHAIN.md
  has the budget).
- The relayer delivers; it does not claim. After the delay the receiver (or anyone) calls `claim(id)` on the
  synthetic (out) or the vault (back); `id` = keccak256 of the message body (the `Queued` event has it).

## What the owner does after 2026-11-01 (the ZETAPHY RPC is back)

Needs what v2 needs first: `ZETAPHY_DEPLOYER_KEY` and `ZETAPHY_VALIDATOR_KEY` (repository secrets, names only), the
validator's address in `zetaphyValidators` (docs/SAPHAN-MULTICHAIN.md). No new secret. The same validator signs the
v2 releases and the token mints.

Test coins (free faucets, see `faucets` per chain in the table), on top of the v2 amounts:

| Account | Chain | Amount | For |
|---|---|---|---|
| deployer | Sepolia | +0.05 ETH (0.1 if the v2 route is not deployed there) | the synthetic (~2.5M gas); roles + ISM if new |
| deployer | Base Sepolia, Arbitrum Sepolia | +0.01 ETH each | the same (cheap) |
| deployer | ZETAPHY | a few ZETAPHY | the vault (~2.5M gas) per destination |
| deployer (relayer signer) | Sepolia / Base / Arbitrum | keep ~0.02 ETH | delivering mints (~0.2M gas each) |
| tester | ZETAPHY | some ZETAPHY (testnet faucet) | to lock |

Order:

1. Deploy the v2 ETH route of a chain first if you want the token route to share its multisig and timelock (the
   token deploy reuses them from `saphan-routes.json`; otherwise it makes new ones).
2. Actions -> **saphan-route**, `chain = sepolia`, `token = zetaphy`: `mode = check` (the precompile must answer
   decimals 18), then `dry_run`, then `deploy`. Open the pull request of `saphan/zetaphy-sepolia` and merge it.
3. The same for `basesepolia`, then `arbitrumsepolia`, each **after** the previous pull request is merged.
4. Open each route (48 h): the ZETAPHY timelock schedules `ZetaphyTokenVault.unpause()` (`0x3f4ba83a`) on the vault
   (proposed the way ZETAPHY timelock proposals are made today), and X's multisig proposes the same call on the
   synthetic to X's timelock; execute both after the delay. Then set `tokens.zetaphy.<chain>.state` to `"OPEN"` in
   `saphan-routes.json` (the hub shows it). Guardians: watch `Queued` on the vault during the delay (see "Trust").
5. **hyperlane-relayer** needs nothing: it picks the token routes up from `saphan-routes.json` on main.

## Verified, and not

- `npm test` in zetaphy-network: `test/saphantokens.test.js` (lock -> mint, burn -> release, wrong origin / sender /
  source / destination / token, replay, token A against token B, destination X against Y's escrow, over-limit,
  lock cap, supply cap, paused, veto, ISM refusals, 6 decimals, fee-on-transfer, false-returning, USDT-style,
  re-entry, ThreatRegistry holds, excess) and `test/saphanconfig.test.js` (the table, the relayer's whitelist,
  settings and gate, the hub's list).
- `test/devnet.saphantokens.integration.js` (`npm run test:devnet:saphantokens`): the native coin through the real
  ERC-20 precompile on a zetaphyd devnet.
- `scripts/saphan-dryrun.js --chain basesepolia --token test` against real Hyperlane contracts (Mailbox, merkle tree
  hook, StaticMessageIdMultisigIsmFactory from `@hyperlane-xyz/cli@45.0.1`) on two local chains: closed at deploy,
  opened, lock -> deliver -> mint after the delay, burn -> deliver -> release after the delay, and the refusals.
- Not run here: the Hyperlane agents with these routes, the deploy against the real testnets, the workflow on
  GitHub, the opening through the timelocks.
