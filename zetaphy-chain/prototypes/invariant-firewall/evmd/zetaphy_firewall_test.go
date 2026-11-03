//go:build test && zetaphy_firewall_prototype

package evmd

// Fork test SKETCH for the chain layer (zetaphy_firewall.go) — NOT RUN YET.
// It is written for zetaphy-chain/fork-tests/evmd (helpers futApp, futSet,
// secPQAccount, secDeploy, secGovAddr from zetaphy_future_test.go and
// zetaphy_security_test.go) and moves there with zetaphy_firewall.go once
// that file is in the patch. Run then with:
//
//	go test -tags=test -run Firewall .
//
// The firewall is a 60-byte stand-in with InvariantFirewall.chainCheck()'s
// ABI: one chain-layer protocol 0x…f1 whose "broken" bit is storage slot 0,
// which any 32-byte call sets (checked on the JS EVM: the answer bytes are the
// ones TestFirewallDecode decodes). A transaction that sets the bit is "a
// transaction that breaks an invariant".

import (
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/stretchr/testify/require"
)

// CALLDATASIZE == 32 ? sstore(0, calldataload(0)) : return abi.encode([0x…f1], sload(0))
var firewallFakeRuntime = common.FromHex("0x36602014603457604060005260005460205260016040527300000000000000000000000000000000000000f160605260806000f35b60003560005500")

func coreMsgTo(a common.Address) core.Message { return core.Message{To: &a} }

func TestFirewallChainLayer(t *testing.T) {
	app, ctx := futApp(t)
	user := secPQAccount(t, app, ctx)
	fake := secDeploy(t, app, ctx, user, firewallFakeRuntime)
	breakIt := common.LeftPadBytes([]byte{1}, 32)
	healIt := make([]byte, 32)
	call := func(data []byte) error {
		c, _ := ctx.CacheContext() // as baseapp: a failed message's state is dropped
		_, err := app.evmCall(c, &MsgEVMCall{Sender: user.String(), To: fake.Hex(), Data: data, GasLimit: 100_000})
		if err == nil {
			// commit: the next call sees it
			_, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: fake.Hex(), Data: data, GasLimit: 100_000})
		}
		return err
	}

	// off: breaking goes through
	require.NoError(t, call(breakIt))
	require.NoError(t, call(healIt))

	// governance points the chain at it; only a contract
	_, err := app.setFuture(ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "invariant-firewall", Data: []byte(`{"address":"0x0000000000000000000000000000000000600d00"}`)})
	require.ErrorContains(t, err, "no contract")
	_, err = app.setFuture(ctx, &MsgSetFuture{Authority: user.String(), Kind: "invariant-firewall", Data: []byte(`{"address":"` + fake.Hex() + `"}`)})
	require.Error(t, err, "only governance")
	futSet(t, app, ctx, "invariant-firewall", map[string]string{"address": fake.Hex()})
	app.firewallBeginBlock(ctx)

	// a transaction that breaks it fails, and leaves nothing behind
	err = call(breakIt)
	require.ErrorIs(t, err, ErrInvariantFirewall)
	list, mask, err := app.firewallCheck(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Zero(t, mask, "the broken state was never committed")
	require.NoError(t, call(healIt), "harmless transactions pass")

	// the EVM transaction path: the hook's error is what reverts an Ethereum tx in ApplyTransaction
	c, _ := ctx.CacheContext()
	app.EVMKeeper.SetState(c, fake, common.Hash{}, breakIt) // what the transaction did, before its hook runs
	r := &ethtypes.Receipt{Status: ethtypes.ReceiptStatusSuccessful}
	require.ErrorIs(t, pqHooks{app}.PostTxProcessing(c, common.Address{}, coreMsgTo(fake), r), ErrInvariantFirewall)
	r.Status = ethtypes.ReceiptStatusFailed
	require.NoError(t, pqHooks{app}.PostTxProcessing(c, common.Address{}, coreMsgTo(fake), r), "a failed tx changed nothing: not checked")

	// already broken at the start of a block (not by a transaction): nothing is reverted
	app.EVMKeeper.SetState(ctx, fake, common.Hash{}, breakIt)
	app.firewallBeginBlock(ctx)
	require.NoError(t, call(breakIt))
	// it heals, then a transaction breaks it again: reverted
	require.NoError(t, call(healIt))
	require.ErrorIs(t, call(breakIt), ErrInvariantFirewall)

	// a registry that does not answer fails open (the chain must not stop) and says so
	loop := secDeploy(t, app, ctx, user, common.FromHex("5b600056"))
	futSet(t, app, ctx, "invariant-firewall", map[string]string{"address": loop.Hex()})
	require.NoError(t, call(breakIt))

	// off again
	futSet(t, app, ctx, "invariant-firewall", map[string]string{"address": ""})
	_, ok := app.firewallAddr(ctx)
	require.False(t, ok)
}
