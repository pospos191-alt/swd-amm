//go:build test

package evmd

// The node-level invariant firewall (zetaphy_firewall.go, docs/CHAIN-FIREWALL.md),
// against the real InvariantFirewall contract (zetaphy-network/contracts/
// InvariantFirewall.sol, SS1) and the fixtures in testdata/firewall/
// FirewallFixtures.sol. ChainVault has a buggy withdraw and does NOT use the
// contract layer (Firewalled): only the node protects it.
//
// The .bin files are creation code from solc 0.8.26 (optimizer 200 runs,
// evmVersion cancun, zetaphy-network's settings). To rebuild them, compile
// InvariantFirewall.sol and FirewallFixtures.sol with those settings and write
// each contract's evm.bytecode.object (hex) to testdata/firewall/<Name>.bin.
//
//	go test -tags=test -run Firewall .

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"

	evmtypes "github.com/cosmos/evm/x/vm/types"
)

var fwTestABI = func() abi.ABI {
	a, err := abi.JSON(strings.NewReader(`[
	 {"type":"constructor","inputs":[{"name":"c","type":"address"},{"name":"g","type":"address"},{"name":"b","type":"uint16"}]},
	 {"type":"function","name":"addInvariant","inputs":[{"name":"p","type":"address"},{"name":"c","type":"address"},{"name":"g","type":"uint32"},{"name":"n","type":"bytes32"}],"outputs":[]},
	 {"type":"function","name":"requestChain","inputs":[{"name":"p","type":"address"}],"outputs":[]},
	 {"type":"function","name":"approveChain","inputs":[{"name":"p","type":"address"}],"outputs":[]},
	 {"type":"function","name":"dropChain","inputs":[{"name":"p","type":"address"}],"outputs":[]},
	 {"type":"function","name":"chainProtocols","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address[]"}]},
	 {"type":"function","name":"invariantsOf","stateMutability":"view","inputs":[{"name":"p","type":"address"}],
	  "outputs":[{"name":"","type":"tuple[]","components":[{"name":"checker","type":"address"},{"name":"gasLimit","type":"uint32"},{"name":"name","type":"bytes32"}]}]}]`))
	if err != nil {
		panic(err)
	}
	return a
}()

var fwVaultABI = func() abi.ABI {
	a, err := abi.JSON(strings.NewReader(`[
	 {"type":"constructor","inputs":[{"name":"fw","type":"address"},{"name":"gov","type":"address"}]},
	 {"type":"function","name":"deposit","stateMutability":"payable","inputs":[],"outputs":[]},
	 {"type":"function","name":"withdraw","inputs":[{"name":"a","type":"uint256"}],"outputs":[]},
	 {"type":"function","name":"withdrawBuggy","inputs":[{"name":"a","type":"uint256"}],"outputs":[]},
	 {"type":"function","name":"set","inputs":[{"name":"m","type":"uint8"}],"outputs":[]}]`))
	if err != nil {
		panic(err)
	}
	return a
}()

func fwBin(t *testing.T, name string) []byte {
	raw, err := os.ReadFile("testdata/firewall/" + name + ".bin")
	require.NoError(t, err)
	return common.FromHex(strings.TrimSpace(string(raw)))
}

func fwName(s string) [32]byte {
	var n [32]byte
	copy(n[:], s)
	return n
}

// fwEnv: a chain with the firewall's code path on (as after "zetaphy-firewall"),
// the real InvariantFirewall (governed by `timelock`), and ChainVault registered
// by its governance `pgov` with the solvency invariant, approved for the chain
// layer. The node-level firewall itself is still off.
type fwEnv struct {
	app                       *EVMD
	ctx                       sdk.Context
	user, pgov, timelock      sdk.AccAddress
	fw, vault, solvency, mode common.Address
}

func fwSetup(t *testing.T) *fwEnv {
	app, ctx := futApp(t)
	app.setFirewallHeight(ctx, 1)
	e := &fwEnv{app: app, ctx: ctx, user: secPQAccount(t, app, ctx), pgov: secPQAccount(t, app, ctx), timelock: secPQAccount(t, app, ctx)}
	deploy := func(from sdk.AccAddress, name string, args []byte) common.Address {
		out, err := app.evmCall(ctx, &MsgEVMCall{Sender: from.String(), Data: append(fwBin(t, name), args...), GasLimit: 8_000_000})
		require.NoError(t, err, name)
		return common.HexToAddress(out.(*MsgEVMCallResponse).Created)
	}
	args, err := fwTestABI.Pack("", common.HexToAddress("0x00000000000000000000000000000000000c3e70"), common.BytesToAddress(e.timelock), uint16(1000))
	require.NoError(t, err)
	e.fw = deploy(e.timelock, "InvariantFirewall", args)
	args, err = fwVaultABI.Pack("", e.fw, common.BytesToAddress(e.pgov))
	require.NoError(t, err)
	e.vault = deploy(e.user, "ChainVault", args)
	e.solvency = deploy(e.user, "SolvencyInvariant", nil)
	e.mode = deploy(e.user, "ModeInvariant", nil)

	require.NoError(t, e.call(e.pgov, e.fw, fwTestABI, "addInvariant", e.vault, e.solvency, uint32(100_000), fwName("solvent")))
	require.NoError(t, e.call(e.pgov, e.fw, fwTestABI, "addInvariant", e.vault, e.mode, uint32(60_000), fwName("mode")))
	require.NoError(t, e.call(e.pgov, e.fw, fwTestABI, "requestChain", e.vault))
	require.NoError(t, e.call(e.timelock, e.fw, fwTestABI, "approveChain", e.vault))
	// two depositors' money in the vault
	require.NoError(t, e.pay(e.user, e.vault, "deposit", fwTenth()))
	require.NoError(t, e.pay(e.pgov, e.vault, "deposit", fwTenth()))
	return e
}

func fwTenth() *big.Int { return new(big.Int).Div(secOne().BigInt(), big.NewInt(10)) }

// call runs one MsgEVMCall as baseapp does: in a cached context that is written only if the message succeeds.
func (e *fwEnv) call(from sdk.AccAddress, to common.Address, a abi.ABI, method string, args ...any) error {
	return e.callValue(from, to, nil, a, method, args...)
}

func (e *fwEnv) pay(from sdk.AccAddress, to common.Address, method string, value *big.Int) error {
	return e.callValue(from, to, value, fwVaultABI, method)
}

func (e *fwEnv) callValue(from sdk.AccAddress, to common.Address, value *big.Int, a abi.ABI, method string, args ...any) error {
	data, err := a.Pack(method, args...)
	if err != nil {
		return err
	}
	m := &MsgEVMCall{Sender: from.String(), To: to.Hex(), Data: data, GasLimit: 1_000_000}
	if value != nil {
		m.Value = value.String()
	}
	c, write := e.ctx.CacheContext()
	if _, err := e.app.evmCall(c, m); err != nil {
		return err
	}
	write()
	return nil
}

func (e *fwEnv) vaultBalance() sdkmath.Int {
	return e.app.BankKeeper.GetBalance(e.ctx, sdk.AccAddress(e.vault.Bytes()), evmtypes.GetEVMCoinDenom()).Amount
}

func (e *fwEnv) on(t *testing.T) {
	futSet(t, e.app, e.ctx, "invariant-firewall", map[string]string{"address": e.fw.Hex()})
	e.app.firewallBeginBlock(e.ctx)
}

func TestFirewallDrainReverted(t *testing.T) {
	e := fwSetup(t)
	held := e.vaultBalance()
	require.Equal(t, new(big.Int).Mul(fwTenth(), big.NewInt(2)), held.BigInt())

	// off (the default): the bug drains the vault
	c, _ := e.ctx.CacheContext()
	data, _ := fwVaultABI.Pack("withdrawBuggy", fwTenth())
	_, err := e.app.evmCall(c, &MsgEVMCall{Sender: e.user.String(), To: e.vault.Hex(), Data: data, GasLimit: 1_000_000})
	require.NoError(t, err, "off: nothing checks")
	_, ok := e.app.firewallAddr(e.ctx)
	require.False(t, ok)

	e.on(t)
	require.True(t, e.app.firewallOn(e.ctx))

	// the draining transaction is reverted, nothing leaves the vault
	err = e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", fwTenth())
	require.ErrorIs(t, err, ErrInvariantFirewall)
	require.ErrorContains(t, err, e.vault.Hex())
	require.ErrorContains(t, err, "solvent")
	require.True(t, held.Equal(e.vaultBalance()), "nothing left the vault")

	// a healthy withdrawal passes
	require.NoError(t, e.call(e.user, e.vault, fwVaultABI, "withdraw", fwTenth()))
	require.True(t, held.Sub(sdkmath.NewIntFromBigInt(fwTenth())).Equal(e.vaultBalance()))
	// so does an unrelated call (to the vault's own checker)
	require.NoError(t, e.call(e.user, e.mode, fwVaultABI, "set", uint8(0)))

	// the Ethereum-tx path: a PostTxProcessing error is what reverts a tx in ApplyTransaction
	c, _ = e.ctx.CacheContext()
	require.NoError(t, e.app.BankKeeper.SendCoins(c, sdk.AccAddress(e.vault.Bytes()), e.user, sdk.NewCoins(sdk.NewCoin(evmtypes.GetEVMCoinDenom(), sdkmath.NewInt(1)))))
	r := &ethtypes.Receipt{Status: ethtypes.ReceiptStatusSuccessful}
	msg := core.Message{To: &e.vault, Value: new(big.Int)}
	require.ErrorIs(t, pqHooks{e.app}.PostTxProcessing(c, common.BytesToAddress(e.user), msg, r), ErrInvariantFirewall)
	r.Status = ethtypes.ReceiptStatusFailed
	require.NoError(t, pqHooks{e.app}.PostTxProcessing(c, common.BytesToAddress(e.user), msg, r), "a failed tx changed nothing: not checked")
	c, _ = e.ctx.CacheContext()
	r.Status = ethtypes.ReceiptStatusSuccessful
	require.NoError(t, pqHooks{e.app}.PostTxProcessing(c, common.BytesToAddress(e.user), msg, r), "a healthy state passes")

	// switched off: no checks, the bug works again
	futSet(t, e.app, e.ctx, "invariant-firewall", map[string]string{"address": ""})
	require.False(t, e.app.firewallOn(e.ctx))
	require.Nil(t, e.app.secRaw(e.ctx).Get(firewallBaseKey))
	require.NoError(t, e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", fwTenth()))
}

// Every way a checker can fail is a violation: false, revert, out of gas, 64 bytes, 2, nothing, and
// a check that would pass only with more gas than its fixed cap.
func TestFirewallFailClosed(t *testing.T) {
	e := fwSetup(t)
	e.on(t)
	for m := uint8(1); m <= 7; m++ {
		err := e.call(e.user, e.mode, fwVaultABI, "set", m)
		require.ErrorIs(t, err, ErrInvariantFirewall, "mode %d", m)
		require.ErrorContains(t, err, "mode", "mode %d: the failing checker is named", m)
	}
	require.NoError(t, e.call(e.user, e.mode, fwVaultABI, "set", uint8(0)), "holds: passes")

	// a protocol already broken at the check point does not revert unrelated transactions
	// (here it broke outside the EVM), and the check point says so
	require.NoError(t, e.app.BankKeeper.SendCoins(e.ctx, sdk.AccAddress(e.vault.Bytes()), e.user,
		sdk.NewCoins(sdk.NewCoin(evmtypes.GetEVMCoinDenom(), sdkmath.NewInt(1)))))
	em := sdk.NewEventManager()
	e.app.firewallBeginBlock(e.ctx.WithEventManager(em))
	require.True(t, fwHasEvent(em, "zetaphy_firewall_broken", e.vault.Hex()))
	require.NoError(t, e.call(e.user, e.mode, fwVaultABI, "set", uint8(0)))
	// healed, and broken again by a transaction: reverted again
	pqFund(t, e.app, e.ctx, sdk.AccAddress(e.vault.Bytes()), sdkmath.NewInt(1))
	e.app.firewallBeginBlock(e.ctx)
	require.ErrorIs(t, e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", big.NewInt(1)), ErrInvariantFirewall)

	// dropped from the chain layer by governance: the node no longer checks it
	require.NoError(t, e.call(e.timelock, e.fw, fwTestABI, "dropChain", e.vault))
	require.NoError(t, e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", big.NewInt(1)))
}

// A registry that cannot be read fails open (the chain must not stop) and says so.
func TestFirewallRegistryFailsOpen(t *testing.T) {
	e := fwSetup(t)
	loop := secDeploy(t, e.app, e.ctx, e.user, common.FromHex("5b600056")) // JUMPDEST PUSH1 0 JUMP: burns all gas
	em := sdk.NewEventManager()
	_, err := e.app.setFuture(e.ctx.WithEventManager(em), &MsgSetFuture{Authority: secGovAddr(), Kind: "invariant-firewall",
		Data: []byte(`{"address":"` + loop.Hex() + `"}`)})
	require.NoError(t, err)
	require.True(t, fwHasEvent(em, "zetaphy_firewall_error", "chainProtocols"))
	require.NoError(t, e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", fwTenth()))
}

// The same state gives the same answer, every time, and a check writes nothing.
func TestFirewallDeterministic(t *testing.T) {
	e := fwSetup(t)
	e.on(t)
	c, _ := e.ctx.CacheContext()
	data, _ := fwVaultABI.Pack("withdrawBuggy", fwTenth())
	// the buggy call's state (evmCall writes it to cc before its firewall check refuses it),
	// then the check, on two copies
	run := func() ([]fwAddr, []bool, []string, error) {
		cc, _ := c.CacheContext()
		_, err := e.app.evmCall(cc, &MsgEVMCall{Sender: e.user.String(), To: e.vault.Hex(), Data: data, GasLimit: 1_000_000})
		require.ErrorIs(t, err, ErrInvariantFirewall)
		return e.app.firewallEvaluate(cc)
	}
	l1, b1, w1, err1 := run()
	l2, b2, w2, err2 := run()
	require.NoError(t, err1)
	require.NoError(t, err2)
	require.Equal(t, l1, l2)
	require.Equal(t, b1, b2)
	require.Equal(t, w1, w2)
	require.Equal(t, []bool{true}, b1)

	// reading writes nothing: the store hash of the EVM and zetaphypq stores is unchanged
	before := fwStoreDigest(e)
	for i := 0; i < 3; i++ {
		_, _, _, err := e.app.firewallEvaluate(e.ctx)
		require.NoError(t, err)
	}
	require.Equal(t, before, fwStoreDigest(e))

	// the errors are identical too (they go into the tx result)
	err1 = e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", fwTenth())
	err2 = e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", fwTenth())
	require.Error(t, err1)
	require.Equal(t, err1.Error(), err2.Error())
}

func fwStoreDigest(e *fwEnv) []byte {
	h := crypto.NewKeccakState()
	for _, k := range []string{pqStoreKey, evmtypes.StoreKey} {
		it := e.ctx.KVStore(e.app.GetKey(k)).Iterator(nil, nil)
		for ; it.Valid(); it.Next() {
			h.Write(it.Key())
			h.Write(it.Value())
		}
		it.Close()
	}
	return h.Sum(nil)
}

func fwHasEvent(em *sdk.EventManager, typ, contains string) bool {
	for _, ev := range em.Events() {
		if ev.Type != typ {
			continue
		}
		for _, a := range ev.Attributes {
			if strings.Contains(a.Value, contains) {
				return true
			}
		}
	}
	return false
}

// Switching on: only governance, only a contract, only after the upgrade; genesis and the CLI.
func TestFirewallSwitch(t *testing.T) {
	e := fwSetup(t)
	set := func(from, addr string) error {
		_, err := e.app.setFuture(e.ctx, &MsgSetFuture{Authority: from, Kind: "invariant-firewall", Data: []byte(`{"address":"` + addr + `"}`)})
		return err
	}
	require.ErrorContains(t, set(secGovAddr(), "0x0000000000000000000000000000000000600d00"), "no contract")
	require.ErrorContains(t, set(secGovAddr(), "0x0000000000000000000000000000000000000000"), "a 0x address")
	require.Error(t, set(e.user.String(), e.fw.Hex()), "only governance")
	_, err := e.app.setFuture(e.ctx, &MsgSetFuture{Authority: secGovAddr(), Kind: "invariant-firewall", Data: []byte(`{"address":"` + e.fw.Hex() + `","x":1}`)})
	require.Error(t, err, "unknown fields refused")

	// before the zetaphy-firewall upgrade the kind does not exist, and nothing is checked
	e.app.setFirewallHeight(e.ctx, 0)
	require.ErrorContains(t, set(secGovAddr(), e.fw.Hex()), "zetaphy-firewall upgrade")
	e.app.secRaw(e.ctx).Set(firewallKey, e.fw.Bytes()) // even with an address in the store (from a genesis)
	require.False(t, e.app.firewallOn(e.ctx))
	require.NoError(t, e.call(e.user, e.vault, fwVaultABI, "withdrawBuggy", big.NewInt(1)))
	e.app.secRaw(e.ctx).Delete(firewallKey)

	// the upgrade: from the next block
	require.NoError(t, e.app.UpgradeKeeper.ApplyUpgrade(e.ctx.WithBlockHeight(40), upgradetypes.Plan{Name: ZetaphyFirewallUpgradeName, Height: 40}))
	require.Equal(t, int64(41), e.app.firewallHeight(e.ctx))
	require.False(t, e.app.firewallActive(e.ctx, 40))
	c41 := e.ctx.WithBlockHeight(41)
	_, err = e.app.setFuture(c41, &MsgSetFuture{Authority: secGovAddr(), Kind: "invariant-firewall", Data: []byte(`{"address":"` + e.fw.Hex() + `"}`)})
	require.NoError(t, err)
	require.True(t, e.app.firewallOn(c41))
	require.False(t, e.app.firewallOn(e.ctx.WithBlockHeight(40)))

	// genesis: export keeps it (on from the new chain's start), the check point is not exported
	raw, err := e.app.pqExportGenesis(c41)
	require.NoError(t, err)
	in, err := pqParseGenesis(raw)
	require.NoError(t, err)
	found := map[byte][]byte{}
	for _, kv := range in {
		found[kv[0][0]] = kv[1]
	}
	require.Equal(t, binary.BigEndian.AppendUint64(nil, 1), found[firewallHeightKey[0]])
	require.Equal(t, e.fw.Bytes(), found[firewallKey[0]])
	_, has := found[firewallBaseKey[0]]
	require.False(t, has)
	bad, _ := json.Marshal([]pqGenesisEntry{{"31", "00"}})
	_, err = pqParseGenesis(bad)
	require.ErrorContains(t, err, "20-byte address")
	bad, _ = json.Marshal([]pqGenesisEntry{{"33", "01"}})
	_, err = pqParseGenesis(bad)
	require.ErrorContains(t, err, "activation height")

	// the CLI
	m, _, err := secProposalMsg([]string{"invariant-firewall", e.fw.Hex()})
	require.NoError(t, err)
	require.Equal(t, "invariant-firewall", m.(*MsgSetFuture).Kind)
	require.Contains(t, string(m.(*MsgSetFuture).Data), e.fw.Hex())
	m, _, err = secProposalMsg([]string{"invariant-firewall", "-"})
	require.NoError(t, err)
	require.Equal(t, `{"address":""}`, string(m.(*MsgSetFuture).Data))
	_, _, err = secProposalMsg([]string{"invariant-firewall", "nope"})
	require.Error(t, err)
}

// The release with the zetaphy-firewall handler may be installed before the vote passes
// (the 2026-10-29 lesson, zetaphy_upgradeguard.go): the chain goes on, the handler runs at the height.
func TestFirewallUpgradeEarlyBinary(t *testing.T) {
	app, ctx := pqApp(t)
	app.setFutV5Height(upgAt(ctx, 40), 1)
	require.NoError(t, app.UpgradeKeeper.ScheduleUpgrade(upgAt(ctx, 40), upgradetypes.Plan{Name: ZetaphyFirewallUpgradeName, Height: 50}))
	for h := int64(41); h < 50; h++ {
		_, err := app.ModuleManager.PreBlock(upgAt(ctx, h))
		require.NoError(t, err, "block %d: the chain goes on before the upgrade height", h)
		require.False(t, app.firewallActive(upgAt(ctx, h), h))
	}
	_, err := app.ModuleManager.PreBlock(upgAt(ctx, 50))
	require.NoError(t, err)
	done, h, err := app.UpgradeKeeper.GetLastCompletedUpgrade(upgAt(ctx, 50))
	require.NoError(t, err)
	require.Equal(t, ZetaphyFirewallUpgradeName, done)
	require.Equal(t, int64(50), h)
	require.True(t, app.firewallActive(upgAt(ctx, 51), 51))
	require.False(t, app.firewallOn(upgAt(ctx, 51)), "still off until governance names a contract")
}

// The node's selectors are the contract's.
func TestFirewallSelectors(t *testing.T) {
	require.True(t, bytes.Equal(fwTestABI.Methods["chainProtocols"].ID, firewallSelChainProtocols))
	require.True(t, bytes.Equal(fwTestABI.Methods["invariantsOf"].ID, firewallSelInvariantsOf))
	require.Equal(t, crypto.Keccak256([]byte("holds(address)"))[:4], firewallSelHolds)
}

// The registry answers the real contract gives decode to what was registered.
func TestFirewallRegistryDecode(t *testing.T) {
	e := fwSetup(t)
	c, _ := e.ctx.CacheContext()
	ret, ok := e.app.firewallStatic(c, e.fw, firewallSelChainProtocols, firewallReadGas)
	require.True(t, ok)
	list, err := firewallDecodeProtocols(ret)
	require.NoError(t, err)
	require.Equal(t, []fwAddr{fwAddr(e.vault)}, list)
	data, _ := fwTestABI.Pack("invariantsOf", e.vault)
	ret, ok = e.app.firewallStatic(c, e.fw, data, firewallReadGas)
	require.True(t, ok)
	invs, err := firewallDecodeInvariants(ret)
	require.NoError(t, err)
	require.Equal(t, []fwInvariant{{fwAddr(e.solvency), 100_000, fwName("solvent")}, {fwAddr(e.mode), 60_000, fwName("mode")}}, invs)
	// a checker that is not a contract: no 32-byte true, a violation
	out, ok := e.app.firewallStatic(c, common.HexToAddress("0x0000000000000000000000000000000000abcdef"), firewallCalldataHolds(firewallSelHolds, fwAddr(e.vault)), 50_000)
	require.False(t, firewallHoldsOK(ok, out))
}
