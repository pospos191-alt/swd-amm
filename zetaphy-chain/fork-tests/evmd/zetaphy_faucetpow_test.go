package evmd

// The proof-of-work faucet (evmd/zetaphy_faucetpow.go): zetaphy_faucetPow and
// zetaphy_faucetPowInfo through a real JSON-RPC server (as the node serves
// them), on a stand-in backend that records the transfers it is asked to send.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tmrpctypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/params"
	gethrpc "github.com/ethereum/go-ethereum/rpc"

	"github.com/cosmos/evm/rpc/backend"
	rpctypes "github.com/cosmos/evm/rpc/types"

	"github.com/cosmos/cosmos-sdk/client"
)

const powTestChainID = 77390

// powBackend: the few backend calls the faucet makes.
type powBackend struct {
	backend.BackendI
	latest  uint64
	balance map[common.Address]*big.Int
	sent    []*ethtypes.Transaction
}

func (b *powBackend) blockHash(h uint64) []byte {
	s := sha256.Sum256(binary.BigEndian.AppendUint64([]byte("block"), h))
	return s[:]
}
func (b *powBackend) BlockNumber(context.Context) (hexutil.Uint64, error) {
	return hexutil.Uint64(b.latest), nil
}
func (b *powBackend) CometBlockByNumber(_ context.Context, n rpctypes.BlockNumber) (*tmrpctypes.ResultBlock, error) {
	if n < 1 || uint64(n) > b.latest {
		return nil, fmt.Errorf("no block %d", n)
	}
	return &tmrpctypes.ResultBlock{BlockID: cmttypes.BlockID{Hash: b.blockHash(uint64(n))}, Block: &cmttypes.Block{}}, nil
}
func (b *powBackend) GetBalance(_ context.Context, a common.Address, _ rpctypes.BlockNumberOrHash) (*hexutil.Big, error) {
	if v := b.balance[a]; v != nil {
		return (*hexutil.Big)(v), nil
	}
	return (*hexutil.Big)(big.NewInt(0)), nil
}
func (b *powBackend) GetTransactionCount(context.Context, common.Address, rpctypes.BlockNumber) (*hexutil.Uint64, error) {
	n := hexutil.Uint64(len(b.sent))
	return &n, nil
}
func (b *powBackend) GasPrice(context.Context) (*hexutil.Big, error) {
	return (*hexutil.Big)(big.NewInt(1e9)), nil
}
func (b *powBackend) ChainConfig() *params.ChainConfig {
	return &params.ChainConfig{ChainID: big.NewInt(powTestChainID)}
}
func (b *powBackend) SendRawTransaction(_ context.Context, raw hexutil.Bytes) (common.Hash, error) {
	tx := new(ethtypes.Transaction)
	if err := tx.UnmarshalBinary(raw); err != nil {
		return common.Hash{}, err
	}
	b.sent = append(b.sent, tx)
	return tx.Hash(), nil
}

// mine finds a nonce whose proof has from minBits to maxBits zero bits.
func mine(t *testing.T, b *powBackend, to common.Address, h uint64, minBits, maxBits int) hexutil.Bytes {
	t.Helper()
	nonce := make([]byte, 8)
	for i := uint64(0); i < 1<<26; i++ {
		binary.BigEndian.PutUint64(nonce, i)
		if z := powZeroBits(FaucetPowDigest(powTestChainID, b.blockHash(h), to, nonce)); z >= minBits && z <= maxBits {
			return nonce
		}
	}
	t.Fatal("no proof found")
	return nil
}

type powRPC struct {
	t   *testing.T
	srv *gethrpc.Server
}

// call: one JSON-RPC call over HTTP from remote; the result or the error message.
func (p powRPC) call(remote, method string, params ...any) (json.RawMessage, string) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	r := httptest.NewRequest("POST", "/", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	p.srv.ServeHTTP(w, r)
	var out struct {
		Result json.RawMessage
		Error  *struct{ Message string }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		p.t.Fatalf("%s: %s", method, w.Body.String())
	}
	if out.Error != nil {
		return nil, out.Error.Message
	}
	return out.Result, ""
}

func newPowFaucet(t *testing.T, bits string) (*powBackend, powRPC, string) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if bits != "" {
		if err := os.WriteFile(filepath.Join(home, "config", "faucet-pow-bits"), []byte(bits+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	key, _ := crypto.GenerateKey()
	faucet.Lock()
	faucet.key, faucet.nonce, faucet.day, faucet.count, faucet.last, faucet.powUsed = key, 0, 0, 0, nil, nil
	faucet.Unlock()
	clock := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	faucetNow = func() time.Time { return clock }
	t.Cleanup(func() { faucetNow = time.Now; faucet.key = nil })
	b := &powBackend{latest: 1000, balance: map[common.Address]*big.Int{}}
	srv := gethrpc.NewServer()
	if err := srv.RegisterName(ZetaphyNamespace, &ZetaphyAPI{clientCtx: client.Context{HomeDir: home}, backend: b}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Stop)
	return b, powRPC{t, srv}, home
}

const local = "127.0.0.1:40000"

func claim(rpc powRPC, to common.Address, h uint64, nonce hexutil.Bytes) (json.RawMessage, string) {
	return rpc.call(local, "zetaphy_faucetPow", to.Hex(), hexutil.Uint64(h), nonce)
}

func TestSecurityFaucetPowProof(t *testing.T) {
	b, rpc, _ := newPowFaucet(t, "12")
	alice := common.HexToAddress("0x6af57fC3633dD0F7907f7900dbd4A2822F43a245")
	bob := common.HexToAddress("0x00000000000000000000000000000000000b0b00")

	// info: the difficulty from the operator's file, the reward, the window
	res, e := rpc.call(local, "zetaphy_faucetPowInfo")
	if e != "" {
		t.Fatal(e)
	}
	var info FaucetPowInfo
	if err := json.Unmarshal(res, &info); err != nil {
		t.Fatal(err)
	}
	if !info.Enabled || info.Bits != 12 || info.ChainID != powTestChainID || info.LatestHeight != 1000 || info.MaxAgeBlocks != FaucetPowMaxAge ||
		info.RemainingToday != FaucetPerDay || info.CooldownSeconds != 86400 || info.Reward.ToInt().Cmp(FaucetAmount) != 0 {
		t.Fatalf("info %+v", info)
	}

	h := b.latest - 5
	n := mine(t, b, alice, h, 12, 256)

	// refused before any grant: the proof is for alice at h only
	for name, try := range map[string]func() string{
		"another address":  func() string { _, e := claim(rpc, bob, h, n); return e },
		"another height":   func() string { _, e := claim(rpc, alice, h-1, n); return e },
		"a future block":   func() string { _, e := claim(rpc, alice, b.latest+1, n); return e },
		"height 0":         func() string { _, e := claim(rpc, alice, 0, n); return e },
		"a 7-byte nonce":   func() string { _, e := claim(rpc, alice, h, n[:7]); return e },
		"a 9-byte nonce":   func() string { _, e := claim(rpc, alice, h, append(append([]byte{}, n...), 0)); return e },
		"a bad address":    func() string { _, e := rpc.call(local, "zetaphy_faucetPow", "0x1234", hexutil.Uint64(h), n); return e },
		"not over http":    func() string { return inproc(rpc.srv, alice, h, n) },
		"another machine":  func() string { _, e := rpc.call("203.0.113.5:1234", "zetaphy_faucetPow", alice.Hex(), hexutil.Uint64(h), n); return e },
		"a private subnet": func() string { _, e := rpc.call("10.0.0.2:1234", "zetaphy_faucetPow", alice.Hex(), hexutil.Uint64(h), n); return e },
	} {
		if e := try(); e == "" {
			t.Errorf("%s: accepted", name)
		}
	}
	if len(b.sent) != 0 {
		t.Fatalf("sent %d", len(b.sent))
	}

	// the proof works once
	res, e = claim(rpc, alice, h, n)
	if e != "" {
		t.Fatal(e)
	}
	var fr FaucetResult
	_ = json.Unmarshal(res, &fr)
	if len(b.sent) != 1 || *b.sent[0].To() != alice || b.sent[0].Value().Cmp(FaucetAmount) != 0 || fr.TxHash != b.sent[0].Hash().Hex() {
		t.Fatalf("grant %+v", fr)
	}
	if b.sent[0].ChainId().Int64() != powTestChainID {
		t.Error("chain id")
	}
	// replayed: refused as used, even with the cooldown out of the way
	faucet.Lock()
	delete(faucet.last, alice)
	faucet.Unlock()
	if _, e := claim(rpc, alice, h, n); !strings.Contains(e, "used already") {
		t.Errorf("replay: %q", e)
	}
	// a new proof for the same address: the cooldown shared with zetaphy_faucet
	faucet.Lock()
	faucet.last[alice] = faucetNow()
	faucet.Unlock()
	h2 := b.latest - 1
	n2 := mine(t, b, alice, h2, 12, 256)
	if _, e := claim(rpc, alice, h2, n2); !strings.Contains(e, "less than a day") {
		t.Errorf("cooldown: %q", e)
	}
	clock := faucetNow().Add(25 * time.Hour)
	faucetNow = func() time.Time { return clock }
	if _, e := claim(rpc, alice, h2, n2); e != "" {
		t.Errorf("after a day: %q", e)
	}
	if len(b.sent) != 2 {
		t.Fatalf("sent %d", len(b.sent))
	}
}

// inproc: the same call in-process (not "http"): refused like websocket.
func inproc(srv *gethrpc.Server, to common.Address, h uint64, n hexutil.Bytes) string {
	c := gethrpc.DialInProc(srv)
	defer c.Close()
	var out FaucetResult
	if err := c.Call(&out, "zetaphy_faucetPow", to.Hex(), hexutil.Uint64(h), n); err != nil {
		return err.Error()
	}
	return ""
}

func TestSecurityFaucetPowAgeAndDifficulty(t *testing.T) {
	b, rpc, home := newPowFaucet(t, "12")
	a := func(i int) common.Address { return common.BigToAddress(big.NewInt(int64(0x1000 + i))) }

	// the oldest block still allowed, and the first one too old
	oldest := b.latest - (FaucetPowMaxAge - 1)
	if _, e := claim(rpc, a(1), oldest, mine(t, b, a(1), oldest, 12, 256)); e != "" {
		t.Errorf("block %d of the last %d: %q", oldest, FaucetPowMaxAge, e)
	}
	if _, e := claim(rpc, a(2), oldest-1, mine(t, b, a(2), oldest-1, 12, 256)); !strings.Contains(e, "too old") {
		t.Errorf("too old: %q", e)
	}
	// the used pair is forgotten once its block is too old to be used anyway
	b.latest += FaucetPowMaxAge
	if _, e := claim(rpc, a(3), b.latest, mine(t, b, a(3), b.latest, 12, 256)); e != "" {
		t.Fatal(e)
	}
	faucet.Lock()
	if len(faucet.powUsed) != 1 {
		t.Errorf("used pairs kept: %d", len(faucet.powUsed))
	}
	faucet.Unlock()

	// too little work for the difficulty
	weak := mine(t, b, a(4), b.latest, 12, 15)
	if err := os.WriteFile(filepath.Join(home, "config", "faucet-pow-bits"), []byte("16"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, e := claim(rpc, a(4), b.latest, weak); !strings.Contains(e, "16 are needed") {
		t.Errorf("low difficulty: %q", e)
	}
	// an operator's value out of range is ignored: the default difficulty
	for _, v := range []string{"3", "64", "x", ""} {
		_ = os.WriteFile(filepath.Join(home, "config", "faucet-pow-bits"), []byte(v), 0o600)
		res, _ := rpc.call(local, "zetaphy_faucetPowInfo")
		var info FaucetPowInfo
		_ = json.Unmarshal(res, &info)
		if info.Bits != FaucetPowBits {
			t.Errorf("bits file %q: %d", v, info.Bits)
		}
	}
	if _, e := claim(rpc, a(4), b.latest, weak); !strings.Contains(e, fmt.Sprintf("%d are needed", FaucetPowBits)) {
		t.Errorf("default difficulty: %q", e)
	}
}

func TestSecurityFaucetPowSharedLimits(t *testing.T) {
	b, rpc, _ := newPowFaucet(t, "12")
	a := func(i int) common.Address { return common.BigToAddress(big.NewInt(int64(0x2000 + i))) }

	// an address that already holds the reward gets nothing
	b.balance[a(1)] = new(big.Int).Set(FaucetAmount)
	if _, e := claim(rpc, a(1), b.latest, mine(t, b, a(1), b.latest, 12, 256)); !strings.Contains(e, "already has") {
		t.Errorf("funded address: %q", e)
	}
	// a proof refused for a limit is not used up
	delete(b.balance, a(1))
	if _, e := claim(rpc, a(1), b.latest, mine(t, b, a(1), b.latest, 12, 256)); e != "" {
		t.Errorf("after the balance moved: %q", e)
	}

	// the daily cap, shared with zetaphy_faucet
	faucet.Lock()
	faucet.count = FaucetPerDay - 1
	faucet.Unlock()
	res, _ := rpc.call(local, "zetaphy_faucetPowInfo")
	var info FaucetPowInfo
	_ = json.Unmarshal(res, &info)
	if info.RemainingToday != 1 {
		t.Errorf("remaining %d", info.RemainingToday)
	}
	if _, e := claim(rpc, a(2), b.latest, mine(t, b, a(2), b.latest, 12, 256)); e != "" {
		t.Fatal(e)
	}
	if _, e := claim(rpc, a(3), b.latest, mine(t, b, a(3), b.latest, 12, 256)); !strings.Contains(e, "today's") {
		t.Errorf("over the cap: %q", e)
	}
	if _, e := rpc.call(local, "zetaphy_faucet", a(4).Hex()); !strings.Contains(e, "today's") {
		t.Errorf("zetaphy_faucet over the shared cap: %q", e)
	}
	// a new UTC day
	clock := faucetNow().Add(24 * time.Hour)
	faucetNow = func() time.Time { return clock }
	if _, e := claim(rpc, a(3), b.latest, mine(t, b, a(3), b.latest, 12, 256)); e != "" {
		t.Errorf("next day: %q", e)
	}
	// zetaphy_faucet and zetaphy_faucetPow share the per-address cooldown
	if _, e := rpc.call(local, "zetaphy_faucet", a(3).Hex()); !strings.Contains(e, "less than a day") {
		t.Errorf("zetaphy_faucet after a PoW grant: %q", e)
	}
	if len(b.sent) != 3 {
		t.Errorf("sent %d", len(b.sent))
	}
}
