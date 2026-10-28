//go:build test

package evmd

// ZETAPHY v5 (zetaphy_future.go): AI precompile, immune system through vote
// extensions, bridge circuit breaker, protected accounts, anomaly hold.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"os"
	"testing"
	"time"

	circl "github.com/cloudflare/circl/sign/mldsa/mldsa44"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	"github.com/cosmos/cosmos-sdk/crypto/keys/ed25519"
	sdk "github.com/cosmos/cosmos-sdk/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"

	evmtypes "github.com/cosmos/evm/x/vm/types"
)

// futApp: secApp with v5 on.
func futApp(t *testing.T) (*EVMD, sdk.Context) {
	app, ctx := secApp(t)
	if !app.futV5(ctx, ctx.BlockHeight()) {
		app.setFutV5Height(ctx, 1)
	}
	require.True(t, app.futV5(ctx, ctx.BlockHeight()))
	return app, ctx
}

func futSet(t *testing.T, app *EVMD, ctx sdk.Context, kind string, v any) {
	var data []byte
	switch d := v.(type) {
	case []byte:
		data = d
	default:
		data, _ = json.Marshal(v)
	}
	_, err := app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: kind, Data: data})
	require.NoError(t, err)
}

// futCall calls a precompile method through MsgEVMCall and unpacks the answer.
func futCall(app *EVMD, ctx sdk.Context, from sdk.AccAddress, to common.Address, a abi.ABI, method string, args ...any) ([]any, error) {
	data, err := a.Pack(method, args...)
	if err != nil {
		return nil, err
	}
	out, err := app.evmCall(ctx, &MsgEVMCall{Sender: from.String(), To: to.Hex(), Data: data, GasLimit: 1_000_000})
	if err != nil {
		return nil, err
	}
	return a.Unpack(method, out.(*MsgEVMCallResponse).Ret)
}

// ---- (11) AI precompile

type gbdtTestNode struct {
	f           uint16
	th          int32
	left, right uint16
	v           int32
}

func gbdtBytes(features uint16, base int32, trees ...[]gbdtTestNode) []byte {
	b := []byte("ZGB1")
	b = binary.BigEndian.AppendUint16(b, features)
	b = binary.BigEndian.AppendUint16(b, uint16(len(trees)))
	b = binary.BigEndian.AppendUint32(b, uint32(base))
	for _, t := range trees {
		b = binary.BigEndian.AppendUint16(b, uint16(len(t)))
		for _, n := range t {
			b = binary.BigEndian.AppendUint16(b, n.f)
			b = binary.BigEndian.AppendUint32(b, uint32(n.th))
			b = binary.BigEndian.AppendUint16(b, n.left)
			b = binary.BigEndian.AppendUint16(b, n.right)
			b = binary.BigEndian.AppendUint32(b, uint32(n.v))
		}
	}
	return b
}

func gbdtFeat(xs ...int32) []byte {
	var b []byte
	for _, x := range xs {
		b = binary.BigEndian.AppendUint32(b, uint32(x))
	}
	return b
}

var testModel = gbdtBytes(2, 0,
	[]gbdtTestNode{{0, 100, 1, 2, 0}, {0xFFFF, 0, 0, 0, 20000}, {0xFFFF, 0, 0, 0, -20000}},
	[]gbdtTestNode{{0xFFFF, 0, 0, 0, 5000}})

func TestAIModelFormat(t *testing.T) {
	m, err := parseGBDT(testModel)
	require.NoError(t, err)
	require.Equal(t, 2, m.features)
	require.Equal(t, 4, m.nodes)
	for name, bad := range map[string][]byte{
		"magic":         append([]byte("XGB1"), testModel[4:]...),
		"trailing":      append(append([]byte{}, testModel...), 0),
		"loop":          gbdtBytes(2, 0, []gbdtTestNode{{0, 1, 0, 0, 0}}),
		"child before":  gbdtBytes(2, 0, []gbdtTestNode{{0, 1, 1, 2, 0}, {1, 1, 0, 2, 0}, {0xFFFF, 0, 0, 0, 0}}),
		"child missing": gbdtBytes(2, 0, []gbdtTestNode{{0, 1, 1, 5, 0}, {0xFFFF, 0, 0, 0, 0}}),
		"feature":       gbdtBytes(2, 0, []gbdtTestNode{{7, 1, 1, 2, 0}, {0xFFFF, 0, 0, 0, 0}, {0xFFFF, 0, 0, 0, 0}}),
		"truncated":     testModel[:len(testModel)-3],
		"too big":       make([]byte, gbdtMaxBytes+1),
	} {
		_, err := parseGBDT(bad)
		require.Error(t, err, name)
	}
	// integer sigmoid: table points exactly, monotone, clamped
	require.Equal(t, uint16(5000), sigmoidBps(0))
	require.Equal(t, uint16(9241), sigmoidBps(25000))
	require.Equal(t, uint16(0), sigmoidBps(-1_000_000))
	require.Equal(t, uint16(10000), sigmoidBps(1_000_000))
	prev := uint16(0)
	for z := int64(-90000); z <= 90000; z += 77 {
		s := sigmoidBps(z)
		require.GreaterOrEqual(t, s, prev)
		prev = s
	}
}

func TestAIPrecompile(t *testing.T) {
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	_, err := futCall(app, ctx, user, AIPrecompileAddress, AIABI, "score", gbdtFeat(1, 2))
	require.Error(t, err, "no model")

	_, err = app.setFuture(ctx, &MsgSetFuture{Authority: user.String(), Kind: "ai-model", Data: testModel})
	require.ErrorContains(t, err, "only governance")
	_, err = app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "ai-model", Data: testModel[:10]})
	require.Error(t, err)
	futSet(t, app, ctx, "ai-model", testModel)

	out, err := futCall(app, ctx, user, AIPrecompileAddress, AIABI, "score", gbdtFeat(50, 0))
	require.NoError(t, err)
	require.Equal(t, uint16(9241), out[0], "2.0 + 0.5 logit")
	out, err = futCall(app, ctx, user, AIPrecompileAddress, AIABI, "score", gbdtFeat(150, -7))
	require.NoError(t, err)
	require.Equal(t, uint16(1824), out[0], "-2.0 + 0.5 logit")
	_, err = futCall(app, ctx, user, AIPrecompileAddress, AIABI, "score", gbdtFeat(1))
	require.Error(t, err, "wrong length")
	out, err = futCall(app, ctx, user, AIPrecompileAddress, AIABI, "model")
	require.NoError(t, err)
	require.Equal(t, uint16(2), out[1])
	require.Equal(t, uint16(2), out[2])
	require.Equal(t, uint32(4), out[3])
	s, ok := app.AIScore(ctx, []int32{50, 0})
	require.True(t, ok)
	require.Equal(t, uint16(9241), s)

	// gas grows with the model, and is the same for the same input
	d, _ := AIABI.Pack("score", gbdtFeat(50, 0))
	gas := func() uint64 { return futMinGas(t, app, ctx, user, AIPrecompileAddress, d) }
	g1 := gas()
	require.Equal(t, g1, gas())
	trees := [][]gbdtTestNode{}
	for i := 0; i < 100; i++ {
		trees = append(trees, []gbdtTestNode{{0, 100, 1, 2, 0}, {0xFFFF, 0, 0, 0, 1}, {0xFFFF, 0, 0, 0, -1}})
	}
	futSet(t, app, ctx, "ai-model", gbdtBytes(2, 0, trees...))
	require.Greater(t, gas(), g1+100*40)

	// removed
	futSet(t, app, ctx, "ai-model", []byte{})
	_, err = futCall(app, ctx, user, AIPrecompileAddress, AIABI, "score", gbdtFeat(1, 2))
	require.Error(t, err, "no model")
}

// Neuro's real model, exported by zetaphy-chain/tools/gbdt-export.mjs: the
// chain gives the exporter's scores exactly (testdata from gbdt-vectors.mjs).
func TestAINeuroModelVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/neuro-gbdt.json")
	require.NoError(t, err)
	var td struct {
		Model   string
		Vectors []struct {
			X   []int32
			Bps uint16
		}
	}
	require.NoError(t, json.Unmarshal(raw, &td))
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	futSet(t, app, ctx, "ai-model", common.FromHex(td.Model))
	for i, v := range td.Vectors {
		s, ok := app.AIScore(ctx, v.X)
		require.True(t, ok)
		require.Equal(t, v.Bps, s, "vector %d", i)
	}
	v := td.Vectors[0]
	d, _ := AIABI.Pack("score", gbdtFeat(v.X...))
	r, err := app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: AIPrecompileAddress.Hex(), Data: d, GasLimit: 1_000_000})
	require.NoError(t, err)
	out, err := AIABI.Unpack("score", r.(*MsgEVMCallResponse).Ret)
	require.NoError(t, err)
	require.Equal(t, v.Bps, out[0])
	gas := futMinGas(t, app, ctx, user, AIPrecompileAddress, d)
	t.Logf("Neuro model (160 trees) score(): %d gas", gas)
	require.Less(t, gas, uint64(100_000))
	start := time.Now()
	for i := 0; i < 1000; i++ {
		app.AIScore(ctx, v.X)
	}
	t.Logf("1000 evaluations: %s", time.Since(start))
}

// futMinGas: the smallest gas limit with which the call succeeds (its real
// cost; a tx's reported gas used has the chain's minimum-gas rule on top).
func futMinGas(t *testing.T, app *EVMD, ctx sdk.Context, from sdk.AccAddress, to common.Address, data []byte) uint64 {
	lo, hi := uint64(21000), uint64(2_000_000)
	for lo < hi {
		mid := (lo + hi) / 2
		c, _ := ctx.CacheContext()
		if _, err := app.evmCall(c, &MsgEVMCall{Sender: from.String(), To: to.Hex(), Data: data, GasLimit: mid}); err == nil {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	require.Less(t, lo, uint64(2_000_000))
	return lo
}

// ---- (12) immune system

// scamRuntime: an ERC-20-looking contract with a blacklist function, a
// tx.origin check and SELFDESTRUCT; the 0xff inside PUSH data is not an opcode.
var scamRuntime = common.FromHex("63a9059cbb" + "6370a08231" + "63095ea7b3" + "63f9f92be4" + "32" + "60ff" + "50" + "ff")

func TestImmuneCodeScore(t *testing.T) {
	f := ImmuneCodeFeatures(scamRuntime)
	require.True(t, f.ERC20)
	require.True(t, f.SelfDestruct)
	require.True(t, f.Origin)
	require.Equal(t, 1, f.Blacklist)
	require.Equal(t, uint16(2000+1000+2500), f.Score())
	require.False(t, ImmuneCodeFeatures(common.FromHex("60ff")).SelfDestruct, "push data")
	require.Equal(t, uint16(0), ImmuneCodeFeatures(common.FromHex("6001600055")).Score())
	require.Equal(t, uint16(0), ImmuneCodeFeatures(nil).Score())
	proxy := common.FromHex("363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3")
	require.True(t, ImmuneCodeFeatures(proxy).MinimalProxy)
	require.Equal(t, uint16(1000), ImmuneCodeFeatures(proxy).Score())
	// metadata after the code is not read as code
	meta := append(common.FromHex("00a1ff"), 0x00, 0x02)
	require.False(t, ImmuneCodeFeatures(append(common.FromHex("6001"), meta...)).SelfDestruct)
}

type futVal struct {
	priv  *ed25519.PrivKey
	cons  []byte
	power int64
}

// futValidators: n staking validators with ed25519 consensus keys.
func futValidators(t *testing.T, app *EVMD, ctx sdk.Context, n int) []futVal {
	var out []futVal
	for i := 0; i < n; i++ {
		priv := ed25519.GenPrivKeyFromSecret([]byte{byte(i), 'z', 'x'})
		op := sdk.ValAddress(bytes.Repeat([]byte{0xa0 + byte(i)}, 20))
		v, err := stakingtypes.NewValidator(op.String(), priv.PubKey(), stakingtypes.Description{})
		require.NoError(t, err)
		require.NoError(t, app.StakingKeeper.SetValidator(ctx, v))
		require.NoError(t, app.StakingKeeper.SetValidatorByConsAddr(ctx, v))
		out = append(out, futVal{priv, priv.PubKey().Address(), 25})
	}
	return out
}

func futExtVote(t *testing.T, ctx sdk.Context, v futVal, height, round int64, ext []byte) abci.ExtendedVoteInfo {
	sb, err := zxExtSignBytes(ctx.ChainID(), height, round, ext)
	require.NoError(t, err)
	sig, err := v.priv.Sign(sb)
	require.NoError(t, err)
	return abci.ExtendedVoteInfo{Validator: abci.Validator{Address: v.cons, Power: v.power}, VoteExtension: ext,
		ExtensionSignature: sig, BlockIdFlag: cmtproto.BlockIDFlagCommit}
}

// futFinalize runs the v5 part of PreBlocker and BeginBlocker for block h
// carrying the extended votes on h-1.
func futFinalize(app *EVMD, ctx sdk.Context, h int64, vals []futVal, votes []abci.ExtendedVoteInfo, lead ...[]byte) {
	pctx := ctx.WithBlockHeight(h).WithExecMode(sdk.ExecModeFinalize)
	var cert []byte
	if len(lead) > 0 {
		cert = lead[0]
	}
	zx := app.zxBuildTx(pctx, h, abci.ExtendedCommitInfo{Round: 0, Votes: votes}, cert)
	var txs [][]byte
	if cert != nil {
		txs = append(txs, cert)
	}
	if zx != nil {
		txs = append(txs, zx)
	}
	var decided []abci.VoteInfo
	for _, v := range vals {
		decided = append(decided, abci.VoteInfo{Validator: abci.Validator{Address: v.cons, Power: v.power}, BlockIdFlag: cmtproto.BlockIDFlagCommit})
	}
	app.zxPreBlock(pctx, &abci.RequestFinalizeBlock{Height: h, Txs: txs, DecidedLastCommit: abci.CommitInfo{Votes: decided}})
	app.breakerBeginBlock(pctx)
}

func futPayload(scores map[common.Address]uint16, flagged ...common.Address) []byte {
	p := &zxPayload{flagged: flagged}
	for _, a := range sortedAddrs(scores) {
		p.scores = append(p.scores, zxScore{a, scores[a]})
	}
	return p.encode()
}

func TestImmuneVotes(t *testing.T) {
	app, ctx := futApp(t)
	vals := futValidators(t, app, ctx, 4)
	user := secPQAccount(t, app, ctx)
	futSet(t, app, ctx, "immune", immuneParams{Enabled: true, EnforceBps: 5000, HoldBps: 4000})
	N := ctx.BlockHeight()
	scam := secDeploy(t, app, ctx.WithExecMode(sdk.ExecModeFinalize), user, scamRuntime)
	require.Equal(t, []common.Address{scam}, app.immunePending(ctx, N))
	app.immuneNoteDeploy(ctx.WithExecMode(sdk.ExecModeCheck), common.HexToAddress("0x1234"))
	require.Len(t, app.immunePending(ctx, N), 1, "CheckTx does not list")

	// The vote on N+1: every honest validator computes the same payload.
	vctx := ctx.WithBlockHeight(N + 1)
	own := app.zxBuild(vctx, N+1)
	p, err := app.zxCheck(vctx, N+1, own)
	require.NoError(t, err)
	require.Equal(t, []zxScore{{scam, 5500}}, p.scores)
	_, err = app.zxCheck(vctx, N+1, futPayload(map[common.Address]uint16{common.HexToAddress("0xbad"): 1}))
	require.ErrorContains(t, err, "not deployed", "only contracts of the block")
	_, err = app.zxCheck(vctx, N+1, futPayload(map[common.Address]uint16{scam: 10001}))
	require.Error(t, err)
	_, err = app.zxCheck(vctx, N+1, []byte("ZX1garbage"))
	require.Error(t, err)

	// Disagreement: one validator lies low, one high; the median holds.
	ext := func(i int, s uint16) abci.ExtendedVoteInfo {
		return futExtVote(t, ctx, vals[i], N+1, 0, futPayload(map[common.Address]uint16{scam: s}))
	}
	snap, _ := ctx.CacheContext()
	futFinalize(app, snap, N+2, vals, []abci.ExtendedVoteInfo{ext(0, 0), ext(1, 5500), ext(2, 5500), ext(3, 10000)})
	s, h, share, ok := app.immuneScore(snap, scam)
	require.True(t, ok)
	require.Equal(t, uint16(5500), s)
	require.Equal(t, N+2, h)
	require.Equal(t, uint16(10000), share)
	require.Empty(t, app.immunePending(snap, N), "pruned")

	// Missing validators: half the power is not enough.
	snap, _ = ctx.CacheContext()
	futFinalize(app, snap, N+2, vals, []abci.ExtendedVoteInfo{ext(0, 5500), ext(1, 5500)})
	_, _, _, ok = app.immuneScore(snap, scam)
	require.False(t, ok, "no quorum")

	// A forged entry (wrong signature, or a payload swapped after signing) counts for nothing.
	forged := ext(2, 5500)
	forged.VoteExtension = futPayload(map[common.Address]uint16{scam: 0})
	snap, _ = ctx.CacheContext()
	futFinalize(app, snap, N+2, vals, []abci.ExtendedVoteInfo{ext(0, 5500), ext(1, 5500), forged})
	_, _, _, ok = app.immuneScore(snap, scam)
	require.False(t, ok, "the forged vote does not make quorum")

	// Signature part carried inline (mode 2) and from the certificate (mode 1).
	sig2 := bytes.Repeat([]byte{7}, circl.SignatureSize)
	sig1 := bytes.Repeat([]byte{9}, circl.SignatureSize)
	pl := futPayload(map[common.Address]uint16{scam: 6000})
	v2 := futExtVote(t, ctx, vals[2], N+1, 0, append(append([]byte{}, sig2...), pl...))
	v1 := futExtVote(t, ctx, vals[1], N+1, 0, append(append([]byte{}, sig1...), pl...))
	cert := pqCertTx(t, app, uint64(N+1), append(append([]byte{}, vals[1].cons...), sig1...))
	snap, _ = ctx.CacheContext()
	futFinalize(app, snap, N+2, vals, []abci.ExtendedVoteInfo{ext(0, 6000), v1, v2}, cert)
	s, _, share, ok = app.immuneScore(snap, scam)
	require.True(t, ok)
	require.Equal(t, uint16(6000), s)
	require.Equal(t, uint16(7500), share)
	z, i := app.zxOf([][]byte{cert, app.zxBuildTx(snap, N+2, abci.ExtendedCommitInfo{Votes: []abci.ExtendedVoteInfo{v1, v2}}, cert)})
	require.Equal(t, 1, i)
	entries, err := zxDecodeEntries(z.Entries)
	require.NoError(t, err)
	require.Len(t, entries, 2)
	require.ElementsMatch(t, []byte{1, 2}, []byte{entries[0].mode, entries[1].mode})

	// Readable by the EVM: scoreOf and the ThreatRegistry views; the threat gate uses them.
	ctx = snap
	out, err := futCall(app, ctx, user, ImmunePrecompileAddress, ImmuneABI, "scoreOf", scam)
	require.NoError(t, err)
	require.Equal(t, []any{uint16(6000), uint64(N + 2), uint16(7500), true}, out)
	out, err = futCall(app, ctx, user, ImmunePrecompileAddress, ImmuneABI, "isContractEnforced", scam)
	require.NoError(t, err)
	require.Equal(t, []any{true, uint8(ThreatReasonImmune)}, out)
	out, err = futCall(app, ctx, user, ImmunePrecompileAddress, ImmuneABI, "isContractHeld", common.HexToAddress("0x77"))
	require.NoError(t, err)
	require.Equal(t, []any{false, uint8(0)}, out)
	out, err = futCall(app, ctx, user, ImmunePrecompileAddress, ImmuneABI, "codeScore", scam)
	require.NoError(t, err)
	require.Equal(t, uint16(5500), out[0])
	_, err = app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: ImmunePrecompileAddress.Hex(), Enabled: 1})
	require.NoError(t, err)
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: scam.Hex(), GasLimit: 100000})
	require.ErrorIs(t, err, ErrThreatFlagged, "the threat gate reads the immune system")
}

// Vote extensions keep the PQ certificate working: the signature part is
// checked and certified as before; a payload is refused before v5.
func TestImmuneKeepsPQCertificate(t *testing.T) {
	app, ctx := futApp(t)
	futSet(t, app, ctx, "immune", immuneParams{Enabled: true})
	keys := pqVals(1)
	const H = 30
	hash := bytes.Repeat([]byte{0xcd}, 32)
	ctx = ctx.WithBlockHeight(H)
	pqRegister(ctx, app, keys[0].addr, keys[0].pub, nil, 1)
	scam := common.HexToAddress("0x5ca4")
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(immunePendingKey(H-1, scam), []byte{})
	sig, err := pqSign(keys[0].sk, pqVoteMsg(ctx.ChainID(), H, hash))
	require.NoError(t, err)
	pl := futPayload(map[common.Address]uint16{scam: 100})
	verify := func(c sdk.Context, ext []byte) bool {
		return app.pqVerifyExtension(c, &abci.RequestVerifyVoteExtension{Hash: hash, ValidatorAddress: keys[0].addr, Height: H, VoteExtension: ext})
	}
	require.True(t, verify(ctx, sig), "signature only, as before")
	require.True(t, verify(ctx, append(append([]byte{}, sig...), pl...)))
	require.False(t, verify(ctx, pl), "a keyed validator must sign")
	bad := append([]byte{}, sig...)
	bad[0] ^= 1
	require.False(t, verify(ctx, append(bad, pl...)))
	require.False(t, verify(ctx, append(append([]byte{}, sig...), []byte("ZX1\x09")...)), "malformed payload")
	app.setFutV5Height(ctx, H+5)
	require.False(t, verify(ctx, append(append([]byte{}, sig...), pl...)), "no payload before v5")
	require.True(t, verify(ctx, sig))
	app.setFutV5Height(ctx, 1)

	// the certificate built from extensions with payloads
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(pqLastBlockKey, append(binary.BigEndian.AppendUint64(nil, H), hash...))
	ext := []abci.ExtendedVoteInfo{{Validator: abci.Validator{Address: keys[0].addr, Power: 10}, VoteExtension: append(append([]byte{}, sig...), pl...), BlockIdFlag: cmtproto.BlockIDFlagCommit}}
	bz := app.pqBuildCert(ctx, H+1, nil, ext)
	c := app.pqCertOf([][]byte{bz})
	require.NotNil(t, c)
	require.Equal(t, append(append([]byte{}, keys[0].addr...), sig...), c.Attestations, "the certificate holds the signature only")
	votes := []abci.VoteInfo{{Validator: abci.Validator{Address: keys[0].addr, Power: 10}, BlockIdFlag: cmtproto.BlockIDFlagCommit}}
	require.NoError(t, app.pqCheckCert(ctx, H+1, nil, votes, [][]byte{bz}))
}

func TestImmuneMalformedZX(t *testing.T) {
	app, ctx := futApp(t)
	b := app.GetTxConfig().NewTxBuilder()
	require.NoError(t, b.SetMsgs(&MsgZXVotes{Signer: secGovAddr(), Height: 9, Entries: []byte{1, 2, 3}}))
	bz, err := app.GetTxConfig().TxEncoder()(b.GetTx())
	require.NoError(t, err)
	require.Error(t, app.zxCheckProposal(10, [][]byte{bz}), "rejected in ProcessProposal")
	require.Error(t, app.zxCheckProposal(12, [][]byte{bz}), "wrong height")
	tx, err := app.TxDecode(bz)
	require.NoError(t, err)
	_, err = app.AnteHandler()(ctx.WithExecMode(sdk.ExecModeCheck), tx, false)
	require.ErrorContains(t, err, "start of a block")
	_, err = app.AnteHandler()(ctx.WithExecMode(sdk.ExecModeFinalize).WithTxIndex(5), tx, false)
	require.Error(t, err)
	_, err = app.AnteHandler()(ctx.WithExecMode(sdk.ExecModeFinalize).WithTxIndex(1), tx, false)
	require.NoError(t, err)
	// never a crash of the block on garbage
	app.zxPreBlock(ctx, &abci.RequestFinalizeBlock{Height: 10, Txs: [][]byte{bz, {0xff}}})
}

// ---- (31) bridge circuit breaker

var futOutTopic = crypto.Keccak256Hash([]byte("Outbound(bytes32,address,uint256)"))

// futBridgeRuntime: pause() sets slot 0 when the caller is the address in
// slot 1 (the guardian); any other call logs an outflow
// Outbound(0, recipient = word 0, amount = word 1).
func futBridgeRuntime() []byte {
	c := common.FromHex("6000356" + "0e01c" + "638456cb59" + "14" + "610042" + "57" + "602435600052" + "600435" + "6000" + "7f")
	c = append(c, futOutTopic.Bytes()...)
	c = append(c, common.FromHex("60206000a3"+"00"+"5b"+"6001543314"+"610050"+"57"+"600080fd"+"5b600160005500")...)
	return c
}

func futOutflow(t *testing.T, app *EVMD, ctx sdk.Context, from sdk.AccAddress, bridge, to common.Address, amount int64) {
	data := append(common.FromHex("11111111"), common.LeftPadBytes(to.Bytes(), 32)...)
	data = append(data, common.LeftPadBytes(big.NewInt(amount).Bytes(), 32)...)
	_, err := app.evmCall(ctx.WithExecMode(sdk.ExecModeFinalize), &MsgEVMCall{Sender: from.String(), To: bridge.Hex(), Data: data, GasLimit: 200000})
	require.NoError(t, err)
}

func TestBridgeBreakerDrain(t *testing.T) {
	app, ctx := futApp(t)
	vals := futValidators(t, app, ctx, 4)
	user := secPQAccount(t, app, ctx)
	bridge := secDeploy(t, app, ctx, user, futBridgeRuntime())
	paused := func(c sdk.Context) bool { return app.EVMKeeper.GetState(c, bridge, common.Hash{}) != (common.Hash{}) }
	cfg := map[string]any{"bridge": bridge.Hex(), "topic": futOutTopic.Hex(), "recipient_topic": 2, "amount_word": 0,
		"min_volume": "1000", "vol_mult_bps": 50000, "new_ratio_bps": 5000, "baseline_shift": 2, "enabled": true}
	_, err := app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "breaker", Data: []byte(`{"bridge":"0x01","enabled":true}`)})
	require.Error(t, err)
	futSet(t, app, ctx, "breaker", cfg)

	// normal traffic: 100 per block to known recipients
	alice, bob := common.HexToAddress("0xa11ce"), common.HexToAddress("0xb0b")
	h := ctx.BlockHeight()
	for i := 0; i < 20; i++ {
		h++
		futOutflow(t, app, ctx.WithBlockHeight(h), user, bridge, []common.Address{alice, bob}[i%2], 100)
		require.Empty(t, app.breakerFlags(ctx.WithBlockHeight(h+1), h), "normal block %d", h)
	}
	// a big but ordinary block (to known recipients) is not flagged by the recipient rule
	h++
	futOutflow(t, app, ctx.WithBlockHeight(h), user, bridge, alice, 5000)
	require.Empty(t, app.breakerFlags(ctx, h), "known recipients")
	// the drain: a large outflow to fresh addresses
	h += 3
	for i := 0; i < 3; i++ {
		futOutflow(t, app, ctx.WithBlockHeight(h), user, bridge, common.BigToAddress(big.NewInt(int64(0xdead00+i))), 5000)
	}
	st := app.breakerStatsOf(ctx, bridge)
	require.Equal(t, h, st.height)
	require.Equal(t, int64(15000), st.volume.Int64())
	require.Equal(t, uint32(3), st.newRecipients)
	require.Equal(t, []common.Address{bridge}, app.breakerFlags(ctx, h))
	pl := futPayload(nil, bridge)
	_, err = app.zxCheck(ctx.WithBlockHeight(h+1), h+1, pl)
	require.NoError(t, err)
	flagAt := func(i int, hh int64) abci.ExtendedVoteInfo { return futExtVote(t, ctx, vals[i], hh, 0, pl) }
	flag := func(i int) abci.ExtendedVoteInfo { return flagAt(i, h+1) }

	// two of four flag: nothing happens
	snap, _ := ctx.CacheContext()
	futFinalize(app, snap, h+2, vals, []abci.ExtendedVoteInfo{flag(0), flag(1)})
	require.False(t, paused(snap))
	require.Nil(t, app.secRaw(snap).Get(breakerKey(breakerTripPfx, bridge)))

	// three of four, but governance has not given the breaker the pauser role:
	// the call fails, the trip is recorded, the chain goes on
	snap, _ = ctx.CacheContext()
	futFinalize(app, snap, h+2, vals, []abci.ExtendedVoteInfo{flag(0), flag(1), flag(2)})
	require.False(t, paused(snap))
	require.Equal(t, append(u64(uint64(h+2)), 0), app.secRaw(snap).Get(breakerKey(breakerTripPfx, bridge)))

	// with the role (BridgeGuard: setGuardian(BreakerAddress, true))
	app.EVMKeeper.SetState(ctx, bridge, common.BigToHash(big.NewInt(1)), common.LeftPadBytes(BreakerAddress.Bytes(), 32))
	snap, _ = ctx.CacheContext()
	futFinalize(app, snap, h+2, vals, []abci.ExtendedVoteInfo{flag(0), flag(1), flag(2)})
	require.True(t, paused(snap), "the chain paused the bridge")
	out, err := futCall(app, snap, user, ImmunePrecompileAddress, ImmuneABI, "breaker", bridge)
	require.NoError(t, err)
	require.Equal(t, true, out[0])
	require.Equal(t, true, out[1])
	require.Equal(t, uint64(h+2), out[2])
	// tripped: it does not fire again, validators stop flagging; governance re-arms
	require.Empty(t, app.breakerFlags(snap, h))
	app.EVMKeeper.SetState(snap, bridge, common.Hash{}, common.Hash{}.Bytes()) // governance unpaused the bridge
	futFinalize(app, snap, h+3, vals, []abci.ExtendedVoteInfo{flagAt(0, h+2), flagAt(1, h+2), flagAt(2, h+2)})
	require.False(t, paused(snap), "no second call while tripped")
	futSet(t, app, snap, "breaker-rearm", map[string]string{"bridge": bridge.Hex()})
	require.Equal(t, []common.Address{bridge}, app.breakerFlags(snap, h))
	futFinalize(app, snap, h+3, vals, []abci.ExtendedVoteInfo{flagAt(0, h+2), flagAt(1, h+2), flagAt(2, h+2)})
	require.True(t, paused(snap))

	// removing the bridge clears its state; flags for it are refused
	cfg["enabled"] = false
	futSet(t, app, snap, "breaker", cfg)
	_, err = app.zxCheck(snap.WithBlockHeight(h+1), h+1, pl)
	require.Error(t, err)
}

// ---- (13) protected accounts

func futTx(t *testing.T, app *EVMD, msgs ...sdk.Msg) sdk.Tx {
	b := app.GetTxConfig().NewTxBuilder()
	require.NoError(t, b.SetMsgs(msgs...))
	return b.GetTx()
}

func TestGuardProtectedAccount(t *testing.T) {
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	other := secPQAccount(t, app, ctx)
	futSet(t, app, ctx, "immune", immuneParams{Enabled: true})
	scam := common.HexToAddress("0x00000000000000000000000000000000005ca400")
	token := common.HexToAddress("0x0000000000000000000000000000000000070c00")
	ok := common.HexToAddress("0x0000000000000000000000000000000000600d00")
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(append([]byte{immuneScorePfx}, scam.Bytes()...), append(binary.BigEndian.AppendUint16(nil, 8000), make([]byte, 10)...))
	call := func(c sdk.Context, from sdk.AccAddress, to common.Address, data []byte) error {
		return app.guardTx(c, futTx(t, app, &MsgEVMCall{Sender: from.String(), To: to.Hex(), Data: data, GasLimit: 100000}))
	}
	approve := func(spender common.Address) []byte {
		return append(common.FromHex("095ea7b3"), append(common.LeftPadBytes(spender.Bytes(), 32), common.LeftPadBytes([]byte{1}, 32)...)...)
	}
	transferFrom := func(to common.Address) []byte {
		d := append(common.FromHex("23b872dd"), common.LeftPadBytes(user.Bytes(), 32)...)
		return append(append(d, common.LeftPadBytes(to.Bytes(), 32)...), common.LeftPadBytes([]byte{1}, 32)...)
	}
	require.NoError(t, call(ctx, user, scam, nil), "not opted in: never checked")
	require.NoError(t, call(ctx, user, token, approve(scam)))

	_, err := futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "protect", uint8(guardModeReject), uint64(0))
	require.NoError(t, err)
	require.ErrorIs(t, call(ctx, user, scam, nil), ErrGuard, "call to a high-risk contract")
	require.ErrorIs(t, call(ctx, user, token, approve(scam)), ErrGuard, "approval to it")
	require.ErrorIs(t, call(ctx, user, token, transferFrom(scam)), ErrGuard, "transfer to it")
	require.NoError(t, call(ctx, user, token, approve(ok)))
	require.NoError(t, call(ctx, user, ok, nil))
	require.NoError(t, call(ctx, other, scam, nil), "other accounts are not affected")
	send := &banktypes.MsgSend{FromAddress: user.String(), ToAddress: sdk.AccAddress(scam.Bytes()).String(), Amount: sdk.NewCoins(sdk.NewInt64Coin(evmtypes.GetEVMCoinDenom(), 1))}
	require.ErrorIs(t, app.guardTx(ctx, futTx(t, app, send)), ErrGuard, "bank send to it")
	// through the full ante handler (CheckTx)
	out, err := futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "highRisk", scam)
	require.NoError(t, err)
	require.Equal(t, true, out[0])

	// turning it off waits a day; a stolen key cannot do it at once
	out, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "protect", uint8(guardModeOff), uint64(0))
	require.NoError(t, err)
	require.Equal(t, uint64(ctx.BlockTime().Unix()+guardDay), out[0])
	require.ErrorIs(t, call(ctx.WithBlockTime(ctx.BlockTime().Add(23*time.Hour)), user, scam, nil), ErrGuard)
	require.NoError(t, call(ctx.WithBlockTime(ctx.BlockTime().Add(25*time.Hour)), user, scam, nil))
	// stronger again: immediate (cancels the pending switch-off)
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "protect", uint8(guardModeQueue), uint64(7200))
	require.NoError(t, err, "weaker: scheduled, not applied")
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "protect", uint8(guardModeReject), uint64(0))
	require.NoError(t, err)
	require.ErrorIs(t, call(ctx.WithBlockTime(ctx.BlockTime().Add(25*time.Hour)), user, scam, nil), ErrGuard)

	// the delay queue (another account)
	_, err = futCall(app, ctx, other, GuardPrecompileAddress, GuardABI, "protect", uint8(guardModeQueue), uint64(10))
	require.Error(t, err, "a delay below an hour")
	_, err = futCall(app, ctx, other, GuardPrecompileAddress, GuardABI, "protect", uint8(guardModeQueue), uint64(7200))
	require.NoError(t, err)
	require.ErrorIs(t, call(ctx, other, scam, nil), ErrGuard)
	out, err = futCall(app, ctx, other, GuardPrecompileAddress, GuardABI, "queue", scam)
	require.NoError(t, err)
	require.Equal(t, uint64(ctx.BlockTime().Unix()+7200), out[0])
	at := func(d time.Duration) sdk.Context { return ctx.WithBlockTime(ctx.BlockTime().Add(d)) }
	require.ErrorIs(t, call(at(time.Hour), other, scam, nil), ErrGuard, "still waiting")
	require.NoError(t, call(at(2*time.Hour), other, scam, nil), "queued long enough")
	require.ErrorIs(t, call(at(27*time.Hour), other, scam, nil), ErrGuard, "the queue entry lasts a day")

	// ThreatRegistry flags count too, even while the gate is off
	reg := secDeploy(t, app, ctx, user, secRegistryRuntime)
	flagged := common.HexToAddress("0x00000000000000000000000000000000000bad00")
	secFlag(app, ctx, reg, flagged, 6)
	require.NoError(t, call(ctx, user, flagged, nil))
	_, err = app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: reg.Hex(), Enabled: 0})
	require.NoError(t, err)
	require.ErrorIs(t, call(ctx, user, flagged, nil), ErrGuard)
	third := secPQAccount(t, app, ctx)
	require.NoError(t, call(ctx, third, flagged, nil), "gate off: unprotected accounts pass")
}

// ---- (33) anomaly hold

func TestAnomalyHold(t *testing.T) {
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	guardian := secPQAccount(t, app, ctx)
	stranger := secPQAccount(t, app, ctx)
	fctx := ctx.WithExecMode(sdk.ExecModeFinalize)
	pay := func(c sdk.Context, from sdk.AccAddress, v int64) error {
		return app.guardTx(c, futTx(t, app, &MsgEVMCall{Sender: from.String(), To: "0x0000000000000000000000000000000000600d00", Value: big.NewInt(v).String(), GasLimit: 50000}))
	}
	require.NoError(t, pay(fctx, user, 1_000_000), "not opted in")
	_, err := futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "holdOptIn", common.BytesToAddress(user), uint64(3600), big.NewInt(10), uint32(30000))
	require.Error(t, err, "the guardian is a second key")
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "holdOptIn", common.BytesToAddress(guardian), uint64(3600), big.NewInt(10), uint32(30000))
	require.NoError(t, err)

	// learning: small outflows build the profile
	for i := 0; i < 4; i++ {
		require.NoError(t, pay(fctx, user, 8))
	}
	require.ErrorIs(t, pay(fctx, user, 12), ErrGuard, "above the minimum while warming up: held")
	require.NoError(t, pay(fctx, user, 8))
	n, avg := app.holdStatsOf(ctx, common.BytesToAddress(user))
	require.Equal(t, uint64(5), n)
	require.Equal(t, int64(8), avg.Int64())
	for i := 0; i < 2; i++ { // 20 <= 3 × 8: inside the profile now
		require.NoError(t, pay(fctx, user, 20))
	}
	require.ErrorIs(t, pay(ctx, user, 500), ErrGuard, "a drain-sized outflow is held (CheckTx)")
	require.ErrorIs(t, pay(fctx, user, 500), ErrGuard, "and in a block")
	require.NoError(t, pay(fctx, stranger, 500), "other accounts are not affected")

	// release by the guardian's second signature
	out, err := futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "requestRelease", big.NewInt(500))
	require.NoError(t, err)
	require.Equal(t, uint64(ctx.BlockTime().Unix()+3600), out[0])
	require.ErrorIs(t, pay(fctx, user, 500), ErrGuard, "not confirmed, not timed out")
	_, err = futCall(app, ctx, stranger, GuardPrecompileAddress, GuardABI, "confirmRelease", common.BytesToAddress(user))
	require.Error(t, err, "only the guardian")
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "confirmRelease", common.BytesToAddress(user))
	require.Error(t, err, "the account cannot confirm itself")
	_, err = futCall(app, ctx, guardian, GuardPrecompileAddress, GuardABI, "confirmRelease", common.BytesToAddress(user))
	require.NoError(t, err)
	require.ErrorIs(t, pay(fctx, user, 600), ErrGuard, "more than released")
	require.NoError(t, pay(fctx, user, 500))
	require.ErrorIs(t, pay(fctx, user, 500), ErrGuard, "the release is used up")

	// release by timeout; the guardian can cancel meanwhile
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "requestRelease", big.NewInt(400))
	require.NoError(t, err)
	_, err = futCall(app, ctx, guardian, GuardPrecompileAddress, GuardABI, "cancelRelease", common.BytesToAddress(user))
	require.NoError(t, err)
	require.ErrorIs(t, pay(fctx.WithBlockTime(ctx.BlockTime().Add(2*time.Hour)), user, 400), ErrGuard, "cancelled")
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "requestRelease", big.NewInt(400))
	require.NoError(t, err)
	later := fctx.WithBlockTime(ctx.BlockTime().Add(61 * time.Minute))
	require.NoError(t, pay(later, user, 400), "timed out: released")

	// opting out waits the timeout; the guardian can stop it
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "holdOptOut")
	require.NoError(t, err)
	require.ErrorIs(t, pay(fctx, user, 5000), ErrGuard, "still on")
	_, err = futCall(app, ctx, guardian, GuardPrecompileAddress, GuardABI, "cancelOptOut", common.BytesToAddress(user))
	require.NoError(t, err)
	require.ErrorIs(t, pay(fctx.WithBlockTime(ctx.BlockTime().Add(2*time.Hour)), user, 5000), ErrGuard, "opt-out cancelled")
	_, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "holdOptOut")
	require.NoError(t, err)
	require.NoError(t, pay(fctx.WithBlockTime(ctx.BlockTime().Add(2*time.Hour)), user, 5000), "opted out after the timeout")

	// the view
	out, err = futCall(app, ctx, user, GuardPrecompileAddress, GuardABI, "holdState", common.BytesToAddress(user))
	require.NoError(t, err)
	require.Equal(t, common.BytesToAddress(guardian), out[0])
}

// ---- gating, upgrade, genesis

func TestFutureGating(t *testing.T) {
	app, ctx := pqApp(t)
	ctx = ctx.WithBlockHeight(40)
	app.setFutV5Height(ctx, 0)
	for _, a := range []common.Address{AIPrecompileAddress, ImmunePrecompileAddress, GuardPrecompileAddress} {
		_, ok := app.zetaphyPrecompile(ctx, a)
		require.False(t, ok, "no v5 precompile before v5")
	}
	_, err := app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "immune", Data: []byte(`{"enabled":true}`)})
	require.ErrorContains(t, err, "not active")
	_, err = app.zxCheck(ctx, 40, futPayload(nil, common.HexToAddress("0x1")))
	require.ErrorContains(t, err, "before the v5 height")
	require.Nil(t, app.zxBuild(ctx, 40))

	require.NoError(t, app.UpgradeKeeper.ApplyUpgrade(ctx, upgradetypes.Plan{Name: ZetaphyV5UpgradeName, Height: 40}))
	require.Equal(t, int64(41), app.futV5Height(ctx))
	require.False(t, app.futV5(ctx, 40))
	_, ok := app.zetaphyPrecompile(ctx.WithBlockHeight(41), GuardPrecompileAddress)
	require.True(t, ok)
	_, ok = app.zetaphyPrecompile(ctx.WithBlockHeight(41), SecurityPrecompileAddress)
	require.Equal(t, app.secV3(ctx.WithBlockHeight(41)), ok, "0x…0901 unchanged")

	// genesis export keeps the settings (v5 on from the new chain's start)
	c41 := ctx.WithBlockHeight(41)
	_, err = app.setFuture(c41, &MsgSetFuture{Authority: secGovAddr(), Kind: "immune", Data: []byte(`{"enabled":true,"enforce_bps":9000}`)})
	require.NoError(t, err)
	_, err = app.setFuture(c41, &MsgSetFuture{Authority: secGovAddr(), Kind: "immune", Data: []byte(`{"enabled":true,"surprise":1}`)})
	require.Error(t, err, "unknown fields refused")
	raw, err := app.pqExportGenesis(c41)
	require.NoError(t, err)
	in, err := pqParseGenesis(raw)
	require.NoError(t, err)
	found := map[byte][]byte{}
	for _, e := range in {
		found[e[0][0]] = e[1]
	}
	require.Equal(t, u64(1), found[futV5Key[0]])
	require.Contains(t, string(found[immuneParamsKey[0]]), `"enforce_bps":9000`)
	var def []pqGenesisEntry
	require.NoError(t, json.Unmarshal(pqGenesisBasic{}.DefaultGenesis(nil), &def))
	require.Contains(t, def, pqGenesisEntry{"20", "0000000000000001"}, "new chains: v5 from block 1")
}

func TestFutureProposalCLI(t *testing.T) {
	m, _, err := secProposalMsg([]string{"immune", `{"enabled":true}`})
	require.NoError(t, err)
	require.Equal(t, "immune", m.(*MsgSetFuture).Kind)
	_, _, err = secProposalMsg([]string{"breaker", `not json`})
	require.Error(t, err)
	m, _, err = secProposalMsg([]string{"breaker-rearm", "0x0000000000000000000000000000000000000001"})
	require.NoError(t, err)
	require.Contains(t, string(m.(*MsgSetFuture).Data), "0x0000000000000000000000000000000000000001")
	m, _, err = futProposalMsg([]string{"ai-model", "x"}, func(string) ([]byte, error) { return []byte(common.Bytes2Hex(testModel) + "\n"), nil })
	require.NoError(t, err)
	require.Equal(t, testModel, m.(*MsgSetFuture).Data)
	// wire format round trip
	bz, err := m.(*MsgSetFuture).Marshal()
	require.NoError(t, err)
	var back MsgSetFuture
	require.NoError(t, back.Unmarshal(bz))
	require.Equal(t, *m.(*MsgSetFuture), back)
}
