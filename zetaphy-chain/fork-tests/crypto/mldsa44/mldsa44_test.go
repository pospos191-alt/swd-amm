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

func TestUnmarshalHostileInput(t *testing.T) {
	for _, bz := range [][]byte{
		{0x0a},                         // tag, no length
		{0x0a, 0xff, 0xff, 0xff, 0x0f}, // length far past the end
		{0x0a, 0x05, 1, 2},             // short value
		{0xff},                         // bad tag
		{0x10, 0x01, 0x0a, 0x01, 0x07}, // unknown varint field, then key
	} {
		var k PubKey
		err := k.Unmarshal(bz)
		if len(bz) == 5 && bz[0] == 0x10 {
			if err != nil || len(k.Key) != 1 || k.Key[0] != 7 {
				t.Fatalf("unknown field not skipped: %v %v", err, k.Key)
			}
			continue
		}
		if err == nil {
			t.Fatalf("accepted %x", bz)
		}
	}
	// a valid key survives MarshalToSizedBuffer into a larger buffer
	pub, _ := newKey(t)
	buf := make([]byte, pub.Size()+10)
	n, _ := pub.MarshalToSizedBuffer(buf)
	var back PubKey
	if err := back.Unmarshal(buf[len(buf)-n:]); err != nil || !back.Equals(pub) {
		t.Fatal("MarshalToSizedBuffer")
	}
}

func FuzzUnmarshalVerify(f *testing.F) {
	f.Add([]byte{0x0a, 0x02, 1, 2}, []byte("msg"), []byte{1})
	f.Fuzz(func(t *testing.T, bz, msg, sig []byte) {
		var k PubKey
		if k.Unmarshal(bz) != nil {
			return
		}
		_ = k.Valid()
		if k.VerifySignature(msg, sig) {
			t.Fatal("random input verified")
		}
		out, _ := k.Marshal()
		var again PubKey
		if again.Unmarshal(out) != nil || string(again.Key) != string(k.Key) {
			t.Fatal("round trip")
		}
	})
}
