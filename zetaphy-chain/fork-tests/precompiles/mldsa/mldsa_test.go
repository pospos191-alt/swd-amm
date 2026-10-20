package mldsa

import (
	"crypto/rand"
	"testing"

	"github.com/cloudflare/circl/sign/mldsa/mldsa44"
	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
)

func pack(variant byte, msg, pk, sig []byte) []byte {
	out := append([]byte{variant}, msg...)
	out = append(out, pk...)
	return append(out, sig...)
}

func TestMLDSA44(t *testing.T) {
	pk, sk, err := mldsa44.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	msg := make([]byte, 32)
	_, _ = rand.Read(msg)
	sig := make([]byte, mldsa44.SignatureSize)
	if err := mldsa44.SignTo(sk, msg, nil, false, sig); err != nil {
		t.Fatal(err)
	}
	pkb, _ := pk.MarshalBinary()
	if !Verify(pack(44, msg, pkb, sig)) {
		t.Fatal("valid signature rejected")
	}
	bad := append([]byte{}, msg...)
	bad[0] ^= 1
	if Verify(pack(44, bad, pkb, sig)) {
		t.Fatal("signature over another message accepted")
	}
	sig[10] ^= 1
	if Verify(pack(44, msg, pkb, sig)) {
		t.Fatal("tampered signature accepted")
	}
	if Verify(pack(65, msg, pkb, sig)) || Verify(pack(44, msg, pkb, sig[:100])) || Verify([]byte{44}) || Verify(nil) {
		t.Fatal("malformed input accepted")
	}
}

func TestMLDSA65(t *testing.T) {
	pk, sk, _ := mldsa65.GenerateKey(rand.Reader)
	msg := make([]byte, 32)
	sig := make([]byte, mldsa65.SignatureSize)
	if err := mldsa65.SignTo(sk, msg, nil, true, sig); err != nil {
		t.Fatal(err)
	}
	pkb, _ := pk.MarshalBinary()
	if !Verify(pack(65, msg, pkb, sig)) {
		t.Fatal("valid signature rejected")
	}
}

func TestGas(t *testing.T) {
	var p Precompile
	if p.RequiredGas([]byte{44}) != VerifyGas44 || p.RequiredGas([]byte{65}) != VerifyGas65 || p.RequiredGas(nil) != InvalidInputGas {
		t.Fatal("gas")
	}
}

// FuzzVerify: no input, however malformed, may panic (a panic in a
// precompile would halt the chain) or be accepted without a valid signature.
func FuzzVerify(f *testing.F) {
	pk, sk, _ := mldsa44.GenerateKey(rand.Reader)
	pkb, _ := pk.MarshalBinary()
	msg := make([]byte, 32)
	sig := make([]byte, mldsa44.SignatureSize)
	_ = mldsa44.SignTo(sk, msg, nil, false, sig)
	good := pack(44, msg, pkb, sig)
	f.Add(good)
	f.Add([]byte{})
	f.Add([]byte{65})
	f.Add(good[:100])
	f.Fuzz(func(t *testing.T, in []byte) {
		ok := Verify(in) // must not panic
		if ok && len(in) != len(good) {
			t.Fatalf("accepted an input of the wrong size (%d bytes)", len(in))
		}
	})
}

// Measures verification time, to keep the gas price honest. For scale: the
// ECRECOVER precompile costs 3,000 gas for roughly 25-50 microseconds.
func BenchmarkVerify44(b *testing.B) {
	pk, sk, _ := mldsa44.GenerateKey(rand.Reader)
	pkb, _ := pk.MarshalBinary()
	msg := make([]byte, 32)
	sig := make([]byte, mldsa44.SignatureSize)
	_ = mldsa44.SignTo(sk, msg, nil, false, sig)
	in := pack(44, msg, pkb, sig)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if !Verify(in) {
			b.Fatal("rejected")
		}
	}
}

func BenchmarkVerify65(b *testing.B) {
	pk, sk, _ := mldsa65.GenerateKey(rand.Reader)
	pkb, _ := pk.MarshalBinary()
	msg := make([]byte, 32)
	sig := make([]byte, mldsa65.SignatureSize)
	_ = mldsa65.SignTo(sk, msg, nil, false, sig)
	in := pack(65, msg, pkb, sig)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if !Verify(in) {
			b.Fatal("rejected")
		}
	}
}
