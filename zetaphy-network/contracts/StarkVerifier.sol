// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title StarkVerifier: the ZETAPHY STARK light-client verifier (proof format v1) on the EVM
/// @notice A line-by-line port of zetaphy-network/src/starklc/verifier.js (DEEP-ALI + FRI over the
///         Stark252 field, SHA-256 Merkle commitments and Fiat-Shamir), using the SHA-256 precompile
///         (0x02) for every hash and the modexp precompile (0x05) for inversions. Stateless: it
///         takes the proof bytes exactly as `encodeProof` writes them and the pinned set
///         { root, logN, logBlowup }, and returns what was proven, or reverts ProofRejected(code).
///
///         What it does NOT do: verify ML-DSA-44 signatures. For revealed rows (modes `all` and
///         `sample`) it checks that each revealed signature and key hash to the committed G and K
///         values (so they are the certificate's signature and the set's key) and returns
///         `revealsHash` = keccak256(G0, K0, G1, K1, ...) and the signed message, so the caller
///         (StarkLightClient) can check the signatures itself or let anyone dispute one during a
///         challenge window. Mode `none` reveals nothing: the prover is trusted for ML-DSA validity.
///         Testnet prototype, not audited. See docs/future/trustless-bridge.md.
contract StarkVerifier {
    uint256 internal constant P = 0x800000000000011000000000000000000000000000000000000000000000001;
    uint256 internal constant R256 = 0x7fffffffffffdf0ffffffffffffffffffffffffffffffffffffffffffffffe1; // 2^256 mod P
    uint256 internal constant INV2 = 0x400000000000008800000000000000000000000000000000000000000000001;
    uint256 internal constant INV3 = 0x2aaaaaaaaaaaab0555555555555555555555555555555555555555555555556;
    uint256 internal constant COSET = 3;
    uint256 internal constant REVEAL = 4 + 7 * 32 + 2420 + 1312; // u32 row, 7 fields, signature, key
    uint256 internal constant SIG = 2420;

    /// Reasons, in the order they are checked (also what the JS verifier's messages say):
    /// 1 malformed/trailing bytes/non-canonical field   2 not the pinned set's size or blowup
    /// 3 another chain   4 weak STARK parameters   5 public sums out of range
    /// 6 constraints do not hold at z   7 reveals out of order/range   8 samples wrong
    /// 9 revealed count != C (mode all)   10 unexpected reveals (mode none)
    /// 11 revealed row is not a signer   12 key is not the set's   13 signature is not the committed one
    /// 14 too few signature-check bits   15 FRI shape   16 proof of work missing
    /// 17 trace openings   18 set openings (wrong set root)   19 composition openings
    /// 20 FRI layer openings   21 FRI folding   22 FRI final polynomial
    error ProofRejected(uint256 code);

    struct Pin {
        bytes32 root;
        uint8 logN;
        uint8 logBlowup;
    }

    struct Result {
        uint8 kind;            // 0 block, 1 handoff
        uint64 height;         // block height, or the next epoch for a handoff
        bytes32 hash;          // block hash, or the next set root for a handoff
        uint8 nextLogN;
        uint8 nextLogBlowup;
        uint256 S;
        uint256 T;
        uint256 U;
        uint256 C;
        uint8 mode;            // 0 none, 1 sample, 2 all
        uint256 revealed;
        uint256 revealsOffset; // where the reveals start in the proof bytes (row u32, 7 fields, sig, key)
        bytes32 revealsHash;   // keccak256 of (G, K) per revealed row, in order
        bytes message;         // the bytes the validators signed (voteMessage / handoff message)
        bool ok;               // the chain's rule 3S > 2T - 3U
        bool pqMajority;       // 3S > 2T
    }

    /// Everything about one verification (calldata offsets are absolute).
    struct V {
        uint256 b; uint256 end;
        uint256 logBlowup; uint256 queries; uint256 grind; uint256 logFinalDeg; uint256 logN;
        uint256 N; uint256 L; uint256 half;
        uint256 stmt; uint256 stmtLen; uint256 chain; uint256 chainLen;
        uint256 S; uint256 T; uint256 U; uint256 C; uint256 mode; uint256 k;
        bytes32 traceRoot; bytes32 qRoot; uint256 ood;
        uint256 rev; uint256 nRev; uint256 samp; uint256 nSamp;
        uint256 fri; uint256 nFri; uint256 fin; uint256 nFin; uint256 nonce;
        uint256 nq; uint256 tl; uint256 sl; uint256 ql;
        uint256 tp; uint256 tpN; uint256 sp; uint256 spN; uint256 qp; uint256 qpN;
        uint256 layers;
        bytes32 setRoot; bytes32 st; uint256 ctr;
        uint256 z; uint256 wN; uint256 wL;
        uint256[] alphas; uint256[] gammas; uint256[] betas; uint256[] idx;
        uint256[] pts; uint256[] gsum;
    }

    // ------------------------------------------------------------------ entry point

    /// @param minSigBits the least signature-check security accepted (0 accepts mode none)
    /// @param minStarkBits the least conjectured STARK security (queries * logBlowup + grinding)
    function verify(bytes calldata proof, Pin calldata pin, bytes calldata chainId, uint256 minSigBits, uint256 minStarkBits)
        external view returns (Result memory r)
    {
        V memory v;
        uint256 b;
        assembly { b := proof.offset }
        v.b = b;
        v.end = b + proof.length;
        v.setRoot = pin.root;
        _parse(v);
        if (v.logN != pin.logN || v.logBlowup != pin.logBlowup) revert ProofRejected(2);
        if (keccak256(proof[v.chain - b:v.chain - b + v.chainLen]) != keccak256(chainId)) revert ProofRejected(3);
        if (v.queries * v.logBlowup + v.grind < minStarkBits || v.logFinalDeg > 10 || v.queries < 1 || v.grind > 40) revert ProofRejected(4);
        if (v.S >= 1 << 100 || v.T >= 1 << 100 || v.U >= 1 << 100 || v.C >= 1 << 100) revert ProofRejected(5);

        r.message = _message(v);
        _transcriptToOod(v, r.message);
        _checkComposition(v);
        (r.revealsHash) = _reveals(v, minSigBits);
        _deepAndFri(v);

        r.kind = uint8(_u(v.stmt, 1));
        r.height = uint64(_u(v.stmt + 2 + v.chainLen, 8));
        r.hash = bytes32(_w(v.stmt + 10 + v.chainLen));
        r.nextLogN = uint8(_u(v.stmt + 42 + v.chainLen, 1));
        r.nextLogBlowup = uint8(_u(v.stmt + 43 + v.chainLen, 1));
        (r.S, r.T, r.U, r.C) = (v.S, v.T, v.U, v.C);
        r.mode = uint8(v.mode);
        r.revealed = v.nRev;
        r.revealsOffset = v.rev - b;
        int256 need = 2 * int256(v.T) - 3 * int256(v.U);
        r.ok = need < 0 || 3 * int256(v.S) > need;
        r.pqMajority = 3 * v.S > 2 * v.T;
    }

    // ------------------------------------------------------------------ parsing

    function _parse(V memory v) private pure {
        unchecked {
            uint256 c = v.b;
            if (v.end - v.b < 64 || _u(c, 5) != 0x5a534c4301) revert ProofRejected(1); // "ZSLC" v1
            c += 5;
            (v.logBlowup, v.queries, v.grind, v.logFinalDeg, v.logN) = (_u(c, 1), _u(c + 1, 1), _u(c + 2, 1), _u(c + 3, 1), _u(c + 4, 1));
            if (v.logN < 3 || v.logN > 20 || v.logBlowup < 1 || v.logBlowup > 6) revert ProofRejected(1);
            v.N = 1 << v.logN;
            v.L = v.N << v.logBlowup;
            v.half = v.L / 2;
            c += 5;
            v.stmt = c;
            uint256 kind = _u(c, 1);
            v.chainLen = _u(c + 1, 1);
            v.chain = c + 2;
            c = v.chain + v.chainLen + 8 + 32;
            if (kind > 1 || (kind == 0 && _u(c, 2) != 0)) revert ProofRejected(1);
            c += 2;
            v.stmtLen = c - v.stmt;
            (v.S, v.T, v.U, v.C) = (_f(c), _f(c + 32), _f(c + 64), _f(c + 96));
            c += 128;
            v.mode = _u(c, 1);
            v.k = _u(c + 1, 2);
            if (v.mode > 2) revert ProofRejected(1);
            c += 3;
            v.traceRoot = bytes32(_w(c));
            v.qRoot = bytes32(_w(c + 32));
            c += 64;
            v.ood = c;
            c += 15 * 32;
            v.nRev = _u(c, 2);
            v.rev = c + 2;
            c = v.rev + v.nRev * REVEAL;
            v.nSamp = _u(c, 2);
            v.samp = c + 2;
            c = v.samp + 2 * v.nSamp;
            v.nFri = _u(c, 1);
            v.fri = c + 1;
            c = v.fri + 32 * v.nFri;
            v.nFin = _u(c, 1);
            v.fin = c + 1;
            c = v.fin + 32 * v.nFin;
            v.nonce = _u(c, 8);
            c += 8;
            v.nq = _u(c, 2);
            c += 2;
            v.tl = c; c += v.nq * 12 * 32;
            v.sl = c; c += v.nq * 8 * 32;
            v.ql = c; c += v.nq * 2 * 32;
            v.tpN = _u(c, 2); v.tp = c + 2; c = v.tp + 32 * v.tpN;
            v.spN = _u(c, 2); v.sp = c + 2; c = v.sp + 32 * v.spN;
            v.qpN = _u(c, 2); v.qp = c + 2; c = v.qp + 32 * v.qpN;
            v.layers = c;
            for (uint256 i = 0; i < v.nFri; i++) {
                if (c > v.end) revert ProofRejected(1);
                c += 2 + _u(c, 2) * 64;
                c += 2 + _u(c, 2) * 32;
            }
            if (c != v.end) revert ProofRejected(1);
        }
    }

    /// The bytes validators sign: "zetaphy/pq-vote\0" chain "\0" u64 height hash (a block), or
    /// "zetaphy/pq-setroot\0" chain "\0" u64 epoch root logN logBlowup (a handoff).
    function _message(V memory v) private pure returns (bytes memory) {
        uint256 kind = _u(v.stmt, 1);
        bytes memory chain = _cd(v.chain, v.chainLen);
        bytes memory rest = _cd(v.chain + v.chainLen, 40); // u64 height, hash
        if (kind == 0) return abi.encodePacked("zetaphy/pq-vote\x00", chain, "\x00", rest);
        return abi.encodePacked("zetaphy/pq-setroot\x00", chain, "\x00", rest, _cd(v.chain + v.chainLen + 40, 2));
    }

    // ------------------------------------------------------------------ transcript replay

    function _transcriptToOod(V memory v, bytes memory message) private view {
        v.st = sha256("zetaphy/starklc/v1\x00proof");
        bytes memory head = abi.encodePacked(
            uint8(1), uint8(v.logBlowup), uint8(v.queries), uint8(v.grind), uint8(v.logFinalDeg), uint8(v.logN),
            v.setRoot, _cd(v.stmt, v.stmtLen), message);
        head = abi.encodePacked(head, v.S, v.T, v.U, v.C, uint8(v.mode), uint64(v.k));
        _absorbMem(v, head);
        _absorb32(v, v.traceRoot);
        v.alphas = new uint256[](18);
        for (uint256 i = 0; i < 18; i++) v.alphas[i] = _field(v);
        _absorb32(v, v.qRoot);
        uint256 cosetPowL = _pow(COSET, v.L);
        uint256 z = _field(v);
        while (z == 0 || _pow(z, v.N) == 1 || _pow(z, v.L) == cosetPowL) z = _field(v);
        v.z = z;
        v.wN = _root(v.logN);
        v.wL = _root(v.logN + v.logBlowup);
        for (uint256 i = 0; i < 15; i++) _f(v.ood + 32 * i);
        _absorbCd(v, v.ood, 15 * 32);
    }

    function _checkComposition(V memory v) private view {
        uint256 o = v.ood;
        uint256[] memory a = v.alphas;
        uint256 z = v.z;
        uint256 wLast = _pow(v.wN, v.N - 1);
        uint256 acc = mulmod(addmod(_compAll(o, a), mulmod(_compTrans(o, a), _sub(z, wLast), P), P), _inv(_sub(_pow(z, v.N), 1)), P);
        uint256 invFirst = _inv(_sub(z, 1));
        uint256 invLast = _inv(_sub(z, wLast));
        // first row: CS, CT, CU, CC = 0
        for (uint256 j = 0; j < 4; j++) acc = addmod(acc, mulmod(a[9 + j], mulmod(_w(o + 64 + 32 * j), invFirst, P), P), P);
        // last row: CS = S, CT = T, CU = U, CC = C, P = 0
        acc = addmod(acc, mulmod(a[13], mulmod(_sub(_w(o + 64), v.S), invLast, P), P), P);
        acc = addmod(acc, mulmod(a[14], mulmod(_sub(_w(o + 96), v.T), invLast, P), P), P);
        acc = addmod(acc, mulmod(a[15], mulmod(_sub(_w(o + 128), v.U), invLast, P), P), P);
        acc = addmod(acc, mulmod(a[16], mulmod(_sub(_w(o + 160), v.C), invLast, P), P), P);
        acc = addmod(acc, mulmod(a[17], mulmod(_w(o + 416), invLast, P), P), P);
        if (acc != _w(o + 448)) revert ProofRejected(6);
    }


    /// Row constraints B(B-1), (1-B)G, BZ, Z(Z-1), ZK at z, mixed with alpha 0..4.
    function _compAll(uint256 o, uint256[] memory a) private pure returns (uint256 x) {
        uint256 B = _w(o);
        uint256 Z = _w(o + 384);
        x = mulmod(a[0], mulmod(B, addmod(B, P - 1, P), P), P);
        x = addmod(x, mulmod(a[1], mulmod(addmod(1, P - B, P), _w(o + 32), P), P), P);
        x = addmod(x, mulmod(a[2], mulmod(B, Z, P), P), P);
        x = addmod(x, mulmod(a[3], mulmod(Z, addmod(Z, P - 1, P), P), P), P);
        x = addmod(x, mulmod(a[4], mulmod(Z, _w(o + 352), P), P), P);
    }

    /// Transitions CS'=CS+BP, CT'=CT+P, CU'=CU+ZP, CC'=CC+B at z, mixed with alpha 5..8.
    function _compTrans(uint256 o, uint256[] memory a) private pure returns (uint256 y) {
        uint256 B = _w(o);
        uint256 Pw = _w(o + 416);
        y = mulmod(a[5], _sub(_sub(_w(o + 192), _w(o + 64)), mulmod(B, Pw, P)), P);
        y = addmod(y, mulmod(a[6], _sub(_sub(_w(o + 224), _w(o + 96)), Pw), P), P);
        y = addmod(y, mulmod(a[7], _sub(_sub(_w(o + 256), _w(o + 128)), mulmod(_w(o + 384), Pw, P)), P), P);
        y = addmod(y, mulmod(a[8], _sub(_sub(_w(o + 288), _w(o + 160)), B), P), P);
    }

    // ------------------------------------------------------------------ signature reveals

    function _reveals(V memory v, uint256 minSigBits) private view returns (bytes32 revealsHash) {
        unchecked {
            uint256 n = v.nRev;
            for (uint256 i = 0; i < n; i++) {
                uint256 row = _u(v.rev + i * REVEAL, 4);
                if (row >= v.N - 1 || (i > 0 && row <= _u(v.rev + (i - 1) * REVEAL, 4))) revert ProofRejected(7);
            }
            if (v.mode == 1) {
                if (v.k != v.nSamp) revert ProofRejected(8);
                bool[] memory used = new bool[](n);
                uint256 bound = v.S == 0 ? 1 : v.S;
                for (uint256 j = 0; j < v.k; j++) {
                    uint256 r = _below(v, bound);
                    uint256 ri = _u(v.samp + 2 * j, 2);
                    if (ri >= n) revert ProofRejected(8);
                    uint256 base = v.rev + ri * REVEAL + 4;
                    if (!(_f(base + 64) <= r && r < _f(base + 96))) revert ProofRejected(8);
                    used[ri] = true;
                }
                for (uint256 i = 0; i < n; i++) if (!used[i]) revert ProofRejected(8);
            } else if (v.mode == 2) {
                if (n != v.C) revert ProofRejected(9);
            } else if (n != 0 || v.nSamp != 0) {
                revert ProofRejected(10);
            }
            bytes memory digests = new bytes(64 * n);
            bytes memory rb = new bytes(232 * n);
            for (uint256 i = 0; i < n; i++) {
                uint256 base = v.rev + i * REVEAL;
                uint256 vals = base + 4;
                for (uint256 j = 0; j < 7; j++) _f(vals + 32 * j);
                if (_w(vals) != 1) revert ProofRejected(11);
                uint256 sigOff = vals + 224;
                uint256 K = _w(vals + 160);
                uint256 G = _w(vals + 32);
                if (_digest31("zetaphy/starklc/pk\x00", sigOff + SIG, 1312) != K) revert ProofRejected(12);
                if (_digest31("zetaphy/starklc/sig\x00", sigOff, SIG) != G) revert ProofRejected(13);
                assembly {
                    mstore(add(add(digests, 32), mul(i, 64)), G)
                    mstore(add(add(digests, 64), mul(i, 64)), K)
                    let d := add(add(rb, 32), mul(i, 232))
                    mstore(d, shl(192, shr(224, calldataload(base)))) // u64(row)
                    calldatacopy(add(d, 8), vals, 224)
                }
            }
            revealsHash = keccak256(digests);
            _absorbMem(v, rb);

            // signature-check security
            int256 need = 2 * int256(v.T) - 3 * int256(v.U);
            if (v.mode == 2 || need <= 0 || minSigBits == 0) return revealsHash;
            if (v.mode == 0 || 3 * v.S <= uint256(need)) revert ProofRejected(14);
            // k * (log2(3S) - log2(need)) >= minSigBits, with a lower bound in 1/65536 bits
            uint256 hi = _log2q(3 * v.S);
            uint256 lo = _log2q(uint256(need)) + 2;
            if (hi <= lo || v.k * (hi - lo) < minSigBits << 16) revert ProofRejected(14);
        }
    }

    // ------------------------------------------------------------------ DEEP + FRI

    function _deepAndFri(V memory v) private view {
        uint256 groups = 2 + 2 * v.nRev;
        uint256 terms = 15 + 7 * v.nRev;
        v.gammas = new uint256[](terms);
        for (uint256 i = 0; i < terms; i++) v.gammas[i] = _field(v);
        uint256 m = v.logN > v.logFinalDeg ? v.logN - v.logFinalDeg : 0;
        if (v.nFri != (m > 0 ? m - 1 : 0) || v.nFin != v.N >> m) revert ProofRejected(15);
        v.betas = new uint256[](m);
        for (uint256 i = 0; i < m; i++) {
            v.betas[i] = _field(v);
            if (i + 1 < m) _absorb32(v, bytes32(_w(v.fri + 32 * i)));
        }
        for (uint256 i = 0; i < v.nFin; i++) _f(v.fin + 32 * i);
        _absorbCd(v, v.fin, 32 * v.nFin);
        if (v.grind > 0) {
            bytes32 h = sha256(abi.encodePacked(v.st, uint64(v.nonce)));
            if (uint256(h) >> (256 - v.grind) != 0) revert ProofRejected(16);
        }
        _absorbMem(v, abi.encodePacked(uint64(v.nonce)));
        _queryIndices(v);

        _openings(v);
        // DEEP group points and their constant parts
        v.pts = new uint256[](groups);
        v.gsum = new uint256[](groups);
        _groups(v);
        (uint256[] memory a0, uint256[] memory a1) = _deepValues(v, groups);
        _fri(v, m, a0, a1);
    }

    /// Merkle openings of the trace, the pinned set and Q at the query positions.
    function _openings(V memory v) private view {
        unchecked {
            uint256 depth = v.logN + v.logBlowup - 1;
            uint256 nq = v.idx.length;
            if (v.nq != nq) revert ProofRejected(1);
            if (!_verifyMany(v.traceRoot, depth, v.idx, _leafHashes(v.tl, 384, nq), v.tp, v.tpN)) revert ProofRejected(17);
            if (!_verifyMany(v.setRoot, depth, v.idx, _leafHashes(v.sl, 256, nq), v.sp, v.spN)) revert ProofRejected(18);
            if (!_verifyMany(v.qRoot, depth, v.idx, _leafHashes(v.ql, 64, nq), v.qp, v.qpN)) revert ProofRejected(19);
        }
    }

    /// f0(x) and f0(-x) at every query (one batched inversion per query).
    function _deepValues(V memory v, uint256 groups) private view returns (uint256[] memory a0, uint256[] memory a1) {
        unchecked {
            uint256 nq = v.idx.length;
            a0 = new uint256[](nq);
            a1 = new uint256[](nq);
            uint256[] memory den = new uint256[](2 * groups);
            for (uint256 q = 0; q < nq; q++) {
                uint256 x = mulmod(COSET, _pow(v.wL, v.idx[q]), P);
                for (uint256 g = 0; g < groups; g++) {
                    den[g] = _sub(x, v.pts[g]);
                    den[groups + g] = _sub(P - x, v.pts[g]);
                }
                _batchInv(den);
                uint256 t = v.tl + q * 384;
                uint256 s = v.sl + q * 256;
                uint256 ql = v.ql + q * 64;
                for (uint256 i = 0; i < 12; i++) _f(t + 32 * i);
                for (uint256 i = 0; i < 8; i++) _f(s + 32 * i);
                a0[q] = _deepAt(v, t, s, _f(ql), den, 0);
                a1[q] = _deepAt(v, t + 192, s + 128, _f(ql + 32), den, groups);
            }
        }
    }

    function _groups(V memory v) private pure {
        unchecked {
            uint256[] memory gm = v.gammas;
            uint256 o = v.ood;
            uint256 s;
            // z: B G CS CT CU CC, A K Z P, Q
            for (uint256 j = 0; j < 11; j++) s = addmod(s, mulmod(gm[j], _w(o + (j < 6 ? 32 * j : j < 10 ? 320 + 32 * (j - 6) : 448)), P), P);
            v.pts[0] = v.z;
            v.gsum[0] = s;
            s = 0;
            // z * wN: CS CT CU CC of the next row
            for (uint256 j = 0; j < 4; j++) s = addmod(s, mulmod(gm[11 + j], _w(o + 192 + 32 * j), P), P);
            v.pts[1] = mulmod(v.z, v.wN, P);
            v.gsum[1] = s;
            for (uint256 i = 0; i < v.nRev; i++) {
                uint256 base = v.rev + i * REVEAL;
                uint256 row = _u(base, 4);
                uint256 vals = base + 4; // B G CS CSn A K P
                uint256 gb = 15 + 7 * i;
                s = mulmod(gm[gb], _w(vals), P);
                s = addmod(s, mulmod(gm[gb + 1], _w(vals + 32), P), P);
                s = addmod(s, mulmod(gm[gb + 2], _w(vals + 64), P), P);
                s = addmod(s, mulmod(gm[gb + 3], _w(vals + 128), P), P);
                s = addmod(s, mulmod(gm[gb + 4], _w(vals + 160), P), P);
                s = addmod(s, mulmod(gm[gb + 5], _w(vals + 192), P), P);
                uint256 w = _pow(v.wN, row);
                v.pts[2 + 2 * i] = w;
                v.gsum[2 + 2 * i] = s;
                v.pts[3 + 2 * i] = mulmod(w, v.wN, P);
                v.gsum[3 + 2 * i] = mulmod(gm[gb + 6], _w(vals + 96), P);
            }
        }
    }

    /// The DEEP composition at one point: t (6 fields) and s (4 fields) at calldata offsets, q.
    function _deepAt(V memory v, uint256 t, uint256 s, uint256 q, uint256[] memory den, uint256 d0) private pure returns (uint256 acc) {
        uint256[] memory gm = v.gammas;
        uint256[] memory gs = v.gsum;
        uint256 num;
        unchecked {
            for (uint256 j = 0; j < 6; j++) num = addmod(num, mulmod(gm[j], _w(t + 32 * j), P), P);
            for (uint256 j = 0; j < 4; j++) num = addmod(num, mulmod(gm[6 + j], _w(s + 32 * j), P), P);
            num = addmod(num, mulmod(gm[10], q, P), P);
            acc = mulmod(_sub(num, gs[0]), den[d0], P);
            num = 0;
            for (uint256 j = 0; j < 4; j++) num = addmod(num, mulmod(gm[11 + j], _w(t + 64 + 32 * j), P), P);
            acc = addmod(acc, mulmod(_sub(num, gs[1]), den[d0 + 1], P), P);
            acc = addmod(acc, _deepReveals(v, [_w(t), _w(t + 32), _w(t + 64), _w(s), _w(s + 32), _w(s + 96)], den, d0), P);
        }
    }

    /// The reveal groups of the DEEP sum: c = B, G, CS, A, K, P at the point.
    function _deepReveals(V memory v, uint256[6] memory c, uint256[] memory den, uint256 d0) private pure returns (uint256 acc) {
        uint256[] memory gm = v.gammas;
        uint256[] memory gs = v.gsum;
        uint256 n = v.nRev;
        assembly {
            let g := add(gm, add(32, mul(15, 32)))     // gammas[15]
            let s := add(gs, 96)                        // gsum[2]
            let d := add(den, add(32, shl(5, add(d0, 2)))) // den[d0 + 2]
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let num := mulmod(mload(g), mload(c), P)
                num := addmod(num, mulmod(mload(add(g, 32)), mload(add(c, 32)), P), P)
                num := addmod(num, mulmod(mload(add(g, 64)), mload(add(c, 64)), P), P)
                num := addmod(num, mulmod(mload(add(g, 96)), mload(add(c, 96)), P), P)
                num := addmod(num, mulmod(mload(add(g, 128)), mload(add(c, 128)), P), P)
                num := addmod(num, mulmod(mload(add(g, 160)), mload(add(c, 160)), P), P)
                acc := addmod(acc, mulmod(addmod(num, sub(P, mload(s)), P), mload(d), P), P)
                let one := mulmod(mload(add(g, 192)), mload(add(c, 64)), P)
                acc := addmod(acc, mulmod(addmod(one, sub(P, mload(add(s, 32))), P), mload(add(d, 32)), P), P)
                g := add(g, 224)
                s := add(s, 64)
                d := add(d, 64)
            }
        }
    }

    /// FRI state: the current domain off * <w> of `size` points, and the next layer's offset.
    struct F { uint256 off; uint256 offInv; uint256 w; uint256 size; uint256 lay; uint256[] pos; uint256[] a0; uint256[] a1; }

    function _fri(V memory v, uint256 m, uint256[] memory a0, uint256[] memory a1) private view {
        F memory f = F(COSET, INV3, v.wL, v.L, v.layers, v.idx, a0, a1);
        for (uint256 k2 = 0; k2 < m; k2++) {
            uint256[] memory folded = _fold(f, v.betas[k2]);
            if (k2 + 1 < m) _layer(v, f, k2, folded);
            else {
                for (uint256 q = 0; q < folded.length; q++) {
                    if (_evalFinal(v, mulmod(f.off, _pow(f.w, f.pos[q]), P)) != folded[q]) revert ProofRejected(22);
                }
            }
        }
        if (m == 0) {
            for (uint256 q = 0; q < f.pos.length; q++) {
                uint256 x = mulmod(COSET, _pow(v.wL, f.pos[q]), P);
                if (_evalFinal(v, x) != f.a0[q] || _evalFinal(v, P - x) != f.a1[q]) revert ProofRejected(22);
            }
        }
    }

    /// One fold: (a0 + a1)/2 + beta (a0 - a1)/(2x), then the domain is squared.
    function _fold(F memory f, uint256 beta) private pure returns (uint256[] memory folded) {
        unchecked {
            uint256 cnt = f.pos.length;
            folded = new uint256[](cnt);
            for (uint256 q = 0; q < cnt; q++) {
                uint256 xInv = mulmod(f.offInv, _pow(f.w, f.size - f.pos[q]), P);
                uint256 odd = mulmod(mulmod(_sub(f.a0[q], f.a1[q]), INV2, P), xInv, P);
                folded[q] = addmod(mulmod(addmod(f.a0[q], f.a1[q], P), INV2, P), mulmod(beta, odd, P), P);
            }
            f.off = mulmod(f.off, f.off, P);
            f.offInv = mulmod(f.offInv, f.offInv, P);
            f.w = mulmod(f.w, f.w, P);
            f.size >>= 1;
        }
    }

    /// The committed layer k2 + 1 opens at the folded positions and holds the folded values.
    function _layer(V memory v, F memory f, uint256 k2, uint256[] memory folded) private view {
        unchecked {
            uint256 h2 = f.size >> 1;
            uint256[] memory np = _uniqueMod(f.pos, h2);
            uint256 n = _u(f.lay, 2);
            uint256 leaves = f.lay + 2;
            if (n != np.length) revert ProofRejected(20);
            uint256 pn = _u(leaves + 64 * n, 2);
            if (!_verifyMany(bytes32(_w(v.fri + 32 * k2)), _log2(h2), np, _leafHashes(leaves, 64, n), leaves + 64 * n + 2, pn)) revert ProofRejected(20);
            for (uint256 q = 0; q < folded.length; q++) {
                uint256 j = _indexOf(np, f.pos[q] % h2);
                if (_f(leaves + 64 * j + (f.pos[q] >= h2 ? 32 : 0)) != folded[q]) revert ProofRejected(21);
            }
            f.a0 = new uint256[](n);
            f.a1 = new uint256[](n);
            for (uint256 j = 0; j < n; j++) { f.a0[j] = _f(leaves + 64 * j); f.a1[j] = _f(leaves + 64 * j + 32); }
            f.pos = np;
            f.lay = leaves + 64 * n + 2 + 32 * pn;
        }
    }

    function _evalFinal(V memory v, uint256 x) private pure returns (uint256 r) {
        unchecked {
            for (uint256 i = v.nFin; i > 0; i--) r = addmod(mulmod(r, x, P), _w(v.fin + 32 * (i - 1)), P);
        }
    }

    function _queryIndices(V memory v) private view {
        unchecked {
            uint256 want = v.queries < v.half ? v.queries : v.half;
            uint256[] memory out = new uint256[](want);
            uint256 n = 0;
            while (n < want) {
                uint256 x = _below(v, v.half);
                uint256 i = 0;
                while (i < n && out[i] < x) i++;
                if (i < n && out[i] == x) continue;
                for (uint256 j = n; j > i; j--) out[j] = out[j - 1];
                out[i] = x;
                n++;
            }
            v.idx = out;
        }
    }

    // ------------------------------------------------------------------ Merkle

    function _leafHashes(uint256 off, uint256 len, uint256 n) private view returns (bytes32[] memory out) {
        unchecked {
            out = new bytes32[](n);
            for (uint256 i = 0; i < n; i++) out[i] = _leafCd(off + i * len, len);
        }
    }

    /// starklc hash.js verifyMany: sorted unique indices, the sibling hashes not computable from
    /// the opened leaves, level by level, left to right (proof at calldata `p`, `pn` nodes).
    function _verifyMany(bytes32 root, uint256 depth, uint256[] memory ind, bytes32[] memory leaves, uint256 p, uint256 pn)
        private view returns (bool)
    {
        unchecked {
            uint256 n = ind.length;
            if (n == 0 || n != leaves.length) return false;
            uint256[] memory ci = new uint256[](n);
            bytes32[] memory ch = new bytes32[](n);
            for (uint256 k = 0; k < n; k++) {
                if (ind[k] >= 1 << depth || (k > 0 && ind[k] <= ind[k - 1])) return false;
                ci[k] = ind[k];
                ch[k] = leaves[k];
            }
            uint256 used = 0;
            for (uint256 lvl = 0; lvl < depth; lvl++) {
                uint256 m = 0;
                for (uint256 k = 0; k < n; k++) {
                    uint256 i = ci[k];
                    bytes32 parent;
                    if (i & 1 == 0 && k + 1 < n && ci[k + 1] == i + 1) {
                        parent = _node(ch[k], ch[k + 1]);
                        k++;
                    } else {
                        if (used >= pn) return false;
                        bytes32 sib = bytes32(_w(p + 32 * used));
                        used++;
                        parent = i & 1 == 1 ? _node(sib, ch[k]) : _node(ch[k], sib);
                    }
                    ci[m] = i >> 1;
                    ch[m] = parent;
                    m++;
                }
                n = m;
            }
            return used == pn && n == 1 && ci[0] == 0 && ch[0] == root;
        }
    }

    function _node(bytes32 l, bytes32 r) private view returns (bytes32 h) {
        assembly {
            let fp := mload(0x40)
            mstore8(fp, 1)
            mstore(add(fp, 1), l)
            mstore(add(fp, 33), r)
            if iszero(staticcall(gas(), 2, fp, 65, 0, 32)) { revert(0, 0) }
            h := mload(0)
        }
    }

    function _leafCd(uint256 off, uint256 len) private view returns (bytes32 h) {
        assembly {
            let fp := mload(0x40)
            mstore8(fp, 0)
            calldatacopy(add(fp, 1), off, len)
            if iszero(staticcall(gas(), 2, fp, add(len, 1), 0, 32)) { revert(0, 0) }
            h := mload(0)
        }
    }

    function _digest31(bytes memory tag, uint256 off, uint256 len) private view returns (uint256 d) {
        assembly {
            let fp := mload(0x40)
            let tl := mload(tag)
            mcopy(fp, add(tag, 32), tl)
            calldatacopy(add(fp, tl), off, len)
            if iszero(staticcall(gas(), 2, fp, add(tl, len), 0, 32)) { revert(0, 0) }
            d := shr(8, mload(0))
        }
    }

    // ------------------------------------------------------------------ transcript

    function _absorbMem(V memory v, bytes memory data) private view {
        bytes32 s = v.st;
        bytes32 out;
        assembly {
            let fp := mload(0x40)
            let len := mload(data)
            mstore(fp, s)
            mcopy(add(fp, 32), add(data, 32), len)
            if iszero(staticcall(gas(), 2, fp, add(len, 32), 0, 32)) { revert(0, 0) }
            out := mload(0)
        }
        v.st = out;
        v.ctr = 0;
    }

    function _absorbCd(V memory v, uint256 off, uint256 len) private view {
        bytes32 s = v.st;
        bytes32 out;
        assembly {
            let fp := mload(0x40)
            mstore(fp, s)
            calldatacopy(add(fp, 32), off, len)
            if iszero(staticcall(gas(), 2, fp, add(len, 32), 0, 32)) { revert(0, 0) }
            out := mload(0)
        }
        v.st = out;
        v.ctr = 0;
    }

    function _absorb32(V memory v, bytes32 x) private pure {
        v.st = sha256(abi.encodePacked(v.st, x));
        v.ctr = 0;
    }

    function _squeeze(V memory v) private view returns (uint256 h) {
        bytes32 s = v.st;
        uint256 c = v.ctr;
        assembly {
            let fp := mload(0x40)
            mstore(fp, s)
            mstore(add(fp, 32), shl(224, c))
            if iszero(staticcall(gas(), 2, fp, 36, 0, 32)) { revert(0, 0) }
            h := mload(0)
        }
        v.ctr = c + 1;
    }

    /// A uniform field element: 512 bits reduced mod p.
    function _field(V memory v) private view returns (uint256) {
        uint256 hi = _squeeze(v);
        uint256 lo = _squeeze(v);
        return addmod(mulmod(hi, R256, P), lo % P, P);
    }

    /// A uniform integer in [0, n): 512 bits reduced mod n.
    function _below(V memory v, uint256 n) private view returns (uint256) {
        uint256 hi = _squeeze(v);
        uint256 lo = _squeeze(v);
        uint256 r = addmod(type(uint256).max % n, 1, n);
        return addmod(mulmod(hi, r, n), lo % n, n);
    }

    // ------------------------------------------------------------------ field

    function _sub(uint256 a, uint256 b) private pure returns (uint256) {
        return addmod(a, P - b, P);
    }

    function _pow(uint256 b, uint256 e) private pure returns (uint256 r) {
        unchecked {
            r = 1;
            while (e > 0) {
                if (e & 1 == 1) r = mulmod(r, b, P);
                b = mulmod(b, b, P);
                e >>= 1;
            }
        }
    }

    function _modexp(uint256 b, uint256 e) private view returns (uint256 r) {
        assembly {
            let fp := mload(0x40)
            mstore(fp, 32)
            mstore(add(fp, 32), 32)
            mstore(add(fp, 64), 32)
            mstore(add(fp, 96), b)
            mstore(add(fp, 128), e)
            mstore(add(fp, 160), P)
            if iszero(staticcall(gas(), 5, fp, 192, 0, 32)) { revert(0, 0) }
            r := mload(0)
        }
    }

    function _inv(uint256 a) private view returns (uint256) {
        if (a == 0) revert ProofRejected(6);
        return _modexp(a, P - 2);
    }

    /// A primitive 2^k-th root of unity: 3^((p-1) / 2^k).
    function _root(uint256 k) private view returns (uint256) {
        return _modexp(COSET, (P - 1) >> k);
    }

    /// Montgomery batch inversion in place (zeros are refused).
    function _batchInv(uint256[] memory xs) private view {
        uint256 n = xs.length;
        uint256[] memory pre = new uint256[](n);
        uint256 acc = 1;
        assembly {
            let x := add(xs, 32)
            let q := add(pre, 32)
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                mstore(add(q, shl(5, i)), acc)
                acc := mulmod(acc, mload(add(x, shl(5, i))), P)
            }
        }
        uint256 ia = _inv(acc);
        assembly {
            let x := add(xs, 32)
            let q := add(pre, 32)
            for { let i := n } gt(i, 0) { i := sub(i, 1) } {
                let o := shl(5, sub(i, 1))
                let t := mulmod(mload(add(q, o)), ia, P)
                ia := mulmod(ia, mload(add(x, o)), P)
                mstore(add(x, o), t)
            }
        }
    }

    // ------------------------------------------------------------------ small helpers

    function _uniqueMod(uint256[] memory pos, uint256 h) private pure returns (uint256[] memory out) {
        unchecked {
            uint256[] memory tmp = new uint256[](pos.length);
            uint256 n = 0;
            for (uint256 q = 0; q < pos.length; q++) {
                uint256 x = pos[q] % h;
                uint256 i = 0;
                while (i < n && tmp[i] < x) i++;
                if (i < n && tmp[i] == x) continue;
                for (uint256 j = n; j > i; j--) tmp[j] = tmp[j - 1];
                tmp[i] = x;
                n++;
            }
            out = new uint256[](n);
            for (uint256 i = 0; i < n; i++) out[i] = tmp[i];
        }
    }

    function _indexOf(uint256[] memory a, uint256 x) private pure returns (uint256) {
        unchecked {
            for (uint256 i = 0; i < a.length; i++) if (a[i] == x) return i;
            revert ProofRejected(21);
        }
    }

    function _log2(uint256 x) private pure returns (uint256 r) {
        unchecked {
            while (x > 1) { x >>= 1; r++; }
        }
    }

    /// floor(log2(x) * 65536), a lower bound (x > 0).
    function _log2q(uint256 x) private pure returns (uint256 r) {
        unchecked {
            uint256 n = _log2(x);
            r = n << 16;
            uint256 y = n >= 127 ? x >> (n - 127) : x << (127 - n);
            for (uint256 bit = 1 << 15; bit > 0; bit >>= 1) {
                y = (y * y) >> 127;
                if (y >= 1 << 128) { r += bit; y >>= 1; }
            }
        }
    }

    function _u(uint256 off, uint256 nbytes) private pure returns (uint256 v) {
        assembly { v := shr(sub(256, mul(8, nbytes)), calldataload(off)) }
    }

    function _w(uint256 off) private pure returns (uint256 v) {
        assembly { v := calldataload(off) }
    }

    /// A canonical field element at `off` (or ProofRejected(1)).
    function _f(uint256 off) private pure returns (uint256 v) {
        assembly { v := calldataload(off) }
        if (v >= P) revert ProofRejected(1);
    }

    function _cd(uint256 off, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        assembly { calldatacopy(add(out, 32), off, len) }
    }
}
