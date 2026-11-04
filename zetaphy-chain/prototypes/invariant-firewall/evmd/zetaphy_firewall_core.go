package evmd

// ZETAPHY invariant firewall, chain layer: the consensus-relevant pure logic
// (PROTOTYPE, docs/future/invariant-firewall.md). Standard library only, so it
// is tested on its own here (go test in this directory); zetaphy_firewall.go
// next to it wires it into the node and is NOT part of setup-node.sh's patch
// yet (build tag zetaphy_firewall_prototype).
//
// The node reads InvariantFirewall.chainCheck() — the chain-layer protocols
// and a bit mask of those whose invariants do not hold — on the state after
// every successful EVM transaction. A protocol that is broken after the
// transaction but was not broken at the last check point (the start of the
// block, or the previous transaction of the block that passed) reverts the
// transaction. A protocol already broken at the check point does not revert
// anything (it was not this transaction, and reverting every transaction
// would halt the chain); the contract layer and CircuitBreaker deal with it.

import (
	"bytes"
	"errors"
)

const (
	firewallCallGas  = 3_000_000 // InvariantFirewall.CHAIN_CALL_GAS
	firewallMaxChain = 8         // InvariantFirewall.MAX_CHAIN
	firewallMaxRet   = 96 + 32*firewallMaxChain
)

// firewallChainCheckSelector: chainCheck().
var firewallChainCheckSelector = []byte{0x2c, 0x3f, 0x8f, 0x2b}

type fwAddr = [20]byte

// fwSmall decodes a 32-byte ABI word that must fit in a uint64.
func fwSmall(w []byte) (uint64, bool) {
	for _, b := range w[:24] {
		if b != 0 {
			return 0, false
		}
	}
	var v uint64
	for _, b := range w[24:32] {
		v = v<<8 | uint64(b)
	}
	return v, true
}

// firewallDecode strictly decodes chainCheck()'s answer
// (address[] protocols, uint256 brokenMask). Anything else is an error.
func firewallDecode(ret []byte) ([]fwAddr, uint64, error) {
	if len(ret) < 96 || len(ret) > firewallMaxRet || len(ret)%32 != 0 {
		return nil, 0, errors.New("chainCheck: answer of the wrong size")
	}
	off, ok1 := fwSmall(ret[0:32])
	mask, ok2 := fwSmall(ret[32:64])
	n, ok3 := fwSmall(ret[64:96])
	if !ok1 || !ok2 || !ok3 || off != 64 || n > firewallMaxChain || uint64(len(ret)) != 96+32*n {
		return nil, 0, errors.New("chainCheck: malformed answer")
	}
	if mask>>n != 0 {
		return nil, 0, errors.New("chainCheck: mask names a protocol that is not listed")
	}
	list := make([]fwAddr, 0, n)
	for i := uint64(0); i < n; i++ {
		w := ret[96+32*i : 128+32*i]
		if !bytes.Equal(w[:12], make([]byte, 12)) {
			return nil, 0, errors.New("chainCheck: malformed address")
		}
		var a fwAddr
		copy(a[:], w[12:])
		for _, b := range list {
			if b == a {
				return nil, 0, errors.New("chainCheck: a protocol listed twice")
			}
		}
		list = append(list, a)
	}
	return list, mask, nil
}

// firewallNewlyBroken: the protocols broken now (by the mask), and those of
// them that were not broken at the check point (baseline): the ones this
// transaction broke.
func firewallNewlyBroken(baseline, list []fwAddr, mask uint64) (broken, newly []fwAddr) {
	for i, a := range list {
		if (mask>>uint(i))&1 == 0 { // #nosec G115 -- i < firewallMaxChain
			continue
		}
		broken = append(broken, a)
		was := false
		for _, b := range baseline {
			if b == a {
				was = true
				break
			}
		}
		if !was {
			newly = append(newly, a)
		}
	}
	return broken, newly
}

// firewallEncodeSet / firewallDecodeSet: the baseline in the store (20 bytes each).
func firewallEncodeSet(set []fwAddr) []byte {
	out := make([]byte, 0, 20*len(set))
	for _, a := range set {
		out = append(out, a[:]...)
	}
	return out
}

func firewallDecodeSet(b []byte) ([]fwAddr, error) {
	if len(b)%20 != 0 || len(b) > 20*firewallMaxChain {
		return nil, errors.New("firewall baseline: corrupt")
	}
	set := make([]fwAddr, len(b)/20)
	for i := range set {
		copy(set[i][:], b[20*i:])
	}
	return set, nil
}
