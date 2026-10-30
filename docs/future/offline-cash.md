# ZETAPHY Offline Cash and ZETAPHY Mesh

**Testnet only.** No real money. Prototype; the contract has not been audited.

Money that works with no internet, and can travel a long way without it:

- **Offline Cash** is a set of bearer notes backed by a bond. An issuer locks coins as notes on chain. The notes then
  pass from hand to hand while everyone is offline. Each hand-over is a post-quantum signature (ML-DSA-44). Whoever
  holds a note last cashes it when they are back online.
- **ZETAPHY Mesh** is store-and-forward transport. It cuts any signed thing (a note, a cheque, a swap order, a signed
  transaction) into small numbered frames with checksums. The frames fit in an SMS, a LoRa / Meshtastic message or a
  QR code. They can travel through several people and several media, in any order. A relay puts the result on chain
  when it is online.

This builds on [offline trading](offline-trading.md) (cheques and offline orders) and on the PQ block certificates
(`zetaphy-network/src/pqcert.js`).

| | Online once | Offline | Online again |
|---|---|---|---|
| **Issuer** | bond (≥ 150 %) + `issue` the notes, locked until `lockUntil` | signs each note over to its first holder | after `lockUntil`: `reclaim` notes nobody cashed |
| **Holder** | (optional) a holder bond for its key | checks a note, keeps it, signs it over to the next key | `redeem` (or signs a cash-out that any relay submits) |
| **Payee** | pins the validator set (once) | checks the chain of signatures and the proof of funds | |
| **Relay** | | collects frames from SMS / LoRa / QR / files | submits; earns the fee in the signed payload |

Code:

| What | Where |
|---|---|
| Contract | `zetaphy-network/contracts/ZetaphyOfflineCash.sol` |
| Shared logic (hashes, chains, swap tickets, proofs, binary/text forms, calldata) | `zetaphy-hub/cash-core.js` (no dependencies; crypto passed in) |
| Node side (keys, proof builder, attestation fallback, on-chain helpers) | `zetaphy-network/src/offlinecash.js` |
| Mesh frames (packets, base45/base32, chunking, reassembly, SHA-256, CRC-16) | `zetaphy-network/src/mesh/frames.js` (the hub serves the byte-identical copy `zetaphy-hub/mesh-frames.js`) |
| Mesh relay and the CLI | `zetaphy-network/src/mesh/relay.js`, `src/mesh/cli.js` (`zetaphy mesh …`, `zetaphy cash …`) |
| Hub (Offline tab, 8 languages, CSP-safe) | `zetaphy-hub/offline-cash.js`, `offline-cash-i18n.js` |
| Deploy | `zetaphy-network/scripts/offline-deploy.js` (now also deploys `ZetaphyOfflineCash`) |

## 1. Notes

- **Holder keys.** A holder is an ML-DSA-44 key, named by `keccak256(publicKey)`. This hash is the 32-byte
  "key hash" you give to whoever pays you. The hub makes this key in the browser and keeps its 32-byte seed
  encrypted (AES-GCM, with a key from PBKDF2-SHA256 at 600,000 rounds, like the cheque key). The CLI keeps it in
  `~/.zetaphy/cash.seed`.
- **`issue(issuerKey, lockUntil, values[])`**, payable. It locks `msg.value` as notes. `values` are the
  denominations, up to 64 notes per call. Holder 0 of every note is `issuerKey`. `lockUntil` is 1 to 366 days
  ahead. Before `lockUntil`, only a holder can take a note's value out; the issuer cannot.
- **The issuer bond.** `bondIssuer(until)` is payable. `issue` requires `bond ≥ 150 % × outstanding notes`, and the
  bond must stay locked until at least `lockUntil + 30 days` (the claim window). There is no early withdrawal. Each
  `issue` also emits `IssuerBonded`, which records the bond as it now stands, so offline proofs can show it.
- **Link (hand-over)**:
  `keccak256(abi.encode(LINK_TAG, DOMAIN, noteId, seq, prev, to, cond))`
  - Holder `seq` signs it with ML-DSA-44, and the signature names the next holder `to`.
  - `prev` is the hash of the previous link. For seq 0 it is the note's root:
    `keccak256(abi.encode(NOTE_TAG, DOMAIN, id, value, lockUntil, issuerKey))`. So the issuer's first signature
    commits to the note's terms.
  - `DOMAIN` binds the chain id and the contract.
- **Terminal (cash-out)**:
  `keccak256(abi.encode(TERMINAL_TAG, DOMAIN, prev, payout, fee))`
  The current holder signs it. Anyone can submit it: a relay pays the gas and earns `fee`, and the rest goes to
  `payout`. The relay cannot change either value.
- **`redeem(id, links, terminal)`**:
  - If the note is still **live**, it pays out. The **earliest valid chain to reach the chain wins.**
  - If the note was **already paid**, the contract looks for a fraud claim (section 2).
  - Every message it accepts is recorded as `spentBy[prev] = message`. So a replay, an old prefix, or a second claim
    pays nothing.
- **`reclaim(ids)`**: after `lockUntil`, the issuer takes back notes nobody cashed. This is expiry, not fraud: the
  holder of a reclaimed note has nothing to claim. Wallets warn when fewer than 3 days are left.
- A holder can keep passing a note on, offline, as long as they like (up to 64 links). Each link adds 3,765 bytes
  (see the size table).

## 2. Double-spending: who bears the risk

Anyone can sign the same note over twice: two different messages that spend the same `prev`. Because the first chain
to reach the chain wins, the other holder is the victim. That victim calls `redeem` with their own chain. The contract
finds the first position where this chain leaves the paid history. The holder at that position signed both messages,
so that holder is the cheater. The contract then pays the victim the note's value, until `lockUntil + 30 days`:

| The split is at | It is paid from | If that bond is short |
|---|---|---|
| seq 0 (the **issuer** signed two hand-overs, or a hand-over and its own cash-out) | the **issuer bond** (≥ 150 % of the issuer's outstanding notes when issued) | the victim loses the rest |
| seq k ≥ 1 (a **later holder** double-spent) | that holder's **holder bond** (`bondHolder(key, until)`, posted by anyone; only the first bonder can add to it or withdraw it after `until`) | the victim loses the rest; with no bond, the victim loses it all |

**Decision: the issuer answers only for its own signatures.** It does not insure later holders. Otherwise anyone could
drain an issuer by double-spending its notes, and nobody would issue. Each later holder answers with their own bond.
So:

- A note received **straight from the issuer** is covered up to the issuer bond. That bond is shared, first come first
  served, by all the victims of that issuer.
- A note that passed through other people is covered only up to the **smallest bond among all the keys that signed in
  its chain**. Any of them could have split it, not only the person paying you. The hub and `zetaphy cash check` show
  this as "covered: X of Y". A holder bond only counts if it is locked until at least the note's `lockUntil + 30 days`.
- A bond is shared by every note its owner passes on. A cheater can split many notes, and the bond pays the victims in
  the order they claim. This is a limit of any bonded offline cash: **for amounts above the covered value, the payee
  bears the risk.** You can lower that risk by taking notes straight from the issuer, by asking payers to keep a large
  holder bond, and by cashing quickly.
- Further splits down an already paid victim branch are traced too. After a victim is paid, their branch is recorded.
  If that victim had also passed the note on twice, the second person down that branch can claim against the
  victim's bond.
- A claimant who signed two spends themselves gets `OwnDoubleSpend`. Paying the claimant from their own bond would
  make no sense.

## 3. Offline proof of funds

When you are paid offline, you want to know that the note really is locked on chain, and how big the bonds are. A
**note proof** shows this. It is checked with **no network**, against a **pinned validator set**: the
`zetaphy pq export-vote-keys` output, saved once from a node you trust.

**Primary: the results proof (`kind: 'results'`).** It is built by `buildResultsProof` from a CometBFT RPC, and
`zetaphy cash proof` uses it. It holds:

1. **Tx result.** The result of the tx that emitted the event (`NoteIssued`, `IssuerBonded` or `HolderBonded`) in
   block H. This is CometBFT's deterministic `ExecTxResult` (code, data, gas_wanted, gas_used). Its `data` holds the
   Cosmos EVM `MsgEthereumTxResponse`, with the **EVM logs**.
2. **Merkle path.** The RFC 6962 path from that result to `last_results_hash` in the **header of block H+1**.
3. **Certificate.** The ML-DSA-44 **PQ certificate of block H+1**: the attestations in the first tx of block H+2. It is
   checked like `pqcert.js` does: the vote message, the header hash and the vote keys valid at that height.

The verifier (`cash-core.js verifyProofItem`) rebuilds the header hash and counts the attestations of the pinned
validators. It requires that **more than 2/3 of all the pinned power** signed. That is stricter than the chain's own
rule, which only counts validators that have a vote key. It then checks the Merkle path, decodes the logs, and
checks that the log comes from the pinned contract. The CLI passes `pqcert.js`'s `headerHash`. The hub uses a
dependency-free port of it, and a test checks that the two give the same result.

**Why not `eth_getProof`.** Cosmos EVM answers `eth_getProof` with IAVL / ICS-23 proofs of its KV store. These are
not Ethereum Merkle-Patricia proofs. To check one offline, you would have to verify IAVL plus the multistore against
`app_hash`. That is more code than this prototype carries. The results path needs only SHA-256, protobuf and the
certificate.

**Fallback: validator attestation (`kind: 'attest'`).** Validators sign the log itself with their vote keys:
`"zetaphy/cash-attest\0" ‖ chainId ‖ "\0" ‖ height ‖ time ‖ keccak(address ‖ topics ‖ data)` (ML-DSA-44,
k-of-n, more than 2/3 of the pinned power). `attestLog` makes one. This needs validators to run a signing service.
It is **not deployed**: only the format and the verifier exist and are tested.

**What a passing proof means, and what it does not.**

- Proven: the note was issued with these terms, and the bond was X as of block H. This holds if the pinned validators
  are honest: the same trust as any light client.
- **Not proven: that nobody cashed the note since.** Only the chain of signatures, together with the bonds, protects
  you against that.
- Bonds can shrink after the proof, as victims are paid. Proofs older than 7 days are flagged **stale**.
- Proofs are big: one ML-DSA signature (2,420 bytes) per validator, plus a header of about 1 KB. Carry them by QR or
  file, or once per issuer and bond, not by SMS for every payment.

## 4. Atomic swap ticket

Holder P of note A and holder Q of note B swap them offline:

- **The ticket.** It fixes both legs and a deadline: `(noteA, seqA, prevA, toA = Q's key, payoutA, noteB, seqB,
  prevB, toB = P's key, payoutB, deadline)`. Its id is `ticketId`.
- **Signing.** Each holder signs its own leg as a Link whose `cond = ticketId`. Each signature therefore commits to
  both legs: the bundle is "signed by both".
- **Settlement.** A conditional link counts only through `settleSwap(ticket, chainA, chainB)`. That call checks both
  chains and pays A to `payoutA` and B to `payoutB` in **one transaction**, or reverts. If either note was already
  spent (for example, P double-spent A first), nothing moves, and Q still holds B.
- **Before settlement.** An unsettled ticket is only an offer. Its legs are not spends, so they cannot be used as
  fraud evidence, and a leg cannot be redeemed alone (`UnsettledSwap`).
- **After settlement.** The ticket signature also served as each holder's cash-out. If Q still signs A over to W
  afterwards, W can claim against Q's holder bond.
- **Limit (v1).** A note received through a ticket cannot be passed on offline before settlement. The wallet refuses,
  because the other leg would have to travel with it.

## 5. ZETAPHY Mesh

**Packet:**

```
"Z" 0x01 | type (1) | flags | deadline (uint32, unix s, 0 = none) | relayer-fee hint (varint) | len (varint) | payload
```

- Types: `tx` (a raw signed tx), `note`, `redeem` (a note with its cash-out), `swap`, `proof`, `cheque` (the `ZCHQ1:`
  text), `order` (`ZORD1:`), `raw`.
- Notes and swaps use a compact binary form: no JSON, no hex.
- The packet id is the first 8 bytes of SHA-256, and relays dedupe on it.
- The fee is only a hint for ordering the queue. The fee that binds is the one inside the signed payload (the
  terminal's `fee`, the order's `relayerFee`).

**Frame:**

```
0xB1 | packet id (4) | seq (uint16) | total (uint16) | chunk | CRC-16/CCITT
```

That is 11 bytes of overhead. After reassembly the packet must hash to its id. This drops mixed-up packets and
damaged frames.

**Text:**

- `ZM` + base45 (RFC 9285). The space is written as `_`, so every character is in the GSM 03.38 7-bit basic set and
  a frame contains no whitespace. You can paste a whole chat export.
- `zm` + base32 (RFC 4648, lower case) for media that lose case or punctuation.

**Profiles:**

| Profile | Frame size |
|---|---|
| `sms-binary` | 140 bytes |
| `sms-text` | 160 characters |
| `lora` | 200 bytes (Meshtastic private app port) |
| `lora-text` | 200 characters |
| `qr` | 1,500 characters |
| `file` | one frame |

**Reassembly** (`Reassembler`): frames can arrive in any order, from any mix of media, with duplicates and losses. The
reassembler reports which sequence numbers are missing. Once a packet is complete, any later frame of it is marked
`done`.

**Multi-path:**

- Send the same packet through several relays. The first copy to land wins.
- The others are refused by the chain's own replay protection: `spentBy` and `AlreadyPaid` for notes, a cheque's
  cumulative total, an order's nonce, a tx's nonce.
- `MeshRelay` records these refusals as `landed-elsewhere` and does not retry them.
- It drops packets past their deadline. It sorts the queue by fee hint, then by deadline. It keeps its state across
  restarts.

**Using it:**

- **CLI**:
  - `zetaphy mesh send <type> <file> --profile sms-text`
  - `zetaphy mesh relay --in frames.txt [--submit]`
  - `zetaphy mesh sizes`
- **Hub**, Offline tab, **Mesh** card:
  - Export: frames as text plus one QR code per frame (Previous / Next).
  - Import: paste frames in any order, from any medium. The hub shows the progress and the missing frames. When it
    is online it can submit a cash-out, cheque or order, so the browser acts as a relay.

### Frames per medium

ML-DSA-44 signatures are 2,420 bytes and public keys 1,312 bytes. Each hand-over carries both, so post-quantum notes
are big. Cheques and orders (secp256k1) are small. This table is the output of `zetaphy mesh sizes`, and a test keeps
it up to date:

| what | packet bytes | sms-binary | sms-text | lora | lora-text | qr | file |
|---|---:|---:|---:|---:|---:|---:|---:|
| signed EVM tx (ECDSA, simple call) | 191 | 2 | 3 | 2 | 2 | 1 | 1 |
| cheque (ZCHQ1 text) | 331 | 3 | 4 | 2 | 3 | 1 | 1 |
| swap order (ZORD1 text) | 780 | 7 | 9 | 5 | 7 | 1 | 1 |
| note, fresh from the issuer (0 links) | 104 | 1 | 2 | 1 | 1 | 1 | 1 |
| note after 1 hand-over (1 ML-DSA link) | 3,870 | 30 | 42 | 21 | 32 | 4 | 1 |
| note after 3 hand-overs | 11,400 | 89 | 122 | 61 | 95 | 12 | 1 |
| cash-out (1 link + terminal) | 7,630 | 60 | 82 | 41 | 64 | 8 | 1 |
| note proof, 4 validators sign | 12,122 | 94 | 129 | 65 | 101 | 13 | 1 |
| note proof, 21 validators sign 15 | 38,963 | 303 | 415 | 207 | 323 | 40 | 1 |

What the table means in practice:

- **Cheques, orders and plain txs fit in a few SMS or LoRa messages.** These are the right things to send over a
  slow, long-distance link.
- **A post-quantum note costs about 30 to 40 SMS per hand-over.** QR codes (4 per hand-over), a file, Bluetooth or a
  LoRa burst suit it better.
- **Proofs** should travel once, by QR or file, and be reused.

Two other notes on size:

- **Cutting the bytes.** A future version could send each holder's public key once per contact, or use a smaller
  post-quantum scheme for hand-overs. ML-DSA-44 was kept because the chain's precompile verifies it today.
- **LoRa airtime.** At typical Meshtastic presets, a 200-byte message takes about 0.3 to 1.5 seconds of airtime, and
  duty-cycle limits (for example 1 % in parts of the EU band) cap how many frames per hour a node may send. So a note
  is minutes of airtime, not seconds.

## 6. Threat model

| Threat | What happens | Who bears it / mitigation |
|---|---|---|
| Issuer signs a note to two people | the first copy cashed wins | the other victim is paid from the issuer bond (≥ 150 % when issued) |
| A later holder signs a note to two people | the first copy cashed wins | paid from that holder's bond, up to the bond; **the payee bears the rest**. The hub shows "covered X of Y" |
| A holder passes the note on, then cashes it himself | his cash-out lands first | the next holder claims against his bond, like any other double-spend |
| An issuer or holder "double-spends" to a key of their own and claims from their own bond | the bond is paid out early to themselves | this is still a double-spend, and it drains the cover genuine victims would get. Claims are first come, first served; a delayed, pro-rata claim queue would fix it (not in v1). Treat the coverage figure as a ceiling, not a guarantee |
| Stale proof of funds | the bond was spent on other victims after the proof | the proof is "as of" a block; older than 7 days is flagged; ask for a fresh one for large amounts |
| Proof from a lying node | | the node is trusted for nothing: the proof is checked against the **pinned** validators (more than 2/3 of their power). A stale pin (validator set changed) fails "not verified" |
| Validators collude (more than 2/3) | they could certify a fake block | the same trust as the chain itself |
| Cash key stolen (device and passphrase) | the thief signs your notes away | encrypted at rest; auto-lock after 15 minutes; cash big notes quickly |
| Issuer reclaims after `lockUntil` | uncashed notes are gone | not fraud. Wallets refuse or warn near `lockUntil` (3 days) |
| Relay changes the payout or the fee | impossible | both are signed by the holder (the terminal) |
| Relay censors or delays | the note waits | send through several relays (multi-path); anyone can submit |
| Replay on another chain or contract | refused | `DOMAIN` binds the chain id and the contract into every hash |
| Replay of a cash-out or claim | refused | `spentBy` / `forkPaid` records; `AlreadyPaid` |
| Frame forgery or corruption | dropped | CRC-16 per frame; the packet must hash to its id; signatures inside |
| Quantum attacker | | every note signature is ML-DSA-44. The relayer's EVM tx is ECDSA, but it moves no note value |
| Privacy | the chain of keys and the amounts are visible to every later holder, and on chain at cashing | notes are not private; use fresh holder keys |

## 7. Legal note: radio

Amateur (ham) radio rules in many countries forbid traffic for business or payment, and forbid encryption or
obscured meaning. Examples are the US (47 CFR §97.113 and §97.113(a)(4)), the UK and much of the EU, and Thailand's
amateur licence conditions. Signed payment frames are financial traffic, so **do not send them on amateur bands.**

LoRa / Meshtastic on licence-free ISM bands (for example 433, 868, 915 or 920–925 MHz, depending on the country) is
allowed within local duty-cycle and power limits. Check your own country's rules. SMS, QR codes, files, Bluetooth and
the internet have no such limit.

## 8. Limits of this prototype

- **The results proof is tested only against a mocked CometBFT**, using real contract logs and real ML-DSA-44
  validator keys. It has not yet been run against a devnet. The protobuf layout follows `cosmos/evm`'s
  `MsgEthereumTxResponse` (logs as hex strings), and the leaf follows CometBFT's deterministic `ExecTxResult`.
- **The attestation fallback is a format and verifier only.** No validator service signs attestations yet.
- **No change and no splitting.** A note is spent whole; pay with several denominations.
- **A swap-received note can only be settled, not passed on, in v1.**
- **Gas.** Each link costs one ML-DSA precompile call plus about 3.8 KB of calldata. The contract caps chains at 64
  links.
- **Notes are native ZETAPHY only.** No ERC-20 notes.
- **The hub's cash key cannot be exported yet.** Back up the notes' text instead. The CLI's
  `~/.zetaphy/cash.seed` can be encrypted with `ZETAPHY_PASSPHRASE`.

## 9. Tests

| Package | Test | What it covers |
|---|---|---|
| `zetaphy-network` | `test/offlinecash.test.js` | issuing, the bond rules, chains of hand-overs and cashing through a relay, replay and old chains, a double-spend by the issuer (paid from the issuer bond) and by a later holder (paid from the holder bond; none or partial), victims down a paid branch, `lockUntil` / `reclaim` / the claim window, holder bonds, swap tickets (atomic; legs alone refused; expiry), domain separation. Real ML-DSA-44 in the in-memory EVM. |
| `zetaphy-network` | `test/offlinecash-proof.test.js` | proofs built from a mocked CometBFT (real logs, real validator keys), verified offline. Tampering, 2 of 4 versus 3 of 4 signers, the attestation fallback, coverage, stale proofs, the receive check. Format round trips, and the SHA-256 / Merkle / header-hash ports against `pqcert.js`. |
| `zetaphy-network` | `test/mesh.test.js` | base45 / base32 vectors, packets, frame sizes per medium, reassembly with loss, reorder, duplicates, corruption and interleaving, multi-path relays on a real contract (first lands, second `landed-elsewhere`), deadlines, the size table in this file, the hub copy. |
| `zetaphy-hub` | `test/cash.test.mjs` | the words in 8 languages, the logic with the wallet bundle's crypto, calldata against ethers, Mesh packets, the cleaned state, the build and the offline shell. |
| `zetaphy-hub` | `test/cash.e2e.mjs` | in Chromium under the real CSP, with the network off: key, receive and check a note, Mesh frames back in out of order, sign it over. |
