//go:build test

package evmd

// Quantum lock guards against a real app: the fee payer, malformed txs that
// must not crash a node, contract-creation nonces, and genesis export.

import (
	"bytes"
	"context"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	"github.com/cosmos/cosmos-sdk/client"
	clienttx "github.com/cosmos/cosmos-sdk/client/tx"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	txtypes "github.com/cosmos/cosmos-sdk/types/tx"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	"github.com/cosmos/cosmos-sdk/x/authz"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	minttypes "github.com/cosmos/cosmos-sdk/x/mint/types"

	"github.com/cosmos/evm/crypto/ethsecp256k1"
	"github.com/cosmos/evm/testutil/constants"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

// pqSetup gives each test a fresh app (needs -tags=test to reset the EVM config).
func pqSetup(t *testing.T) *EVMD {
	evmtypes.NewEVMConfigurator().ResetTestConfig()
	return Setup(t, constants.ExampleChainID.ChainID, constants.ExampleChainID.EVMChainID)
}

// pqApp: a fresh app and a context at height 2 with vote extensions on.
func pqApp(t *testing.T) (*EVMD, sdk.Context) {
	app := pqSetup(t)
	ctx := app.NewContext(false).WithBlockHeight(2).WithChainID(constants.ExampleChainID.ChainID)
	cp := ctx.ConsensusParams()
	cp.Abci = &cmtproto.ABCIParams{VoteExtensionsEnableHeight: 1}
	return app, ctx.WithConsensusParams(cp)
}

func pqFund(t *testing.T, app *EVMD, ctx sdk.Context, addr sdk.AccAddress, amt sdkmath.Int) {
	coins := sdk.NewCoins(sdk.NewCoin(evmtypes.GetEVMCoinDenom(), amt))
	require.NoError(t, app.BankKeeper.MintCoins(ctx, minttypes.ModuleName, coins))
	require.NoError(t, app.BankKeeper.SendCoinsFromModuleToAccount(ctx, minttypes.ModuleName, addr, coins))
	if app.AccountKeeper.GetAccount(ctx, addr) == nil {
		app.AccountKeeper.SetAccount(ctx, app.AccountKeeper.NewAccountWithAddress(ctx, addr))
	}
}

func pqSignTx(t *testing.T, app *EVMD, ctx sdk.Context, b client.TxBuilder, keys []cryptotypes.PrivKey) {
	var sigs []signing.SignatureV2
	for _, k := range keys {
		acc := app.AccountKeeper.GetAccount(ctx, sdk.AccAddress(k.PubKey().Address()))
		sigs = append(sigs, signing.SignatureV2{PubKey: k.PubKey(), Data: &signing.SingleSignatureData{SignMode: signing.SignMode_SIGN_MODE_DIRECT}, Sequence: acc.GetSequence()})
	}
	require.NoError(t, b.SetSignatures(sigs...))
	sigs = nil
	for _, k := range keys {
		acc := app.AccountKeeper.GetAccount(ctx, sdk.AccAddress(k.PubKey().Address()))
		sd := authsigning.SignerData{ChainID: ctx.ChainID(), AccountNumber: acc.GetAccountNumber(), Sequence: acc.GetSequence(), Address: acc.GetAddress().String(), PubKey: k.PubKey()}
		s, err := clienttx.SignWithPrivKey(context.Background(), signing.SignMode_SIGN_MODE_DIRECT, sd, b, k, app.GetTxConfig(), acc.GetSequence())
		require.NoError(t, err)
		sigs = append(sigs, s)
	}
	require.NoError(t, b.SetSignatures(sigs...))
}

// The locked key must not be able to spend the account as a fee payer.
func TestPQLockFeePayer(t *testing.T) {
	app, ctx := pqApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	lockedKey, _ := ethsecp256k1.GenerateKey()
	otherKey, _ := ethsecp256k1.GenerateKey()
	locked, other := sdk.AccAddress(lockedKey.PubKey().Address()), sdk.AccAddress(otherKey.PubKey().Address())
	bal := sdkmath.NewInt(1_000_000_000_000_000_000)
	pqFund(t, app, ctx, locked, bal)
	pqFund(t, app, ctx, other, bal)
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(pqLockKey(locked), make([]byte, 20))

	build := func(from sdk.AccAddress, payer sdk.AccAddress, keys ...cryptotypes.PrivKey) sdk.Tx {
		b := app.GetTxConfig().NewTxBuilder()
		require.NoError(t, b.SetMsgs(&banktypes.MsgSend{FromAddress: from.String(), ToAddress: from.String(), Amount: sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewInt(1)))}))
		b.SetGasLimit(200000)
		b.SetFeeAmount(sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewInt(200000_000_000_000))))
		if payer != nil {
			b.SetFeePayer(payer)
		}
		pqSignTx(t, app, ctx, b, keys)
		return b.GetTx()
	}
	// As in baseapp: the ante handler runs on a branch that is dropped on error.
	ante := func(tx sdk.Tx) error {
		c, _ := ctx.CacheContext()
		_, err := app.AnteHandler()(c, tx, false)
		return err
	}
	err := ante(build(locked, nil, lockedKey))
	require.ErrorContains(t, err, "quantum-locked")
	err = ante(build(other, locked, otherKey, lockedKey))
	require.ErrorContains(t, err, "quantum-locked", "fee payer")
	require.Equal(t, bal, app.BankKeeper.GetBalance(ctx, locked, denom).Amount)
	require.NoError(t, ante(build(other, nil, otherKey)), "an unlocked account still works")
}

func pqRawTx(t *testing.T, app *EVMD, body *txtypes.TxBody, ai *txtypes.AuthInfo, sigs [][]byte) (sdk.Tx, []byte) {
	bb, err := body.Marshal()
	require.NoError(t, err)
	ab, err := ai.Marshal()
	require.NoError(t, err)
	bz, err := (&txtypes.TxRaw{BodyBytes: bb, AuthInfoBytes: ab, Signatures: sigs}).Marshal()
	require.NoError(t, err)
	tx, _ := app.TxDecode(bz)
	return tx, bz
}

// Malformed txs: an error from the ante handler and from CheckTx, never a crash.
func TestPQMalformedTxs(t *testing.T) {
	app := pqSetup(t)
	_, err := app.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 1, Time: time.Now()})
	require.NoError(t, err)
	_, err = app.Commit()
	require.NoError(t, err)
	priv, _ := ethsecp256k1.GenerateKey()
	from := sdk.AccAddress(priv.PubKey().Address())
	send, _ := codectypes.NewAnyWithValue(&banktypes.MsgSend{FromAddress: from.String(), ToAddress: from.String(), Amount: sdk.NewCoins(sdk.NewInt64Coin(evmtypes.GetEVMCoinDenom(), 1))})
	exec := authz.NewMsgExec(from, []sdk.Msg{&evmtypes.MsgEthereumTx{From: from.Bytes()}})
	execAny, _ := codectypes.NewAnyWithValue(&exec)
	pk, _ := codectypes.NewAnyWithValue(priv.PubKey())
	si := []*txtypes.SignerInfo{{PublicKey: pk, ModeInfo: &txtypes.ModeInfo{Sum: &txtypes.ModeInfo_Single_{Single: &txtypes.ModeInfo_Single{Mode: signing.SignMode_SIGN_MODE_DIRECT}}}}}
	cases := map[string][]byte{}
	_, cases["no fee"] = pqRawTx(t, app, &txtypes.TxBody{Messages: []*codectypes.Any{send}}, &txtypes.AuthInfo{SignerInfos: si}, [][]byte{{1}})
	_, cases["bad granter"] = pqRawTx(t, app, &txtypes.TxBody{Messages: []*codectypes.Any{send}}, &txtypes.AuthInfo{SignerInfos: si, Fee: &txtypes.Fee{GasLimit: 100000, Granter: "garbage"}}, [][]byte{{1}})
	_, cases["exec of an empty eth tx"] = pqRawTx(t, app, &txtypes.TxBody{Messages: []*codectypes.Any{execAny}}, &txtypes.AuthInfo{SignerInfos: si, Fee: &txtypes.Fee{GasLimit: 100000}}, [][]byte{{1}})
	_, cases["no signature"] = pqRawTx(t, app, &txtypes.TxBody{Messages: []*codectypes.Any{send}}, &txtypes.AuthInfo{SignerInfos: si, Fee: &txtypes.Fee{GasLimit: 100000}}, nil)
	for name, bz := range cases {
		if tx, err := app.TxDecode(bz); err == nil {
			// Upstream ante decorators panic on some of these (baseapp's runTx
			// recovers); the mempool path below must not crash either.
			require.NotPanics(t, func() { _, _ = app.pqTxSigners(tx) }, name)
		}
		res, err := app.CheckTx(&abci.RequestCheckTx{Tx: bz, Type: abci.CheckTxType_New})
		require.NoError(t, err, name)
		require.NotZero(t, res.Code, name)
	}
	time.Sleep(time.Second) // the mempool's insert goroutines must not have crashed the test binary
}

// Each creation takes a fresh nonce: two in one tx, then the account moves on.
func TestPQCreateNonce(t *testing.T) {
	app, ctx := pqApp(t)
	ctx = ctx.WithGasMeter(storetypes.NewGasMeter(5_000_000))
	k, _ := ethsecp256k1.GenerateKey()
	a := sdk.AccAddress(k.PubKey().Address())
	pqFund(t, app, ctx, a, sdkmath.NewInt(1_000_000_000_000_000_000))
	acc := app.AccountKeeper.GetAccount(ctx, a)
	require.NoError(t, acc.SetSequence(4)) // a tx signed at 3, after the ante handler
	app.AccountKeeper.SetAccount(ctx, acc)
	initCode := common.FromHex("0x600060005360016000f3") // deploys one byte
	for _, nonce := range []uint64{4, 5} {
		out, err := app.evmCall(ctx, &MsgEVMCall{Sender: a.String(), Data: initCode, GasLimit: 200000})
		require.NoError(t, err)
		require.Equal(t, crypto.CreateAddress(common.BytesToAddress(a), nonce).Hex(), out.(*MsgEVMCallResponse).Created)
	}
	require.Equal(t, uint64(6), app.AccountKeeper.GetAccount(ctx, a).GetSequence())
}

// Locks and vote keys survive a genesis export and import.
func TestPQGenesis(t *testing.T) {
	app, ctx := pqApp(t)
	st := ctx.KVStore(app.GetKey(pqStoreKey))
	st.Set(pqLockKey(make([]byte, 20)), []byte{7})
	cur, old := bytes.Repeat([]byte{8}, 1312), bytes.Repeat([]byte{9}, 1312)
	st.Set(pqVoteKeyOf([]byte{1, 2}), append(append([]byte{0, 0, 0, 0, 0, 0, 0, 1}, cur...), old...)) // replaced in block 1
	st.Set(pqLastBlockKey, make([]byte, 40))
	raw, err := app.pqExportGenesis(ctx)
	require.NoError(t, err)
	app2, ctx2 := pqApp(t)
	require.NoError(t, app2.pqInitGenesis(ctx2, raw))
	require.Equal(t, []byte{7}, app2.pqController(ctx2, make([]byte, 20)))
	require.Equal(t, append(make([]byte, 8), cur...), ctx2.KVStore(app2.GetKey(pqStoreKey)).Get(pqVoteKeyOf([]byte{1, 2})), "the current key only, from height 0")
	require.Nil(t, ctx2.KVStore(app2.GetKey(pqStoreKey)).Get(pqLastBlockKey), "not carried over")
	require.Error(t, app2.pqInitGenesis(ctx2, []byte(`[{"key":"09","value":"00"}]`)), "unknown prefix")
}
