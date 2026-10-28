package evmd

// rpc-guard (evmd/zetaphy_rpcguard.go): the public RPC filter in front of
// CometBFT and the EVM JSON-RPC. Backends here are stand-ins that record
// what reaches them; the CometBFT one decodes bodies with CometBFT's own
// request type, as its server does.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	rpctypes "github.com/cometbft/cometbft/rpc/jsonrpc/types"
)

type recorder struct {
	mu     sync.Mutex
	paths  []string
	bodies []string
}

func (rc *recorder) server(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rc.mu.Lock()
		rc.paths = append(rc.paths, r.URL.Path)
		rc.bodies = append(rc.bodies, string(b))
		rc.mu.Unlock()
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	t.Cleanup(s.Close)
	return s
}

func (rc *recorder) count() int { rc.mu.Lock(); defer rc.mu.Unlock(); return len(rc.paths) }

func newTestGuard(t *testing.T, cfg GuardConfig) (*Guard, *recorder, *recorder) {
	comet, evm := &recorder{}, &recorder{}
	cfg.Comet, cfg.EVM = comet.server(t).URL, evm.server(t).URL
	if cfg.PerMinute == 0 {
		cfg.PerMinute = 1000
	}
	if cfg.MaxInFlight == 0 {
		cfg.MaxInFlight = 8
	}
	g, err := NewGuard(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return g, comet, evm
}

func do(h http.Handler, method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:5555"
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSecurityRPCGuardComet(t *testing.T) {
	g, comet, _ := newTestGuard(t, GuardConfig{FaucetPerDay: 3})
	h := g.CometHandler()
	cases := []struct {
		method, target, body string
		want                 int
	}{
		{"GET", "/status", "", 200},
		{"GET", "/block?height=5", "", 200},
		{"GET", "/tx_search?query=%22tx.height%3E1%22&per_page=1", "", 200},
		{"POST", "/", `{"jsonrpc":"2.0","id":1,"method":"abci_query","params":{}}`, 200},
		{"POST", "/", `[{"method":"status"},{"method":"broadcast_tx_sync","params":{"tx":"AA=="}}]`, 200},
		{"GET", "/dump_consensus_state", "", 403},
		{"GET", "/net_info", "", 403},
		{"GET", "/unconfirmed_txs", "", 403},
		{"GET", "/genesis", "", 403},
		{"GET", "/unsafe_flush_mempool", "", 403},
		{"GET", "/", "", 403},
		{"GET", "/%64ump_consensus_state", "", 403},
		{"GET", "/status/../dump_consensus_state", "", 403},
		{"POST", "/dump_consensus_state", "", 403},
		{"POST", "/", `{"method":"dump_consensus_state"}`, 403},
		{"POST", "/", `{"method":"status","method":"dump_consensus_state"}`, 403},
		{"POST", "/", `{"METHOD":"dump_consensus_state"}`, 403},
		{"POST", "/", `{"method":"net_info"}`, 403},
		{"POST", "/", `[{"method":"status"},{"method":"consensus_state"}]`, 403},
		{"POST", "/", `[]`, 400},
		{"POST", "/", `not json`, 400},
		{"POST", "/", `{"method":"status"} {"method":"net_info"}`, 400},
		{"PUT", "/status", "", 405},
	}
	for _, c := range cases {
		before := comet.count()
		w := do(h, c.method, c.target, c.body, nil)
		if w.Code != c.want {
			t.Errorf("%s %s %s: got %d, want %d (%s)", c.method, c.target, c.body, w.Code, c.want, w.Body.String())
		}
		if forwarded := comet.count() > before; forwarded != (c.want == 200) {
			t.Errorf("%s %s %s: forwarded=%v", c.method, c.target, c.body, forwarded)
		}
	}
	if w := do(h, "GET", "/websocket", "", map[string]string{"Upgrade": "websocket", "Connection": "Upgrade"}); w.Code != 403 {
		t.Errorf("websocket: %d", w.Code)
	}
	big := `{"method":"broadcast_tx_sync","params":{"tx":"` + strings.Repeat("A", guardBodyLimit) + `"}}`
	if w := do(h, "POST", "/", big, nil); w.Code != 413 {
		t.Errorf("over 1 MB: %d", w.Code)
	}
	batch := "[" + strings.TrimSuffix(strings.Repeat(`{"method":"status"},`, guardMaxBatch+1), ",") + "]"
	if w := do(h, "POST", "/", batch, nil); w.Code != 400 {
		t.Errorf("batch over the limit: %d", w.Code)
	}
	// What reached CometBFT is the path checked here.
	for _, p := range comet.paths {
		if name := strings.TrimPrefix(p, "/"); name != "" && !cometMethods[name] {
			t.Errorf("forwarded path %q", p)
		}
	}
}

func TestSecurityRPCGuardEVMAndFaucet(t *testing.T) {
	g, _, evm := newTestGuard(t, GuardConfig{FaucetPerDay: 2})
	clock := time.Date(2026, 10, 27, 23, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return clock }
	h := g.EVMHandler()
	ok := []string{
		`{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}`,
		`{"method":"eth_call","params":[{},"latest"]}`,
		`{"method":"net_version"}`, `{"method":"web3_clientVersion"}`,
		`{"method":"zetaphy_securityStatus"}`,
		`[{"method":"eth_blockNumber"},{"method":"eth_getBalance","params":["0x0","latest"]}]`,
	}
	for _, b := range ok {
		if w := do(h, "POST", "/", b, nil); w.Code != 200 {
			t.Errorf("%s: %d %s", b, w.Code, w.Body.String())
		}
	}
	bad := []string{
		`{"method":"txpool_content"}`, `{"method":"debug_traceTransaction"}`, `{"method":"admin_peers"}`,
		`{"method":"personal_unlockAccount"}`, `{"method":"eth_"}`, `{"method":""}`, `{}`,
		`{"method":"eth_chainId","method":"txpool_content"}`, `[{"method":"eth_chainId"},{"method":"debug_x"}]`,
	}
	for _, b := range bad {
		if w := do(h, "POST", "/", b, nil); w.Code < 400 {
			t.Errorf("%s: %d", b, w.Code)
		}
	}
	if w := do(h, "GET", "/", "", nil); w.Code != 405 {
		t.Errorf("GET: %d", w.Code)
	}
	if w := do(h, "POST", "/", `[{"method":"zetaphy_faucet","params":["0x1"]},{"method":"zetaphy_faucet","params":["0x2"]}]`, nil); w.Code != 400 {
		t.Errorf("two faucet calls in one batch: %d", w.Code)
	}

	faucet := func(ip, addr string) int {
		return do(h, "POST", "/", fmt.Sprintf(`{"method":"zetaphy_faucet","params":["%s"]}`, addr), map[string]string{"X-Forwarded-For": ip}).Code
	}
	if faucet("203.0.113.7", "0x1") != 200 || faucet("203.0.113.7", "0x2") != 200 {
		t.Fatal("first two grants from one IP")
	}
	if c := faucet("203.0.113.7", "0x3"); c != 429 {
		t.Errorf("third grant from one IP: %d", c)
	}
	// a spoofed X-Forwarded-For entry before Caddy's own does not help
	if c := faucet("198.51.100.1, 203.0.113.7", "0x4"); c != 429 {
		t.Errorf("spoofed earlier entry: %d", c)
	}
	if faucet("203.0.113.8", "0x5") != 200 {
		t.Error("another IP")
	}
	// one IPv6 /64 is one caller
	if faucet("2001:db8:1:2::1", "0x6") != 200 || faucet("2001:db8:1:2::ffff", "0x7") != 200 {
		t.Fatal("v6 grants")
	}
	if c := faucet("2001:db8:1:2:abcd::9", "0x8"); c != 429 {
		t.Errorf("same /64: %d", c)
	}
	clock = clock.Add(2 * time.Hour) // next UTC day
	if faucet("203.0.113.7", "0x9") != 200 {
		t.Error("new day")
	}
	for _, b := range evm.bodies {
		var c rpcCall
		if json.Unmarshal([]byte(b), &c) == nil && c.Method != "" && !evmMethodOK(c.Method) {
			t.Errorf("forwarded %s", b)
		}
	}
}

func TestSecurityRPCGuardFaucetPow(t *testing.T) {
	g, _, evm := newTestGuard(t, GuardConfig{FaucetPerDay: 1, FaucetPowPerDay: 3})
	clock := time.Date(2026, 10, 28, 22, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return clock }
	h := g.EVMHandler()
	pow := func(ip, addr string) int {
		return do(h, "POST", "/", fmt.Sprintf(`{"method":"zetaphy_faucetPow","params":["%s","0x10","0x0000000000000001"]}`, addr), map[string]string{"X-Forwarded-For": ip}).Code
	}
	// one faucet call per request, whichever method
	for _, b := range []string{
		`[{"method":"zetaphy_faucetPow","params":[]},{"method":"zetaphy_faucetPow","params":[]}]`,
		`[{"method":"zetaphy_faucet","params":["0x1"]},{"method":"zetaphy_faucetPow","params":[]}]`,
	} {
		if w := do(h, "POST", "/", b, nil); w.Code != 400 {
			t.Errorf("%s: %d", b, w.Code)
		}
	}
	// its own daily count per IP, apart from zetaphy_faucet's
	before := evm.count()
	for i := 0; i < 3; i++ {
		if c := pow("203.0.113.20", fmt.Sprint("0x", i)); c != 200 {
			t.Fatalf("claim %d: %d", i, c)
		}
	}
	if c := pow("203.0.113.20", "0x9"); c != 429 {
		t.Errorf("fourth claim from one IP: %d", c)
	}
	if c := pow("198.51.100.1, 203.0.113.20", "0x9"); c != 429 {
		t.Errorf("spoofed earlier entry: %d", c)
	}
	if c := do(h, "POST", "/", `{"method":"zetaphy_faucet","params":["0x1"]}`, map[string]string{"X-Forwarded-For": "203.0.113.20"}).Code; c != 200 {
		t.Errorf("zetaphy_faucet keeps its own count: %d", c)
	}
	if c := pow("2001:db8:5:6::1", "0x1"); c != 200 {
		t.Errorf("another IP: %d", c)
	}
	// the info method is not a claim
	for i := 0; i < 5; i++ {
		if w := do(h, "POST", "/", `{"method":"zetaphy_faucetPowInfo","params":[]}`, map[string]string{"X-Forwarded-For": "203.0.113.20"}); w.Code != 200 {
			t.Fatalf("info: %d", w.Code)
		}
	}
	if got := evm.count() - before; got != 3+1+1+5 {
		t.Errorf("forwarded %d", got)
	}
	clock = clock.Add(3 * time.Hour) // next UTC day
	if c := pow("203.0.113.20", "0x9"); c != 200 {
		t.Errorf("new day: %d", c)
	}
	if _, err := NewGuard(GuardConfig{Comet: "http://127.0.0.1:1", EVM: "http://127.0.0.1:2", PerMinute: 1, FaucetPowPerDay: -1, MaxInFlight: 1}); err == nil {
		t.Error("negative faucet-pow-per-day accepted")
	}
}

func TestSecurityRPCGuardLimits(t *testing.T) {
	g, _, _ := newTestGuard(t, GuardConfig{PerMinute: 3, FaucetPerDay: 1})
	clock := time.Date(2026, 10, 27, 10, 0, 0, 0, time.UTC)
	g.now = func() time.Time { return clock }
	h := g.CometHandler()
	for i := 0; i < 3; i++ {
		if w := do(h, "GET", "/status", "", map[string]string{"X-Forwarded-For": "192.0.2.1"}); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	if w := do(h, "GET", "/status", "", map[string]string{"X-Forwarded-For": "192.0.2.1"}); w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Errorf("over the minute limit: %d", w.Code)
	}
	if w := do(h, "GET", "/status", "", map[string]string{"X-Forwarded-For": "192.0.2.2"}); w.Code != 200 {
		t.Errorf("another IP: %d", w.Code)
	}
	clock = clock.Add(time.Minute)
	if w := do(h, "GET", "/status", "", map[string]string{"X-Forwarded-For": "192.0.2.1"}); w.Code != 200 {
		t.Errorf("next minute: %d", w.Code)
	}

	// X-Forwarded-For counts only from 127.0.0.1
	r := httptest.NewRequest("GET", "/status", nil)
	r.RemoteAddr = "198.51.100.9:1234"
	r.Header.Set("X-Forwarded-For", "10.0.0.1")
	if k := ClientKey(r); k != "198.51.100.9" {
		t.Errorf("direct caller key %q", k)
	}

	// a full key table refuses new keys instead of starting over
	w := newWindow(time.Minute, 2)
	now := clock
	if !w.allow("a", 5, now) || !w.allow("b", 5, now) || w.allow("c", 5, now) || !w.allow("a", 5, now) {
		t.Error("window table limit")
	}

	// in-flight ceiling
	block, entered := make(chan struct{}), make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/status" {
			close(entered)
			<-block // holds the only slot
		}
	}))
	defer slow.Close()
	g2, err := NewGuard(GuardConfig{Comet: slow.URL, EVM: slow.URL, PerMinute: 100, FaucetPerDay: 1, MaxInFlight: 1})
	if err != nil {
		t.Fatal(err)
	}
	h2 := g2.CometHandler()
	done := make(chan struct{})
	go func() { do(h2, "GET", "/status", "", nil); close(done) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first request did not arrive")
	}
	if w := do(h2, "GET", "/health", "", nil); w.Code != 503 {
		t.Errorf("while busy: %d", w.Code)
	}
	close(block)
	<-done
	if w := do(h2, "GET", "/health", "", nil); w.Code != 200 {
		t.Errorf("after: %d", w.Code)
	}

	if err := loopbackAddr("0.0.0.0:26667"); err == nil {
		t.Error("public listen address accepted")
	}
	if err := loopbackAddr("127.0.0.1:26667"); err != nil {
		t.Error(err)
	}
}

// Whatever the body, a request the guard forwards to CometBFT carries only
// allowed methods as CometBFT itself decodes them.
func FuzzRPCGuardComet(f *testing.F) {
	for _, s := range []string{
		`{"method":"status"}`, `[{"method":"status"},{"method":"block"}]`, `{"method":"status","method":"net_info"}`,
		`{"method":"net_info"}`, `{"Method":"genesis"}`, ` [ {"method":"tx"} ] `, `{"method":"status"}x`,
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, body string) {
		comet, evm := &recorder{}, &recorder{}
		g, err := NewGuard(GuardConfig{Comet: comet.server(t).URL, EVM: evm.server(t).URL, PerMinute: 1 << 30, FaucetPerDay: 1, MaxInFlight: 4})
		if err != nil {
			t.Fatal(err)
		}
		w := do(g.CometHandler(), "POST", "/", body, nil)
		if w.Code != 200 {
			return
		}
		var reqs []rpctypes.RPCRequest
		if err := json.Unmarshal([]byte(body), &reqs); err != nil {
			var one rpctypes.RPCRequest
			if err := json.Unmarshal([]byte(body), &one); err != nil {
				return // CometBFT refuses it too
			}
			reqs = []rpctypes.RPCRequest{one}
		}
		for _, r := range reqs {
			if r.ID == nil {
				continue // a notification (no id): CometBFT does not run it
			}
			if !cometMethods[r.Method] {
				t.Fatalf("forwarded %q (CometBFT reads method %q)", body, r.Method)
			}
		}
	})
}
