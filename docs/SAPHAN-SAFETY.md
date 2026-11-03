# ZETAPHY Saphan: escape hatch and bonded challenges

**Testnets only, not audited.** Two safety nets around every Saphan route (docs/SAPHAN-MULTICHAIN.md), on top of
what a route already has (two independent lanes, quarantine, Neuro vetoes, the threat registry, daily limits):

- **Escape hatch** (source chain): if ZETAPHY stops (halted, censored, cut off), holders still get their ETH back
  from the route's lockbox, without asking anyone.
- **Bonded challenges** (ZETAPHY): anyone can stop a bad transfer before it mints; the lanes that vouched for it
  lose their bonds.

## Escape hatch

```
 ZETAPHY                                              source chain X
 SaphanCheckpointer.beat()  ── heartbeat (our validators sign it, like a release) ──▶ HyperlaneLockBoxV2
   anyone, at most hourly, pays the Mailbox fee                                          lastHeard = now

 no heartbeat and no release for ESCAPE_AFTER (14 days):  the lockbox is ESCAPING
   - lock() refuses (no new money comes in)
   - submitExitRoot(root, total, sigs): our validators (the lockbox's ISM, its threshold) sign
     exitDigest(root, total); once
   - escape(owed, proof): each address takes its line, pro rata if the backing is short; once
   - after the root: claim() and every message from ZETAPHY are refused (the root already counts them)
 a heartbeat before the root ends escaping; governance cannot call an escape off (setCheckpointer refuses then)
```

**What the exit root owes** (`src/saphansafety.js exitEntitlements`): token(X) balances on ZETAPHY at its last block
(read from its Transfer events), releases queued on the lockbox and not claimed (their receivers), and locks ZETAPHY
never minted (their senders). One line per address: leaf = `keccak256(keccak256(abi.encode(address, owed)))`,
sorted-pair Merkle tree. Anyone can rebuild it from public data and check what the validators signed.

**Trust**: the same validators that already sign every release (they could already release funds), nothing more.
A wrong root would need the threshold of them, as a forged release would. The light-client lane (Saphan PR 3)
removes this trust for inbound transfers.

Commands (zetaphy-network):

```
node scripts/saphan.js heartbeat --chain sepolia                      # one beat (the deployer pays the fee)
node scripts/saphan.js exit-root --file owed.json                     # root and total of [[address, wei], ...]
node scripts/saphan.js exit-root --file owed.json --chain sepolia --sign yes   # a validator signs (KEYFILE)
node scripts/saphan.js exit-proof --file owed.json --account 0x…      # a holder's proof for escape()
```

`owed.json` is either `[[address, wei], ...]` or `{ "balances": [...], "unclaimedReleases": [...], "unmintedLocks": [...] }`.

## Bonded challenges

```
 anyone ── open(transfer, reason) + bond ──▶ SaphanChallenges ── hold(id) ──▶ BridgeAirlock   (release waits)
 Neuro runners (NeuroJobs: active, clean track record) ── vote(id, uphold?) within votingPeriod
 resolve(id):
   uphold quorum      ──▶ airlock.veto(id): it never mints; challenger: bond back + half of the slashed lane bonds;
                          the bonds of every lane that attested it are slashed (the other half: the reserve)
   reject quorum, or the period ends without an uphold quorum
                      ──▶ airlock.unhold(id): it goes on; the challenger's bond goes to the transfer's recipient
```

- **The challenger role can only delay.** `BridgeAirlock.hold` / `unhold` touch one transfer's release, only for a
  transfer some lane attested and not yet released or vetoed. It cannot attest, release, mint, pause or move money,
  like a marker. Governance sets it (`setChallenger`) and makes it a vetoer (`setVetoer`) so an upheld challenge
  can veto.
- **Lane bonds**: a lane's operator bonds it (`bondLane`); leaving takes `UNBOND_DELAY` (14 days, longer than any
  vote), and the bond can be slashed until then.
- **Payouts are pulled** (`claim()`); slashed bonds kept as reserve go to insurance (`payReserve`, governance), e.g.
  the HackInsurance pool.
- **Defaults** (`safety-deploy`): bond 10 ZTPHY, 2 days to vote, quorum 2 runners with at least 3 agreed jobs.

What it does not do yet: a transfer that is already minted is not rolled back. That case is covered by the guard's
limits and pause and by insurance. Runners decide from evidence off the chain; the light-client lane (PR 3) lets a
challenge carry a proof that the lock does not exist on X.

## Turning it on for a route

1. Actions -> **saphan-route**, `mode = safety` (after the route is deployed): SaphanCheckpointer and
   SaphanChallenges on ZETAPHY. The run's summary lists the governance calls still to make; the addresses go to
   `saphan/<chain>-safety` (merge it).
2. Governance:
   - on the source chain (its timelock, 48 h): `lockbox.setCheckpointer(checkpointer)`;
   - on ZETAPHY (its timelock): `airlock.setChallenger(challenges)` and `airlock.setVetoer(challenges, true)`.
3. Heartbeats: `mode = heartbeat` (or `node scripts/saphan.js heartbeat`) at least daily; the relayer carries them.

Contracts: `contracts/HyperlaneLockBoxV2.sol` (escape hatch), `contracts/SaphanCheckpointer.sol`,
`contracts/SaphanChallenges.sol`, `contracts/BridgeAirlock.sol` (hold / unhold). Tests: `test/saphansafety.test.js`.
