// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Test-only cost probe for an ML-DSA-44 verifier written in Solidity (no such verifier is in this
/// repo): it measures the two primitives that dominate one FIPS 204 verification on the EVM -
/// the Keccak-f[1600] permutation (SHAKE128/256 are NOT the KECCAK256 opcode: different padding
/// and output length, so the permutation must be run in EVM code) and the 256-point NTT mod
/// q = 8380417 - so test/starkbridge.test.js can estimate a dispute's gas from measured parts.
/// keccakEmpty() checks the permutation against the KECCAK256 opcode.
contract MLDSACost {
    bytes internal constant RC = hex"00000000000000010000000000008082800000000000808a8000000080008000000000000000808b000000008000000180000000800080818000000000008009000000000000008a00000000000000880000000080008009000000008000000a000000008000808b800000000000008b8000000000008089800000000000800380000000000080028000000000000080000000000000800a800000008000000a8000000080008081800000000000808000000000800000018000000080008008";
    uint256 internal constant Q = 8380417;

    /// Keccak-f[1600] on 25 lanes (one 64-bit lane per memory word) at `a`; scratch at `b` (30 words).
    function _keccakF(uint256 a, uint256 b) internal pure {
        bytes memory rcs = RC;
        assembly {
            let M := 0xffffffffffffffff
            let rc := add(rcs, 32)
            for { let r := 0 } lt(r, 24) { r := add(r, 1) } {
                mstore(add(b, 800), xor(xor(xor(xor(mload(add(a, 0)), mload(add(a, 160))), mload(add(a, 320))), mload(add(a, 480))), mload(add(a, 640))))
                mstore(add(b, 832), xor(xor(xor(xor(mload(add(a, 32)), mload(add(a, 192))), mload(add(a, 352))), mload(add(a, 512))), mload(add(a, 672))))
                mstore(add(b, 864), xor(xor(xor(xor(mload(add(a, 64)), mload(add(a, 224))), mload(add(a, 384))), mload(add(a, 544))), mload(add(a, 704))))
                mstore(add(b, 896), xor(xor(xor(xor(mload(add(a, 96)), mload(add(a, 256))), mload(add(a, 416))), mload(add(a, 576))), mload(add(a, 736))))
                mstore(add(b, 928), xor(xor(xor(xor(mload(add(a, 128)), mload(add(a, 288))), mload(add(a, 448))), mload(add(a, 608))), mload(add(a, 768))))
                { let d := xor(mload(add(b, 928)), and(or(shl(1, mload(add(b, 832))), shr(63, mload(add(b, 832)))), M))
                    mstore(add(a, 0), xor(mload(add(a, 0)), d))
                    mstore(add(a, 160), xor(mload(add(a, 160)), d))
                    mstore(add(a, 320), xor(mload(add(a, 320)), d))
                    mstore(add(a, 480), xor(mload(add(a, 480)), d))
                    mstore(add(a, 640), xor(mload(add(a, 640)), d))
                }
                { let d := xor(mload(add(b, 800)), and(or(shl(1, mload(add(b, 864))), shr(63, mload(add(b, 864)))), M))
                    mstore(add(a, 32), xor(mload(add(a, 32)), d))
                    mstore(add(a, 192), xor(mload(add(a, 192)), d))
                    mstore(add(a, 352), xor(mload(add(a, 352)), d))
                    mstore(add(a, 512), xor(mload(add(a, 512)), d))
                    mstore(add(a, 672), xor(mload(add(a, 672)), d))
                }
                { let d := xor(mload(add(b, 832)), and(or(shl(1, mload(add(b, 896))), shr(63, mload(add(b, 896)))), M))
                    mstore(add(a, 64), xor(mload(add(a, 64)), d))
                    mstore(add(a, 224), xor(mload(add(a, 224)), d))
                    mstore(add(a, 384), xor(mload(add(a, 384)), d))
                    mstore(add(a, 544), xor(mload(add(a, 544)), d))
                    mstore(add(a, 704), xor(mload(add(a, 704)), d))
                }
                { let d := xor(mload(add(b, 864)), and(or(shl(1, mload(add(b, 928))), shr(63, mload(add(b, 928)))), M))
                    mstore(add(a, 96), xor(mload(add(a, 96)), d))
                    mstore(add(a, 256), xor(mload(add(a, 256)), d))
                    mstore(add(a, 416), xor(mload(add(a, 416)), d))
                    mstore(add(a, 576), xor(mload(add(a, 576)), d))
                    mstore(add(a, 736), xor(mload(add(a, 736)), d))
                }
                { let d := xor(mload(add(b, 896)), and(or(shl(1, mload(add(b, 800))), shr(63, mload(add(b, 800)))), M))
                    mstore(add(a, 128), xor(mload(add(a, 128)), d))
                    mstore(add(a, 288), xor(mload(add(a, 288)), d))
                    mstore(add(a, 448), xor(mload(add(a, 448)), d))
                    mstore(add(a, 608), xor(mload(add(a, 608)), d))
                    mstore(add(a, 768), xor(mload(add(a, 768)), d))
                }
                mstore(add(b, 0), mload(add(a, 0)))
                mstore(add(b, 512), and(or(shl(36, mload(add(a, 160))), shr(28, mload(add(a, 160)))), M))
                mstore(add(b, 224), and(or(shl(3, mload(add(a, 320))), shr(61, mload(add(a, 320)))), M))
                mstore(add(b, 736), and(or(shl(41, mload(add(a, 480))), shr(23, mload(add(a, 480)))), M))
                mstore(add(b, 448), and(or(shl(18, mload(add(a, 640))), shr(46, mload(add(a, 640)))), M))
                mstore(add(b, 320), and(or(shl(1, mload(add(a, 32))), shr(63, mload(add(a, 32)))), M))
                mstore(add(b, 32), and(or(shl(44, mload(add(a, 192))), shr(20, mload(add(a, 192)))), M))
                mstore(add(b, 544), and(or(shl(10, mload(add(a, 352))), shr(54, mload(add(a, 352)))), M))
                mstore(add(b, 256), and(or(shl(45, mload(add(a, 512))), shr(19, mload(add(a, 512)))), M))
                mstore(add(b, 768), and(or(shl(2, mload(add(a, 672))), shr(62, mload(add(a, 672)))), M))
                mstore(add(b, 640), and(or(shl(62, mload(add(a, 64))), shr(2, mload(add(a, 64)))), M))
                mstore(add(b, 352), and(or(shl(6, mload(add(a, 224))), shr(58, mload(add(a, 224)))), M))
                mstore(add(b, 64), and(or(shl(43, mload(add(a, 384))), shr(21, mload(add(a, 384)))), M))
                mstore(add(b, 576), and(or(shl(15, mload(add(a, 544))), shr(49, mload(add(a, 544)))), M))
                mstore(add(b, 288), and(or(shl(61, mload(add(a, 704))), shr(3, mload(add(a, 704)))), M))
                mstore(add(b, 160), and(or(shl(28, mload(add(a, 96))), shr(36, mload(add(a, 96)))), M))
                mstore(add(b, 672), and(or(shl(55, mload(add(a, 256))), shr(9, mload(add(a, 256)))), M))
                mstore(add(b, 384), and(or(shl(25, mload(add(a, 416))), shr(39, mload(add(a, 416)))), M))
                mstore(add(b, 96), and(or(shl(21, mload(add(a, 576))), shr(43, mload(add(a, 576)))), M))
                mstore(add(b, 608), and(or(shl(56, mload(add(a, 736))), shr(8, mload(add(a, 736)))), M))
                mstore(add(b, 480), and(or(shl(27, mload(add(a, 128))), shr(37, mload(add(a, 128)))), M))
                mstore(add(b, 192), and(or(shl(20, mload(add(a, 288))), shr(44, mload(add(a, 288)))), M))
                mstore(add(b, 704), and(or(shl(39, mload(add(a, 448))), shr(25, mload(add(a, 448)))), M))
                mstore(add(b, 416), and(or(shl(8, mload(add(a, 608))), shr(56, mload(add(a, 608)))), M))
                mstore(add(b, 128), and(or(shl(14, mload(add(a, 768))), shr(50, mload(add(a, 768)))), M))
                mstore(add(a, 0), xor(mload(add(b, 0)), and(xor(mload(add(b, 32)), M), mload(add(b, 64)))))
                mstore(add(a, 32), xor(mload(add(b, 32)), and(xor(mload(add(b, 64)), M), mload(add(b, 96)))))
                mstore(add(a, 64), xor(mload(add(b, 64)), and(xor(mload(add(b, 96)), M), mload(add(b, 128)))))
                mstore(add(a, 96), xor(mload(add(b, 96)), and(xor(mload(add(b, 128)), M), mload(add(b, 0)))))
                mstore(add(a, 128), xor(mload(add(b, 128)), and(xor(mload(add(b, 0)), M), mload(add(b, 32)))))
                mstore(add(a, 160), xor(mload(add(b, 160)), and(xor(mload(add(b, 192)), M), mload(add(b, 224)))))
                mstore(add(a, 192), xor(mload(add(b, 192)), and(xor(mload(add(b, 224)), M), mload(add(b, 256)))))
                mstore(add(a, 224), xor(mload(add(b, 224)), and(xor(mload(add(b, 256)), M), mload(add(b, 288)))))
                mstore(add(a, 256), xor(mload(add(b, 256)), and(xor(mload(add(b, 288)), M), mload(add(b, 160)))))
                mstore(add(a, 288), xor(mload(add(b, 288)), and(xor(mload(add(b, 160)), M), mload(add(b, 192)))))
                mstore(add(a, 320), xor(mload(add(b, 320)), and(xor(mload(add(b, 352)), M), mload(add(b, 384)))))
                mstore(add(a, 352), xor(mload(add(b, 352)), and(xor(mload(add(b, 384)), M), mload(add(b, 416)))))
                mstore(add(a, 384), xor(mload(add(b, 384)), and(xor(mload(add(b, 416)), M), mload(add(b, 448)))))
                mstore(add(a, 416), xor(mload(add(b, 416)), and(xor(mload(add(b, 448)), M), mload(add(b, 320)))))
                mstore(add(a, 448), xor(mload(add(b, 448)), and(xor(mload(add(b, 320)), M), mload(add(b, 352)))))
                mstore(add(a, 480), xor(mload(add(b, 480)), and(xor(mload(add(b, 512)), M), mload(add(b, 544)))))
                mstore(add(a, 512), xor(mload(add(b, 512)), and(xor(mload(add(b, 544)), M), mload(add(b, 576)))))
                mstore(add(a, 544), xor(mload(add(b, 544)), and(xor(mload(add(b, 576)), M), mload(add(b, 608)))))
                mstore(add(a, 576), xor(mload(add(b, 576)), and(xor(mload(add(b, 608)), M), mload(add(b, 480)))))
                mstore(add(a, 608), xor(mload(add(b, 608)), and(xor(mload(add(b, 480)), M), mload(add(b, 512)))))
                mstore(add(a, 640), xor(mload(add(b, 640)), and(xor(mload(add(b, 672)), M), mload(add(b, 704)))))
                mstore(add(a, 672), xor(mload(add(b, 672)), and(xor(mload(add(b, 704)), M), mload(add(b, 736)))))
                mstore(add(a, 704), xor(mload(add(b, 704)), and(xor(mload(add(b, 736)), M), mload(add(b, 768)))))
                mstore(add(a, 736), xor(mload(add(b, 736)), and(xor(mload(add(b, 768)), M), mload(add(b, 640)))))
                mstore(add(a, 768), xor(mload(add(b, 768)), and(xor(mload(add(b, 640)), M), mload(add(b, 672)))))
                mstore(a, xor(mload(a), shr(192, mload(add(rc, shl(3, r))))))
            }
        }
    }

    /// Keccak-256("") through our permutation (rate 136, pad 0x01 .. 0x80), lanes little-endian.
    function keccakEmpty() external pure returns (bytes32 out) {
        uint256[25] memory st;
        uint256[30] memory scratch;
        st[0] = 0x01;
        st[16] = 0x80 << 56;
        uint256 a; uint256 b;
        assembly { a := st b := scratch }
        _keccakF(a, b);
        for (uint256 i = 0; i < 4; i++) {
            uint256 lane = st[i];
            for (uint256 j = 0; j < 8; j++) out |= bytes32(((lane >> (8 * j)) & 0xff) << (248 - 8 * (8 * i + j)));
        }
    }

    /// `n` Keccak-f[1600] permutations (gas per permutation = (gas(n) - gas(0)) / n).
    function permutations(uint256 n) external pure returns (uint256) {
        uint256[25] memory st;
        uint256[30] memory scratch;
        uint256 a; uint256 b;
        assembly { a := st b := scratch }
        for (uint256 i = 0; i < n; i++) _keccakF(a, b);
        return st[0];
    }

    /// `n` forward NTTs (FIPS 204 Algorithm 41) of a 256-coefficient polynomial mod q.
    function ntts(uint256 n) external pure returns (uint256) {
        uint256[256] memory z;
        uint256[256] memory w;
        // zetas[k] = 1753^brv8(k) mod q
        uint256[256] memory pw;
        pw[0] = 1;
        for (uint256 i = 1; i < 256; i++) pw[i] = mulmod(pw[i - 1], 1753, Q);
        for (uint256 k = 0; k < 256; k++) {
            uint256 r = 0;
            for (uint256 bit = 0; bit < 8; bit++) if ((k >> bit) & 1 == 1) r |= 1 << (7 - bit);
            z[k] = pw[r];
        }
        for (uint256 i = 0; i < 256; i++) w[i] = i * 7919 % Q;
        for (uint256 t = 0; t < n; t++) {
            assembly {
                let k := 0
                for { let len := 128 } gt(len, 0) { len := shr(1, len) } {
                    for { let start := 0 } lt(start, 256) { start := add(start, shl(1, len)) } {
                        k := add(k, 1)
                        let zeta := mload(add(z, shl(5, k)))
                        for { let j := start } lt(j, add(start, len)) { j := add(j, 1) } {
                            let pj := add(w, shl(5, j))
                            let pl := add(pj, shl(5, len))
                            let tt := mulmod(zeta, mload(pl), Q)
                            let aj := mload(pj)
                            mstore(pl, addmod(aj, sub(Q, tt), Q))
                            mstore(pj, addmod(aj, tt, Q))
                        }
                    }
                }
            }
        }
        return w[1];
    }

    /// `n` x 256 pointwise products mod q (as in A*z and c*t1 in the NTT domain).
    function pointwise(uint256 n) external pure returns (uint256 acc) {
        uint256[256] memory x;
        for (uint256 i = 0; i < 256; i++) x[i] = i * 31 + 5;
        for (uint256 t = 0; t < n; t++) {
            assembly {
                for { let i := 0 } lt(i, 256) { i := add(i, 1) } {
                    acc := addmod(acc, mulmod(mload(add(x, shl(5, i))), add(t, 3), Q), Q)
                }
            }
        }
    }
}
