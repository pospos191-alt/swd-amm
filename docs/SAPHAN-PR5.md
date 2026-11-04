# ZETAPHY Saphan: cross-chain reads, bundles, intents and one account everywhere (testnet)

**Testnets only, not audited, not deployed yet. No real money.** Saphan PR 5 adds four things on top of the
Saphan routes and Gateway (docs/SAPHAN-GATEWAY.md, docs/SAPHAN-SAFETY.md, docs/SAPHAN-PROOFS.md). None of them adds a
signer, a relayer that must be trusted, or an admin key: each one is checked by the route's existing lanes
(Hyperlane's validators, our validators, quarantine, Neuro, limits) or by a proof.

| Feature | Contract (zetaphy-network/contracts) | JS helper (src) | Tests (test) |
|---|---|---|---|
| S5 Cross-chain reads | `SaphanReads.sol` (SaphanReads, SaphanReadResponder, SaphanZetaphyReads, SaphanMpt) | `saphanreads.js` | `saphanreads.test.js` |
| D Multi-chain bundles | `SaphanBundles.sol` | `saphanbundles.js` | `saphanbundles.test.js` |
| E Intents + Neuro risk | `SaphanIntents.sol` (SaphanIntents, SaphanFillRelay) | `saphanintents.js` | `saphanintents.test.js` |
| C One account on every chain | `SaphanAccounts.sol` (SaphanAccount, SaphanAccountFactory) | `saphanaccounts.js` | `saphanaccounts.test.js` |

What is real and what is a prototype, in one line each:

- **Reads**: lane answers are complete and tested end to end. Proven answers about a source chain need a light
  client of that chain on ZETAPHY, which **does not exist yet**: the Merkle-Patricia verifier is complete and tested
  against an EVM's own proofs, but on testnet `SaphanReads` is deployed without one (lane answers only). Reading
  ZETAPHY from a source chain uses the STARK light client, which is itself a prototype (docs/SAPHAN-PROOFS.md).
- **Bundles**: complete and tested. "All or nothing" is exact on ZETAPHY (one transaction); a call sent on to
  another chain can still fail there and is refunded there by the Gateway (see below).
- **Intents**: complete and tested. The optimistic path trusts one honest watcher during the challenge window.
  Neuro's score is only as good as the feeder that posts it (docs on NeuroScore).
- **Accounts**: complete and tested. The "same address everywhere" needs the factory deployed by one fresh key as its
  first transaction on every chain; nothing is deployed yet.

## S5 Cross-chain reads: "what is value V on chain X at block B"

```
 source chain X                                              ZETAPHY
 ──────────────                                              ───────
 anyone ── SaphanReadResponder.answer(target, data) ──┐       SaphanReads(X)
   staticcall target (fixed 500k gas, checked first)  │         requestCall / requestSlot / requestAccount: a bounty (caller pays)
   (result, block.number, block.timestamp, answerer)  │
   X's Mailbox ── Hyperlane ─────────────────────────┼──▶ Mailbox + the route's ISM ─▶ handle(): newest answer kept
                                                      │
 eth_getProof(account, slots, B) of any X node ──────┼──▶ proveSlot / proveAccount: Merkle-Patricia proof under
                                                           X's state root at B (a light client of X: `stateRoots`)
                                                         read(query, minBlock, maxAge): refused when stale
                                                         collect(request): the bounty to whoever brought the answer
```

- **Answers carry their block.** Every answer has the X block number and time it is from. A newer answer replaces an
  older one; an older one arriving late is ignored (and does not block the Mailbox).
- **Stale answers are refused.** `read` / `readCall` / `readSlot` / `readBalance` take `minBlock` and `maxAge`: an
  answer from an older block, or older than `maxAge` seconds, reverts `Stale`. A contract decides what is fresh enough
  for it.
- **The caller pays.** `requestCall(target, data, minBlock, ttl)` (and `requestSlot`, `requestAccount`) holds a
  bounty in ZTPHY. Anyone who brings a fitting answer before the request expires (`ttl` at most 7 days) is credited
  with it (`collect`, then `claim`). Unanswered: the requester takes it back after expiry (`cancel`, `claim`). The
  answerer pays X's Mailbox fee (exact value, `quote`).
- **Nobody can fake or starve an answer.** Only the responder on X (set once by the deployer) may speak for X, and
  the Mailbox on ZETAPHY checks the route's ISM first. The responder gives every view call the same gas and checks it
  is there, so an answerer cannot make a call fail on purpose. A result longer than 1024 bytes is answered as failed.
- **The other way round.** `SaphanZetaphyReads.verify` on a source chain checks any ZETAPHY storage slot at a height
  the STARK light client finalized (IAVL path to the evm store, multistore path to the app hash, as proven releases
  do). It is a view: a contract on X calls it with the proof inside its own transaction and says how recent the
  height must be (`minHeight`). Only existing slots can be proven (no proof of absence yet).

Commands (offline): `node scripts/saphan.js read-query --chain-id <X> --target 0x… (--data 0x… | --slot <n>)`.

## D Multi-chain bundles: all run, or all are refunded

```
 Sepolia: alice ── depositAndCall(SaphanBundles, data = (id, 0)) ─▶ route ─▶ ZetaphyGateway ─▶ onSaphanCall: leg 0 in
 Base:    bob   ── depositAndCall(SaphanBundles, data = (id, 1)) ─▶ route ─▶ ZetaphyGateway ─▶ onSaphanCall: leg 1 in
 ZETAPHY: carol ── fund(id, 2) ─────────────────────────────────────────────────────────────▶ leg 2 in
 anyone ── execute(id, plan): ONE transaction: every step on ZETAPHY (tokens + onSaphanBundle)
                                                + every call to another chain (ZetaphyGateway.withdrawAndCall)
          any step fails ─▶ the whole transaction reverts (try again before the deadline)
 deadline passed, not run ─▶ refund(id): each funded leg owed to its refundTo ─▶ claim(token)
```

- `create(legs, plan, deadline)`: up to 8 legs and 8 steps, deadline at most 30 days. The plan is fixed now (its hash
  is stored) and must spend **exactly** what the legs bring, token by token; anything else is refused.
- **Per-leg proof of delivery.** A leg from another chain arrives as a Gateway call: the route's lanes attested its
  deposit address, which is the hash of the whole call (sender, amount, data = the bundle and leg). The bundle also
  checks the tokens are really in its hands (its balance beyond what it already owes), so a fake "gateway" funds
  nothing. A leg that is late, paid twice or from the wrong sender is refused, and the Gateway refunds it on its chain.
- **Calls to other chains** carry the Gateway's own call hash (event `OutSent`): the target there receives
  `abi.encode(bundle id, creator, data)` from the Gateway, with `sender` = SaphanBundles.
- **What "atomic" means here.** Everything on ZETAPHY, and the *sending* of every call to another chain, happens in
  one ZETAPHY transaction or not at all. A call that is sent can still fail on its own chain (the target reverts);
  the Gateway then pays the money to that step's `revertTo` there. Making the destination calls themselves
  all-or-nothing would need the other chains to wait for one another (a two-phase commit); that is not built.
- Refunds are pulled (`claim(token)`) on ZETAPHY by each leg's `refundTo`; from there the route takes them home.
- The executor pays the Mailbox fees of the outbound steps (`fees`, exact); what the Gateways give back returns to it.

## E Intents with Neuro risk

```
 Sepolia: alice ── depositAndCall(SaphanIntents, data = order) ─▶ route ─▶ intent open on ZETAPHY, A in escrow
          order: give A (token(Sepolia)), want >= B of Base ETH for bob, by T
 Neuro:   NeuroScore(bob) high, or ThreatRegistry holds/enforces bob ─▶ refused (the Gateway refunds alice)
          medium ─▶ fills count only after riskDelay (notBefore)
 Base:    solver ── SaphanFillRelay.fill(id, bob, B') ─▶ bob gets B' ETH now, from the solver
                    └─ Base's Mailbox ── Hyperlane ─▶ SaphanIntents.handle: proven fill ─▶ solver owed A on ZETAPHY
 faster:  solver ── claimFill(id) + bond ─▶ no challenge in challengeWindow ─▶ settle(): solver owed A, bond back
          watcher ── challenge(id) + bond ─▶ only the fill's message decides:
                     it comes (same solver)  ─▶ solver repaid, gets the challenger's bond
                     it comes (other solver) ─▶ that solver repaid; the claimer's bond is slashed
                     nothing in disputePeriod ─▶ timeout(): claimer slashed to the challenger, intent open again
 nobody fills by T + grace ─▶ refund(): A owed back to refundTo
```

- Open on ZETAPHY with `open(order)`, or from any route in one transaction (`depositAndCall` with
  `data = abi.encode(order)`; `src/saphanintents.js orderData`). `dstDomain` = ZETAPHY's chain id means the
  recipient wants an ERC-20 on ZETAPHY: `fillLocal` pays and repays in one transaction (no proof needed).
- **Neuro gates and delays.** At opening: `ThreatRegistry.isAddressHeld/isAddressEnforced(chain Y, recipient)` refuses;
  `NeuroScore.scoreOf(recipient)` level 3 (high) refuses, level 2 (medium) delays every fill by `riskDelay`. A local
  fill checks the recipient again. A solver the ThreatRegistry holds cannot fill on ZETAPHY or claim. NeuroScore's
  model and thresholds change only through governance (the ZetaphyTimelock).
- **Solver bonds and slashing.** Each optimistic claim posts `claimBond` in ZTPHY (exact). A false claim loses it to
  the challenger (or to the solver who really filled). A challenge posts `challengeBond` and loses it to a solver
  whose fill is proven. Bonds are pulled with `withdrawBonds()`. A solver claims and fills from the same address
  (the fill's message names the address that filled on Y; another address counts as someone else's fill).
- **Trust.** A proven fill trusts what a route already trusts for its inbound transfers (Hyperlane's validators for
  Y). The optimistic path is faster but trusts that someone (the user, the hub, any watcher) challenges a false claim
  within `challengeWindow`; `disputePeriod` must be longer than a Hyperlane delivery.
- **Solvers must check before filling** (`intentOf`, `src/saphanintents.js fillProblem`): a fill that does not match
  (another recipient, less than minOut, after the deadline, before notBefore, an intent already filled or refunded) is
  rejected on ZETAPHY and not repaid. Each intent can be filled once per relay.
- Payouts are pulls: repayments and refunds `claim(token)`, bonds `withdrawBonds()`. The recipient on Y is paid at
  once by the relay (the solver's own ETH).

## C One account on every chain

```
 fresh key K, first transaction on every chain ─▶ SaphanAccountFactory at the same address F everywhere
 account(owner) = CREATE2(F, salt = owner, SaphanAccount + owner)   (the same on every chain; src/saphanaccounts.js)

 ZETAPHY:  owner ── account.execute(calls)
 chain X:  owner ── ZetaphyGateway(X).withdrawAndCall(account, abi.encode(calls), amount, ..., revertTo = account)
           ─▶ route ─▶ SaphanSourceGateway(X).execute ─▶ account.onSaphanCall(77390, owner, data): runs the calls
```

- Anyone may deploy an account (`factory.deploy(owner)`); it belongs to its owner either way.
- **Who controls it.** On ZETAPHY, the owner directly. Anywhere else, only the owner's calls from ZETAPHY through that
  chain's Gateway: the account checks the Gateway (the factory's, fixed at deploy), the source chain (ZETAPHY) and the
  sender (its owner). The owner's own key is never used on other chains, so a contract owner on ZETAPHY (a multisig,
  a QuantumWallet) controls its accounts everywhere, and whoever holds the same address on another chain controls
  nothing.
- The calls run all or none; if one fails, the Gateway keeps the ETH for `revertTo` (the account itself with
  `controlArgs`) and anyone moves it into the account with `pullRefunds()`.
- On ZETAPHY the account also accepts money sent from other chains through a Gateway (it runs no call from it).

Commands (offline): `node scripts/saphan.js account --owner 0x… (--deployer 0x… | --factory 0x…)`.

## Compared with ZetaChain

The trust question is the same as for the Gateway (docs/SAPHAN-GATEWAY.md): ZetaChain's cross-chain actions are
attested by its observer-signers and their TSS key. Here every feature reuses what the route already checks:

| | Who attests it here | New trust |
|---|---|---|
| Read answers (lane) | the route's ISM (Hyperlane's validators of X) | none |
| Read answers (proven) | a light client of X + Merkle-Patricia proofs | none (once a light client exists) |
| Bundle legs | the route's lanes (the Gateway's deposit address = the call's hash) + the tokens on hand | none |
| Intent fills | the fill's Hyperlane message (Y's validators), or a bonded claim nobody disproved | one honest watcher on the fast path |
| Account control | the route's outbound checks (our validators or proven releases, delay, veto) | none |

## Deploying (not done yet)

Nothing in this PR is deployed. In order, per chain: `SaphanReads(X)` on ZETAPHY then `SaphanReadResponder` on X and
`setResponder` (once); `SaphanBundles` on ZETAPHY (no configuration); `SaphanIntents` on ZETAPHY (NeuroScore,
ThreatRegistry, the Mailbox, an ISM covering the fill chains, bonds and periods) then `SaphanFillRelay` on each Y and
`setRelay(Y, relay)` (once each); `SaphanAccountFactory` from one fresh key as its first transaction on every chain
(ZETAPHY: gateway = zero; X: its SaphanSourceGateway). The hub has no page for these yet.

## Limits

- Testnet only, not audited, nothing deployed, test coins only.
- No light client of an EVM chain runs on ZETAPHY yet, so proven reads of source chains wait for one.
- Bundles are atomic on ZETAPHY, not across the destination chains (see above).
- The optimistic intent path needs a watcher; the hub does not run one yet.
- Lane answers and fill messages are only as safe as the route's Hyperlane validators, like the route's inbound
  transfers.
- Merkle-Patricia proofs with nodes embedded in their parent (under 32 bytes) are refused; with hashed keys they do
  not occur in practice.
