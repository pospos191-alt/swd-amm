package evmd

// Tests of the chain layer's pure logic (zetaphy_firewall_core.go). Runs with the standard library only:
//
//	cd zetaphy-chain/prototypes/invariant-firewall/evmd && go test .
//
// The answer bytes below are what InvariantFirewall.chainCheck() (and the fake firewall used by the
// integration test sketch) return; zetaphy-network/test/firewall.test.js checks the contract side.

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func fwWord(v uint64) []byte {
	w := make([]byte, 32)
	for i := 0; i < 8; i++ {
		w[31-i] = byte(v >> (8 * i))
	}
	return w
}

func fwAnswer(mask uint64, addrs ...fwAddr) []byte {
	out := append(fwWord(64), fwWord(mask)...)
	out = append(out, fwWord(uint64(len(addrs)))...)
	for _, a := range addrs {
		out = append(out, make([]byte, 12)...)
		out = append(out, a[:]...)
	}
	return out
}

func fwA(b byte) fwAddr { var a fwAddr; a[19] = b; return a }

func TestFirewallDecode(t *testing.T) {
	// exactly what the EVM returned for chainCheck() with one protocol 0x…f1 broken (from the JS EVM)
	raw, _ := hex.DecodeString("0000000000000000000000000000000000000000000000000000000000000040" +
		"0000000000000000000000000000000000000000000000000000000000000001" +
		"0000000000000000000000000000000000000000000000000000000000000001" +
		"00000000000000000000000000000000000000000000000000000000000000f1")
	list, mask, err := firewallDecode(raw)
	if err != nil || len(list) != 1 || list[0] != fwA(0xf1) || mask != 1 {
		t.Fatalf("decode: %v %v %v", list, mask, err)
	}
	if !bytes.Equal(raw, fwAnswer(1, fwA(0xf1))) {
		t.Fatal("the test encoder agrees with the EVM")
	}
	// empty list
	list, mask, err = firewallDecode(fwAnswer(0))
	if err != nil || len(list) != 0 || mask != 0 {
		t.Fatalf("empty: %v %v %v", list, mask, err)
	}
	// eight protocols, all broken
	all := []fwAddr{fwA(1), fwA(2), fwA(3), fwA(4), fwA(5), fwA(6), fwA(7), fwA(8)}
	list, mask, err = firewallDecode(fwAnswer(0xff, all...))
	if err != nil || len(list) != 8 || mask != 0xff {
		t.Fatalf("eight: %v %v %v", list, mask, err)
	}

	bad := map[string][]byte{
		"nothing":          nil,
		"short":            raw[:64],
		"not words":        append(append([]byte{}, raw...), 0),
		"wrong offset":     append(fwWord(32), raw[32:]...),
		"mask beyond list": fwAnswer(2, fwA(1)),
		"huge mask":        append(append(fwWord(64), append([]byte{1}, make([]byte, 31)...)...), raw[64:]...),
		"nine protocols":   fwAnswer(0, append(all, fwA(9))...),
		"length mismatch":  append(fwAnswer(0, fwA(1)), make([]byte, 32)...),
		"dirty address":    append(append([]byte{}, raw[:96]...), append([]byte{1}, raw[97:]...)...),
		"listed twice":     fwAnswer(0, fwA(1), fwA(1)),
	}
	for name, b := range bad {
		if _, _, err := firewallDecode(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestFirewallNewlyBroken(t *testing.T) {
	list := []fwAddr{fwA(1), fwA(2), fwA(3)}
	// nothing broken
	broken, newly := firewallNewlyBroken(nil, list, 0)
	if len(broken) != 0 || len(newly) != 0 {
		t.Fatal("nothing broken")
	}
	// the transaction broke protocol 2: revert
	broken, newly = firewallNewlyBroken(nil, list, 0b010)
	if len(broken) != 1 || len(newly) != 1 || newly[0] != fwA(2) {
		t.Fatalf("newly broken: %v %v", broken, newly)
	}
	// protocol 2 was already broken at the check point: not this transaction's doing
	broken, newly = firewallNewlyBroken([]fwAddr{fwA(2)}, list, 0b010)
	if len(broken) != 1 || len(newly) != 0 {
		t.Fatalf("already broken: %v %v", broken, newly)
	}
	// ... but breaking another one still reverts
	_, newly = firewallNewlyBroken([]fwAddr{fwA(2)}, list, 0b110)
	if len(newly) != 1 || newly[0] != fwA(3) {
		t.Fatalf("another one: %v", newly)
	}
	// a protocol that healed and is broken again by a later transaction counts as new: the
	// baseline after a passing transaction is what is broken then
	broken, _ = firewallNewlyBroken([]fwAddr{fwA(2)}, list, 0)
	_, newly = firewallNewlyBroken(broken, list, 0b010)
	if len(newly) != 1 {
		t.Fatal("re-broken after healing")
	}
	// the order of the list may change between calls (dropChain swaps): addresses, not indexes, matter
	_, newly = firewallNewlyBroken([]fwAddr{fwA(2)}, []fwAddr{fwA(3), fwA(2), fwA(1)}, 0b010)
	if len(newly) != 0 {
		t.Fatal("reordered list")
	}
}

func TestFirewallSet(t *testing.T) {
	set := []fwAddr{fwA(1), fwA(0xf1)}
	got, err := firewallDecodeSet(firewallEncodeSet(set))
	if err != nil || len(got) != 2 || got[0] != set[0] || got[1] != set[1] {
		t.Fatalf("round trip: %v %v", got, err)
	}
	if got, err := firewallDecodeSet(nil); err != nil || len(got) != 0 {
		t.Fatal("empty")
	}
	if _, err := firewallDecodeSet(make([]byte, 21)); err == nil {
		t.Fatal("corrupt length accepted")
	}
	if _, err := firewallDecodeSet(make([]byte, 20*9)); err == nil {
		t.Fatal("too many accepted")
	}
}
