# Private identity on ZETAPHY: zero-knowledge proofs over the human labels (testnet)

[ภาษาไทย](zk-identity.th.md)

**Testnet / prototype only. Nothing with real money. The trusted setup is a single-party DEV setup. Groth16 on BN254
is not post-quantum.** Read §7 and §8 before relying on any of it.

A labelled person (passkey-verified `LabelRegistry` HUMAN, optionally a vouched unique human of `VouchRegistry`,
[agents.md §25](agents.md)) can prove:

- **"I am a labelled person"**: my identity is in the registry's tree;
- **"I act once here"**: one nullifier per person per *scope* (an airdrop id, a poll id), so a second claim or vote is
  refused, while two scopes see unrelated nullifiers (**unlinkable across apps**);
- **"my level is at least X"**: 1 = passkey person, 2 = vouched unique person;
- **bound to a signal** (the airdrop recipient and relayer fee, the poll option) so a proof seen in the mempool cannot
  be redirected;

without revealing which account, passkey or identity is theirs. Age or other issuer credentials are an extension
(§10), not built.

| Piece | Where |
|---|---|
| Circuit (circom 2, depth 20, 5,585 constraints) | `zetaphy-network/zkid/circuits/identity.circom` |
| Tooling: compile, DEV setup, verifier export, fixtures, benchmark | `zetaphy-network/zkid/setup.js`, `lib.js`, `BENCH.json` |
| Poseidon generator (browser JS + Solidity from circomlib's constants) | `zetaphy-network/zkid/gen-poseidon.js` |
| Contracts | `PoseidonT3.sol` (generated), `ZkIdentityRegistry.sol`, `ZkIdentityVerifier.sol` (generated, DEV), `PrivateAirdrop.sol`, `PrivatePoll.sol` |
| Hub: "Private identity" card in the Agents tab (8 languages, CSP-safe) | `zetaphy-hub/zkid.js`, `zkid-core.js`, `zkid-poseidon.js`, `zkid-worker.js`, `zkid-i18n.js`, `zkid/` (prover files + manifest) |
| Tests | `zetaphy-network/zkid/test/circuit.test.js`, `zetaphy-network/test/zkid.test.js`, `zetaphy-hub/test/zkid.test.mjs`, `zetaphy-hub/test/zkid.e2e.mjs` |
| CI | `.github/workflows/zkid.yml` (checks only; never makes a new key) |

Nothing is deployed yet. The hub reads `contracts.zkIdentityRegistry` and `contracts.privateAirdrop` from
`hub-config.json` or lets the user type them.

---

## 1. Design

**Identity.** Two random field elements made in the browser: `secret`, `nullifierKey` (31 random bytes each, below
the BN254 scalar field). Stored in this browser's `localStorage` (`zetaphy-hub:zkid`), exportable as an encrypted
backup (PBKDF2-SHA-256, 600,000 rounds → AES-256-GCM, a JSON file). Never sent anywhere.

```
commitment C = Poseidon(secret, nullifierKey)        registered on chain, reveals nothing
leaf         = Poseidon(C, level)                     level 1 passkey person, 2 vouched unique person
nullifier    = Poseidon(nullifierKey, scope)          one per person per scope
```

Poseidon is circomlib's Poseidon(2) (BN254, t = 3, 8 full + 57 partial rounds). The same function exists three times,
generated from the same constants and tested against each other: in the circuit (circomlib), in the browser
(`zkid-poseidon.js`, BigInt) and on chain (`PoseidonT3.sol`, straight-line EVM assembly, ≈ 45 k gas per hash).

**The tree** (`ZkIdentityRegistry`): a Poseidon Merkle tree of depth 20 (≈ 1 M members) kept **on chain**, every node
stored, so leaves can be updated and removed (empty = 0, empty subtrees = `zeros[h]`). `leavesRange(from, count)`
returns the leaves; the browser rebuilds the tree locally and finds its own leaf **locally** (the RPC node is asked for
all leaves, never for one commitment).

**Registration** (`register(C)`, from the labelled account): the registry reads `LabelRegistry.labelOf(sender) == HUMAN`
and the level from `VouchRegistry.levelOf` (1 if none is set). Binding rules, against making many identities from one
label:

- an **account** keeps its first commitment forever (it can come back with it after a removal, never with another);
- a **passkey** (`credentialHash`) is bound forever to the first commitment registered with it: if the passkey moves to
  another account, that account can carry the **same** commitment (same nullifiers), never a new one;
- a **commitment** is active for one account at a time (a copied commitment is refused while its holder is a member).

**Sync** (`sync(account)`, anyone): sets the leaf to the account's level now: up after vouching, down after a ban or a
suspension, **removed** (leaf 0) when the label expired, was revoked, or the passkey moved or is bound to another
identity. A keeper (or any user) calls it; until then the old leaf stays provable.

**Roots history.** Every change makes a new root; a replaced root stays valid for `rootTtl` (governance, e.g. 1 hour),
so proofs in flight survive new registrations. The current root never expires.

**Scopes.** Apps claim their scopes in the registry (`registerScope`, first come first served), so two apps never share
a nullifier space by accident. `PrivateAirdrop` takes its scope at construction; `PrivatePoll` one per poll.

**The circuit** (public signals in this order: `root, nullifier, scope, signalHash, minLevel`):

1. `C = Poseidon(secret, nullifierKey)`, `leaf = Poseidon(C, level)`;
2. the leaf and a 20-level path (binary indices) hash to `root`;
3. `nullifier = Poseidon(nullifierKey, scope)`;
4. `level ≥ minLevel` (both 8-bit range-checked);
5. `signalHash²` is computed, so the signal is part of the proven statement.

**Verification** (`ZkIdentityRegistry.verify(root, nullifier, scope, signalHash, minLevel, proof[8])`): the root must
be current or recent, `minLevel ≥ 1`, then the Groth16 verifier. The **app** supplies scope, signal and minLevel from
its own state; the prover chooses none of them.

**Apps.**

- `PrivateAirdrop(registry, scope, minLevel, amount)`: `claim(recipient, fee, root, nullifier, proof)` pays `amount − fee`
  to `recipient` and `fee` to the sender, once per nullifier. `signal = keccak256(recipient, fee) >> 8`: anyone (the
  person from a fresh address, or a relayer) can submit it; nobody can change where the coins go or the fee.
- `PrivatePoll`: `createPoll(scope, questionHash, options, minLevel, endsAt)`, `vote(scope, option, root, nullifier,
  proof)` with `signal = keccak256(scope, option) >> 8`. Tallies are public as votes arrive.

**Hub (Agents tab → "Private identity").** Create identity → *Register with my account* (a transaction from the
labelled account, through the hub's pre-sign summary) → *Make the proof* for the test airdrop: reads scope, minLevel
and the signal for the typed recipient, rebuilds the tree, checks the nullifier is unused, downloads the prover files
(`zkid/identity.wasm` 1.8 MB, `zkid/identity.zkey` 3.3 MB) and refuses them unless their sha256 matches
`zkid/manifest.json`, proves in a **Web Worker** (`zkid-worker.js`), then offers *Send the claim from the connected
wallet* (with a warning that this links the claim to that account) and the calldata for any relayer.

**CSP.** The hub's pages keep `script-src 'self'` without WebAssembly. Only `zkid-worker.js` is served with its own
CSP (`script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'`); a dedicated worker gets the CSP of its own script, so
the WebAssembly prover runs there and nowhere else (checked in Chromium by `zkid.e2e.mjs`). snarkjs comes from the
pinned `vendor/snarkjs.min.js` (0.7.6, sha256 in `vendor/snarkjs.json`), loaded with `importScripts` from the same
origin.

## 2. Privacy guarantees

What a proof reveals: the root (which tree state), the nullifier for this scope, the scope, the signal, `minLevel`.

- **Who** among the members of that root with level ≥ minLevel made it: hidden (zero-knowledge; the anonymity set is
  those members).
- **Linking across scopes**: nullifiers of different scopes are Poseidon outputs under a secret key; without
  `nullifierKey` they look unrelated. An airdrop and a poll cannot tell they saw the same person.
- **Linking to the label**: the commitment is a hash of two secrets; the registration shows *that* an account joined,
  not which later proofs are its.

## 3. What it does NOT protect

- **Network metadata.** The RPC node and the relayer see the IP address and the timing of requests and transactions.
  Use a different network path (Tor, a VPN) and don't claim right after registering.
- **The sender of the transaction.** Claiming from the account that registered (or one funded from it) links them.
  Use a fresh address funded elsewhere, or a relayer (the fee is bound in the proof).
- **Small anonymity sets.** With few members, or few at level 2, "one of them" is not much. `minLevel 2` also reveals
  that you are level 2. Timing of a `sync` (level change) followed by a proof can narrow it further.
- **Recipient reuse.** Sending several airdrops to the same address links them by that address.
- **The browser.** The secret sits unencrypted in `localStorage`. Malware, a browser extension with page access, or
  anyone using the browser profile can copy it and act as you. The encrypted backup is only as strong as its password.
- **Transferability.** An identity is a bearer secret: it can be given or sold, and a bot can use a human's identity.
  The registry proves a labelled person *registered* it, not that this person is the one proving now.
- **Public facts.** That an account is labelled human, its passkey hash, its level and that it registered are public.
- **Partial tallies.** `PrivatePoll` shows tallies as votes arrive (no commit-reveal, no anti-coercion; MACI-style
  designs address that).

## 4. Anti-Sybil analysis

The proof is **exactly as Sybil-resistant as the admission rule** (the human label and, for level 2, the vouches). The
zero-knowledge layer adds no uniqueness and must not lose any; the binding rules make sure one label carries one
identity:

| To get another identity (another nullifier per scope) the attacker needs | Level 1 | Level 2 |
|---|---|---|
| a new account | yes | yes |
| a new passkey (credential hash never registered) | yes: cheap (anyone can create many passkeys, or use an attester) | yes |
| new vouches from N vouched unique people (rate-limited, strikes on ban) | – | yes: expensive, visible on chain |

- Moving a passkey to a new account, or re-registering after a removal, gives back **the same** commitment (same
  nullifiers) or nothing.
- Copying someone's public commitment from another labelled account is refused while its holder is a member; after the
  holder leaves, the copier only gets a leaf whose secret it does not know (useless to it, but it does keep a leaf alive
  for the real owner — the "lending" case below).
- **Remaining attacks**: many passkeys + many accounts at level 1 (level 1 is a speed bump: apps that care should use
  `minLevel 2`); bought or colluding vouches at level 2 (bounded and traceable, see agents.md §25); renting or selling
  identities (inherent to any bearer-secret scheme, Semaphore and World ID included); a removed member keeps proving
  until someone calls `sync` and `rootTtl` passes; front-running a registration with the same commitment (griefing:
  the victim makes a new identity; the attacker burns an account and a passkey). A registration-time proof of knowledge
  of the commitment's preimage bound to `msg.sender` would remove the last one (future work).
- **Governance** can change the VouchRegistry and `rootTtl`, and controls attesters and bans in the label contracts:
  it can change who counts as a person, but never learn who proved what.

## 5. Benchmarks (measured)

Node 22 on a 4-core Intel Xeon @ 2.8 GHz (`zetaphy-network/zkid/BENCH.json`); browser = Playwright's headless Chromium
on the same machine; gas from the in-memory EVM (Cancun) in `test/zkid.test.js`.

| Item | Value |
|---|---|
| Circuit | 5,585 constraints (depth 20), compile 3 s |
| Prover files | `identity.wasm` 1.79 MB, `identity.zkey` 3.30 MB |
| Proof | 256 bytes (Groth16) + 5 public signals = 416 bytes; a `claim` call = 388 bytes of calldata (scope, signal and minLevel come from the contract) |
| Prove, node, single thread | median 2.09 s (2.00–2.23 s, n = 10) |
| Prove, node, multi-thread | 0.77 s |
| Prove, browser (Chromium, Web Worker, single thread) | 2.5 s (+ file download and sha256 check) |
| Phones (estimate, not measured) | 3–6× slower: ≈ 6–15 s |
| Verify, JS | 21 ms |
| `ZkIdentityRegistry.verify` (Groth16, pairing precompiles) | ≈ 219 k execution gas |
| `PrivateAirdrop.claim` | ≈ 309 k execution gas (+ 21 k + calldata) |
| `PrivatePoll.vote` | ≈ 275 k execution gas |
| `ZkIdentityRegistry.register` | ≈ 1.63 M execution gas (20 Poseidon hashes at ≈ 45 k + 20 new storage slots) |
| `PoseidonT3.poseidon` | ≈ 45 k gas per hash |
| DEV setup (groth16 setup + 1 contribution + verify) | 35 s |

Registration is expensive because the whole tree is stored on chain (so updates and removals need no witness). Cheaper
paths: a tighter Poseidon (≈ 20 k gas), storing only the frontier and taking update paths from the caller, or batching.

## 6. Comparison

| | ZETAPHY private identity | Semaphore (v4) | World ID | Polygon ID / Privado ID | zkPassport |
|---|---|---|---|---|---|
| Who may join | a passkey-labelled person; level 2 = vouched by unique people | whoever the group admin admits | a person scanned by an Orb (iris) | anyone an issuer gives a credential | a holder of an NFC e-passport / ID card |
| Uniqueness source | labels + web of trust (weak at level 1, moderate at 2) | none of its own | iris uniqueness (strong), one company's hardware | the issuer's checks | the government document (strong per document) |
| Proves | membership, level ≥ X, one nullifier per scope, bound signal | membership, nullifier per scope, message | personhood + nullifier per action (Semaphore-based) | selective claims (age ≥ X, country …) over issuer-signed credentials | document validity + attributes (age, nationality) |
| Proof system | Groth16 / BN254 | Groth16 / BN254 (PSE ceremony) | Semaphore Groth16 | Groth16 (iden3 circuits) | Noir/UltraHonk-style SNARKs (and others) |
| Trusted setup | **DEV, single party** (to be replaced) | public multi-party ceremony | public ceremony | public ceremony | universal / circuit-specific |
| Post-quantum | no (§8) | no | no | no | no (also RSA/ECDSA document signatures) |
| Personal data | none (no biometrics, no documents) | none | iris codes (hashed, operated by World) | held by the issuer and the holder | read from the document on the device |

The design is Semaphore's pattern with a different admission rule (on-chain human labels, levels in the leaf), the
tree on ZETAPHY, and scopes registered per app.

## 7. Trusted setup (DEV) — read this

- **Phase 1** is public: the Perpetual Powers of Tau, contribution 0080 (80+ contributors), the same pinned file Neuro's
  zkML uses (`zetaphy-neuro/ml/onchain/zk/ceremony/phase1.json`, sha256 + blake2b checked).
- **Phase 2 is one contribution by one machine** (`setup.js`, random entropy, then forgotten). Whoever ran it could
  have kept the entropy and could then **forge proofs**: fake members, any level, unlimited nullifiers — drain an
  airdrop, stuff a poll. It does **not** let them deanonymize honest proofs.
- The verifier says so: `DEV_SETUP = true`, `ZKEY_SHA256` = sha256 of the zkey the hub ships; the hub refuses prover
  files whose sha256 differs from its manifest.
- **Before mainnet**: a public multi-party phase-2 ceremony for this circuit (one honest contributor suffices), with a
  transcript, a public beacon and in-browser contributions — the same tooling pattern as Neuro's zkML ceremony
  (`zetaphy-neuro/ml/onchain/zk/ceremony/`, `zetaphy-hub/ceremony.html`), as a separate transcript for this circuit.
  The verifier, the hub files and the fixture are then regenerated from the final zkey.

## 8. Post-quantum status and roadmap

**Groth16 on BN254 is not post-quantum.** A large quantum computer (Shor) computes discrete logarithms on BN254, which
lets it recover the setup's trapdoor and **forge proofs**, i.e. break soundness (fake claims, extra votes).
Privacy is in better shape: Groth16 proofs are perfectly zero-knowledge and commitments/nullifiers are Poseidon hashes,
so recorded proofs do not become linkable later ("harvest now, deanonymize later" does not apply to the proofs; network
metadata still does).

**PQ path: a STARK membership proof** (hash-based, transparent: no trusted setup at all).

- Statement: the same (leaf in a Merkle tree, nullifier, level, signal), with a STARK-friendly hash whose security is
  post-quantum (Poseidon2 or Rescue-Prime over a STARK field, or SHA-256/BLAKE3 at a higher cost) for both the tree and
  the FRI commitments.
- Size of the computation: 23 hash permutations (20 path + commitment + leaf + nullifier) — a trace of a few hundred
  rows, far smaller than the block-finality statement of the repo's STARK light-client prototype (branch
  `worktree-agent-a638e15c9a3e64d32`, `docs/future/stark-light-client.md`), which proves an n = 100 validator set
  in a **44 KB** proof, 0.42 s prove (JS), ≈ 20 ms verify (node and browser).
- Estimates from those measurements: **proof ≈ 40–80 KB** at the prototype's default parameters (≈ 100 conjectured
  bits; ≈ +40 KB for the 60-query PQ-hardened preset), **prove ≈ 1–3 s in the browser** with the repo's JS BigInt prover
  (≈ 0.1–0.5 s with a WASM Plonky3/Stwo prover), **verify ≈ 20–60 ms** off chain, and **≈ 1.5–2.5 M gas** for an EVM
  verifier (calldata ≈ 0.6–1 M of it) versus ≈ 0.22 M for Groth16 today. Wrapping the STARK in a pairing SNARK would be
  cheaper on chain but not post-quantum.
- Migration: a new tree with the STARK-friendly hash (the identity secrets can stay; each member re-registers a new
  commitment from the same `nullifierKey`, and apps switch verifiers at a scope boundary so nullifiers stay unique
  per scope), a transition period accepting both, and the Groth16 verifier retired when quantum risk becomes concrete.

## 9. Tests (run)

- `zetaphy-network/zkid`: `npm test` → `test/circuit.test.js` (6): the shipped wasm/zkey match the manifest and the
  Solidity verifier carries the same key; the generated Poseidon copies are up to date; a valid proof verifies and its
  public signals are what the JS computes (level-1 and level-2 members); changing any public signal (scope, signal,
  minLevel, root, nullifier; another recipient) fails verification; wrong root, nullifier for another scope, swapped
  scope, level below minLevel, a claimed higher level, a non-member (even with a member's path) and a non-binary path
  index cannot be proven; one nullifier per scope, different across scopes; a removed leaf proves nothing.
- `zetaphy-network`: `npm test` (all) incl. `test/zkid.test.js` (11): PoseidonT3 = JS = circomlib's vector; the
  verifier is the hub's DEV key; registration only for labelled humans, levels from VouchRegistry, tree = JS tree;
  account / passkey / commitment binding (passkey moved to another account); `sync` up, out, expiry; roots history
  (old root valid within `rootTtl`, refused after); airdrop: valid claim, **double claim refused**, other recipient /
  tampered proof / wrong root / wrong nullifier refused, relayer fee bound; scopes unique; `minLevel 2` enforced by the
  contract; poll: one vote per person, option bound, tallies, deadline; `verify` refuses minLevel 0 and unknown roots.
- `zetaphy-hub`: `npm test` incl. `test/zkid.test.mjs` (9): Poseidon vector, identities, tree/paths, proof words,
  selectors and calldata vs ethers, the encrypted backup (round trip, wrong password, tampered file), 8 languages with
  placeholders, prover files vs manifest, the CSP split. `npm run test:e2e` incl. `test/zkid.e2e.mjs` (Chromium with the
  site's CSPs, real contracts in an in-memory EVM): create, export / forget / import the backup, register, **prove in
  the browser**, claim to a fresh address, second claim refused, Thai, no sideways scroll at 375 px.

Regenerate everything (new DEV key): `cd zetaphy-network/zkid && npm ci && node setup.js` (then `npm run build` in
`zetaphy-network` and commit the verifier, the hub files, the fixture and `BENCH.json` together).

## 10. Extension (not built): issuer credentials, e.g. "age ≥ 18"

- An issuer (a registered key on chain, e.g. a KYC provider or a university) signs, with **EdDSA-Poseidon on
  BabyJubJub**, a credential `cred = Poseidon(holderId, attributeType, value, expiry)` where
  `holderId = Poseidon(nullifierKey, 1)` ties it to the identity (so it cannot be lent apart from the identity).
- The circuit adds circomlib's `EdDSAPoseidonVerifier` (≈ 5–7 k constraints), checks the issuer key against a public
  issuer-key hash, `value ≤ today − 18 years` with `today` public and range-checked, and `expiry > today`; revocation
  through an issuer-run revocation tree (a second non-membership path) or short expiries.
- Size: ≈ 12–14 k constraints → zkey ≈ 7–8 MB, browser prove ≈ 5–6 s, same verify gas (one more public signal).
- Personal data: the birth date stays with the issuer and the holder; the chain and the app see only "≥ 18 per issuer
  X". Not built here because it needs an issuer flow and a BabyJubJub EdDSA signer in the browser, and an issuer is a
  party that does hold personal data.

## 11. What remains

- Deploy on testnet and list the addresses in the hub config; a keeper that calls `sync` for expired labels.
- The public phase-2 ceremony (§7); then remove `DEV_SETUP`.
- Registration proof of knowledge (anti front-running), cheaper registration (§5), a relayer service (no always-on
  server: volunteer runners).
- Issuer credentials (§10); the STARK path (§8).
