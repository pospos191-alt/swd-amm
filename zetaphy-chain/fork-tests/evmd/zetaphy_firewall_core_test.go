//go:build test

package evmd

// The invariant firewall's pure logic (zetaphy_firewall_core.go): strict decoding of the registry,
// the contract's bounds enforced again by the node, the per-transaction gas budget, the checker
// answer rule and the newly-broken rule. zetaphy_firewall_test.go runs the same code on the EVM.

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
)

func fwWord(v uint64) []byte {
	w := make([]byte, 32)
	for i := 0; i < 8; i++ {
		w[31-i] = byte(v >> (8 * i))
	}
	return w
}

func fwA(b byte) fwAddr { var a fwAddr; a[19] = b; return a }

func fwAddrWord(a fwAddr) []byte { return append(make([]byte, 12), a[:]...) }

func fwProtocolsAnswer(addrs ...fwAddr) []byte {
	out := append(fwWord(32), fwWord(uint64(len(addrs)))...)
	for _, a := range addrs {
		out = append(out, fwAddrWord(a)...)
	}
	return out
}

func fwInvariantsAnswer(invs ...fwInvariant) []byte {
	out := append(fwWord(32), fwWord(uint64(len(invs)))...)
	for _, v := range invs {
		out = append(out, fwAddrWord(v.Checker)...)
		out = append(out, fwWord(v.Gas)...)
		out = append(out, v.Name[:]...)
	}
	return out
}

func TestFirewallCoreDecodeProtocols(t *testing.T) {
	list, err := firewallDecodeProtocols(fwProtocolsAnswer())
	require.NoError(t, err)
	require.Empty(t, list)
	all := []fwAddr{fwA(1), fwA(2), fwA(3), fwA(4), fwA(5), fwA(6), fwA(7), fwA(8)}
	list, err = firewallDecodeProtocols(fwProtocolsAnswer(all...))
	require.NoError(t, err)
	require.Equal(t, all, list, "registry order kept")

	bad := map[string][]byte{
		"nine protocols":   fwProtocolsAnswer(append(all, fwA(9))...),
		"duplicate":        fwProtocolsAnswer(fwA(1), fwA(1)),
		"zero address":     fwProtocolsAnswer(fwAddr{}),
		"empty":            nil,
		"short":            fwWord(32),
		"not words":        append(fwProtocolsAnswer(fwA(1)), 0),
		"trailing word":    append(fwProtocolsAnswer(fwA(1)), fwWord(0)...),
		"length too big":   append(append(fwWord(32), fwWord(2)...), fwAddrWord(fwA(1))...),
		"wrong offset":     append(append(fwWord(64), fwWord(1)...), fwAddrWord(fwA(1))...),
		"huge length":      append(append(fwWord(32), append(bytes.Repeat([]byte{0xff}, 24), make([]byte, 8)...)...), fwAddrWord(fwA(1))...),
		"dirty address":    append(append(fwWord(32), fwWord(1)...), append([]byte{1}, make([]byte, 31)...)...),
		"far too long":     make([]byte, 64+32*9),
		"empty but padded": append(fwProtocolsAnswer(), fwWord(0)...),
	}
	for name, ret := range bad {
		_, err := firewallDecodeProtocols(ret)
		require.Error(t, err, name)
	}
}

func TestFirewallCoreDecodeInvariants(t *testing.T) {
	inv := func(b byte, gas uint64) fwInvariant {
		return fwInvariant{Checker: fwA(b), Gas: gas, Name: [32]byte{'x', b}}
	}
	eight := []fwInvariant{inv(1, 5_000), inv(2, 500_000), inv(3, 6_000), inv(4, 7_000), inv(5, 8_000), inv(6, 9_000), inv(7, 10_000), inv(8, 11_000)}
	got, err := firewallDecodeInvariants(fwInvariantsAnswer(eight...))
	require.NoError(t, err)
	require.Equal(t, eight, got)
	got, err = firewallDecodeInvariants(fwInvariantsAnswer())
	require.NoError(t, err)
	require.Empty(t, got)

	for name, c := range map[string]struct {
		ret  []byte
		want string
	}{
		"nine invariants":   {fwInvariantsAnswer(append(eight, inv(9, 5_000))...), "more than 8"},
		"cap below 5,000":   {fwInvariantsAnswer(inv(1, 4_999)), "gas cap"},
		"cap above 500,000": {fwInvariantsAnswer(inv(1, 500_001)), "gas cap"},
		"cap not a uint32":  {fwInvariantsAnswer(inv(1, 1<<32)), "malformed"},
		"zero checker":      {fwInvariantsAnswer(fwInvariant{Gas: 5_000}), "malformed"},
		"same checker":      {fwInvariantsAnswer(inv(1, 5_000), inv(1, 6_000)), "twice"},
		"cut short":         {fwInvariantsAnswer(inv(1, 5_000))[:64+64], "invariantsOf"},
		"empty":             {nil, "invariantsOf"},
	} {
		_, err := firewallDecodeInvariants(c.ret)
		require.ErrorContains(t, err, c.want, name)
	}
}

func TestFirewallCoreHolds(t *testing.T) {
	yes := fwWord(1)
	require.True(t, firewallHoldsOK(true, yes))
	require.False(t, firewallHoldsOK(false, yes), "revert or out of gas")
	require.False(t, firewallHoldsOK(true, fwWord(0)), "false")
	require.False(t, firewallHoldsOK(true, fwWord(2)), "2 is not a bool")
	require.False(t, firewallHoldsOK(true, append(fwWord(1), fwWord(1)...)), "64 bytes")
	require.False(t, firewallHoldsOK(true, nil), "nothing")
	require.False(t, firewallHoldsOK(true, append([]byte{1}, yes[1:]...)), "high bits set")
	data := firewallCalldataHolds([]byte{0xaa, 0xbb, 0xcc, 0xdd}, fwA(7))
	require.Equal(t, append([]byte{0xaa, 0xbb, 0xcc, 0xdd}, fwAddrWord(fwA(7))...), data)
}

func TestFirewallCoreBudget(t *testing.T) {
	four := []fwInvariant{{Gas: 500_000}, {Gas: 500_000}, {Gas: 500_000}, {Gas: 500_000}}
	used, ok := firewallBudget(0, four)
	require.True(t, ok)
	require.Equal(t, uint64(2_000_000), used, "exactly the budget fits")
	used2, ok := firewallBudget(used, []fwInvariant{{Gas: 5_000}})
	require.False(t, ok, "nothing more fits")
	require.Equal(t, used, used2, "a protocol that does not fit takes nothing")
	used, ok = firewallBudget(1_995_000, []fwInvariant{{Gas: 5_000}})
	require.True(t, ok)
	require.Equal(t, uint64(2_000_000), used)
	// the worst case the registry can ask for stays bounded: 8 protocols x 8 x 500,000
	var total uint64
	n := 0
	for p := 0; p < firewallMaxProtocols; p++ {
		invs := make([]fwInvariant, firewallMaxInvariants)
		for i := range invs {
			invs[i].Gas = firewallMaxCheckGas
		}
		if u, ok := firewallBudget(total, invs); ok {
			total, n = u, n+1
		}
	}
	require.Zero(t, n, "4,000,000 gas of checks for one protocol never fits")
	require.LessOrEqual(t, total, uint64(firewallTxGasBudget))
}

func TestFirewallCoreNewlyBroken(t *testing.T) {
	list := []fwAddr{fwA(1), fwA(2), fwA(3)}
	now, newly := firewallNewlyBroken(nil, list, []bool{true, false, true})
	require.Equal(t, []fwAddr{fwA(1), fwA(3)}, now)
	require.Equal(t, now, newly)
	now, newly = firewallNewlyBroken([]fwAddr{fwA(3)}, list, []bool{true, false, true})
	require.Equal(t, []fwAddr{fwA(1), fwA(3)}, now)
	require.Equal(t, []fwAddr{fwA(1)}, newly, "already broken at the check point: not this tx")
	now, newly = firewallNewlyBroken([]fwAddr{fwA(1)}, list, []bool{false, false, false})
	require.Empty(t, now)
	require.Empty(t, newly)
	_, newly = firewallNewlyBroken(nil, list, []bool{true}) // shorter answer: only what it says
	require.Equal(t, []fwAddr{fwA(1)}, newly)

	// the stored set round-trips; corrupt values are refused
	set, err := firewallDecodeSet(firewallEncodeSet(list))
	require.NoError(t, err)
	require.Equal(t, list, set)
	set, err = firewallDecodeSet(nil)
	require.NoError(t, err)
	require.Empty(t, set)
	_, err = firewallDecodeSet(make([]byte, 21))
	require.Error(t, err)
	_, err = firewallDecodeSet(make([]byte, 20*9))
	require.Error(t, err)
}
