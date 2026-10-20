package evmd

// MsgEVMCall: wire format (must match zetaphy-network/src/pqtx.js), hostile
// bytes, and that the SDK finds the signer from the hand-built descriptor.

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/msgservice"

	"github.com/cosmos/evm/crypto/mldsa44"
	evmencoding "github.com/cosmos/evm/encoding"
)

// The same message is encoded in zetaphy-network/test/pqtx.test.js.
const evmCallVector = "0a2e7a65746170687931646b736e66366c756b71366a773035386a34387376736461" +
	"6a673864717561366e36376c3972122a307830303030303030303030303030303030" +
	"3030303030303030303030303030303030303030303234321a0135220aa9059cbb00" +
	"000000000028c09a0c"

func sampleEVMCall() *MsgEVMCall {
	return &MsgEVMCall{
		Sender:   "zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r",
		To:       "0x0000000000000000000000000000000000000242",
		Value:    "5",
		Data:     []byte{0xa9, 0x05, 0x9c, 0xbb, 0, 0, 0, 0, 0, 0},
		GasLimit: 200000,
	}
}

func TestEVMCallWire(t *testing.T) {
	m := sampleEVMCall()
	b, err := m.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(b); got != evmCallVector {
		t.Fatalf("wire bytes changed:\n got %s\nwant %s", got, evmCallVector)
	}
	if m.Size() != len(b) {
		t.Fatal("Size")
	}
	var back MsgEVMCall
	if err := back.Unmarshal(b); err != nil {
		t.Fatal(err)
	}
	if back.Sender != m.Sender || back.To != m.To || back.Value != m.Value || !bytes.Equal(back.Data, m.Data) || back.GasLimit != m.GasLimit {
		t.Fatalf("round trip: %+v", back)
	}
	// Unknown fields are skipped, empty input is the zero message.
	if err := back.Unmarshal(append(append([]byte{}, b...), 0x30, 0x01)); err != nil || back.GasLimit != 200000 {
		t.Fatal("unknown field", err)
	}
	if err := back.Unmarshal(nil); err != nil || back.Sender != "" {
		t.Fatal("empty")
	}
	r := &MsgEVMCallResponse{Ret: []byte{1, 2}, GasUsed: 21000}
	rb, _ := r.Marshal()
	var rr MsgEVMCallResponse
	if err := rr.Unmarshal(rb); err != nil || rr.GasUsed != 21000 || !bytes.Equal(rr.Ret, r.Ret) {
		t.Fatal("response round trip", err)
	}
}

func TestEVMCallHostileBytes(t *testing.T) {
	b, _ := sampleEVMCall().Marshal()
	for i := range b {
		var m MsgEVMCall
		_ = m.Unmarshal(b[:i]) // truncated: error or a shorter message, never a panic
	}
	for _, bad := range [][]byte{
		{0x0a, 0x7f},             // length past the end
		{0x28, 0x80},             // varint cut off
		{0x0a, 0x00, 0x28},       // tag with no value
		{0xff, 0xff, 0xff, 0xff}, // bad tag
		{0x0a, 0x01, 0xff},       // sender not UTF-8
	} {
		var m MsgEVMCall
		if err := m.Unmarshal(bad); err == nil {
			t.Errorf("%x: accepted", bad)
		}
	}
	// A known field with the wrong wire type is kept as unknown, never read.
	var m MsgEVMCall
	if err := m.Unmarshal([]byte{0x08, 0x01, 0x2a, 0x01, 0x00}); err != nil || m.Sender != "" || m.GasLimit != 0 {
		t.Fatalf("wrong wire types: %+v %v", m, err)
	}
}

func FuzzEVMCallUnmarshal(f *testing.F) {
	b, _ := sampleEVMCall().Marshal()
	f.Add(b)
	f.Fuzz(func(t *testing.T, in []byte) {
		var m MsgEVMCall
		if m.Unmarshal(in) != nil {
			return
		}
		out, _ := m.Marshal()
		var again MsgEVMCall
		if err := again.Unmarshal(out); err != nil || again.Sender != m.Sender || again.To != m.To ||
			again.Value != m.Value || !bytes.Equal(again.Data, m.Data) || again.GasLimit != m.GasLimit {
			t.Fatalf("re-encode differs: %+v vs %+v", m, again)
		}
	})
}

// The ante handler checks the signature of whoever GetSigners names: it must
// be the sender field, read from the descriptor's cosmos.msg.v1.signer option.
func TestEVMCallSigner(t *testing.T) {
	cfg := evmencoding.MakeConfig(77390)
	cfg.InterfaceRegistry.RegisterImplementations((*sdk.Msg)(nil), &MsgEVMCall{})
	msgservice.RegisterMsgServiceDesc(cfg.InterfaceRegistry, &pqCallServiceDesc)
	want := bytes.Repeat([]byte{7}, 20)
	m := sampleEVMCall()
	m.Sender = sdk.AccAddress(want).String()
	other := sdk.AccAddress(bytes.Repeat([]byte{9}, 20)).String()
	for _, msg := range []sdk.Msg{m, &MsgQuantumLock{Signer: m.Sender, Owner: other, Controller: other},
		&MsgPQVoteKey{Operator: m.Sender, PubKey: []byte{1}}} {
		signers, _, err := cfg.Codec.GetMsgV1Signers(msg)
		if err != nil {
			t.Fatal(err)
		}
		if len(signers) != 1 || !bytes.Equal(signers[0], want) {
			t.Fatalf("%T signers %x", msg, signers)
		}
	}
	// Packed in a tx as an Any, it resolves to the same type.
	a, err := codectypes.NewAnyWithValue(m)
	if err != nil || a.TypeUrl != "/zetaphy.pq.v1.MsgEVMCall" {
		t.Fatal(a.TypeUrl, err)
	}
	var back sdk.Msg
	if err := cfg.InterfaceRegistry.UnpackAny(a, &back); err != nil || back.(*MsgEVMCall).Sender != m.Sender {
		t.Fatal("unpack", err)
	}
}

func TestPQMessagesWire(t *testing.T) {
	lock := &MsgQuantumLock{Signer: "a", Owner: "b", Controller: "c"}
	b, _ := lock.Marshal()
	if hex.EncodeToString(b) != "0a01611201621a0163" {
		t.Fatalf("lock %x", b)
	}
	vk := &MsgPQVoteKey{Operator: "o", PubKey: []byte{1}, Proof: []byte{2}, OldKeySig: []byte{3}}
	b, _ = vk.Marshal()
	if hex.EncodeToString(b) != "0a016f1201011a0102220103" {
		t.Fatalf("vote key %x", b)
	}
	c := &MsgEVMCall{Sender: "s", AsOwner: "0xab"}
	b, _ = c.Marshal()
	var back MsgEVMCall
	if err := back.Unmarshal(b); err != nil || back.AsOwner != "0xab" || back.To != "" {
		t.Fatalf("as_owner %+v %v", back, err)
	}
	r := &MsgEVMCallResponse{Created: "0x01"}
	b, _ = r.Marshal()
	var rb MsgEVMCallResponse
	if err := rb.Unmarshal(b); err != nil || rb.Created != "0x01" {
		t.Fatal("created", err)
	}
}

// Vote signatures: the seed file gives the key, a signature checks only for
// the same chain, height and block hash.
func TestPQVoteSignature(t *testing.T) {
	f := filepath.Join(t.TempDir(), "seed")
	if err := os.WriteFile(f, []byte("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sk, pub, err := pqVoteSeed(f)
	if err != nil {
		t.Fatal(err)
	}
	hash := bytes.Repeat([]byte{0xaa}, 32)
	sig, err := pqSign(sk, pqVoteMsg("zetaphy_77390-1", 7, hash))
	if err != nil {
		t.Fatal(err)
	}
	pk := &mldsa44.PubKey{Key: pub}
	if !pk.VerifySignature(pqVoteMsg("zetaphy_77390-1", 7, hash), sig) {
		t.Fatal("own signature")
	}
	for _, bad := range [][]byte{pqVoteMsg("zetaphy-testnet-2", 7, hash), pqVoteMsg("zetaphy_77390-1", 8, hash),
		pqVoteMsg("zetaphy_77390-1", 7, bytes.Repeat([]byte{0xab}, 32))} {
		if pk.VerifySignature(bad, sig) {
			t.Fatal("signature accepted for another vote")
		}
	}
	if err := os.WriteFile(f, []byte("abcd"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := pqVoteSeed(f); err == nil {
		t.Fatal("short seed accepted")
	}
}
