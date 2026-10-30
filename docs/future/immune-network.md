**English** | [ภาษาไทย](immune-network.th.md)

# The Web3 immune system: seen on one chain, known on every chain

Testnet prototype. Nothing here is deployed yet, nothing holds real money, and none of it has been audited by an
outside firm. Free public RPCs only; no keys of any real chain are used anywhere.

An attack seen anywhere should be known everywhere, fast, and other chains, wallets and dapps should be able to
defend themselves automatically. ZETAPHY's Neuro runners and its audit network already check code; the immune
network turns what they see into **flags agreed by bonded runners**, carries them to **every chain** within about a
minute, ships a **vaccine** (a detector derived from the attack) with each flag so clones are caught elsewhere, and
publishes everything as a **free, signed, static feed**. It never pauses anything by itself: chains, wallets,
dapps and circuit breakers read it and decide.

| Piece | Where |
|---|---|
| Sentinels per chain (EVM, Solana, Osmosis/CosmWasm), rate-limited RPC, resumable cursors | `zetaphy-network/src/immune/sentinel.js`, `rpc.js`, `chains.js` |
| Detectors (pure verdicts a runner re-runs) | `src/immune/detectors.js` |
| Evidence bundles (canonical JSON, sha256 = IPFS CIDv1) | `src/immune/evidence.js` |
| Vaccines (exact / fingerprint / similarity / selectors; CosmWasm and Solana checksums) | `src/immune/vaccines.js` (reuses `src/vaccine.js` and Neuro's `similarity.js`) |
| k-of-n agreement helpers (finding hash, runner vote, reject verdict, false-flag cost) | `src/immune/agree.js` |
| Registry on ZETAPHY: flags only from a NeuroJobs quorum; ttl, appeal, lift | `contracts/ImmuneRegistry.sol` (`ImmuneRegistry`) |
| Broadcaster: batched, gas-bounded Hyperlane fan-out + IBC memo for Osmosis | `contracts/ImmuneRegistry.sol` (`ImmuneBroadcaster`) |
| Mirror on every other EVM chain | `contracts/ImmuneMirror.sol` |
| Consumer side: `IImmuneFeed`, `ImmuneCheck`, `ImmuneGuard` (`notFlagged(to)`), reference router | `contracts/ImmuneGuard.sol` |
| Propagation planner, IBC memo (JS), latency model | `src/immune/propagate.js` |
| Open feed (JSON, NDJSON, RSS, Atom, ML-DSA-44 snapshot) | `src/immune/feed.js`, `scripts/immune-feed.js`, `.github/workflows/immune-feed.yml` |
| Defense SDK (`checkAddress`, `advise`, `watchFlags`) | `src/immune/sdk.js` |
| Mock multi-chain, attack scenarios, recorded fixture | `src/immune/mockchain.js`, `scenarios.js`, `test/fixtures/immune/` |
| Scripts | `scripts/immune-sentinel.js`, `immune-record.js`, `immune-feed.js`, `immune-sim.js` |
| Hub: Immunity tab dashboard + pre-sign warning (8 languages, CSP-safe) | `zetaphy-hub/assist.js`, `assist-i18n.js`, `hub.js`, `build.mjs` |
| Explorer: immune risk badge (8 languages) | `zetaphy-explorer/src/risk.js`, `src/config.js` (`immuneFeed`) |
| Deployment record (empty until deployed) | `zetaphy-chain/hyperlane/immune-network.json` |
| Tests | `zetaphy-network/test/immune.test.js`, `test/immune-e2e.test.js`; `zetaphy-hub/test/assist.test.mjs`, `assist.e2e.mjs`; `zetaphy-explorer/test/insight.test.js` |

## Architecture

```
 chain A (any)                  ZETAPHY                                          chains B, C, … (any)
 ┌──────────────┐  report   ┌───────────────────────────────────────────┐  Hyperlane  ┌──────────────────────┐
 │ sentinel     │──────────▶│ NeuroJobs "immune" job (fee)              │  (our ISM)  │ ImmuneMirror         │
 │ (free RPC,   │ finding + │  3 seats by lottery over n bonded runners │────────────▶│  isFlagged(chain,a)  │
 │  rate-limit, │ evidence  │  each re-runs the detector on the bundle  │             │  isCodeFlagged(h)    │
 │  cursor)     │ (IPFS CID)│  commit-reveal; >= k agree                │             │  ThreatFlag event    │
 └──────────────┘           │ ImmuneRegistry.attest(job, finding)       │             └─────────┬────────────┘
        ▲                   │  keys: account on its chain, EOA on every │                       │
        │ vaccine           │  EVM chain, code hash everywhere          │  IBC (ICS-20 memo)    ▼
        │ (from the feed)   │ ImmuneBroadcaster.broadcast(keys)         │──────────▶ Osmosis   routers with
        │                   │  <= 24 keys x <= 16 routes per call       │  CosmWasm  mirror    ImmuneGuard,
        │                   └───────────────────────┬───────────────────┘                      wallets (SDK),
        │                                           │ every 30 min (GitHub Action)            circuit breakers
        └──────────── feed.json / ndjson / rss / atom / snapshot.pq.json (immune-feed branch, jsDelivr) ◀─ SDK fallback
```

1. **Detect** (`sentinel.js`). One sentinel per chain polls a free public endpoint through a token bucket (4
   requests/s by default), rotates endpoints on 429/5xx, and keeps its cursor (`state.next`) so a restart or an
   outage loses nothing. What it looks for (`detectors.js`):
   - `clone`: a new contract matching a shared vaccine (exact code, Neuro fingerprint, opcode-shingle similarity
     with Neuro's honest baseline removed, or most of the exploit's distinctive selectors);
   - `flashloan`: a flash loan (Aave v2/v3, Balancer, Uniswap v3) + a pool price pushed ≥ 25% inside the same
     transaction + net profit to the caller: the calling contract is an exploit, the sender an attacker on every
     EVM chain;
   - `outflow`: a watched protocol losing ≥ 10% of a token (or 8× its usual outflow) in one block, mostly to one
     address;
   - `drainer`: one spender collecting unlimited approvals (`Approval` / `ApprovalForAll`) from ≥ 3 holders and
     sweeping ≥ 2 of them within a window, plus the address the sweeps go to;
   - `taint`: funds leaving a flagged attacker or drainer to a fresh externally owned account (severity 2: a
     warning only, never a block);
   - Solana `sol-drainer`: one delegate / new owner taking SPL token accounts of ≥ 3 owners;
   - Osmosis `wasm-clone` (an instantiated code whose checksum matches a vaccine) and `authz-drainer` (one grantee
     receiving send grants from ≥ 3 accounts).
   Each detector is split into a collector and a **pure verdict over explicit inputs**. The inputs go into the
   evidence bundle, so anyone can re-run the verdict without an RPC.
2. **Agree** (`agree.js`, NeuroJobs). The sentinel requests a NeuroJobs job of chain `immune` with target
   `immune:<chainId>:<evidence CID>:<findingHash>`. NeuroJobs seats 3 runners by its block-hash lottery over the
   bonded pool (`NeuroControl`). Each runner fetches the bundle by its content hash, checks the hash, checks a
   shipped vaccine is intact, re-runs the detector and commits `findingHash(finding)` if it reproduces, or
   `rejectHash(evidenceHash)` if it does not. `ImmuneRegistry.attest(jobId, finding)` accepts only a job of chain
   `immune` whose verdict is `findingHash(finding)` and that at least `minAgreed` runners revealed (k = 2 or 3 of
   the 3 seats; n = every bonded runner).
3. **Registry** (`ImmuneRegistry`). A finding sets up to three keys, the same derivations as `ThreatRegistry`:
   the account on its own chain, an externally owned account on **every** EVM chain (chain id 0: the same key signs
   everywhere), and the code hash on every chain. Each key carries `kind`, `severity` (1 info, 2 suspicious, 3
   high, 4 critical), `since`, `expiresAt` (1-180 days), `evidenceHash` and `vaccine`, and a `round` that bumps on
   every change (mirrors keep the newest round).
4. **Propagate** (`ImmuneBroadcaster`, `propagate.js`). Anyone calls `broadcast(keys)` and pays the Hyperlane fees:
   one message per route, only the keys that route still lacks (by round), at most 24 keys and 16 routes per call.
   The message is `abi.encode(4, chainId, items)` (kind 4; NeuroOracle uses 1-3, 3 = audit certificate). On the
   destination the Mailbox checks a message-id multisig ISM of **our** validators, as NeuroOracle and the Saphan
   routes do, and calls `ImmuneMirror.handle`. Osmosis: `pushIbc(keys)` sends an ICS-20 transfer whose memo
   ibc-hooks executes on the CosmWasm mirror (`cosmwasm/neuro-oracle-osmo`, one more instance whose hook sender is
   the broadcaster's). Solana: **documented path only** (below).
5. **Defend**. Routers, vaults and bridges inherit `ImmuneGuard` and add `notFlagged(to)`; wallets and dapps call
   the SDK; circuit breakers follow `ThreatFlag` or poll `isFlagged`. The hub warns before signing and the explorer
   shows a badge.
6. **Vaccinate** (`vaccines.js`). When the flagged thing is an exploit or drainer **contract**, the sentinel derives
   a vaccine from its runtime code; its sha256 id is the finding's `vaccine` (agreed by the runners with the rest),
   is stored with the flag on every mirror (`vaccineOf(key)`), and the vaccine itself rides in the feed. Every
   sentinel loads it and re-scans recent deployments at once, so a modified redeploy on another chain is caught
   and goes through the same agreement.

## The interface mirrors offer (for wallets, routers and circuit breakers)

Every feed, the registry on ZETAPHY and each mirror elsewhere, answers `IImmuneFeed` (`contracts/ImmuneGuard.sol`):

```solidity
event ThreatFlag(uint256 indexed chainId, address indexed subject, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
event CodeThreatFlag(bytes32 indexed codeHash, bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
function isFlagged(uint256 chainId, address subject) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
function isCodeFlagged(bytes32 codeHash) external view returns (bool flagged, uint8 severity, uint64 since, bytes32 evidenceHash);
function live() external view returns (bool);
```

`isFlagged(chainId, a)` checks both the chain's own key and the every-EVM-chain key and returns the worse.
`flagged = false` is also what a paused mirror and an expired flag answer; `live()` is false while a mirror is
paused or was never written, so a consumer can choose to fail open or fail closed.

**A circuit breaker** (the opt-in `src/selfheal/` breaker is built separately; any vendor's works the same way)
consumes it in one of two ways and decides by itself:

```solidity
// on-chain: before an exit, or in a keeper's check
(bool f, uint8 sev, , bytes32 ev) = IImmuneFeed(mirror).isFlagged(block.chainid, counterparty);
if (f && sev >= 4) breaker.trip(ev); // the breaker's own rule, its own owner, its own unpause
```

```js
// off-chain: follow the events (sdk.js watchFlags) and trip / alert
const { events, next } = await watchFlags(send, mirror, { fromBlock });
for (const e of events) if (e.flagged && e.severity >= 4 && watched.has(e.subject)) await breaker.trip(e.evidenceHash);
```

The immune network never calls a breaker; a breaker never writes the feed.

## Defense SDK

```js
import { createImmune } from 'zetaphy-network/src/immune/sdk.js';
const immune = createImmune({
  mirrors: { 84532: { rpc: 'https://sepolia.base.org', address: '0x…ImmuneMirror' } },
  feedUrl: 'https://cdn.jsdelivr.net/gh/pospos191-alt/swd-amm@immune-feed/',
  trustedKeys: ['0x…keyHash of the feed signer'],
});
await immune.checkAddress(84532, '0x…');  // { flagged, severity, since, evidenceHash, source: 'mirror' | 'feed' | 'none', … }
await immune.advise(56, '0x…');           // { action: 'block' | 'warn' | 'ok' | 'unknown', … }
```

The chain's own mirror answers first (the same answer a contract gets); the feed answers when there is no mirror,
the mirror is down, paused or empty, or the chain is not EVM (Solana base58 and Cosmos bech32 accounts work). With
`trustedKeys` set, a feed whose ML-DSA-44 snapshot does not verify under a pinned key, or does not hash to the
feed, is refused. `source: 'none'` means nothing could be read: the caller decides.

**Solidity**: inherit `ImmuneGuard(feed, minSeverity, failClosed)` and put `notFlagged(to)` on exits.
`ImmuneCheck` reads with a gas cap (60k per call) and never reverts on a broken feed. The default suggestion is
`minSeverity = 3` (high) and fail-open; a contract holding a lot of value may choose fail-closed for its exits.
`ImmuneGuardedRouter` is the reference integration.

## Trust model

**Who flags.** Nobody alone. A flag exists only after a NeuroJobs job of chain `immune` reached a quorum: 3 seats
drawn by NeuroJobs' block-hash lottery over every bonded runner (defender seats and quarantine rules included), at
least `minAgreed` (2 by default, 3 for stricter deployments) revealing the same `findingHash`. Each runner re-runs
the detector on the content-addressed evidence; it does not have to trust the sentinel, the requester or the other
runners. Governance cannot flag (there is no such function): it can only **protect** keys (a bridge's own
contracts, for example), which also lifts a flag on them. `ThreatRegistry`'s protected keys are protected here
too.

**False flags cost bonds.** A flag is *provisional* while the job's challenge window is open (`provisional(key)`;
the feed says so). Anyone can challenge in NeuroJobs with the reject verdict and a bond of at least 2× the fee. A
fresh round of runners (never the round-1 seats, never the challenger) re-runs the evidence. If it overturns, every
round-1 runner that revealed the false verdict loses **50% of its bond** (`CHALLENGE_SLASH_BPS`), half to the
challenger and half to the honest seats of the round, plus a strike (two strikes in five seats: quarantine), and
`ImmuneRegistry.lift(key)` clears the flag; the next broadcast clears it on every mirror. A challenger who is wrong
loses its bond. In the simulation, two colluding seats flag an innocent address, the honest third seat rejects,
a challenge overturns it, both colluders go from 100 to 50 ZETAPHY of bond, and the flag is gone from chain B
26 simulated seconds after the challenge began.

**Censorship and appeal.** Nothing stops anyone from requesting a job: the fee is the only gate, and the lottery
decides who sits, so a cartel must hold most of the bonded weight to choose seats. A flag that stands can still be
appealed later with an `immune-clear` job (verdict `clearHash(key, round)`), for example when a protocol has
recovered its funds or a contract changed owner; the same quorum rule applies. Every flag also ends by itself at
`expiresAt` (1-180 days; drainers 180, exploits 90, linked addresses 30): every view treats an expired flag as not
flagged, and `lift(key)` (anyone) bumps the round so mirrors that do not expire by themselves (the CosmWasm one)
learn it too. Severity 2 (taint) is a warning only: `ImmuneGuard` refuses at 3 by default.

**Delivery.** A mirror trusts the broadcaster's address on ZETAPHY and our validators' ISM; stale or replayed
rounds change nothing. A guardian can pause a mirror (governance unpauses); paused, it answers "not flagged" and
`live() = false`. The feed is a convenience copy signed with ML-DSA-44; the registry and the mirrors are the source
of truth.

**What it does not do.** It does not freeze funds, pause contracts or reverse transactions anywhere. It states a
reproducible finding about an address or a code hash; what to do with it belongs to each chain, protocol and
wallet. The wording everywhere is neutral (an exploit, a drainer, a known-bad code pattern), never an accusation of
a person.

## Latency (simulated)

Public RPCs were blocked from the environment this was built in (the proxy answered 403 for every endpoint tried:
publicnode, base.org, Solana devnet, Osmosis LCD), so every number below is **simulated seconds**, not a live
measurement.

End to end on in-process EVMs running the real contracts (`test/immune-e2e.test.js`, `node scripts/immune-sim.js`),
one clock, each step charged what it costs on the real chains (ZETAPHY 5 s blocks, validators sign 1 s, relayer
3 s, destination block):

| Stage | Seconds |
|---|---|
| attack block on Sepolia → sentinel report (6 s poll + requests) | 5.5 |
| NeuroJobs agreement, **two** findings (exploit contract + attacker), one after the other | 32 |
| `attest` × 2 | 10 |
| broadcast → mirror on Base Sepolia / Arbitrum Sepolia | +11 / +10 |
| **attack → flag answered on chain B / C** | **58.5 / 57.5** |
| clone deployed on C → caught (vaccine) → flagged on C's mirror | 32.6 |
| false flag broadcast → challenged, overturned, lifted on B | 26 |

The seeded model over every covered chain (`propagate.js simulate`, 300 trials, seed 11, attack on Sepolia, jitter on
polling, runner re-verification, signing, relaying and IBC): **median 53.5 s, p90 61.1 s**; stages detect 11.1 s,
agree 25 s, registry 5 s. Osmosis (IBC) is a few seconds slower than the Hyperlane routes.

**Gas.** `broadcast` is bounded by construction (≤ 24 keys × ≤ 16 routes). Measured against a Mailbox that only
emits: 67k (1 key, 1 route), 824k (24 × 1), 1.09M (8 × 4), 13.85M (24 × 16). `broadcastGas()` is a checked upper
bound of these; `planBatches()` shrinks batches so a call stays under 12M including the real Mailbox's per-dispatch
cost (~150k assumed). The e2e uses a test Mailbox that also stores each message (1.54M for 4 keys × 2 routes).

## Live vs simulated

| | Status |
|---|---|
| Contracts (registry, broadcaster, mirror, guard, router) | compiled and tested in-process with NeuroJobs, NeuroControl and a Hyperlane Mailbox + multisig ISM; **not deployed** |
| Sentinels over free public RPCs | code ready (`scripts/immune-sentinel.js --chains …`); **not live-tested here** (all public endpoints blocked: 403) |
| Detectors | tested on the mock multi-chain (EVM, Solana, Osmosis) and on a recorded fixture (`test/fixtures/immune/sepolia-attacks.json`, recorded from the mock scenario; `scripts/immune-record.js --live <chain>` records a live one) |
| Hyperlane propagation | simulated with the test Mailbox + ISM (signed checkpoints by test validators) |
| Osmosis (IBC) | the memo is built on chain and matches the CosmWasm mirror's format (tested); the IBC hop itself is not exercised |
| Solana | sentinel + detector tested on the mock; **no Sealevel mirror**: Solana consumers use the feed via the SDK |
| Feed | built and ML-DSA-signed in tests; the Action is written but has not run (it needs the default branch) |
| Hub / explorer | dashboard, pre-sign warning and badge tested against fakes and in the hub's browser e2e (planned state) |

### The Solana path (documented, not built)

Hyperlane's Sealevel Mailbox can carry the same body (`abi.encode(4, chainId, items)`) to a Solana program that
verifies the same multisig ISM and stores `key → (round, flagged, severity, since, expiresAt, evidenceHash)` in a PDA
per key (`seeds = ["immune", key]`), newest round wins. A Solana program or wallet then reads the PDA of
`accountKey(1399811149, pubkey)` (and `codeKey` of a program's data hash). Until it exists, Solana wallets and dapps
use the signed feed through the SDK (`checkAddress(1399811149, '<base58>')`).

## How others join

- **Run a sentinel** (anyone): `node scripts/immune-sentinel.js --chains sepolia,basesepolia --feed <feed url>`;
  reports land in `.immune/reports/<cid>.json` with the job target. Pin the bundle on any IPFS node and request
  the job (fee ≥ `minFee`). Add a chain to `src/immune/chains.js` with its free endpoints.
- **Be a runner**: register a bond in NeuroJobs (`register()`), approve the `immune` and `immune-clear`
  chains in NeuroControl (governance), and vote with `runnerVote(report, { vaccines })`.
- **Add a detector**: a pure verdict function in `detectors.js` + its collector; register it in `VERDICTS` so runners
  can re-run it. Keep thresholds conservative: a false flag costs the runners who agree to it.
- **Add a chain's mirror**: deploy `ImmuneMirror(mailbox, 77390, 77390, broadcaster, ism, governance, guardian)` and
  have governance call `ImmuneBroadcaster.setReceiver(domain, mirror)`; record it in
  `zetaphy-chain/hyperlane/immune-network.json` (the hub and the feed pick it up).
- **Defend a protocol**: inherit `ImmuneGuard` with the mirror on your chain, or call the SDK; subscribe a circuit
  breaker to `ThreatFlag`.
- **Read the feed**: `feed.json` / `feed.ndjson` / `rss.xml` / `atom.xml` on the `immune-feed` branch; verify
  `snapshot.pq.json` with `verifySnapshot(feed, snapshot, { trustedKeys })` or the hub's PQ verifier.

## Limits

- Not deployed; all latencies simulated; no public endpoint could be reached from here.
- Detectors are heuristics with conservative thresholds: they miss attacks that do not move a pool price inside
  one transaction, drainers that use `permit` signatures without an `Approval` event first, and slow drains below
  the outflow floor. Similarity can be evaded by heavy obfuscation; exact and fingerprint matches cannot.
- Agreement adds about 4-5 ZETAPHY blocks per finding; findings of one attack are separate jobs (run in parallel in
  practice; one after the other in the simulation).
- Mirrors trust our validator set's ISM (as the existing NeuroOracle routes do); a compromised majority of it could
  write false states to mirrors until governance replaces the ISM. Consumers that need more can read ZETAPHY's
  registry directly or require the feed's signature too.
- The flash-loan detector reads Uniswap-v2-style `Sync` events for prices; other AMMs need their own price events.
- `pushIbc` relies on ZETAPHY's ICS-20 precompile and an Osmosis channel; neither is exercised in the tests.
