//go:build zetaphy_firewall_prototype

package evmd

// ZETAPHY invariant firewall, chain layer — PROTOTYPE, NOT IN THE NODE YET.
// docs/future/invariant-firewall.md. This file is written against the
// patched evmd of zetaphy-chain/setup-node.sh (cosmos/evm v0.7.3 + the
// ZETAPHY_PQ_PATCH) but has not been compiled or run against it: it sits
// behind the build tag zetaphy_firewall_prototype and outside the patch, so
// the node that setup-node.sh builds does not contain it. Moving it into the
// patch takes the wiring at the end of this comment and a run of the fork
// test sketch next to it (zetaphy_firewall_test.go) in CI.
//
// What it does once wired in (off until governance turns it on):
//
//	invariant-firewall  MsgSetFuture kind: {"address":"0x…"} (an InvariantFirewall
//	                    contract) or {"address":""} to turn it off
//
// After every successful EVM transaction (pqHooks.PostTxProcessing, whose
// error reverts the whole transaction in x/vm's ApplyTransaction) and every
// successful MsgEVMCall, the node calls InvariantFirewall.chainCheck() on the
// state the transaction left (read-only, CHAIN_CALL_GAS, from the
// "zetaphy-firewall" module address). A chain-layer protocol whose invariants
// do not hold now but did hold at the last check point makes the transaction
// fail with ErrInvariantFirewall: whichever contract the attacker went
// through, whatever token was pulled by an approved spender, the broken state
// is never committed. The check point is the start of the block
// (firewallBeginBlock records what is broken then) and then each transaction
// that passes. A protocol that is already broken at a check point (time
// passed, a non-EVM message, a checker that changed its mind) does not revert
// anything: the chain must not stop because one protocol is broken.
//
// The chain layer fails OPEN on a firewall that cannot be read (no code,
// revert, out of gas, malformed answer): it emits zetaphy_firewall_error and
// lets the transaction through, so a broken registry cannot halt the chain.
// InvariantFirewall's bounds (MAX_CHAIN, CHAIN_GAS_BUDGET, the per-check gas
// caps and InsufficientGas) make chainCheck fit in CHAIN_CALL_GAS, so a
// correct registry always answers. The contract layer (Firewalled) stays
// fail-closed.
//
// Cost: the hook does not charge gas (as every PostTxProcessing hook in
// cosmos/evm); every EVM transaction pays the node up to CHAIN_CALL_GAS of
// EVM work. That is why the timelock approves each protocol and the budget
// is a contract constant.
//
// Wiring (to add to the patch together with this file and the core):
//
//	zetaphy_future.go   futKeyKnown: p <= 0x32; setFuture: case "invariant-firewall":
//	                    app.setFirewall(ctx, m.Data); futProposalMsg: the same kind
//	                    (an address or "-")
//	zetaphy_pqguard.go  pqHooks.PostTxProcessing, after threatRefused and before the
//	                    quantum-lock part: if r.Status == ethtypes.ReceiptStatusSuccessful
//	                    { if err := h.app.firewallPostTx(ctx); err != nil { return err } }
//	zetaphy_pqcall.go   evmCall, after `if res.Failed()`: if err := app.firewallPostTx(ctx);
//	                    err != nil { return nil, err } (the message handler's error discards
//	                    the message's state)
//	app.go              BeginBlocker, after breakerBeginBlock: app.firewallBeginBlock(ctx)

import (
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	ethtypes "github.com/ethereum/go-ethereum/core/types"

	errorsmod "cosmossdk.io/errors"

	"github.com/cosmos/evm/x/vm/statedb"
	evmtypes "github.com/cosmos/evm/x/vm/types"

	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	errortypes "github.com/cosmos/cosmos-sdk/types/errors"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
)

// Keys of the zetaphypq store (after v5's 0x20..0x30).
var (
	firewallKey     = []byte{0x31} // the InvariantFirewall contract, EVM address (20)
	firewallBaseKey = []byte{0x32} // protocols broken at the last check point (20 bytes each)
)

// FirewallCaller is the "from" of chainCheck: a module address (no key).
var FirewallCaller = common.BytesToAddress(authtypes.NewModuleAddress("zetaphy-firewall"))

// ErrInvariantFirewall: a transaction broke a chain-layer protocol's invariant (codespace "zetaphy", code 40).
var ErrInvariantFirewall = errorsmod.Register("zetaphy", 40, "invariant firewall")

func (app *EVMD) firewallAddr(ctx sdk.Context) (common.Address, bool) {
	v := app.secRaw(ctx).Get(firewallKey)
	if len(v) != 20 {
		return common.Address{}, false
	}
	return common.BytesToAddress(v), true
}

// setFirewall: governance's "invariant-firewall" kind of MsgSetFuture.
func (app *EVMD) setFirewall(ctx sdk.Context, data []byte) error {
	var c struct {
		Address string `json:"address"`
	}
	if err := futJSON(data, &c); err != nil {
		return err
	}
	st := ctx.KVStore(app.GetKey(pqStoreKey))
	if c.Address == "" {
		st.Delete(firewallKey)
		st.Delete(firewallBaseKey)
		return nil
	}
	if !common.IsHexAddress(c.Address) || common.HexToAddress(c.Address) == (common.Address{}) {
		return errorsmod.Wrap(errortypes.ErrInvalidRequest, "invariant-firewall: address: a 0x address, or \"\" to turn it off")
	}
	a := common.HexToAddress(c.Address)
	if len(app.EVMKeeper.GetCode(ctx, app.EVMKeeper.GetCodeHash(ctx, a))) == 0 {
		return errorsmod.Wrapf(errortypes.ErrInvalidRequest, "invariant-firewall: no contract at %s", a.Hex())
	}
	st.Set(firewallKey, a.Bytes())
	st.Delete(firewallBaseKey)
	return nil
}

// firewallCheck runs chainCheck() read-only on ctx's state (nothing is written back).
func (app *EVMD) firewallCheck(ctx sdk.Context) (list []fwAddr, mask uint64, err error) {
	fw, ok := app.firewallAddr(ctx)
	if !ok {
		return nil, 0, errors.New("no InvariantFirewall is set")
	}
	c, _ := ctx.CacheContext() // never written back
	c = c.WithGasMeter(storetypes.NewInfiniteGasMeter()).WithKVGasConfig(storetypes.GasConfig{}).
		WithTransientKVGasConfig(storetypes.GasConfig{}).WithEventManager(sdk.NewEventManager())
	if len(app.EVMKeeper.GetCode(c, app.EVMKeeper.GetCodeHash(c, fw))) == 0 {
		return nil, 0, fmt.Errorf("no contract at the firewall %s", fw.Hex())
	}
	var res *evmtypes.MsgEthereumTxResponse
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("chainCheck: %v", r)
			}
		}()
		sdb := statedb.New(c, app.EVMKeeper, statedb.NewEmptyTxConfig())
		res, err = app.EVMKeeper.ApplyMessage(c, sdb, core.Message{
			From: FirewallCaller, To: &fw, Value: new(big.Int), GasLimit: firewallCallGas, Data: firewallChainCheckSelector,
			GasPrice: new(big.Int), GasFeeCap: new(big.Int), GasTipCap: new(big.Int), AccessList: ethtypes.AccessList{},
			SkipNonceChecks: true,
		}, nil, false, false, true)
	}()
	if err != nil {
		return nil, 0, err
	}
	if res == nil || res.Failed() {
		return nil, 0, errors.New("chainCheck reverted or ran out of gas")
	}
	return firewallDecode(res.Ret)
}

func (app *EVMD) firewallOn(ctx sdk.Context) bool {
	if !app.futV5(ctx, ctx.BlockHeight()) {
		return false
	}
	_, ok := app.firewallAddr(ctx)
	return ok
}

func (app *EVMD) firewallError(ctx sdk.Context, err error) {
	ctx.EventManager().EmitEvent(sdk.NewEvent("zetaphy_firewall_error", sdk.NewAttribute("error", err.Error())))
}

// firewallBeginBlock records what is broken at the start of the block (the first check point).
func (app *EVMD) firewallBeginBlock(ctx sdk.Context) {
	if !app.firewallOn(ctx) {
		return
	}
	st := ctx.KVStore(app.GetKey(pqStoreKey))
	list, mask, err := app.firewallCheck(ctx)
	if err != nil {
		app.firewallError(ctx, err)
		st.Delete(firewallBaseKey)
		return
	}
	broken, _ := firewallNewlyBroken(nil, list, mask)
	st.Set(firewallBaseKey, firewallEncodeSet(broken))
}

// firewallPostTx: after a successful EVM transaction or MsgEVMCall, on the state it left. An error
// reverts it. ctx is the transaction's own (cached) context, so the new check point is committed
// with the transaction, or dropped with it.
func (app *EVMD) firewallPostTx(ctx sdk.Context) error {
	if !app.firewallOn(ctx) {
		return nil
	}
	list, mask, err := app.firewallCheck(ctx)
	if err != nil {
		app.firewallError(ctx, err) // fail open (see the top of this file)
		return nil
	}
	base, err := firewallDecodeSet(app.secRaw(ctx).Get(firewallBaseKey))
	if err != nil {
		base = nil
	}
	broken, newly := firewallNewlyBroken(base, list, mask)
	if len(newly) > 0 {
		return errorsmod.Wrapf(ErrInvariantFirewall, "the transaction breaks an invariant of %s", common.BytesToAddress(newly[0][:]).Hex())
	}
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(firewallBaseKey, firewallEncodeSet(broken))
	return nil
}
