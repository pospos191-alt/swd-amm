package mldsa44

import (
	"crypto/rand"
	"crypto/sha256"
	"testing"

	"github.com/cloudflare/circl/sign/mldsa/mldsa44"
	gogoproto "github.com/cosmos/gogoproto/proto"
)

func newKey(t *testing.T) (*PubKey, *mldsa44.PrivateKey) {
	pk, sk, err := mldsa44.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := pk.MarshalBinary()
	return &PubKey{Key: b}, sk
}

func TestSignVerifyAndAddress(t *testing.T) {
	pub, sk := newKey(t)
	msg := []byte("sign doc bytes")
	sig := make([]byte, SignatureSize)
	if err := mldsa44.SignTo(sk, msg, nil, true, sig); err != nil {
		t.Fatal(err)
	}
	if !pub.VerifySignature(msg, sig) {
		t.Fatal("valid signature rejected")
	}
	if pub.VerifySignature([]byte("other"), sig) {
		t.Fatal("signature over other bytes accepted")
	}
	sig[0] ^= 1
	if pub.VerifySignature(msg, sig) {
		t.Fatal("tampered signature accepted")
	}
	if pub.VerifySignature(msg, sig[:100]) || (&PubKey{Key: pub.Key[:10]}).VerifySignature(msg, sig) {
		t.Fatal("wrong sizes accepted")
	}
	h := sha256.Sum256(pub.Key)
	if string(pub.Address()) != string(h[:20]) {
		t.Fatal("address is not sha256(key)[:20]")
	}
	other, _ := newKey(t)
	if pub.Equals(other) || !pub.Equals(&PubKey{Key: append([]byte{}, pub.Key...)}) {
		t.Fatal("Equals")
	}
}

func TestProtoRoundTripAndRegistry(t *testing.T) {
	pub, _ := newKey(t)
	bz, err := pub.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var back PubKey
	if err := back.Unmarshal(bz); err != nil || !back.Equals(pub) {
		t.Fatalf("round trip: %v", err)
	}
	if gogoproto.MessageName(pub) != ProtoName {
		t.Fatalf("registered name %q", gogoproto.MessageName(pub))
	}
	if gogoproto.FileDescriptor(protoFile) == nil {
		t.Fatal("file descriptor not registered")
	}
}
