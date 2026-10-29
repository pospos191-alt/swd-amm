//go:build test

package evmd

// ZETAPHY v5 anomaly hold for ERC-20 tokens (zetaphy_guard.go): per-token
// rules under the account's guardian and timeout, and the native coin's
// ERC-20 interface counted under the native rule.

import (
	"bytes"
	"math/big"
	"testing"
	"time"

	transfertypes "github.com/cosmos/ibc-go/v11/modules/apps/transfer/types"
	clienttypes "github.com/cosmos/ibc-go/v11/modules/core/02-client/types"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	"github.com/cosmos/evm/precompiles/ics20"
	erc20types "github.com/cosmos/evm/x/erc20/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
)

var holdERC20ABI = func() abi.ABI {
	a, err := abi.JSON(bytes.NewReader([]byte(`[
 {"type":"function","name":"transfer","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"type":"function","name":"transferFrom","inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"type":"function","name":"approve","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"type":"function","name":"increaseAllowance","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"type":"function","name":"approve","inputs":[{"name":"token","type":"address"},{"name":"spender","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"}],"outputs":[]}
]`)))
	if err != nil {
		panic(err)
	}
	return a
}()

func holdPack(t *testing.T, method string, args ...any) []byte {
	m, ok := holdERC20ABI.Methods[method] // "approve0": Permit2's approve (overloaded name)
	require.True(t, ok, method)
	in, err := m.Inputs.Pack(args...)
	require.NoError(t, err)
	return append(append([]byte{}, m.ID...), in...)
}

func holdSetPair(app *EVMD, ctx sdk.Context, token common.Address, denom string) {
	p := erc20types.NewTokenPair(token, denom, erc20types.OWNER_MODULE)
	app.Erc20Keeper.SetTokenPair(ctx, p)
	app.Erc20Keeper.SetERC20Map(ctx, token, p.GetID())
	app.Erc20Keeper.SetDenomMap(ctx, denom, p.GetID())
}

func TestAnomalyHoldERC20(t *testing.T) {
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	guardian := secPQAccount(t, app, ctx)
	stranger := secPQAccount(t, app, ctx)
	U, G := common.BytesToAddress(user), common.BytesToAddress(guardian)
	fctx := ctx.WithExecMode(sdk.ExecModeFinalize)
	token := common.HexToAddress("0x0000000000000000000000000000000000070c00")
	untracked := common.HexToAddress("0x0000000000000000000000000000000000070c01")
	native := common.HexToAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")
	dest := common.HexToAddress("0x0000000000000000000000000000000000de5700")
	spender := common.HexToAddress("0x000000000000000000000000000000000005e4d0")
	tokenDenom := "erc20/" + token.Hex()
	holdSetPair(app, ctx, native, evmtypes.GetEVMCoinDenom())
	holdSetPair(app, ctx, token, tokenDenom)
	maxU := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))

	call := func(c sdk.Context, from sdk.AccAddress, to common.Address, data []byte) error {
		return app.guardTx(c, futTx(t, app, &MsgEVMCall{Sender: from.String(), To: to.Hex(), Data: data, GasLimit: 100000}))
	}
	xfer := func(c sdk.Context, from sdk.AccAddress, tok common.Address, amt int64) error {
		return call(c, from, tok, holdPack(t, "transfer", dest, big.NewInt(amt)))
	}
	guard := func(from sdk.AccAddress, method string, args ...any) ([]any, error) {
		return futCall(app, ctx, from, GuardPrecompileAddress, GuardABI, method, args...)
	}
	tokenState := func() (count uint64, avg int64) {
		out, err := guard(user, "holdTokenState", U, token)
		require.NoError(t, err)
		return out[2].(uint64), out[3].(*big.Int).Int64()
	}

	// not opted in: nothing is checked
	require.NoError(t, xfer(fctx, user, token, 1_000_000))
	_, err := guard(user, "holdToken", token, big.NewInt(10), uint32(30000))
	require.Error(t, err, "opt in first")
	require.ErrorContains(t, app.holdTokenOptIn(ctx, U, token, big.NewInt(10), 30000), "opt in first")
	_, err = guard(user, "holdOptIn", G, uint64(3600), big.NewInt(10), uint32(30000))
	require.NoError(t, err)
	_, err = guard(user, "holdToken", native, big.NewInt(10), uint32(30000))
	require.Error(t, err, "the native coin's ERC-20 interface is the main rule's")
	require.ErrorContains(t, app.holdTokenOptIn(ctx, U, native, big.NewInt(10), 30000), "native coin")
	_, err = guard(user, "holdToken", token, big.NewInt(0), uint32(30000))
	require.Error(t, err, "minAmount > 0")
	_, err = guard(user, "holdToken", token, big.NewInt(10), uint32(30000))
	require.NoError(t, err)
	_, err = guard(user, "holdToken", token, big.NewInt(10), uint32(30000))
	require.Error(t, err, "held already")
	require.ErrorContains(t, app.holdTokenOptIn(ctx, U, token, big.NewInt(10), 30000), "held already")
	out, err := guard(stranger, "holdTokens", U)
	require.NoError(t, err)
	require.Equal(t, []common.Address{token}, out[0])

	// warm-up and the learned profile, per token
	for i := 0; i < 4; i++ {
		require.NoError(t, xfer(fctx, user, token, 8))
	}
	err = xfer(fctx, user, token, 12)
	require.ErrorIs(t, err, ErrGuard, "above the minimum while warming up: held")
	require.ErrorContains(t, err, "requestTokenRelease")
	require.NoError(t, xfer(fctx, user, token, 8))
	n, avg := tokenState()
	require.Equal(t, uint64(5), n)
	require.Equal(t, int64(8), avg)
	require.NoError(t, xfer(fctx, user, token, 20), "20 <= 3 × 8")
	n, _ = tokenState()
	require.Equal(t, uint64(6), n)
	nat, natAvg := app.holdStatsOf(ctx, U)
	require.Zero(t, nat, "token outflows do not touch the native profile")
	require.Zero(t, natAvg.Sign())

	require.NoError(t, xfer(fctx, user, untracked, 1_000_000), "a token without a rule is not checked")
	// an ordinary contract call (an unknown selector) by an enrolled account
	// (guardTargets used to slice out of range here)
	require.NotPanics(t, func() { guardTargets(&dest, []byte{1, 2, 3, 4, 5}) })
	require.NoError(t, call(fctx, user, dest, append([]byte{0xde, 0xad, 0xbe, 0xef}, make([]byte, 64)...)))
	require.NoError(t, xfer(fctx, stranger, token, 1_000_000), "other accounts are not affected")

	// every way of moving a drain-sized amount is held, in CheckTx and in a block
	drains := map[string]sdk.Msg{
		"transfer":           &MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "transfer", dest, big.NewInt(500)), GasLimit: 1e5},
		"transferFrom(self)": &MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "transferFrom", U, dest, big.NewInt(500)), GasLimit: 1e5},
		"approve":            &MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "approve", spender, big.NewInt(500)), GasLimit: 1e5},
		"unlimited approve":  &MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "approve", spender, maxU), GasLimit: 1e5},
		"increaseAllowance":  &MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "increaseAllowance", spender, big.NewInt(500)), GasLimit: 1e5},
		"Permit2 approve":    &MsgEVMCall{Sender: user.String(), To: permit2Address.Hex(), Data: holdPack(t, "approve0", token, spender, big.NewInt(500), big.NewInt(1)), GasLimit: 1e5},
		"bank send":          &banktypes.MsgSend{FromAddress: user.String(), ToAddress: stranger.String(), Amount: sdk.NewCoins(sdk.NewCoin(tokenDenom, sdkmath.NewInt(500)))},
		"multisend": &banktypes.MsgMultiSend{Inputs: []banktypes.Input{{Address: user.String(), Coins: sdk.NewCoins(sdk.NewCoin(tokenDenom, sdkmath.NewInt(500)))}},
			Outputs: []banktypes.Output{{Address: stranger.String(), Coins: sdk.NewCoins(sdk.NewCoin(tokenDenom, sdkmath.NewInt(500)))}}},
		"IBC transfer": &transfertypes.MsgTransfer{SourcePort: "transfer", SourceChannel: "channel-0", Token: sdk.NewCoin(tokenDenom, sdkmath.NewInt(500)),
			Sender: user.String(), Receiver: "osmo1receiver", TimeoutTimestamp: 1},
		"convert to another":      &erc20types.MsgConvertERC20{ContractAddress: token.Hex(), Amount: sdkmath.NewInt(500), Receiver: stranger.String(), Sender: U.Hex()},
		"convert coin to another": &erc20types.MsgConvertCoin{Coin: sdk.NewCoin(tokenDenom, sdkmath.NewInt(500)), Receiver: common.BytesToAddress(stranger).Hex(), Sender: user.String()},
	}
	ics, err := ics20.ABI.Pack(ics20.TransferMethod, "transfer", "channel-0", tokenDenom, big.NewInt(500), U, "osmo1receiver",
		clienttypes.Height{}, uint64(1), "")
	require.NoError(t, err)
	drains["ICS-20 precompile"] = &MsgEVMCall{Sender: user.String(), To: ics20Address.Hex(), Data: ics, GasLimit: 1e6}
	for name, m := range drains {
		require.ErrorIs(t, app.guardTx(ctx, futTx(t, app, m)), ErrGuard, name+" (CheckTx)")
		require.ErrorIs(t, app.guardTx(fctx, futTx(t, app, m)), ErrGuard, name+" (block)")
	}
	n, _ = tokenState()
	require.Equal(t, uint64(6), n, "held outflows teach nothing")

	// what is not the signer's own outflow is not counted
	require.NoError(t, call(fctx, user, token, holdPack(t, "transferFrom", common.BytesToAddress(stranger), dest, big.NewInt(500))),
		"pulling someone else's tokens")
	require.NoError(t, call(fctx, user, untracked, holdPack(t, "approve0", token, spender, big.NewInt(500), big.NewInt(1))),
		"Permit2's selector on another contract")
	require.NoError(t, app.guardTx(fctx, futTx(t, app, &erc20types.MsgConvertERC20{ContractAddress: token.Hex(), Amount: sdkmath.NewInt(500),
		Receiver: user.String(), Sender: U.Hex()})), "converting to oneself")

	// approvals are checked but do not teach; one tx's outflows add up
	require.NoError(t, call(fctx, user, token, holdPack(t, "approve", spender, big.NewInt(20))))
	n2, _ := tokenState()
	require.Equal(t, n, n2, "an approval does not teach the profile")
	two := futTx(t, app,
		&MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "transfer", dest, big.NewInt(15)), GasLimit: 1e5},
		&MsgEVMCall{Sender: user.String(), To: token.Hex(), Data: holdPack(t, "transfer", dest, big.NewInt(15)), GasLimit: 1e5})
	require.ErrorIs(t, app.guardTx(fctx, two), ErrGuard, "15 + 15 > 3 × average")

	// release by the guardian
	out, err = guard(user, "requestTokenRelease", token, big.NewInt(500))
	require.NoError(t, err)
	require.Equal(t, uint64(ctx.BlockTime().Unix()+3600), out[0])
	require.ErrorIs(t, xfer(fctx, user, token, 500), ErrGuard, "not confirmed, not timed out")
	_, err = guard(stranger, "confirmTokenRelease", U, token)
	require.Error(t, err, "only the guardian")
	_, err = guard(user, "confirmTokenRelease", U, token)
	require.Error(t, err, "the account cannot confirm itself")
	_, err = guard(guardian, "confirmTokenRelease", U, token)
	require.NoError(t, err)
	require.ErrorIs(t, xfer(fctx, user, token, 600), ErrGuard, "more than released")
	require.NoError(t, xfer(ctx, user, token, 500), "CheckTx does not use it up")
	require.NoError(t, xfer(fctx, user, token, 500))
	require.ErrorIs(t, xfer(fctx, user, token, 500), ErrGuard, "the release is used up")

	// release by timeout; cancel in between
	_, err = guard(user, "requestTokenRelease", token, big.NewInt(400))
	require.NoError(t, err)
	_, err = guard(user, "cancelTokenRelease", U, token)
	require.NoError(t, err, "the account may cancel its own release")
	require.ErrorIs(t, xfer(fctx.WithBlockTime(ctx.BlockTime().Add(2*time.Hour)), user, token, 400), ErrGuard, "cancelled")
	_, err = guard(user, "requestTokenRelease", token, big.NewInt(400))
	require.NoError(t, err)
	require.ErrorIs(t, xfer(fctx.WithBlockTime(ctx.BlockTime().Add(59*time.Minute)), user, token, 400), ErrGuard, "before the timeout")
	require.NoError(t, xfer(fctx.WithBlockTime(ctx.BlockTime().Add(61*time.Minute)), user, token, 400), "timed out: released")
	require.ErrorIs(t, xfer(fctx.WithBlockTime(ctx.BlockTime().Add(25*time.Hour)), user, token, 5000), ErrGuard, "releases do not last")

	// an unlimited approval can be released (for a DEX router, say)
	_, err = guard(user, "requestTokenRelease", token, maxU)
	require.NoError(t, err)
	_, err = guard(guardian, "confirmTokenRelease", U, token)
	require.NoError(t, err)
	require.NoError(t, call(fctx, user, token, holdPack(t, "approve", spender, maxU)))

	// a token's opt-out waits the timeout; the guardian can stop it
	_, err = guard(stranger, "holdTokenOptOut", token)
	require.Error(t, err, "nothing to opt out of")
	out, err = guard(user, "holdTokenOptOut", token)
	require.NoError(t, err)
	require.Equal(t, uint64(ctx.BlockTime().Unix()+3600), out[0])
	require.ErrorIs(t, xfer(fctx, user, token, 5000), ErrGuard, "still on")
	_, err = guard(user, "cancelTokenOptOut", U, token)
	require.Error(t, err, "only the guardian cancels an opt-out")
	_, err = guard(guardian, "cancelTokenOptOut", U, token)
	require.NoError(t, err)
	require.ErrorIs(t, xfer(fctx.WithBlockTime(ctx.BlockTime().Add(2*time.Hour)), user, token, 5000), ErrGuard, "opt-out cancelled")
	_, err = guard(user, "holdTokenOptOut", token)
	require.NoError(t, err)
	later := fctx.WithBlockTime(ctx.BlockTime().Add(2 * time.Hour))
	require.NoError(t, xfer(later, user, token, 5000), "opted out after the timeout")
	out, err = futCall(app, later, user, GuardPrecompileAddress, GuardABI, "holdTokens", U)
	require.NoError(t, err)
	require.Empty(t, out[0])
}

// The native coin through its ERC-20 interface (0xEeee…EEeE), IBC and
// MsgConvertCoin counts under the account's native rule; the account's
// opt-out ends its token rules, and a new opt-in starts clean.
func TestAnomalyHoldNativeERC20(t *testing.T) {
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	guardian := secPQAccount(t, app, ctx)
	U, G := common.BytesToAddress(user), common.BytesToAddress(guardian)
	fctx := ctx.WithExecMode(sdk.ExecModeFinalize)
	native := common.HexToAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE")
	token := common.HexToAddress("0x0000000000000000000000000000000000070c00")
	dest := common.HexToAddress("0x0000000000000000000000000000000000de5700")
	denom := evmtypes.GetEVMCoinDenom()
	holdSetPair(app, ctx, native, denom)
	guard := func(c sdk.Context, from sdk.AccAddress, method string, args ...any) ([]any, error) {
		return futCall(app, c, from, GuardPrecompileAddress, GuardABI, method, args...)
	}
	pay := func(c sdk.Context, v int64) error {
		return app.guardTx(c, futTx(t, app, &MsgEVMCall{Sender: user.String(), To: dest.Hex(), Value: big.NewInt(v).String(), GasLimit: 50000}))
	}
	_, err := guard(ctx, user, "holdOptIn", G, uint64(3600), big.NewInt(10), uint32(30000))
	require.NoError(t, err)
	for i := 0; i < 5; i++ {
		require.NoError(t, pay(fctx, 8))
	}
	n, _ := app.holdStatsOf(ctx, U)
	require.Equal(t, uint64(5), n)

	for name, m := range map[string]sdk.Msg{
		"ERC-20 interface transfer": &MsgEVMCall{Sender: user.String(), To: native.Hex(), Data: holdPack(t, "transfer", dest, big.NewInt(500)), GasLimit: 1e5},
		"ERC-20 interface approve":  &MsgEVMCall{Sender: user.String(), To: native.Hex(), Data: holdPack(t, "approve", dest, big.NewInt(500)), GasLimit: 1e5},
		"IBC transfer": &transfertypes.MsgTransfer{SourcePort: "transfer", SourceChannel: "channel-0", Token: sdk.NewCoin(denom, sdkmath.NewInt(500)),
			Sender: user.String(), Receiver: "osmo1receiver", TimeoutTimestamp: 1},
		"convert coin to another": &erc20types.MsgConvertCoin{Coin: sdk.NewCoin(denom, sdkmath.NewInt(500)), Receiver: dest.Hex(), Sender: user.String()},
	} {
		require.ErrorIs(t, app.guardTx(fctx, futTx(t, app, m)), ErrGuard, name)
	}
	require.NoError(t, app.guardTx(fctx, futTx(t, app, &MsgEVMCall{Sender: user.String(), To: native.Hex(),
		Data: holdPack(t, "transfer", dest, big.NewInt(9)), GasLimit: 1e5})), "inside the profile")
	n, _ = app.holdStatsOf(ctx, U)
	require.Equal(t, uint64(6), n, "the ERC-20 interface teaches the native profile")

	// the account's opt-out ends the token rules too; a new opt-in starts clean
	_, err = guard(ctx, user, "holdToken", token, big.NewInt(10), uint32(30000))
	require.NoError(t, err)
	_, err = guard(ctx, user, "holdOptOut")
	require.NoError(t, err)
	later := fctx.WithBlockTime(ctx.BlockTime().Add(2 * time.Hour))
	require.NoError(t, app.guardTx(later, futTx(t, app, &MsgEVMCall{Sender: user.String(), To: token.Hex(),
		Data: holdPack(t, "transfer", dest, big.NewInt(1_000_000)), GasLimit: 1e5})), "opted out")
	_, err = guard(later, user, "holdOptIn", G, uint64(3600), big.NewInt(10), uint32(30000))
	require.NoError(t, err)
	out, err := guard(later, user, "holdTokens", U)
	require.NoError(t, err)
	require.Empty(t, out[0], "token rules of the earlier opt-in are gone")
	n, _ = app.holdStatsOf(later, U)
	require.Zero(t, n, "so is the profile")
}
