//go:build test

package evmd

// ZETAPHY stage 7: CosmWasm next to the EVM (zetaphy_cosmwasm.go). Reference
// contracts: wasmd's testdata (hackatom, reflect), sha256 pinned below.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	wasmkeeper "github.com/CosmWasm/wasmd/x/wasm/keeper"
	"github.com/CosmWasm/wasmd/x/wasm/keeper/testdata"
	wasmtypes "github.com/CosmWasm/wasmd/x/wasm/types"
	wasmvmtypes "github.com/CosmWasm/wasmvm/v3/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	errortypes "github.com/cosmos/cosmos-sdk/types/errors"
	"github.com/cosmos/cosmos-sdk/x/authz"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"

	"github.com/cosmos/evm/crypto/ethsecp256k1"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

// sha256 of the reference contracts (wasmd v0.70.5 x/wasm/keeper/testdata,
// built by CosmWasm's release pipeline).
const (
	wasmHackatomSHA256 = "3f4cd47c39c57fe1733fb41ed176eebd9d5c67baf5df8a1eeda1455e758f8514"
	wasmReflectSHA256  = "99aef385de6f1cd85c2253fa35a3c2596c7106ca14e81ba3b6ba5fbd362fe92d"
)

func wasmSum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func wasmStore(t *testing.T, app *EVMD, ctx sdk.Context, code []byte) uint64 {
	t.Helper()
	res, err := wasmkeeper.NewMsgServerImpl(&app.WasmKeeper).StoreCode(ctx, &wasmtypes.MsgStoreCode{Sender: secGovAddr(), WASMByteCode: code})
	require.NoError(t, err)
	require.Equal(t, wasmSum(code), hex.EncodeToString(res.Checksum))
	return res.CodeID
}

func wasmInstantiate(t *testing.T, app *EVMD, ctx sdk.Context, sender sdk.AccAddress, codeID uint64, msg any, funds sdk.Coins) sdk.AccAddress {
	t.Helper()
	bz, err := json.Marshal(msg)
	require.NoError(t, err)
	res, err := wasmkeeper.NewMsgServerImpl(&app.WasmKeeper).InstantiateContract(ctx, &wasmtypes.MsgInstantiateContract{
		Sender: sender.String(), CodeID: codeID, Label: "test", Msg: bz, Funds: funds})
	require.NoError(t, err)
	a, err := sdk.AccAddressFromBech32(res.Address)
	require.NoError(t, err)
	require.Len(t, a, 32, "contract addresses are 32 bytes")
	return a
}

func wasmExecute(app *EVMD, ctx sdk.Context, sender, contract sdk.AccAddress, msg any) error {
	bz, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = wasmkeeper.NewMsgServerImpl(&app.WasmKeeper).ExecuteContract(ctx, &wasmtypes.MsgExecuteContract{
		Sender: sender.String(), Contract: contract.String(), Msg: bz})
	return err
}

func TestWasmReferenceContracts(t *testing.T) {
	require.Equal(t, wasmHackatomSHA256, wasmSum(testdata.HackatomContractWasm()))
	require.Equal(t, testdata.ChecksumHackatom, wasmHackatomSHA256)
	require.Equal(t, wasmReflectSHA256, wasmSum(testdata.ReflectContractWasm()))
}

// A new chain: upload by governance only, instantiate by everybody, 800 KiB.
func TestWasmGenesisParams(t *testing.T) {
	app, ctx := secApp(t)
	var gs wasmtypes.GenesisState
	app.AppCodec().MustUnmarshalJSON(app.DefaultGenesis()[wasmtypes.ModuleName], &gs)
	require.Equal(t, wasmtypes.AccessTypeNobody, gs.Params.CodeUploadAccess.Permission)
	require.Empty(t, gs.Params.CodeUploadAccess.Addresses)
	require.Equal(t, wasmtypes.AccessTypeEverybody, gs.Params.InstantiateDefaultPermission)
	p := app.WasmKeeper.GetParams(ctx)
	require.Equal(t, wasmtypes.AccessTypeNobody, p.CodeUploadAccess.Permission)
	require.Equal(t, wasmtypes.AccessTypeEverybody, p.InstantiateDefaultPermission)
	require.Equal(t, ZetaphyMaxWasmSize, wasmtypes.MaxWasmSize)
	require.Equal(t, ZetaphyMaxWasmSize, wasmtypes.MaxProposalWasmSize)
}

// Only governance stores code; anyone instantiates and executes it. Fees
// and coins are the chain's own (azetaphy).
func TestWasmGovOnlyUploadStoreInstantiateExecute(t *testing.T) {
	app, ctx := secApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	k, _ := ethsecp256k1.GenerateKey()
	user := sdk.AccAddress(k.PubKey().Address())
	pqFund(t, app, ctx, user, secOne())
	srv := wasmkeeper.NewMsgServerImpl(&app.WasmKeeper)
	_, err := srv.StoreCode(ctx, &wasmtypes.MsgStoreCode{Sender: user.String(), WASMByteCode: testdata.HackatomContractWasm()})
	require.ErrorIs(t, err, errortypes.ErrUnauthorized, "upload is governance only")

	codeID := wasmStore(t, app, ctx, testdata.HackatomContractWasm())
	beneficiary := sdk.AccAddress(crypto.Keccak256([]byte("beneficiary"))[:20])
	contract := wasmInstantiate(t, app, ctx, user, codeID,
		map[string]string{"verifier": user.String(), "beneficiary": beneficiary.String()},
		sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewInt(5000))))
	require.Equal(t, int64(5000), app.BankKeeper.GetBalance(ctx, contract, denom).Amount.Int64())

	q, err := app.WasmKeeper.QuerySmart(ctx, contract, []byte(`{"verifier":{}}`))
	require.NoError(t, err)
	require.JSONEq(t, `{"verifier":"`+user.String()+`"}`, string(q))

	other := sdk.AccAddress(crypto.Keccak256([]byte("other"))[:20])
	pqFund(t, app, ctx, other, secOne())
	require.Error(t, wasmExecute(app, ctx, other, contract, map[string]any{"release": map[string]any{}}), "only the verifier releases")
	require.NoError(t, wasmExecute(app, ctx, user, contract, map[string]any{"release": map[string]any{}}))
	require.Equal(t, int64(5000), app.BankKeeper.GetBalance(ctx, beneficiary, denom).Amount.Int64())

	// Governance can open upload to an allow-list.
	p := app.WasmKeeper.GetParams(ctx)
	p.CodeUploadAccess = wasmtypes.AccessTypeAnyOfAddresses.With(user)
	_, err = srv.UpdateParams(ctx, &wasmtypes.MsgUpdateParams{Authority: secGovAddr(), Params: p})
	require.NoError(t, err)
	_, err = srv.StoreCode(ctx, &wasmtypes.MsgStoreCode{Sender: user.String(), WASMByteCode: testdata.HackatomContractWasm()})
	require.NoError(t, err)
	_, err = srv.UpdateParams(ctx, &wasmtypes.MsgUpdateParams{Authority: user.String(), Params: wasmtypes.DefaultParams()})
	require.Error(t, err, "only governance sets the parameters")
}

// Wasm txs are Cosmos txs: the quantum lock and Q-day apply to them.
func TestWasmQDayAndQuantumLock(t *testing.T) {
	app, ctx := secApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	codeID := wasmStore(t, app, ctx, testdata.HackatomContractWasm())
	k, _ := ethsecp256k1.GenerateKey()
	user := sdk.AccAddress(k.PubKey().Address())
	pqFund(t, app, ctx, user, secOne())
	contract := wasmInstantiate(t, app, ctx, user, codeID,
		map[string]string{"verifier": user.String(), "beneficiary": user.String()}, nil)
	pq := secPQAccount(t, app, ctx)

	exec := func(from sdk.AccAddress) sdk.Msg {
		return &wasmtypes.MsgExecuteContract{Sender: from.String(), Contract: contract.String(), Msg: []byte(`{"release":{}}`)}
	}
	signed := func(c sdk.Context, msg sdk.Msg) sdk.Tx {
		b := app.GetTxConfig().NewTxBuilder()
		require.NoError(t, b.SetMsgs(msg))
		b.SetGasLimit(500000)
		b.SetFeeAmount(sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewInt(500000_000_000_000))))
		pqSignTx(t, app, c, b, []cryptotypes.PrivKey{k})
		return b.GetTx()
	}
	unsigned := func(msg sdk.Msg) sdk.Tx {
		b := app.GetTxConfig().NewTxBuilder()
		require.NoError(t, b.SetMsgs(msg))
		b.SetGasLimit(500000)
		return b.GetTx()
	}
	ante := func(c sdk.Context, tx sdk.Tx) error {
		cc, _ := c.CacheContext()
		_, err := app.AnteHandler()(cc, tx, false)
		return err
	}
	require.NoError(t, ante(ctx, signed(ctx, exec(user))), "an ECDSA wasm tx before Q-day")

	secSetQDay(t, app, ctx, 50, 5)
	after := ctx.WithBlockHeight(50)
	require.ErrorIs(t, ante(after, signed(after, exec(user))), ErrQDay, "after Q-day an ECDSA-signed wasm tx is refused")
	require.ErrorIs(t, app.qdayCheckTx(after, unsigned(exec(user))), ErrQDay)
	require.NoError(t, app.qdayCheckTx(after, unsigned(exec(pq))), "an ML-DSA-44 signer passes")
	// (An authz grant given before Q-day keeps working, as for every message.)

	// A quantum-locked account's own key cannot run wasm txs either.
	secSetQDay(t, app, ctx, 0, 0)
	app.applyQuantumLock(ctx, user, pq)
	require.ErrorContains(t, ante(ctx, signed(ctx, exec(user))), "quantum-locked")
}

func wasmAny(t *testing.T, app *EVMD, m sdk.Msg) wasmvmtypes.CosmosMsg {
	a, err := codectypes.NewAnyWithValue(m)
	require.NoError(t, err)
	return wasmvmtypes.CosmosMsg{Any: &wasmvmtypes.AnyMsg{TypeURL: a.TypeUrl, Value: a.Value}}
}

func wasmReflect(app *EVMD, ctx sdk.Context, owner, reflect sdk.AccAddress, msgs ...wasmvmtypes.CosmosMsg) error {
	return wasmExecute(app, ctx, owner, reflect, testdata.ReflectHandleMsg{Reflect: &testdata.ReflectPayload{Msgs: msgs}})
}

// What a contract dispatches: no authz on behalf of a quantum-locked
// account, no EVM txs or ZETAPHY account messages, no IBC channel traffic.
func TestWasmDispatchGuard(t *testing.T) {
	app, ctx := secApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	owner := sdk.AccAddress(crypto.Keccak256([]byte("owner"))[:20])
	pqFund(t, app, ctx, owner, secOne())
	reflect := wasmInstantiate(t, app, ctx, owner, wasmStore(t, app, ctx, testdata.ReflectContractWasm()), map[string]any{}, nil)
	pqFund(t, app, ctx, reflect, secOne())

	// Its own coins: a plain bank send works.
	dest := sdk.AccAddress(crypto.Keccak256([]byte("dest"))[:20])
	send := wasmvmtypes.CosmosMsg{Bank: &wasmvmtypes.BankMsg{Send: &wasmvmtypes.SendMsg{ToAddress: dest.String(), Amount: wasmvmtypes.Array[wasmvmtypes.Coin]{{Denom: denom, Amount: "7"}}}}}
	require.NoError(t, wasmReflect(app, ctx, owner, reflect, send))
	require.Equal(t, int64(7), app.BankKeeper.GetBalance(ctx, dest, denom).Amount.Int64())

	// An authz grant to the contract, used through MsgExec: fine while the
	// granter is not locked, refused once it is.
	granter := sdk.AccAddress(crypto.Keccak256([]byte("granter"))[:20])
	pqFund(t, app, ctx, granter, secOne())
	exp := ctx.BlockTime().AddDate(1, 0, 0)
	require.NoError(t, app.AuthzKeeper.SaveGrant(ctx, reflect, granter, authz.NewGenericAuthorization(sdk.MsgTypeURL(&banktypes.MsgSend{})), &exp))
	ex := authz.NewMsgExec(reflect, []sdk.Msg{&banktypes.MsgSend{FromAddress: granter.String(), ToAddress: dest.String(), Amount: sdk.NewCoins(sdk.NewInt64Coin(denom, 3))}})
	require.NoError(t, wasmReflect(app, ctx, owner, reflect, wasmAny(t, app, &ex)))
	require.Equal(t, int64(10), app.BankKeeper.GetBalance(ctx, dest, denom).Amount.Int64())
	app.applyQuantumLock(ctx, granter, secPQAccount(t, app, ctx))
	err := wasmReflect(app, ctx, owner, reflect, wasmAny(t, app, &ex))
	require.ErrorContains(t, err, "quantum-locked")
	require.Equal(t, int64(10), app.BankKeeper.GetBalance(ctx, dest, denom).Amount.Int64())

	// EVM txs and ZETAPHY's post-quantum messages are for keys, not contracts.
	require.Error(t, wasmReflect(app, ctx, owner, reflect, wasmAny(t, app, &evmtypes.MsgEthereumTx{From: reflect})))
	require.ErrorIs(t, app.wasmGuard(ctx, &evmtypes.MsgEthereumTx{From: reflect}, 0), ErrWasmGuard)
	require.ErrorIs(t, app.wasmGuard(ctx, &MsgEVMCall{Sender: reflect.String()}, 0), ErrWasmGuard)
	require.ErrorIs(t, app.wasmGuard(ctx, &MsgQuantumLock{Signer: reflect.String()}, 0), ErrWasmGuard)

	// IBC: no raw packets or channel changes from contracts (v1 and v2).
	err = wasmReflect(app, ctx, owner, reflect, wasmvmtypes.CosmosMsg{IBC: &wasmvmtypes.IBCMsg{SendPacket: &wasmvmtypes.SendPacketMsg{
		ChannelID: "channel-0", Data: []byte("x"), Timeout: wasmvmtypes.IBCTimeout{Timestamp: 1}}}})
	require.ErrorIs(t, err, ErrWasmGuard)
	g := wasmGuardMessenger{}
	_, _, _, err = g.DispatchMsg(ctx, reflect, "", wasmvmtypes.CosmosMsg{IBC2: &wasmvmtypes.IBC2Msg{SendPacket: &wasmvmtypes.IBC2SendPacketMsg{SourceClient: "07-tendermint-0"}}})
	require.ErrorIs(t, err, ErrWasmGuard)
	_, _, _, err = g.DispatchMsg(ctx, reflect, "", wasmvmtypes.CosmosMsg{IBC: &wasmvmtypes.IBCMsg{CloseChannel: &wasmvmtypes.CloseChannelMsg{ChannelID: "channel-0"}}})
	require.ErrorIs(t, err, ErrWasmGuard)
}

// IBC for contracts is off: the routers know only the transfer stack.
func TestWasmIBCPortsOff(t *testing.T) {
	app, _ := secApp(t)
	require.Equal(t, []string{"transfer"}, app.IBCKeeper.PortKeeper.Router.Keys())
	require.False(t, app.IBCKeeper.ChannelKeeperV2.Router.HasRoute(wasmkeeper.PortIDPrefixV2+"zetaphy1abc"))
	require.True(t, app.IBCKeeper.ChannelKeeperV2.Router.HasRoute("transfer"))
}

// A running chain gets x/wasm with "zetaphy-v4": the module's genesis runs
// (wasmd's defaults), then ZETAPHY's parameters replace them.
func TestWasmV4UpgradeHandler(t *testing.T) {
	app, ctx := secApp(t)
	ctx = ctx.WithBlockHeight(40)
	up := ctx.KVStore(app.GetKey(upgradetypes.StoreKey))
	up.Delete(append([]byte{upgradetypes.VersionMapByte}, []byte(wasmtypes.ModuleName)...)) // as on a chain without wasm
	vmap, err := app.UpgradeKeeper.GetModuleVersionMap(ctx)
	require.NoError(t, err)
	_, had := vmap[wasmtypes.ModuleName]
	require.False(t, had)
	require.NoError(t, app.WasmKeeper.SetParams(ctx, wasmtypes.DefaultParams()))
	st := ctx.KVStore(app.GetKey(pqStoreKey))
	st.Delete(pqActivationKey)
	st.Delete(secV3Key)

	require.NoError(t, app.UpgradeKeeper.ApplyUpgrade(ctx, upgradetypes.Plan{Name: ZetaphyV4UpgradeName, Height: 40}))
	p := app.WasmKeeper.GetParams(ctx)
	require.Equal(t, wasmtypes.AccessTypeNobody, p.CodeUploadAccess.Permission, "wasmd's default (everybody) replaced")
	require.Equal(t, wasmtypes.AccessTypeEverybody, p.InstantiateDefaultPermission)
	require.Equal(t, int64(41), app.zetaphyV2Height(ctx), "v4 includes v2")
	require.Equal(t, int64(41), app.secV3Height(ctx), "and v3")
	vmap, err = app.UpgradeKeeper.GetModuleVersionMap(ctx)
	require.NoError(t, err)
	_, had = vmap[wasmtypes.ModuleName]
	require.True(t, had)
	require.Equal(t, []string{wasmtypes.StoreKey}, zetaphyStoreUpgrades().Added)
}
