# ZETAPHY Saphan PR 6: proofs, BTC withdrawals, liquidity, recovery, privacy, self-healing, offline, more chains

**Testnets only. Nothing here is audited. No mainnet, no real money.** Saphan is ZETAPHY's cross-chain bridge
(docs/SAPHAN-MULTICHAIN.md, SAPHAN-GATEWAY.md, SAPHAN-SAFETY.md, SAPHAN-PROOFS.md, SAPHAN-TOKENS.md). This PR adds
eight pieces. Each one says plainly whether it is **real** (works end to end on the testnet design, with tests) or a
**prototype** (shows the shape; something important is missing, and the section says what).

| Item | What | Real or prototype | Where |
|---|---|---|---|
| S2 | Machine-checked invariants of the bridge core | real (Foundry invariants, Halmos proofs, a JS property test in the normal suite) | `zetaphy-network/audit/invariants/saphan/`, `test/saphaninvariants.test.js` |
| S7 | Optimistic BTC withdrawals (BitVM2-style claim / challenge / slash) | **prototype**: no Bitcoin script, no peg-out | `contracts/SaphanBitVM.sol`, `src/saphanbitvm.js` |
| S9 | "AI liquidity": route limits that follow the flows, inside governance bounds | real (the policy is deterministic; an LLM may only hint) | `contracts/SaphanLiquidity.sol`, `src/saphanliquidity.js` |
| S10 | Guided recovery after an incident (pause, snapshot, Merkle claims, resume) | real | `contracts/SaphanRecovery.sol`, `src/saphanrecovery.js`, `saphan recovery …` |
| F | Private transfers (commitment + nullifier pool, fixed amounts) | real zero-knowledge proofs, **DEV trusted setup** | `contracts/SaphanPrivacy.sol`, `src/saphanprivacy.js` |
| G | Self-healing watcher (stuck messages, heartbeats, CircuitBreaker trips) | real service logic, tested on mocks and a real route | `src/saphanheal.js`, `saphan heal once` |
| H | Bridge transfers signed offline, relayed later by anyone | real | `contracts/SaphanOffline.sol`, `src/saphanoffline.js`, `saphan offline …` |
| I | More chains: Optimism Sepolia, Polygon Amoy, BSC testnet (Avalanche Fuji planned) | table entries (routes still to deploy) | `zetaphy-chain/hyperlane/saphan-chains.json` |

The CLI is `node scripts/saphan.js <command> …` in `zetaphy-network` (the new commands live in
`scripts/saphan-ops.js`, which lists every option).

## S2: invariants a machine checks

Four properties of a route (lockbox on the source chain; airlock, guard, token and outbox on ZETAPHY):

1. **The lockbox never releases more than was locked.** Its balance is exactly `locked` = locks - payouts.
2. **Every bridged coin is backed.** Supply on ZETAPHY + releases on their way back (burned, not yet paid) <= locked.
   The gap is exactly the locks ZETAPHY has not minted yet.
3. **Each message is released once.** A second delivery of the same body, a second claim, a second mint: all refused.
   One lying lane cannot mint anything (two independent lanes must agree).
4. **Daily limits hold.** Per UTC day: paid <= the lockbox's limit, minted <= the guard's limit for the route.

Three tools check them, each with its strength:

- **Foundry invariants** (`audit/invariants/saphan/SaphanRoute.inv.t.sol`): random sequences of locks, honest and
  lying attestations, releases, burns, deliveries in any order and twice, claims, vetoes, pauses and time, on the real
  contracts, both chains in one EVM. `cd zetaphy-network && forge test --match-contract Saphan`. The audit pipeline
  (`audit/run.sh`, step invariants) runs it with the other suites.
- **Halmos** (`audit/invariants/saphan/SaphanSymbolic.t.sol`, functions `check_*`): proofs for *all* inputs of a
  small scenario: any two locks and any two releases never pay more than locked or than the daily limit, each release
  pays once; the pro rata rule of the escape hatch / recovery never pays more than the pool.
  `halmos --forge-build-out audit/out --contract SaphanSymbolic`.
- **A JS property test in the normal suite** (`test/saphaninvariants.test.js`): the same four properties checked
  after every step of seeded random sequences, so `node --test test/*.test.js` catches a regression without Foundry.

Results are in `audit/invariants.md` (section "Saphan route").

## S7: optimistic BTC withdrawals (PROTOTYPE)

The problem: sending BTC back from ZETAPHY needs keys on Bitcoin. BitVM2's idea: an **operator** pays the user from
its own BTC first, then asks to be paid back; anyone can prove the operator lied, and one honest watcher is enough.

```
 holder                         ZETAPHY: SaphanBtcWithdrawals                    Bitcoin
 request(amount, btcScript) ─▶  escrows the bridged BTC
                                                         operator pays btcScript ≥ sats, with
                                                         OP_RETURN "ZTPHYW" || id || operator
 operator ── claim(id, txid, vout) ─▶ challenge window (e.g. 1 day), bondPerClaim locked
 anyone ── challenge(id) + bond ─▶ the operator must prove() the payment by SPV within the response window
   proven      ─▶ operator gets the escrow + the challenger's bond
   not proven  ─▶ slash(id): holder gets the escrow back + half the operator's bond; challenger: bond + half
 not challenged ─▶ finalize(id) after the window: operator gets the escrow
```

- The OP_RETURN ties a payment to **one withdrawal and one operator**: nobody can claim someone else's payment, and
  one payment serves one withdrawal.
- Each open claim locks part of the operator's bond, so it cannot leave with a bond it might lose.
- Payouts are pulled (`withdraw()`); every parameter is fixed at deploy; no owner, admin or pause.

**What is missing (why it is a prototype):** in BitVM2 the money comes back from a Bitcoin peg UTXO through
pre-signed transactions, and the disprove step runs as Bitcoin script (a SNARK verifier split into pieces). Here the
whole game runs on ZETAPHY and the "disprove" is simplified to "prove the payment by SPV or lose the bond". The SPV
check uses the existing `BtcLightClient` (proof of work, confirmations).

## S9: liquidity that follows the flows

A route's daily release limit should be high when people use it and low when they do not (a low limit caps what an
attacker can take in a day). `src/saphanliquidity.js` computes the next limit from the releases it observed:

- the 90th percentile of the last 7 days' daily totals, times 1.5 headroom;
- an optional **LLM hint** ("up / down / hold" with a factor) may nudge it by at most 20 %; anything else is ignored;
- then the governance band: never below `min`, never above `max`, at most `maxStepBps` change per update.

The same input gives the same answer on every machine, and the contract stores a hash of the input, so anyone can
recompute a proposal.

`SaphanLiquidityBounds` (one per source chain, governance = that chain's ZetaphyTimelock) holds each route's band
and target. The rebalancer (a key governance names) moves the target one bounded step at a time. **On chain it can
only lower risk**: the contract is a guardian of the lockbox, and `applyDown` lowers the lockbox's daily limit to the
target. A raise goes through the lockbox's timelock (`raiseProposal` prints the `schedule()` call); governance never
has to accept it. `liquidity plan` runs the policy from a file of flows.

## S10: the recovery path

When something goes wrong on a route, `node scripts/saphan.js recovery plan --state state.json` walks the steps and
says which one is next:

1. **pause**: guardians pause the lockbox and the guard (as today).
2. **snapshot**: `recovery read` collects the events (token(X) transfers on ZETAPHY up to the incident block,
   releases queued and not paid, locks never minted); `recovery snapshot --events events.json --exclude 0x…` turns
   them into one line per address and a Merkle root. It is the **escape hatch's exit tree** (same leaf, same proofs),
   so anyone can rebuild it and check it. Leaving an address out (e.g. the attacker) is a public decision in the file.
3. **claims**: governance deploys `SaphanRecoveryClaims` and, through its timelock (the delay is everyone's time to
   check the root), calls `start(root, total)` once (`recovery start` prints the calls). Anyone funds it (insurance,
   treasury, recovered funds). Each address claims its line once (`recovery proof --account 0x…`): in full when the
   pool covers the total, else pro rata. The pool is fixed at `start`, so the order of claims never changes a share.
   After the claim period, `sweep()` sends what is left to the insurance pool.
4. **resume**: governance unpauses once the cause is fixed.

## F: private transfers

`SaphanPrivacyPool` lets a holder of a bridged token break the link between the address that bridged in and the
address that uses the coins. One pool per token and amount (e.g. 0.01 sepETH):

- **deposit**: make a secret note offline, deposit its commitment with exactly the pool's amount;
- **withdraw**: later, from any address (or through a relayer who is paid a fee), a zero-knowledge proof that "one of
  the pool's deposits is mine", revealing only a nullifier (so each note is spent once) and bound to the recipient and
  fee (a copied proof cannot redirect the coins).

The proof is **real**: it reuses the private-identity circuit and its Groth16 verifier (zetaphy-network/zkid,
docs/future/zk-identity.md), unchanged. **But the trusted setup is DEV**: one machine made the key, and whoever ran it
could forge proofs and empty every pool. Mainnet would need a public multi-party ceremony first. Also: the anonymity
set is only the pool's deposits (small on a testnet), and deposits and timing are public. The test proofs come from
`zkid/privacy-fixture.js` with the hub's prover files.

## G: self-healing

`src/saphanheal.js` is a watcher with one `tick()` per route:

- **stuck messages**: a release the outbox sent but the lockbox never recorded, or a lock the lane never delivered,
  for longer than 30 minutes: replay the delivery (Hyperlane deliveries are idempotent and the contracts refuse
  replays, so a replay can only help), with backoff, at most 3 times;
- **heartbeats**: nothing heard from ZETAPHY for 20 hours: send one (long before the 14-day escape hatch opens);
- **anomalies**: under-backing (`reserves()` below 99.5 %), a mint spike (10x the hourly baseline), or a message still
  stuck after every replay: **trip the route's CircuitBreaker** with hashed evidence (this runner's attestation; the
  breaker's quorum of runners decides).

It never moves money and never unpauses. Errors in reading or acting are logged, never thrown.
`node scripts/saphan.js heal once` runs one tick over the deployed routes and, without `--act yes`, only says what it
would do.

## H: offline transfers

Like the offline cheques and swap orders: sign at home with no network, let anyone carry it online later.

1. Online once: approve `SaphanOfflineTransfers` for the route's token on ZETAPHY.
2. Offline: `node scripts/saphan.js offline sign --contract 0x… --outbox 0x… --to 0x… --amount <wei> --fee <wei>`
   prints a `ZSPH1:…` text (put it in a QR code).
3. Anyone online: `offline check` (signature, deadline, known route), then `offline relay`: the contract pulls amount
   + fee from the signer, pays the relayer its fee, and sends the amount through the route's outbox. From there it is
   an ordinary transfer: the guard's limits and pause, the lockbox's delay, veto and daily limit all apply.

The relayer cannot change anything signed (route, receiver, amount, fee); each nonce works once; `cancel(nonce)`
burns one. This direction only (ZETAPHY -> source chain): locking native coins on a source chain needs the sender's
own transaction.

## I: more chains

Added to `saphan-chains.json` (`chains`): **Optimism Sepolia** (11155420), **Polygon Amoy** (80002), **BSC testnet**
(97). Mailbox, merkle tree hook, validator announce and ISM factory come from the Hyperlane registry; the validator
(Abacus Works' default testnet validator, threshold 1) from the monorepo's `defaultMultisigConfigs`, both read on
2026-11-04 from their main branches. They were **not** checked on chain from here (the sandbox could not reach the
RPCs): re-check before running the saphan-route workflow. They show in the hub as "planned" until a route is deployed.

**Avalanche Fuji** is in a separate `planned` section that nothing reads: the registry still has its contracts, but
Hyperlane publishes no default validator for it, so nobody we know would sign Fuji -> ZETAPHY messages.

## What is not done

- S7 stays a prototype until there is a real peg-out on Bitcoin and an audit.
- The privacy pool needs a multi-party trusted setup before it protects anything of value.
- The liquidity contract can only lower limits by itself; raises stay with each chain's timelock (on purpose).
- The new chains need a route deployed (the saphan-route workflow) and their addresses checked on chain first.
- Hub screens for these features are not part of this PR (the CLI and contracts are).
