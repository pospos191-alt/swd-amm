# ZETAPHY as a quantum-safe settlement layer

**Testnet only.** No real money. None of the contracts here has been audited. Q-day is a planning problem, not a
date: this document says what is protected now, what is still classical, and what we would do on the way.

The goal: value held on ZETAPHY stays safe on "Q-day" (the day a quantum computer can derive a secp256k1, Ed25519 or
P-256 private key from its public key), and ZETAPHY is a place users of other chains can move to before that day.

| Piece | State | Where |
|---|---|---|
| ML-DSA-44 accounts, ML-DSA vote keys, PQ block certificates, quantum lock | **implemented** (earlier work) | `zetaphy-chain`, [chain-protocol.md](chain-protocol.md), [SECURITY-CORE.md](../SECURITY-CORE.md) |
| Chain Q-day rule (ECDSA refused from a voted height, unmigrated accounts frozen, commit–reveal for never-used keys) | **implemented** (earlier work) | `zetaphy-chain` ante handler, `gov.sh qday`, `zetaphy security …` |
| Quantum-exposure inventory, readiness score | **implemented** | `zetaphy-network/src/qsafe/inventory.js`, `zetaphy qsafe inventory`, hub "Quantum" tab |
| `QuantumRescue`: hash pre-commitment today, ML-DSA reveal after Q-day, escrow, QDayGuard view | **implemented** (contract) | `zetaphy-network/contracts/QuantumRescue.sol`, `src/qsafe/rescue.js` |
| `MsgQDayRescue`: the chain honours a QuantumRescue reveal as a quantum lock of the whole account | **designed** (section 4.3) | — |
| ZK-of-seed recovery (prove the BIP-32 seed behind an exposed key) | **designed** (section 4.5) | builds on the STARK light-client work |
| `PQSettlement`: batch netting authorised only by ML-DSA signatures | **implemented** (contract) | `contracts/PQSettlement.sol`, `src/qsafe/settlement.js` |
| `PQMultisigIsm`: Hyperlane ISM with ML-DSA validator attestations | **implemented** (contract, ZETAPHY destination) | `contracts/PQMultisigIsm.sol`, `src/qsafe/pqism.js` |
| STARK-wrapped attestations for destinations without ML-DSA (Ethereum, BNB) | **designed** (section 6.2) | — |
| Hub "Quantum safety" tab (8 languages) | **implemented** | `zetaphy-hub/quantum*.js` |

## 1. Threat model

**What a quantum computer breaks.** Shor's algorithm solves the discrete logarithm on elliptic curves and factors
RSA. With a large enough fault-tolerant machine, every secp256k1 (Ethereum, Bitcoin, Cosmos `eth_secp256k1`), Ed25519
(CometBFT, IBC light clients), P-256 (passkeys, TLS certificates) and BN254 (Groth16, KZG) key can be recovered **from
its public key**. Hashes (SHA-256, Keccak) and symmetric ciphers (AES-256) lose about half their bits to Grover's
algorithm and stay usable at today's sizes. ML-DSA (FIPS 204), ML-KEM (FIPS 203), SLH-DSA (FIPS 205) and hash-based
signatures are designed to resist both.

**Two different dangers.**

1. **Exposed signing keys (the main risk for value).** An account is exposed once its public key is public: on
   Ethereum-style chains that happens with the first signed transaction (the public key is recoverable from the
   signature); on Cosmos chains the public key is stored with the account. An unused address hides its key behind a
   hash, which a quantum computer cannot invert, so "never signed" accounts are much safer than "used" ones. Signatures
   do **not** have a harvest-now problem: an old signature cannot be "decrypted"; the danger is that new signatures
   can be forged once the key is derived.
2. **Harvest now, decrypt later (HNDL).** Encrypted traffic recorded today (TLS, peer-to-peer links, encrypted
   mempools) can be decrypted once the key exchange is broken. On a public chain most data is public anyway; the
   rows marked HNDL in the inventory are where privacy (not funds) is at stake: pending transactions, RPC sessions,
   node identities.

**The timeline is uncertain, and we say so.** No machine today can break a 256-bit elliptic-curve key. Public
resource estimates keep falling (for example Gidney's 2025 estimate of factoring RSA-2048 with under a million noisy
qubits in under a week; elliptic-curve keys of 256 bits need fewer logical qubits than RSA-2048). Government guidance
(NIST IR 8547 draft: deprecate quantum-vulnerable signatures by 2030, disallow by 2035) plans for the 2030s.
Expert surveys spread from "within 10 years" to "never at this scale". A protocol cannot pick the right year; it can
(a) make the safe path available long before, (b) let governance set Q-day with notice, and (c) keep an emergency
path that does not depend on the classical key.

**Attacker we design for.** After Q-day: can derive any exposed classical private key (in hours, so a reveal in the
mempool is a race), sees the mempool, can run nodes and relayers. Before Q-day (the dangerous window): may already be
able to break **some** keys slowly and secretly. Cannot break ML-DSA, SHA-256/Keccak, or forge a STARK.

## 2. Quantum-exposure inventory

Every classical-crypto dependency of the stack, its Q-day risk, today's mitigation and the migration step, kept as
data in `zetaphy-network/src/qsafe/inventory.js`. `test/qsafe-inventory.test.js` checks every row (fields, statuses,
that each referenced repo path exists) and that the table below is exactly what the file generates. Status: **pq**
(post-quantum only), **hybrid** (classical and PQ together, safe if either holds), **partial** (a PQ path exists but
classical keys still guard part of it), **classical**. HNDL = recorded data could be read later.

**Readiness score: 46/100** (impact-weighted: critical 5, high 3, medium 2, low 1; credit pq 1, hybrid 0.8, partial
0.4, classical 0). `zetaphy qsafe inventory` prints it with the open rows; the hub's Quantum tab shows it. The score
is meant to be uncomfortable: it moves only when a row's status honestly changes.

<!-- qsafe-inventory:begin (generated from zetaphy-network/src/qsafe/inventory.js; do not edit by hand) -->
| id | Component | Crypto | Status | Q-day impact | HNDL | Today | Migration |
|---|---|---|---|---|---|---|---|
| `consensus-votes` | CometBFT block votes | Ed25519 + ML-DSA-44 vote extensions | hybrid | critical | no | Every vote carries an ML-DSA-44 signature; block H+1 carries the ML-DSA certificate of H (MsgPQCertificate), checked by every node and by `zetaphy pq verify-block`. | Keep >2/3 of voting power registered (gov.sh vote-key); refuse to run Q-day while it is lower. |
| `double-sign-evidence` | Double-sign evidence and slashing | Ed25519 | partial | high | no | gov.sh pq-evidence on: no slashing on Ed25519 evidence alone for validators with an ML-DSA key (off by default). | Vote pq-evidence on with the Q-day proposal; ML-DSA evidence needs the round in CometBFT's PQ signing (upstream). |
| `validator-remote-signer` | Validator key and remote signer (horcrux) | Ed25519 (threshold) | partial | medium | no | The PQ certificate rule needs the separate ML-DSA vote key (config/pq_vote_key.seed). | Back up and rotate pq_vote_key.seed with the validator key; native ML-DSA consensus keys when CometBFT supports them. |
| `p2p-transport` | CometBFT peer-to-peer links | X25519 + Ed25519 node keys (SecretConnection) | classical | medium | yes | Sentry topology; blocks are PQ-certified, so a fake peer cannot feed a forged chain to a node. | Hybrid X25519+ML-KEM-768 handshake upstream, or validator links over WireGuard with a post-quantum pre-shared key until then. |
| `evm-accounts` | secp256k1 accounts (MetaMask, Cosmos eth_secp256k1) | secp256k1 ECDSA | partial | critical | no | Q-day rule refuses ECDSA from a voted height; quantum lock to an ML-DSA-44 account; commit–reveal for never-used keys; QuantumRescue pre-commitments for used keys; explorer exposure page. | Lock or pre-commit now (hub "Quantum safety" tab); governance schedules Q-day months ahead; MsgQDayRescue (designed) turns rescues into locks. |
| `native-pq-accounts` | Native ML-DSA-44 accounts | ML-DSA-44 (FIPS 204) | pq | critical | no | Cosmos txs signed with ML-DSA-44 only; MsgEVMCall gives them the whole EVM. | Done. Consider ML-DSA-65 for long-lived treasuries. |
| `validator-operators` | Validator operator accounts | secp256k1 ECDSA | partial | high | no | gov.sh quantum-lock; the controller manages the validator through MsgEVMCall as_owner and MsgPQVoteKey validator_owner. | All operators locked before the Q-day vote. |
| `contract-ecrecover` | Signatures checked inside contracts (permit, cheques, offline orders, EIP-712) | secp256k1 ecrecover | partial | high | no | From Q-day the chain makes ecrecover return no address (fails safe: the feature stops). | PQ variants: PQSettlement for payments, QuantumWallet for actions; ML-DSA-signed cheques/orders next. |
| `passkeys-p256` | Passkeys (WebAuthn, P-256 precompile 0x…0100) | P-256 ECDSA | classical | medium | no | The chain disables P-256 verification at Q-day (fails safe); passkeys are second factors next to ML-DSA in AgentPolicyWallet. | Wait for PQ WebAuthn (FIDO ML-DSA); keep ML-DSA as the primary key. |
| `frost-cosign` | FROST threshold Schnorr (agent co-signing) | secp256k1 Schnorr | classical | medium | no | Used as an extra check next to the owner's key, not alone. | ML-DSA threshold (or t-of-n ML-DSA multisig like PQMultisigIsm). |
| `zk-groth16` | Groth16 proofs (NeuroScore zk, trusted-setup ceremony) | BN254 pairings | classical | medium | no | Proofs gate scores and optional features, not custody. | Hash-based STARK proofs (the STARK light-client work), FRI verifiers on ZETAPHY. |
| `governance-signers` | Timelock and multisig signers | secp256k1 ECDSA (EOA owners) | partial | critical | no | Owners can be QuantumWallets or native PQ accounts (msg.sender = their 0x address); locked EOAs act through their controller. | Replace every EOA owner with a PQ account before Q-day; the inventory test keeps this row partial until then. |
| `ibc-light-clients` | IBC light clients (both directions) | Ed25519 (07-tendermint) | classical | high | no | IBC rate limits and the IBC hold (large inbound transfers wait, guardian can refund). | A client that checks ZETAPHY's ML-DSA certificates (08-wasm) or a STARK proof of them (STARK light client). |
| `ibc-relayer` | IBC relayer (Hermes) key | secp256k1 ECDSA | classical | medium | no | Q-day should not be scheduled while IBC depends on it (docs/SECURITY-CORE.md). | A relayer that signs with ML-DSA-44 (pqtx.js buildTx). |
| `hyperlane-ism` | Hyperlane ISM validators (Saphan bridge) | secp256k1 ECDSA multisig | partial | critical | no | BridgeAirlock quarantine, BridgeGuard caps, the chain's bridge breaker; PQMultisigIsm (ML-DSA validators) is ready for ZETAPHY-side delivery. | Aggregation ISM (ECDSA AND ML-DSA) inbound now, ML-DSA only at Q-day; outbound to chains without ML-DSA via a STARK-wrapped attestation. |
| `hyperlane-relayer` | Hyperlane relayer and agents' submit keys | secp256k1 ECDSA | classical | low | no | Relayers are untrusted for safety; small gas balances. | Submit through a native PQ account (MsgEVMCall) on ZETAPHY. |
| `remote-chain-custody` | Assets locked on Ethereum / BNB (lockboxes) | the remote chain's ECDSA | classical | high | no | Caps per route; inbound migration moves value to PQ accounts on ZETAPHY. | The "move to a PQ account on ZETAPHY" flow; remote admins behind PQ-signed (STARK-verified) governance. |
| `oracles` | Price oracles (Pyth relay, ZetaphyOracle reporters) | secp256k1 (Wormhole guardians, reporter EOAs) | classical | high | no | TWAP and bounds where used. | Reporters as PQ accounts; guardian-signed feeds only through a PQ attestation (pqattest.js style). |
| `pq-web-wallet` | ZETAPHY web wallet (ML-DSA-44 in the browser) | ML-DSA-44 | pq | high | no | Seeds sealed with scrypt + AES-256-GCM. | Done. |
| `snap` | ZETAPHY Snap (ML-DSA keys inside MetaMask) | ML-DSA-44 from SIP-6 entropy | pq | high | no | Recoverable from the MetaMask recovery phrase. | Publish after MetaMask review. |
| `injected-wallets` | MetaMask / injected EIP-1193 wallets in the dapps | secp256k1 ECDSA | classical | high | no | The hub warns per address (exposure), and offers lock / rescue. | Route signing through the Snap or the PQ web wallet; QuantumWallet for contract accounts. |
| `tls` | HTTPS for RPC, explorer, hub (TLS) | ECDHE (X25519) + ECDSA/RSA certificates | partial | medium | yes | Modern browsers and hosts already negotiate hybrid X25519MLKEM768 key exchange where both sides support it. | Require hybrid ML-KEM at our reverse proxies; PQ certificates when the Web PKI has them; wallets verify data, not TLS. |
| `mempool-privacy` | Pending transactions (mempool) | none (public) | classical | low | yes | Threat gate and wallet checks. | The ML-KEM encrypted mempool (another workstream). |
| `keys-at-rest` | Keys at rest (CLI seeds, wallet vaults) | scrypt + AES-256-GCM | pq | medium | yes | AES-256 (not AES-128) everywhere. | Done; keep passphrases long. |
| `release-integrity` | Node install and release integrity | SHA-256 pins (+ GitHub SSH/TLS) | hybrid | high | no | cloud-init.sh runs setup-node.sh only when its SHA-256 matches; content-addressed files. | Hash-based (SLH-DSA) release signatures when tooling supports them. |
| `pq-attestations` | Reports and AI attestations | ML-DSA-44 | pq | low | no | pqattest archives signed with ML-DSA. | Done. |
| `pq-settlement` | Settlement of payments (PQSettlement) | ML-DSA-44 | pq | critical | no | Only ML-DSA signatures move balances; batch digests settle once. | Deploy on testnet; stablecoins route through it. |
<!-- qsafe-inventory:end -->

**Related prototypes on other branches** (not duplicated here): the PQ encrypted mempool (`zetaphy-network/src/encmempool`,
ML-KEM: the `mempool-privacy` row), the STARK light client (`zetaphy-network/src/starklc`: the `ibc-light-clients`
and `zk-groth16` rows and sections 4.5 and 6.2 below), self-healing circuit breakers (`CircuitBreaker`: they pause a
bridge or market automatically, which is the first line of defence if forged signatures appear), and the immune network
and audit-as-a-service work (in progress).

## 3. What is protected today, and what is still classical

**Protected against a quantum attacker (on ZETAPHY):**
- funds of **native ML-DSA-44 accounts** (Cosmos txs signed with ML-DSA-44 only; `MsgEVMCall` gives them the EVM);
- **quantum-locked** secp256k1 accounts (`MsgQuantumLock`): the chain refuses their own ECDSA key; only the ML-DSA
  controller acts for them;
- contracts that authorise only through ML-DSA (`QuantumWallet` in PQ-only mode, `PQSettlement`, `QuantumRescue`
  reveals, `PQMultisigIsm`);
- **block finality**, as long as validators holding more than 2/3 of the voting power have registered ML-DSA vote
  keys: block H+1 carries the ML-DSA certificate of block H, checked by every node and by `zetaphy pq verify-block`.

**Still classical (see the inventory):** CometBFT's own Ed25519 votes and p2p links, IBC light clients in both
directions, the Hyperlane ISM and relayer keys on the remote side, MetaMask and every other injected wallet,
timelock and multisig signers that are EOAs, oracle reporters, TLS. Assets bridged in from Ethereum/BNB are only as
safe as the lockbox on the origin chain.

## 4. Q-day protocol

### 4.1 The chain rule (implemented earlier; recap)

Governance votes a height `QDAY` with notice (`gov.sh qday <height>` refuses heights closer than the minimum notice).
From `QDAY` the ante handler refuses every Ethereum tx (always ECDSA), accepts Cosmos txs only when every signer is
ML-DSA-44, and ignores ECDSA inside contracts' precompile paths. Accounts that are neither ML-DSA nor quantum-locked are
frozen: nobody can move them, including someone who forged a signature. Never-used keys can still migrate after
Q-day by commit–reveal (`MsgQDayCommit` / `MsgQDayReveal`). Details: [SECURITY-CORE.md](../SECURITY-CORE.md) §1.

**Preconditions governance should check before voting QDAY** (the inventory rows that block it):
1. more than 2/3 of voting power has ML-DSA vote keys and `pq-evidence on` is proposed with it (`consensus-votes`,
   `double-sign-evidence`);
2. validator operator accounts are quantum-locked (`validator-operators`), else governance stops after Q-day;
3. timelock / multisig owners are PQ accounts (`governance-signers`);
4. an ML-DSA IBC relayer and Hyperlane submitter exist, or IBC/Hyperlane are paused (`ibc-relayer`, `hyperlane-relayer`);
5. inbound Hyperlane routes verify ML-DSA attestations (`hyperlane-ism`);
6. users had months of warning in the wallet, Snap, explorer and hub (the Quantum tab shows QDAY).

### 4.2 Contract policy (implemented)

Contracts on ZETAPHY or on any EVM chain can follow the same rule without a chain upgrade:

- `QuantumRescue.qdayHeight()` is the earlier of the chain's Q-day (read from the security precompile `0x…0901
  qday()`) and a governance-set local height (for chains without the precompile; at least 100 blocks notice).
- `QuantumRescue.classicalTrusted(account)` is the **QDayGuard** check: before Q-day `true`; after it only if the
  chain says the account is migrated (quantum-locked), in which case the call can only have come from its ML-DSA
  controller via `MsgEVMCall as_owner`. A contract that pays out to `msg.sender` (escrows, vesting, bridge refunds)
  calls it and, when it says `false`, pays into the rescue escrow instead (`depositFor`), where only the rescued ML-DSA
  controller can claim.

### 4.3 Ante-handler change: honour rescues (designed)

The chain freezes exposed, unmigrated accounts. A `QuantumRescue` reveal proves that the account's owner bound an
ML-DSA key to it *while the ECDSA key was still trusted*. The design lets that proof unfreeze the account as a quantum
lock. It is not implemented in Go here: it needs a chain upgrade, an audit of the precompile read path and a
governance vote that names the rescue contract.

```go
// new message, signed by any ML-DSA-44 account (the relayer pays the fee)
type MsgQDayRescue struct { Signer string; Owner common.Address }

func (k Keeper) QDayRescue(ctx sdk.Context, m *MsgQDayRescue) error {
    p := k.GetParams(ctx)
    if p.RescueContract == (common.Address{}) { return ErrRescueOff }          // governance names the contract
    if !k.QDayActive(ctx) { return ErrQDayNotYet }
    if k.IsMigrated(ctx, m.Owner) || k.IsPQAccount(ctx, m.Owner) { return ErrAlreadyMigrated }
    // read QuantumRescue.controllerOf(owner) with a gas-capped static EVM call at the current state
    ctrl, err := k.evm.StaticCallAddress(ctx, p.RescueContract, "controllerOf(address)", m.Owner)
    if err != nil || ctrl == (common.Address{}) { return ErrNotRescued }
    // the controller is the native ML-DSA-44 address sha256("zetaphy/mldsa44\0"‖pk)[0:20]; it must exist
    // on chain with that key type (it signed at least once), so the lock points at a real PQ account
    if !k.IsPQAccount(ctx, ctrl) { return ErrControllerNotPQ }
    k.SetQuantumLock(ctx, m.Owner, ctrl)                                       // same state as MsgQuantumLock
    ctx.EventManager().EmitEvent(qdayRescueEvent(m.Owner, ctrl))
    return nil
}

// ante handler after QDAY: unchanged. An ECDSA-signed tx is refused; a locked owner moves only via its
// controller (MsgEVMCall as_owner), exactly as for MsgQuantumLock.
```

Why this is safe: the rescue commitment had to mature `maturity` blocks **before** QDAY, the reveal needs the
ML-DSA key and the secret, and the controller is derived from the revealed key (a relayer cannot redirect it).
Its residual risk is the general one: an attacker who can break a key long before QDAY can also commit (or cancel)
for it and wait. Setting QDAY early enough is what protects against that; `Committed` events let wallets alert
owners to commitments they did not make.

### 4.4 Rescue pre-commitment (implemented: `QuantumRescue.sol`)

1. **Today**, from the classical address: `commit(c)` with
   `c = keccak256(abi.encode("ZETAPHY QuantumRescue v1", chainId, contract, account, keccak256(pqPublicKey), secret))`.
   Only a hash is public; the ML-DSA key and the 32-byte secret stay offline (the "rescue kit").
2. A commitment counts `maturity` blocks later and only if it matured **before** Q-day. A newer commitment (or a
   cancel, `commit(0)`) replaces the old one only once it is mature, so an attacker who breaks the key shortly before
   Q-day cannot displace an older commitment.
3. **After Q-day**, anyone relays `reveal(account, pk, secret, sig)`: the contract recomputes `c`, checks the ML-DSA-44
   signature over `rescueDigest(account, controller)` through the precompile `0x…0900` (or accepts the controller
   sending it itself), and records `controllerOf[account] = sha256("zetaphy/mldsa44\0"‖pk)[0:20]`.
4. The **escrow** works today: protocol payouts to a frozen address go to `depositFor` / `depositTokenFor`; the
   rescued controller (or the account itself while `classicalTrusted`) claims them.

Hub: Quantum tab → "Rescue pre-commitment" (the browser makes the ML-DSA key with the wallet's own ML-DSA code).
CLI: `zetaphy qsafe rescue-kit <account> --contract <0x…>` (kit + `commit` calldata), after Q-day
`zetaphy qsafe rescue-reveal kit.json` (`reveal` calldata, relayable by anyone).

### 4.5 ZK-of-seed recovery (designed)

Most exposed accounts belong to HD wallets (MetaMask, hardware wallets): the private key is
`BIP32(PBKDF2-HMAC-SHA512(mnemonic), path)`. A quantum attacker can derive the **private key** from the public key,
but not the **seed**, because the derivation is hash-based. So after Q-day, an owner who still has the mnemonic
can prove ownership without any pre-commitment:

- public inputs: `address`, `controller` (the new ML-DSA-44 account), `chainId`;
- witness: mnemonic (or seed), derivation path;
- statement: `keccak256(pub(BIP32(seed, path)))[12:] == address`, with `controller` bound into the proof's transcript;
- proof system: a **STARK** (hash-based, so it stays sound against quantum attackers), the same family as the STARK
  light client prototype (`zetaphy-network/src/starklc`, on its own branch). Groth16/KZG would not do: they rely on
  pairings a quantum computer breaks.
- on chain: a `MsgQDaySeedRecover{owner, controller, proof}` verified by a STARK-verifier precompile, then the same
  `SetQuantumLock` as 4.3; a long challenge window (e.g. 30 days) during which a pre-commitment or an earlier seed
  proof for the same account wins.

Limits: it does not help accounts whose key was not derived from a seed (raw imported keys, some exchanges); the
proof is heavy (PBKDF2 with 2048 rounds of HMAC-SHA512 plus secp256k1 arithmetic in the circuit: minutes to hours
of proving on consumer hardware, done once); the verifier precompile needs its own audit. Ethereum researchers have
proposed the same emergency path for Ethereum.

## 5. PQ settlement: `PQSettlement.sol`

Accounts are ML-DSA-44 keys (`keyId = keccak256(publicKey)`); no ECDSA key can move anything in it.

- `deposit(keyId, token, amount)`: anyone funds a key (token `0` = native ZETAPHY; fee-on-transfer tokens are
  credited with what arrived).
- `settle(parties, payments, salt, deadline, sigs)`: many payments among up to 64 keys and 8 tokens in one tx. Every
  key that **pays** signs the same batch digest with ML-DSA (verified through `0x…0900`, the `QuantumWallet` path);
  the contract nets each key's position per token and moves only the net, all or nothing. Parties must be sorted and
  distinct, signatures in party order (each counts once).
- **Replay protection**: the digest binds chain id, contract, parties, payments, salt and deadline; a digest settles
  once (`settledAt`). Withdrawals use a per-key nonce.
- **Finality**: a batch settled in block H is final once the ML-DSA certificate of H (carried in H+1) verifies
  **and** the ML-DSA signers alone hold more than 2/3 of all voting power. Off chain:
  `settlementFinality({ height, verifyBlock })` in `src/qsafe/settlement.js` with `src/pqcert.js` `verifyBlock`
  (and pinned vote keys). On chain, `isFinal(digest)` only says a later block exists: it trusts the chain's own
  certificate rule, which every node enforces.

Use: exchanges, market makers and payment hubs net many payments per block among PQ keys, so their settlement does
not depend on any classical key. Limits: ML-DSA-44 signatures are 2,420 bytes and public keys 1,312 bytes, so a
batch with many payers is large; the on-chain netting is O(parties × tokens).

## 6. PQ bridge

### 6.1 Into ZETAPHY: `PQMultisigIsm.sol` (implemented)

Hyperlane's message-id multisig ISM trusts ECDSA validator signatures, which a quantum computer could forge from the
validators' public keys. `PQMultisigIsm` checks the same checkpoint (origin, merkle tree hook, root, index, message
id) signed with **ML-DSA-44** by `threshold` of a governance-set validator set (stored as key hashes; the keys ride in
the metadata, about 3.7 KB per signature). It works where ML-DSA is verifiable, i.e. **ZETAPHY as the destination**.
Transition: put it beside the ECDSA ISM in a Hyperlane aggregation ISM (both must pass) now; drop the ECDSA one at
Q-day. A relayer needs the metadata builder in `src/qsafe/pqism.js` (`moduleType()` is 0: no stock relayer builds it).

### 6.2 Out of ZETAPHY to chains without ML-DSA: STARK-wrapped attestations (designed)

Ethereum and BNB cannot verify ML-DSA cheaply. The route:
1. ZETAPHY validators (or the PQ ISM validator set) sign the outbound checkpoint with ML-DSA, as today for blocks;
2. a prover produces a **STARK** that "≥ threshold of these key hashes signed this checkpoint with valid ML-DSA-44
   signatures" (or, stronger, that the checkpoint is in a block certified by > 2/3 of ZETAPHY's PQ voting power: the
   STARK light client statement);
3. a STARK-verifier ISM on the destination checks one proof (~100–200 KB calldata, hash-based, no trusted setup);
4. while the destination itself is classical, its ECDSA ISM stays beside it in an aggregation ISM.

What it cannot fix: the destination chain's own accounts and validators stay classical; a bridge only stops the
**link** from being the weakest part.

### 6.3 Migration into a PQ account on ZETAPHY (flow)

For a user with assets on Ethereum or BNB:
1. Create an ML-DSA-44 account (ZETAPHY wallet or the Snap) and send one transaction so its key is on chain.
2. In Saphan (hub → Saphan), bridge from the origin chain with **recipient = that ML-DSA-44 account's 0x address**
   (`HyperlaneLockBoxV2` locks on the origin; the bridged token is minted on ZETAPHY to the PQ account).
3. Optional: lock the old MetaMask account on ZETAPHY to the PQ account too (quantum lock), so anything still sent to
   it is safe.
4. Hold, trade or settle (PQSettlement) from the PQ account.

Honest caveat: a bridged token is a claim on the origin-chain lockbox. If the origin chain's custody (its owner keys or
its validators) fails on Q-day, the claim can lose its backing. Native ZETAPHY assets and assets issued on ZETAPHY do
not have this problem. The move from a classical exposed key on the origin chain is itself a classical signature, so
it must happen **before** Q-day.

## 7. Comparison

| | Accounts | Consensus / finality | Migration path for exposed keys |
|---|---|---|---|
| **ZETAPHY** | native ML-DSA-44 accounts; secp256k1 accounts can quantum-lock to one | CometBFT Ed25519 + ML-DSA vote keys and per-block ML-DSA certificates | chain Q-day rule; lock before; commit–reveal (never-used keys); QuantumRescue pre-commitment; MsgQDayRescue and ZK-of-seed (designed) |
| **QRL** | hash-based XMSS since genesis (2018), stateful; its next version moves to ML-DSA (Dilithium) | its own PoS | born post-quantum: little to migrate |
| **Algorand** | Ed25519 accounts | Falcon-signed state proofs certify the chain's state to other chains | state proofs protect the history and light clients; accounts still need a migration |
| **Ethereum** | secp256k1 EOAs; account abstraction (ERC-4337, EIP-7702) lets smart accounts verify PQ signatures in code | roadmap toward hash-based signatures and STARK aggregation | research proposals: freeze exposed EOAs and recover HD wallets with a STARK proof of the seed (the same idea as 4.5) |
| **Bitcoin** | secp256k1 (ECDSA, Schnorr/Taproot exposes keys in outputs) | PoW (hash-based, quantum affects it only mildly) | BIP-360 (draft, originally "P2QRH"): a new output type for PQ signatures; the proposal is still changing and not activated |

What ZETAPHY adds to this picture: the PQ pieces already run at every layer we control (accounts, votes, block
certificates, wallet, Snap, explorer), the remaining classical dependencies are listed and tested as data, and there
is a rescue that users can prepare **today** with the wallet they already have.

## 8. Limits

- Everything is on the testnet. Contracts are unaudited; the ML-DSA precompile and certificate rule are ours.
- Consensus is hybrid, not PQ-only: Ed25519 still signs every CometBFT vote. A classical-only verifier (a stock IBC
  light client) can be fooled after Q-day.
- `PQSettlement.isFinal` trusts the chain's certificate rule; quantum-safe finality for an outside verifier needs
  `settlementFinality` with pinned vote keys.
- `QuantumRescue` reveals do not move the account by themselves until `MsgQDayRescue` exists; today they control the
  rescue escrow and contracts that honour `controllerOf`.
- The STARK routes (6.2, 4.5) are designs; the STARK prototype lives on its own branch.
- The readiness score is a weighting we chose, not a measurement of risk.

## 9. Files, commands, tests

| | |
|---|---|
| Contracts | `zetaphy-network/contracts/QuantumRescue.sol`, `PQSettlement.sol`, `PQMultisigIsm.sol` |
| JS | `zetaphy-network/src/qsafe/inventory.js`, `rescue.js`, `settlement.js`, `pqism.js`, `cli.js` |
| CLI | `zetaphy qsafe inventory [--json]`, `zetaphy qsafe rescue-kit <account> --contract <0x…>`, `zetaphy qsafe rescue-reveal <kit.json>` |
| Hub | Quantum tab: `zetaphy-hub/quantum.js`, `quantum-core.js`, `quantum-i18n.js` (8 languages); `build.mjs` writes `qsafe` into `hub-config.json`; a deployment record `zetaphy-network/deployments/qsafe-77390.json` (`quantumRescue`, `pqSettlement`, `pqMultisigIsm`) turns on sending |
| Tests | `zetaphy-network/test/qsafe-inventory.test.js`, `qsafe-rescue.test.js`, `qsafe-settlement.test.js`, `qsafe-ism.test.js` (real ML-DSA-44 keys through a JS precompile); `zetaphy-hub/test/quantum.test.mjs`, `quantum.e2e.mjs` |
