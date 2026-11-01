# Self-healing: contain an exploit in progress, narrowly and for a limited time

**Testnet prototype.** No real money. The contracts have not been audited.

When Neuro sees an exploit in progress against a protocol, the chain should stop the damage within seconds. It
should not wait hours for a multisig to wake up. It also must not hand anyone a "pause everything" key. This
prototype does both, but only for protocols that **opt in**. Each trip is:

- **narrow:** only the functions the protocol listed, and only those the evidence implicates;
- **time-boxed:** it always expires by itself;
- **reversible:** the protocol's own governance can end it at once, and the chain timelock can veto it;
- **pre-approved:** each limit was chosen by the protocol in advance;
- **costly to abuse:** runners who sign a false trip lose their bond, which compensates the protocol.

| Piece | Where |
|---|---|
| `CircuitBreaker`: policies, bonded guardians, trips, outflow invariant, claims, slashing | `zetaphy-network/contracts/CircuitBreaker.sol` |
| `CircuitBreakable`: what a protocol adds (`whenNotTripped(selector)`, `_outflow`, held payments) | `zetaphy-network/contracts/CircuitBreakable.sol` |
| Detectors: logs, traces, z-score, reentrancy, bytecode scan, oracle deviation | `zetaphy-network/src/selfheal/detect.js` |
| Runner peers: recompute and sign, k-of-n signature gathering (simulated) | `zetaphy-network/src/selfheal/peers.js` |
| Detector loop: block by block, propose, gather, submit `tripWithSignatures` | `zetaphy-network/src/selfheal/loop.js` |
| End-to-end demo (vault drained over several blocks; OFF vs ON) | `zetaphy-network/scripts/selfheal-demo.js`, `test/helpers/selfhealdemo.js` |
| Tests | `zetaphy-network/test/selfheal.test.js`, `selfheal-detect.test.js`, `selfheal-e2e.test.js` |
| Hub card "Self-healing" (On-chain AI tab; read-only) | `zetaphy-hub/aichain.js` |

## 1. How a protocol opts in

The protocol contract calls `CircuitBreaker.register(policy)` itself, so its own governance decides. The policy is
everything a trip may ever do to it:

| Field | Meaning | Bounds (constants) |
|---|---|---|
| `governance` | the protocol's own governance: release a trip, change the policy, opt out, cancel held payments, claim a false trip | not 0 |
| `selectors` | the functions that may be paused | ≤ 16 |
| `invariantMask` | which of them an invariant trip pauses | within `selectors` |
| `assets`, `caps`, `window` | outflow cap per window for each asset (0 = native coin) | ≤ 8 assets; window 1 min to 1 day |
| `tripCapBps`, `holdAbove` | while tripped, the caps drop to `tripCapBps`, and single payments above `holdAbove` are **held** | ≤ 100% |
| `holdReview` | how long a held payment waits before anyone may pay it | ≤ 7 days |
| `maxPause` | how long a trip lasts | 10 min to 3 days |
| `quorum` | how many bonded runners must sign the same evidence | `minQuorum` to 16 |

To change the policy, or to opt out, the protocol waits `POLICY_DELAY` (2 days) and cannot do either while it is
tripped. So an attacker who takes over governance cannot loosen the breaker in the middle of an attack.

In the contract, the integration is three things (see `HealVault` in `test/helpers/SelfHealKit.sol`):

```solidity
contract Vault is CircuitBreakable {
    constructor(ICircuitBreaker b) CircuitBreakable(b) {}
    function withdrawAll() external whenNotTripped(this.withdrawAll.selector) {
        uint256 amount = balances[msg.sender];
        bool pay = _outflow(address(0), msg.sender, amount); // reports the outflow; false = held
        if (pay) _payOut(address(0), msg.sender, amount);
        balances[msg.sender] = 0;
    }
    function _payOut(address, address to, uint256 amount) internal override { /* send */ }
}
```

When `_outflow` returns false, the payment is **held**: the funds stay in the protocol, the call does not revert,
and the payment is recorded in `held`. It does not revert because a revert would also undo the trip that the same
call may have just caused. After the trip and `holdReview`, anyone may pay a held payment (`releaseHeld`). It is
then counted against the cap again. Or the protocol's governance cancels it (`cancelHeld`), and the funds stay.

## 2. Two ways to trip, and nothing else

1. **Runner evidence (k of n).** At least `quorum` distinct eligible runners sign the same digest:

   `{chainId, breaker, protocol, epoch, fromBlock, toBlock, evidenceHash, detectorId, mask}`

   They can sign in one of two ways:
   - ECDSA signatures gathered off chain, submitted by anyone with `tripWithSignatures`. Signers must be strictly
     ascending, so the same signer cannot be counted twice.
   - One `attest()` tx per runner. This works for any account type, so a runner with an ML-DSA account can attest
     post-quantum through `MsgEVMCall`.

   **Eligible** means all of these hold:
   - the runner is an active NeuroJobs runner with a bond;
   - it has at least `minAgreed` accepted verdicts;
   - it posted a **guardian bond** here.

   Slashing happens here, because NeuroJobs bonds cannot be slashed from outside. Each attester is re-checked
   when the quorum forms, so a runner that stopped being eligible does not count.

   The evidence must be **fresh**:
   - its range ends at most 64 blocks ago;
   - it spans at most 256 blocks;
   - it starts after the previous trip's range;
   - its hash was never used before.

   `epoch` goes up on every trip, so old signatures stop counting. `mask` must stay within the policy's selectors.

2. **On-chain invariant.** The breaker itself sees an outflow that would exceed the window's cap
   (`recordOutflow`). It trips with `invariantMask`, holds that payment, and needs no runners.

`MAX_STREAK` (3) trips in a row is the limit. "In a row" means each trip starts within `maxPause` of the previous
one's end. After that, the protocol's governance must `rearm`. So runners cannot keep a protocol paused forever by
chaining trips. A quiet period of `maxPause` resets the streak.

## 3. What a trip does, and how it ends

- `isPaused(protocol, selector)` is true only for the selectors in the trip's mask, and only while
  `block.timestamp < until` (`start + maxPause`). Other functions keep working. In the demo, deposits and the
  correct `withdraw` keep working while `withdrawAll` is paused.
- Outflows keep flowing, but with the cap cut to `tripCapBps`, and large single payments are held.
- A trip ends in one of three ways:
  - by itself at `until` (always);
  - early, by the protocol's governance (`release`);
  - early, by the chain timelock (`veto`).
- **No admin key.** The chain governance is the ZetaphyTimelock. It can:
  - set bounded parameters (guardian bond, claim bond, `minQuorum` ≥ 2, `minAgreed`, slash ≤ 50%);
  - veto a trip;
  - judge false-trip claims.

  It has **no function that pauses anything**.

## 4. False trips: slashing and compensation

- Within `CLAIM_WINDOW` (7 days) of a runner trip, the protocol's governance may `claimFalse(id)` by posting the
  claim bond.
- The timelock judges it with `resolveClaim`:
  - **Proven false:** each signer loses `slashBps` (default 50%) of its guardian bond. 80% of the slashed total
    goes to the protocol's governance, along with its claim bond back. The rest is burned. A signer slashed below
    the guardian bond is no longer eligible until it tops up.
  - **Rejected:** the claim bond is split among the signers. This makes frivolous claims cost something too.
- **Not judged within 14 days:** anyone may `expireClaim`. The claim bond is refunded and nobody is slashed.
- A signer cannot exit while a trip it signed can still be claimed or is being judged (`lockedUntil`,
  `openClaims`). So it cannot sign a bad trip and then run.

## 5. The detectors (off chain, deterministic)

Every honest runner must compute the **same evidence** from the chain, so that k of them can sign one hash. So
`evaluate(cfg, data, from, to)` is a pure function of logs, code and (optionally) call traces over the block range
plus a fixed look-back of 40 blocks. The evidence is canonical JSON hashed with sha256, like a Neuro report hash.
It lists:

- per-block volumes;
- the baseline;
- recipients;
- signals.

| Signal | What it reads |
|---|---|
| `volume` | the block's outflow is a z-score outlier (z ≥ 3, std floored at 25% of the mean) against the look-back, with idle blocks counted as 0, and above an absolute floor |
| `burst` | reentrancy from logs: ≥ 3 outflows to one recipient inside one tx |
| `trace` | reentrancy from a `callTracer` frame tree: the protocol calls out, and inside that call the protocol is entered again (only when the watch config says `traces`, so every runner uses the same inputs) |
| `callback` | Neuro bytecode scan (`zetaphy-neuro/src/bytecode.js`): the recipient's code pushes one of the protocol's own pausable selectors |
| `fresh` | the recipient is a contract never paid during the look-back |
| `oracle` | a configured price-feed update deviates ≥ 20% from the look-back median |

Outflows come from the protocol's configured events and from ERC-20 `Transfer`s out of it (Neuro's `decodeLogs`).

**The trip rule.** A trip needs `volume` **and** a corroborating signal: `burst`, `trace` or `oracle`. The other way
to trip is an unknown shape that is very strong: z ≥ 30 and ≥ 100 coins, paid to a `fresh` contract that has a
`callback`. A volume outlier alone, such as a whale's withdrawal, is only recorded as an alert, never tripped on.

**The mask.** It pauses only the selectors whose outflow events carried the anomalous block's money.

**The loop** (`loop.js`) reads every new block. When a block is anomalous for a protocol that is not tripped, the
loop:

1. builds a proposal;
2. sends it to the runner peers. Each peer **recomputes** the evidence from its own view of the chain and signs
   only if its result is anomalous with the same hash and mask (`peers.js`);
3. checks each signature;
4. submits `tripWithSignatures` once it has the quorum.

The peer exchange is simulated in memory. A deployment would carry it over the runners' existing transport.

## 6. Demo numbers (in-memory chain, `node scripts/selfheal-demo.js 200 7`)

The setup:

- A vault with a textbook reentrancy bug (`withdrawAll` pays before it zeroes the balance) holds about 4,600 coins.
- First, 200 blocks of benign traffic: 10 users depositing and withdrawing 1–20 coins, a smart-contract wallet,
  and a whale who withdraws and deposits 120 coins now and then.
- Then the attacker deploys a contract. Once per block, it deposits 10 and re-enters 9 times, taking 100 coins per
  block. An honest user's withdrawal follows each attack.
- Simulated blocks are 5 s apart.

| Run | Lost | Attack blocks that got through | Trip | Detection latency | False trips (benign phase) | Honest withdrawals OK |
|---|---|---|---|---|---|---|
| Self-healing OFF | 4,490 (vault drained) | 50 | – | – | – | 50/50 |
| ON, runner evidence (3 of 5) | **90** | 1 | runners | **1 block** (the trip lands in the block after the first anomalous block, ≈ 5 s) | **0** (214 blocks scanned; 3 z-score-only alerts, none tripped) | 60/60 |
| ON, invariant only (cap 2,000 / 10 min) | 2,300 | 26 | invariant | when the cap broke | 0 | 60/60 |
| ON, invariant only, cap too tight (600 / 10 min) | 0 | 0 | invariant | tripped **during benign traffic** | **1** | 60/60 |

Another seed (`200 11`) gives the same picture: OFF loses 2,820, runner mode loses 90, with 7 z-score-only alerts
and 0 false trips.

What the table shows:

- **Funds saved with runner evidence:** 4,400 of 4,490 (98%). Only the first attack block got through, and the
  trip paused only `withdrawAll`.
- A plain z-score monitor would have raised 3 alerts on the benign workload. The corroboration rule turned none of
  them into a trip.
- The invariant mode needs no runners at all, and it bounds the loss per window. But it is only as good as its
  calibration: a cap below normal traffic is a false trip. That is why caps are pre-approved by the protocol and
  why invariant trips are not slashable (nobody signed them).

**Griefing** (`test/selfheal-e2e.test.js`):

- **A colluding minority** (2 of 5 runners, quorum 3) proposes made-up evidence. The 3 honest peers refuse it ("no
  anomaly in my view of the chain"), and the contract refuses 2 signatures with `NoQuorum`. Repeating a signature
  is refused (`NotSorted`). So is adding an outsider's (`BadSignature` or `NotEligible`). A proposer that tampers
  with the mask of a real anomaly is also refused, because honest peers recompute the mask.
- **A colluding quorum** (3 of 5) can trip a healthy protocol once. Even then:
  - the trip is narrow: deposits keep working;
  - the protocol's governance releases it at once;
  - the claim is proven false, so each colluder loses half its guardian bond (5 of 10 coins);
  - the protocol receives 80% of the 15 slashed, plus its claim bond back;
  - the colluders drop out of eligibility.

## 7. Threat model

| Threat | What stops it |
|---|---|
| One key pauses a protocol | No such key. Runner trips need `quorum` (≥ `minQuorum` ≥ 2) bonded, eligible runners. Governance has no pause function. |
| Runners keep a protocol paused | Every trip expires (≤ 3 days, the protocol's own `maxPause`). Fresh evidence is needed each time (range after the last trip, new hash, new epoch). `MAX_STREAK` trips at most, then the protocol must rearm. |
| Runners trip a healthy protocol (griefing, extortion, short attack) | The quorum must collude. The trip is narrow (listed selectors only). The protocol releases it at once. Each signer loses its bond, which compensates the protocol. Signers cannot exit before the claim window ends. |
| Attacker front-runs or delays the trip | The detector trips in the block after the first anomalous one. The invariant cap needs no off-chain step. Held payments keep the attacker's later payouts in the protocol. |
| Attacker splits the drain below detection | The per-window cap is enforced on chain whatever the detectors see. The cap drops to `tripCapBps` while tripped. |
| Attacker controls the protocol's governance | It can release a trip. But it cannot loosen the policy or opt out while tripped, or within 2 days. The timelock's veto is the only other override. |
| Replaying old signatures | The digest binds chain id, breaker, protocol, epoch, block range and evidence hash. Used hashes are rejected. |
| Signature malleability | Low-s only, v ∈ {27, 28}. Signers strictly ascending. |
| Breaker bug bricks a protocol | `whenNotTripped` only reads `isPaused`. A protocol deployed with breaker address 0 is never touched. A trip always expires. |

## 8. Why opt-in and narrow

A chain-wide pause is a censorship tool. Once it exists, someone will be asked to use it. It also stops honest users
of every protocol to save one.

Here, nothing happens to a contract that did not register. A registered contract decides in advance:

- which functions may stop;
- for how long;
- how many runners it trusts;
- how much may leave per window.

So the protocol accepts the risk of a false trip knowingly, bounded and compensated, in exchange for losing one
block of an exploit instead of the whole treasury. Narrowness also lowers the cost of a false trip. In the demo,
users kept depositing and withdrawing normally while `withdrawAll` was paused.

## 9. Comparison

| | Who decides | Effect | Bounded / expires | Abuse cost |
|---|---|---|---|---|
| **Forta** (detection bots + Firewall) | bots raise alerts; the protocol's own keys or a firewall rule act | whatever the protocol's pause does; Forta Firewall screens txs before execution on supported rollups | up to the protocol | bot staking (for alert quality), not for wrong pauses |
| **Hypernative** | ML-based detection; the protocol pre-authorizes automated responses (often a pause from a multisig/guardian module) | usually a full pause | up to the protocol | none on chain |
| **Hexagate** (Chainalysis) | pre-transaction simulation and ML detection; the protocol's guardian key pauses or blocks | full pause or tx blocking | up to the protocol | none on chain |
| **Chain-level circuit breakers** (e.g. ERC-7265's token outflow rate limiter; validator-run bridge breakers such as ZETAPHY item #31) | an on-chain rate limit, or a validator supermajority | delays or locks withdrawals above a rate; or pauses a bridge | ERC-7265: settle after a grace period; #31: until governance unpauses | none (rate limit), or validator stake |
| **This prototype** | k of n bonded Neuro runners recomputing the same evidence, or the on-chain cap | only the listed and implicated selectors; cap cut; large payments held | always expires (≤ `maxPause`); protocol release; timelock veto | slashed guardian bond, paid to the protocol |

What is new here:

- The trip is **decentralized and accountable**: a quorum of bonded runners who must reproduce the evidence, not
  one vendor's key.
- It is **bounded by the protocol's own policy**.
- **Wrong trips are paid for** by the people who caused them.

The ERC-7265-style rate limit is included as the invariant mode. It fits well as a backstop that needs no detector.

## 10. Limits (prototype)

- The peer exchange is simulated in one process. Real runners would need a transport and a proposer rotation.
  Signature gathering is not incentivized, and nobody is paid for a correct trip yet.
- Detectors are heuristics. A novel exploit without a reentrancy shape, an oracle move, or an extreme outlier to a
  fresh callback contract is caught only by the outflow cap. A slow drain under the cap per window is not caught.
- Evidence must be reproducible by every runner, so detectors cannot use private mempool data or non-deterministic
  ML. A Neuro model would have to be pinned by `ModelEpochs` to be used here.
- The timelock judges false-trip claims. That is slow (its delay) and political. A replay-based judgment, like
  HackInsurance's runner replay, would be better.
- `CircuitBreaker` is deployed by the frontier button (`.github/workflows/frontier-deploy.yml`, docs/future/deploy.md).
  The hub card says "not deployed" until its record is merged.
- The first anomalous block is never stopped. Detection needs it to be in a block. With ≈ 5 s blocks and one
  trip tx, that is one block of loss; the invariant cap can bound even that.

## Tests

- `test/selfheal.test.js` (18 tests, in-memory EVM):
  - policy bounds and delays;
  - k-of-n (fewer, outsiders, unsorted, duplicates, bad signatures);
  - the local digest equals the contract's;
  - NeuroJobs eligibility;
  - on-chain attestations;
  - fresh evidence;
  - narrow effects;
  - expiry, release, veto;
  - streak;
  - governance has no pause power;
  - invariant trip and held payments;
  - slashing and compensation;
  - rejected and expired claims;
  - the real ZetaphyTimelock as the only override;
  - **invariants over random sequences:** trips expire within `maxPause`, the cap holds, no trip below quorum,
    only masked selectors pause.
- `test/selfheal-detect.test.js`: outflows, baseline and z-score, bursts and traces, the bytecode scan, the
  corroboration rule, and oracle deviation.
- `test/selfheal-e2e.test.js`: the demo (OFF vs ON), false positives on 150 benign blocks, a colluding minority
  refused, a colluding quorum slashed, expiry and a renewed attack caught again, and invariant-only mode with its
  calibration risk.
