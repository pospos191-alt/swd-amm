//go:build test

package evmd

// ZETAPHY v5 ModelAt (zetaphy_modelat.go): the Neuro model version in force
// at a height, read from the ModelEpochs registry governance points at.

import (
	"bytes"
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/stretchr/testify/require"

	"github.com/cosmos/cosmos-sdk/client"
	sdk "github.com/cosmos/cosmos-sdk/types"
)

var modelEpochsTestABI = func() abi.ABI {
	a, err := abi.JSON(bytes.NewReader([]byte(`[
 {"type":"constructor","inputs":[{"name":"governance_","type":"address"},{"name":"epochLength_","type":"uint64"},{"name":"minDelay_","type":"uint64"}]},
 {"type":"function","name":"schedule","inputs":[{"name":"hash","type":"bytes32"},{"name":"activation","type":"uint64"},{"name":"uri","type":"string"}],"outputs":[{"name":"index","type":"uint256"}]},
 {"type":"function","name":"cancelLast","inputs":[],"outputs":[]}
]`)))
	if err != nil {
		panic(err)
	}
	return a
}()

// modelDeploy deploys zetaphy-network's ModelEpochs (testdata/ModelEpochs.bin,
// from artifacts/ModelEpochs.json) with gov as its governance.
func modelDeploy(t *testing.T, app *EVMD, ctx sdk.Context, gov sdk.AccAddress, epoch, minDelay uint64) common.Address {
	raw, err := os.ReadFile("testdata/ModelEpochs.bin")
	require.NoError(t, err)
	args, err := modelEpochsTestABI.Pack("", common.BytesToAddress(gov), epoch, minDelay)
	require.NoError(t, err)
	code := append(common.FromHex(strings.TrimSpace(string(raw))), args...)
	out, err := app.evmCall(ctx, &MsgEVMCall{Sender: gov.String(), Data: code, GasLimit: 3_000_000})
	require.NoError(t, err)
	return common.HexToAddress(out.(*MsgEVMCallResponse).Created)
}

func modelCall(app *EVMD, ctx sdk.Context, from sdk.AccAddress, reg common.Address, method string, args ...any) error {
	data, err := modelEpochsTestABI.Pack(method, args...)
	if err != nil {
		return err
	}
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: from.String(), To: reg.Hex(), Data: data, GasLimit: 500_000})
	return err
}

func TestFutureModelAt(t *testing.T) {
	app, ctx := futApp(t) // height 10
	gov := secPQAccount(t, app, ctx)
	reg := modelDeploy(t, app, ctx, gov, 10, 1)
	hashA, hashB := common.HexToHash("0xc8e6eb9ced9494e6773d0850d434c8dd436a5d76ba67f59ff0d29a8e8c1d9549"), common.HexToHash("0xbb")

	// no registry set: no model
	v, err := app.ModelVersionAt(ctx, 20)
	require.ErrorContains(t, err, "no ModelEpochs registry")
	require.False(t, v.Found)

	// governance sets it; only a contract, only governance
	_, err = app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "model-epochs", Data: []byte(`{"address":"0x0000000000000000000000000000000000600d00"}`)})
	require.ErrorContains(t, err, "no contract")
	_, err = app.setFuture(ctx, &MsgSetFuture{Authority: gov.String(), Kind: "model-epochs", Data: []byte(`{"address":"` + reg.Hex() + `"}`)})
	require.Error(t, err, "only governance")
	_, err = app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "model-epochs", Data: []byte(`{"address":"` + reg.Hex() + `","x":1}`)})
	require.Error(t, err, "unknown fields refused")
	futSet(t, app, ctx, "model-epochs", map[string]string{"address": reg.Hex()})
	out, err := futCall(app, ctx, gov, AIPrecompileAddress, AIABI, "modelEpochs")
	require.NoError(t, err)
	require.Equal(t, reg, out[0], "contracts can read where the registry is")

	// an empty registry: no version, no error
	v, err = app.ModelVersionAt(ctx, 20)
	require.NoError(t, err)
	require.False(t, v.Found)

	// versions at 20 and 30, scheduled at height 10
	require.NoError(t, modelCall(app, ctx, gov, reg, "schedule", hashA, uint64(20), "https://example.invalid/a.json"))
	require.NoError(t, modelCall(app, ctx, gov, reg, "schedule", hashB, uint64(30), "https://example.invalid/b.json"))
	expect := func(c sdk.Context, h int64, found bool, hash common.Hash, act int64, idx uint64) {
		t.Helper()
		v, err := app.ModelVersionAt(c, h)
		require.NoError(t, err)
		require.Equal(t, found, v.Found, "height %d", h)
		if found {
			require.Equal(t, [32]byte(hash), v.Hash, "height %d", h)
			require.Equal(t, act, v.Activation)
			require.Equal(t, idx, v.Index)
			require.True(t, strings.HasPrefix(v.URI, "https://example.invalid/"))
		}
		// the query path (EthCall, as `q neuro model-at` and zetaphy_modelAt) agrees
		r := modelAtVia(c, app.EVMKeeper, reg.Bytes(), h)
		require.Equal(t, found, r.Found, "query, height %d: %s", h, r.Error)
		if found {
			require.Equal(t, hash.Hex(), *r.Hash)
			require.Equal(t, act, *r.Activation)
		}
	}
	expect(ctx, 11, false, common.Hash{}, 0, 0)
	expect(ctx, 19, false, common.Hash{}, 0, 0) // before the first activation
	expect(ctx, 20, true, hashA, 20, 0)         // at it
	expect(ctx, 29, true, hashA, 20, 0)
	expect(ctx, 30, true, hashB, 30, 1)
	expect(ctx, 1_000_000, true, hashB, 30, 1)

	// determinism: the lookup writes nothing and always answers the same
	caller := app.EVMKeeper.GetAccount(ctx, ModelEpochsCaller)
	events := len(ctx.EventManager().Events())
	first, _ := app.ModelVersionAt(ctx, 25)
	for i := 0; i < 20; i++ {
		again, err := app.ModelVersionAt(ctx, 25)
		require.NoError(t, err)
		require.Equal(t, first, again)
	}
	require.Equal(t, caller, app.EVMKeeper.GetAccount(ctx, ModelEpochsCaller), "no nonce or account change")
	require.Equal(t, events, len(ctx.EventManager().Events()), "no events")
	// a second node that replays the same txs gets the same answers
	app2, ctx2 := futApp(t)
	gov2 := secPQAccount(t, app2, ctx2)
	reg2 := modelDeploy(t, app2, ctx2, gov2, 10, 1)
	futSet(t, app2, ctx2, "model-epochs", map[string]string{"address": reg2.Hex()})
	require.NoError(t, modelCall(app2, ctx2, gov2, reg2, "schedule", hashA, uint64(20), "https://example.invalid/a.json"))
	require.NoError(t, modelCall(app2, ctx2, gov2, reg2, "schedule", hashB, uint64(30), "https://example.invalid/b.json"))
	for _, h := range []int64{1, 19, 20, 29, 30, 31, 99} {
		a, _ := app.ModelVersionAt(ctx, h)
		b, _ := app2.ModelVersionAt(ctx2, h)
		require.Equal(t, a, b, "height %d", h)
	}

	// finality: at height 21, cancelLast can only drop the version at 30;
	// every answer for heights <= 21 stays
	c21 := ctx.WithBlockHeight(21)
	require.NoError(t, modelCall(app, c21, gov, reg, "cancelLast"))
	expect(c21, 20, true, hashA, 20, 0)
	expect(c21, 21, true, hashA, 20, 0)
	expect(c21, 30, true, hashA, 20, 0)
	require.Error(t, modelCall(app, c21, gov, reg, "cancelLast"), "the version in force cannot be cancelled")
	require.Error(t, modelCall(app, c21, gov, reg, "schedule", hashB, uint64(20), "https://example.invalid/b.json"), "nor replaced")
	expect(c21, 20, true, hashA, 20, 0)

	// a registry that does not behave counts as no model
	loop := secDeploy(t, app, ctx, gov, common.FromHex("5b600056")) // JUMPDEST PUSH1 0 JUMP: runs out of gas
	futSet(t, app, ctx, "model-epochs", map[string]string{"address": loop.Hex()})
	v, err = app.ModelVersionAt(ctx, 20)
	require.Error(t, err)
	require.False(t, v.Found)
	require.False(t, modelAtVia(ctx, app.EVMKeeper, loop.Bytes(), 20).Found)
	junk := secDeploy(t, app, ctx, gov, common.FromHex("60206000f3")) // returns 32 zero bytes
	futSet(t, app, ctx, "model-epochs", map[string]string{"address": junk.Hex()})
	v, err = app.ModelVersionAt(ctx, 20)
	require.Error(t, err)
	require.False(t, v.Found)
	outs := modelEpochsABI.Methods["versionAt"].Outputs
	lie, err := outs.Pack(true, big.NewInt(0), [32]byte{1}, uint64(50), "u")
	require.NoError(t, err)
	_, err = modelAtDecode(lie, 40)
	require.Error(t, err, "a version from after the height asked")
	zero, _ := outs.Pack(true, big.NewInt(0), [32]byte{}, uint64(10), "u")
	_, err = modelAtDecode(zero, 40)
	require.Error(t, err, "a zero hash")
	ok, _ := outs.Pack(true, big.NewInt(3), [32]byte{1}, uint64(40), "u")
	v, err = modelAtDecode(ok, 40)
	require.NoError(t, err)
	require.Equal(t, ModelVersion{Found: true, Index: 3, Hash: [32]byte{1}, Activation: 40, URI: "u"}, v)
	require.False(t, modelAtVia(ctx, app.EVMKeeper, nil, 20).Found, "no registry")
	_, err = app.ModelVersionAt(ctx, 0)
	require.Error(t, err, "heights start at 1")

	// governance removes it
	futSet(t, app, ctx, "model-epochs", map[string]string{"address": ""})
	v, err = app.ModelVersionAt(ctx, 20)
	require.ErrorContains(t, err, "no ModelEpochs registry")
	require.False(t, v.Found)
	out, err = futCall(app, ctx, gov, AIPrecompileAddress, AIABI, "modelEpochs")
	require.NoError(t, err)
	require.Equal(t, common.Address{}, out[0])

	// the genesis export keeps it
	futSet(t, app, ctx, "model-epochs", map[string]string{"address": reg.Hex()})
	raw, err := app.pqExportGenesis(ctx)
	require.NoError(t, err)
	in, err := pqParseGenesis(raw)
	require.NoError(t, err)
	found := false
	for _, e := range in {
		if bytes.Equal(e[0], modelEpochsKey) {
			found = bytes.Equal(e[1], reg.Bytes())
		}
	}
	require.True(t, found)

	// the proposal command
	m, _, err := secProposalMsg([]string{"model-epochs", reg.Hex()})
	require.NoError(t, err)
	require.Equal(t, "model-epochs", m.(*MsgSetFuture).Kind)
	require.Contains(t, string(m.(*MsgSetFuture).Data), reg.Hex())
	m, _, err = secProposalMsg([]string{"model-epochs", "-"})
	require.NoError(t, err)
	require.JSONEq(t, `{"address":""}`, string(m.(*MsgSetFuture).Data))
	_, _, err = secProposalMsg([]string{"model-epochs", "nope"})
	require.Error(t, err)
	_, err = ModelAtQuery(ctx, client.Context{}, 1)
	require.Error(t, err, "height 1 has no state before it")
}
