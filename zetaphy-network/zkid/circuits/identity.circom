pragma circom 2.1.6;

// ZETAPHY private identity (docs/future/zk-identity.md): a Semaphore-style membership proof.
//
// The prover knows (secret, nullifierKey) whose identity commitment C = Poseidon(secret, nullifierKey) was registered
// in ZkIdentityRegistry by an account holding a human label, at uniqueness level `level` (1 passkey human,
// 2 vouched unique human). The registry's leaf is Poseidon(C, level). The proof shows, without revealing C, the leaf,
// its position, the level or the account:
//   1. the leaf is in the Merkle tree with root `root` (Poseidon, depth DEPTH);
//   2. nullifier = Poseidon(nullifierKey, scope): one value per person per scope (an airdrop, a poll), so a scope can
//      refuse a second action, while two scopes see unrelated nullifiers (unlinkable);
//   3. level >= minLevel;
//   4. signalHash (e.g. the hash of the airdrop recipient) is part of the proven statement, so a proof copied from
//      the mempool cannot be replayed with another recipient (the verifier's public inputs would differ).
// Public signals, in this order: root, nullifier, scope, signalHash, minLevel.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template ZkIdentity(DEPTH) {
    signal input root;
    signal input nullifier;
    signal input scope;
    signal input signalHash;
    signal input minLevel;

    signal input secret;
    signal input nullifierKey;
    signal input level;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];

    // identity commitment and leaf
    component commit = Poseidon(2);
    commit.inputs[0] <== secret;
    commit.inputs[1] <== nullifierKey;
    component leaf = Poseidon(2);
    leaf.inputs[0] <== commit.out;
    leaf.inputs[1] <== level;

    // Merkle path: pathIndices[i] = 1 when the node is the right child at height i
    signal node[DEPTH + 1];
    signal left[DEPTH];
    signal right[DEPTH];
    component h[DEPTH];
    node[0] <== leaf.out;
    for (var i = 0; i < DEPTH; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        left[i] <== node[i] + pathIndices[i] * (pathElements[i] - node[i]);
        right[i] <== node[i] + pathElements[i] - left[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== left[i];
        h[i].inputs[1] <== right[i];
        node[i + 1] <== h[i].out;
    }
    root === node[DEPTH];

    // one nullifier per person per scope
    component nf = Poseidon(2);
    nf.inputs[0] <== nullifierKey;
    nf.inputs[1] <== scope;
    nullifier === nf.out;

    // level >= minLevel (both 8-bit)
    component lb = Num2Bits(8);
    lb.in <== level;
    component mb = Num2Bits(8);
    mb.in <== minLevel;
    component ge = GreaterEqThan(8);
    ge.in[0] <== level;
    ge.in[1] <== minLevel;
    ge.out === 1;

    // bind the signal (a public input with no other constraint could be optimised away)
    signal signalSquare;
    signalSquare <== signalHash * signalHash;
}

component main {public [root, nullifier, scope, signalHash, minLevel]} = ZkIdentity(20);
