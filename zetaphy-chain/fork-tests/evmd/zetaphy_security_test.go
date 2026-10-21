//go:build test

package evmd

// ZETAPHY security core (zetaphy_security.go): Q-day with the commit–reveal
// migration, the threat gate with consent, and the security precompile.

import (
	"crypto/ecdsa"
	"crypto/rand"
	"math/big"
	"testing"
	"time"

	circl "github.com/cloudflare/circl/sign/mldsa/mldsa44"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/cosmos/cosmos-sdk/x/authz"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"

	"github.com/cosmos/evm/crypto/ethsecp256k1"
	"github.com/cosmos/evm/crypto/mldsa44"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

func secGovAddr() string { return authtypes.NewModuleAddress(govtypes.ModuleName).String() }

func secOne() sdkmath.Int { return sdkmath.NewInt(1_000_000_000_000_000_000) }

// secApp: a fresh app at height 10 with the security core on and a gas meter.
func secApp(t *testing.T) (*EVMD, sdk.Context) {
	app, ctx := pqApp(t)
	ctx = ctx.WithBlockHeight(10).WithBlockTime(time.Unix(1_800_000_000, 0)).WithGasMeter(storetypes.NewGasMeter(50_000_000))
	if !app.secV3(ctx) {
		app.setSecV3Height(ctx, 1)
	}
	require.True(t, app.secV3(ctx))
	return app, ctx
}

// secPQAccount: an ML-DSA-44 account with its key on chain, funded.
func secPQAccount(t *testing.T, app *EVMD, ctx sdk.Context) sdk.AccAddress {
	pk, _, err := circl.GenerateKey(rand.Reader)
	require.NoError(t, err)
	pub := &mldsa44.PubKey{Key: pk.Bytes()}
	addr := sdk.AccAddress(pub.Address())
	pqFund(t, app, ctx, addr, secOne())
	acc := app.AccountKeeper.GetAccount(ctx, addr)
	require.NoError(t, acc.SetPubKey(pub))
	require.NoError(t, acc.SetSequence(1))
	app.AccountKeeper.SetAccount(ctx, acc)
	return addr
}

func secSetQDay(t *testing.T, app *EVMD, ctx sdk.Context, h, delay uint64) {
	_, err := app.setQDay(ctx, &MsgSetQDay{Authority: secGovAddr(), Height: h, RevealDelay: delay})
	require.NoError(t, err)
}

func TestQDaySchedule(t *testing.T) {
	app, ctx := secApp(t)
	_, err := app.setQDay(ctx, &MsgSetQDay{Authority: sdk.AccAddress(make([]byte, 20)).String(), Height: 100})
	require.ErrorContains(t, err, "only governance")
	_, err = app.setQDay(ctx, &MsgSetQDay{Authority: secGovAddr(), Height: 10})
	require.ErrorContains(t, err, "future block", "not the current or a past block")
	_, err = app.setQDay(ctx, &MsgSetQDay{Authority: secGovAddr(), Height: 100, RevealDelay: 1})
	require.ErrorContains(t, err, "reveal_delay")
	secSetQDay(t, app, ctx, 100, 0)
	h, d := app.qdayParams(ctx)
	require.Equal(t, int64(100), h)
	require.Equal(t, int64(QDayDefaultRevealDelay), d)
	require.False(t, app.qdayActive(ctx))
	require.True(t, app.qdayActive(ctx.WithBlockHeight(100)))
	get := func(a common.Address, k common.Hash) common.Hash { return app.EVMKeeper.GetState(ctx, a, k) }
	require.False(t, evmtypes.QDayReached(get, big.NewInt(99)))
	require.True(t, evmtypes.QDayReached(get, big.NewInt(100)), "mirrored for ecrecover and the mempool")
	secSetQDay(t, app, ctx, 0, 0)
	require.False(t, app.qdayActive(ctx.WithBlockHeight(100)))
	require.False(t, evmtypes.QDayReached(get, big.NewInt(100)))
}

// After Q-day: ECDSA signers and Ethereum txs are refused, ML-DSA-44 signers pass.
func TestQDayAnte(t *testing.T) {
	app, ctx := secApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	k, _ := ethsecp256k1.GenerateKey()
	ecdsaAddr := sdk.AccAddress(k.PubKey().Address())
	pqFund(t, app, ctx, ecdsaAddr, secOne())
	pq := secPQAccount(t, app, ctx)
	send := func(from sdk.AccAddress) *banktypes.MsgSend {
		return &banktypes.MsgSend{FromAddress: from.String(), ToAddress: from.String(), Amount: sdk.NewCoins(sdk.NewInt64Coin(denom, 1))}
	}
	build := func(msgs ...sdk.Msg) sdk.Tx {
		b := app.GetTxConfig().NewTxBuilder()
		require.NoError(t, b.SetMsgs(msgs...))
		b.SetGasLimit(200000)
		b.SetFeeAmount(sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewInt(200000_000_000_000))))
		return b.GetTx()
	}
	signed := func(c sdk.Context) sdk.Tx {
		b := app.GetTxConfig().NewTxBuilder()
		require.NoError(t, b.SetMsgs(send(ecdsaAddr)))
		b.SetGasLimit(200000)
		b.SetFeeAmount(sdk.NewCoins(sdk.NewCoin(denom, sdkmath.NewInt(200000_000_000_000))))
		pqSignTx(t, app, c, b, []cryptotypes.PrivKey{k})
		return b.GetTx()
	}
	ante := func(c sdk.Context, tx sdk.Tx) error {
		cc, _ := c.CacheContext()
		_, err := app.AnteHandler()(cc, tx, false)
		return err
	}
	secSetQDay(t, app, ctx, 50, 5)
	require.NoError(t, ante(ctx, signed(ctx)), "before Q-day nothing changes")
	after := ctx.WithBlockHeight(50)
	err := ante(after, signed(after))
	require.ErrorIs(t, err, ErrQDay)
	require.ErrorContains(t, err, "ECDSA")
	require.Equal(t, secOne(), app.BankKeeper.GetBalance(ctx, ecdsaAddr, denom).Amount, "frozen: the funds stay")
	require.NoError(t, app.qdayCheckTx(after, build(send(pq))), "an ML-DSA-44 signer passes")
	require.ErrorIs(t, app.qdayCheckTx(after, build(send(ecdsaAddr))), ErrQDay)
	require.ErrorContains(t, app.qdayCheckTx(after, build(&evmtypes.MsgEthereumTx{From: ecdsaAddr.Bytes()})), "Ethereum transactions")
	exec := authz.NewMsgExec(pq, []sdk.Msg{&evmtypes.MsgEthereumTx{From: ecdsaAddr.Bytes()}})
	require.ErrorIs(t, app.qdayCheckTx(after, build(&exec)), ErrQDay, "inside authz too")
}

// A quantum-locked (migrated) MetaMask account still moves its funds after
// Q-day, through its ML-DSA-44 controller; ecrecover answers nothing.
func TestQDayMigratedAccountUsable(t *testing.T) {
	app, ctx := secApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	owner, _ := crypto.GenerateKey()
	ownerAddr := sdk.AccAddress(crypto.PubkeyToAddress(owner.PublicKey).Bytes())
	pqFund(t, app, ctx, ownerAddr, secOne())
	ctrl := secPQAccount(t, app, ctx)
	app.applyQuantumLock(ctx, ownerAddr, ctrl)
	secSetQDay(t, app, ctx, 20, 5)
	after := ctx.WithBlockHeight(20)
	dest := common.HexToAddress("0x00000000000000000000000000000000000a11ce")
	_, err := app.evmCall(after, &MsgEVMCall{Sender: ctrl.String(), To: dest.Hex(), Value: "1000", GasLimit: 100000, AsOwner: ownerAddr.String()})
	require.NoError(t, err)
	require.Equal(t, int64(1000), app.BankKeeper.GetBalance(after, dest.Bytes(), denom).Amount.Int64())

	// ecrecover: a valid signature by an unlocked key recovers nothing after Q-day.
	other, _ := crypto.GenerateKey()
	input := secEcrecoverInput(t, other)
	out, err := app.evmCall(ctx.WithBlockHeight(19), &MsgEVMCall{Sender: ctrl.String(), To: "0x0000000000000000000000000000000000000001", Data: input, GasLimit: 100000})
	require.NoError(t, err)
	require.Equal(t, crypto.PubkeyToAddress(other.PublicKey), common.BytesToAddress(out.(*MsgEVMCallResponse).Ret), "before Q-day")
	out, err = app.evmCall(after, &MsgEVMCall{Sender: ctrl.String(), To: "0x0000000000000000000000000000000000000001", Data: input, GasLimit: 100000})
	require.NoError(t, err)
	require.Empty(t, out.(*MsgEVMCallResponse).Ret, "after Q-day")
}

func secEcrecoverInput(t *testing.T, k *ecdsa.PrivateKey) []byte {
	h := crypto.Keccak256([]byte("permit"))
	sig, err := crypto.Sign(h, k)
	require.NoError(t, err)
	in := make([]byte, 128)
	copy(in, h)
	in[63] = sig[64] + 27
	copy(in[64:], sig[:64])
	return in
}

type secMigrant struct {
	key   *ecdsa.PrivateKey
	owner sdk.AccAddress
	ctrl  sdk.AccAddress
	salt  []byte
	sig   []byte
	comm  []byte
}

func secNewMigrant(t *testing.T, app *EVMD, ctx sdk.Context, key *ecdsa.PrivateKey, ctrl sdk.AccAddress) *secMigrant {
	owner := sdk.AccAddress(crypto.PubkeyToAddress(key.PublicKey).Bytes())
	text := QDayRevealText(ctx.ChainID(), common.BytesToAddress(owner), common.BytesToAddress(ctrl))
	sig, err := crypto.Sign(accounts.TextHash([]byte(text)), key)
	require.NoError(t, err)
	sig[64] += 27 // as personal_sign returns it
	salt := crypto.Keccak256(sig)
	return &secMigrant{key: key, owner: owner, ctrl: ctrl, salt: salt, sig: sig,
		comm: QDayCommitment(ctx.ChainID(), crypto.CompressPubkey(&key.PublicKey), common.BytesToAddress(ctrl), salt)}
}

func (m *secMigrant) reveal(app *EVMD, ctx sdk.Context) error {
	_, err := app.qdayReveal(ctx, &MsgQDayReveal{Signer: m.ctrl.String(), Owner: m.owner.String(), Controller: m.ctrl.String(), Salt: m.salt, Signature: m.sig})
	return err
}

func (m *secMigrant) commit(t *testing.T, app *EVMD, ctx sdk.Context) {
	_, err := app.qdayCommit(ctx, &MsgQDayCommit{Signer: m.ctrl.String(), Commitment: m.comm})
	require.NoError(t, err)
}

// An account that never sent a tx migrates by commit–reveal after Q-day.
func TestQDayCommitReveal(t *testing.T) {
	app, ctx := secApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	key, _ := crypto.GenerateKey()
	ctrl := secPQAccount(t, app, ctx)
	m := secNewMigrant(t, app, ctx, key, ctrl)
	pqFund(t, app, ctx, m.owner, secOne())
	secSetQDay(t, app, ctx, 20, 5)

	m.commit(t, app, ctx.WithBlockHeight(18)) // made before Q-day: allowed
	_, err := app.qdayCommit(ctx.WithBlockHeight(18), &MsgQDayCommit{Signer: ctrl.String(), Commitment: m.comm})
	require.ErrorContains(t, err, "already recorded")
	require.ErrorContains(t, m.reveal(app, ctx.WithBlockHeight(19)), "opens at Q-day")
	require.ErrorContains(t, m.reveal(app, ctx.WithBlockHeight(22)), "too recent")
	bad := *m
	bad.salt = make([]byte, 32)
	require.ErrorContains(t, bad.reveal(app, ctx.WithBlockHeight(23)), "no commitment matches")
	other, _ := crypto.GenerateKey()
	forged := *m
	forged.sig, _ = crypto.Sign(accounts.TextHash([]byte(QDayRevealText(ctx.ChainID(), common.BytesToAddress(m.owner), common.BytesToAddress(ctrl)))), other)
	require.ErrorContains(t, forged.reveal(app, ctx.WithBlockHeight(23)), "not made by the owner")

	c23 := ctx.WithBlockHeight(23)
	require.NoError(t, m.reveal(app, c23))
	_, final, pend, ok := app.qdayPending(c23, m.owner)
	require.True(t, ok)
	require.Equal(t, int64(28), final)
	require.Equal(t, []byte(ctrl), pend)
	require.Nil(t, app.pqController(c23, m.owner), "pending, not yet a lock")
	require.ErrorContains(t, m.reveal(app, c23), "no commitment matches", "a commitment opens once")

	app.secBeginBlock(ctx.WithBlockHeight(27))
	require.Nil(t, app.pqController(ctx, m.owner))
	app.secBeginBlock(ctx.WithBlockHeight(28))
	require.Equal(t, []byte(ctrl), app.pqController(ctx, m.owner), "migrated")
	_, _, _, ok = app.qdayPending(ctx, m.owner)
	require.False(t, ok)
	after := ctx.WithBlockHeight(29)
	_, err = app.evmCall(after, &MsgEVMCall{Sender: ctrl.String(), To: "0x00000000000000000000000000000000000b0b00", Value: "7", GasLimit: 100000, AsOwner: m.owner.String()})
	require.NoError(t, err, "the controller acts for the migrated account")
	require.Equal(t, int64(7), app.BankKeeper.GetBalance(after, common.HexToAddress("0x00000000000000000000000000000000000b0b00").Bytes(), denom).Amount.Int64())
}

// refused: a reveal of an account whose key was used on chain before Q-day.
func TestQDayExposedKeyStaysFrozen(t *testing.T) {
	app, ctx := secApp(t)
	ctrl := secPQAccount(t, app, ctx)
	secSetQDay(t, app, ctx, 20, 3)
	// sent a tx (sequence 1)
	k1, _ := crypto.GenerateKey()
	m1 := secNewMigrant(t, app, ctx, k1, ctrl)
	pqFund(t, app, ctx, m1.owner, secOne())
	acc := app.AccountKeeper.GetAccount(ctx, m1.owner)
	require.NoError(t, acc.SetSequence(1))
	app.AccountKeeper.SetAccount(ctx, acc)
	m1.commit(t, app, ctx)
	require.ErrorContains(t, m1.reveal(app, ctx.WithBlockHeight(25)), "public key was used on chain")
	// a signature checked by ecrecover (a permit) before Q-day
	k2, _ := crypto.GenerateKey()
	m2 := secNewMigrant(t, app, ctx, k2, ctrl)
	pqFund(t, app, ctx, m2.owner, secOne())
	_, err := app.evmCall(ctx, &MsgEVMCall{Sender: ctrl.String(), To: "0x0000000000000000000000000000000000000001", Data: secEcrecoverInput(t, k2), GasLimit: 100000})
	require.NoError(t, err)
	require.True(t, app.qdayExposed(ctx, m2.owner), "ecrecover marked it")
	m2.commit(t, app, ctx)
	require.ErrorContains(t, m2.reveal(app, ctx.WithBlockHeight(25)), "public key was used on chain")
	// an unfunded key seen by ecrecover leaves no state
	k3, _ := crypto.GenerateKey()
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: ctrl.String(), To: "0x0000000000000000000000000000000000000001", Data: secEcrecoverInput(t, k3), GasLimit: 100000})
	require.NoError(t, err)
	require.False(t, app.qdayExposed(ctx, sdk.AccAddress(crypto.PubkeyToAddress(k3.PublicKey).Bytes())))
}

// refused: front-running a reveal with a commitment made after seeing it;
// the oldest commitment wins while a migration is pending.
func TestQDayFrontRunning(t *testing.T) {
	app, ctx := secApp(t)
	key, _ := crypto.GenerateKey()
	victimCtrl := secPQAccount(t, app, ctx)
	thiefCtrl := secPQAccount(t, app, ctx)
	victim := secNewMigrant(t, app, ctx, key, victimCtrl)
	pqFund(t, app, ctx, victim.owner, secOne())
	secSetQDay(t, app, ctx, 20, 4)
	victim.commit(t, app, ctx.WithBlockHeight(21))

	// The reveal shows the public key; the same key signs for another controller.
	thief := secNewMigrant(t, app, ctx, key, thiefCtrl)
	thief.salt = make([]byte, 32)
	thief.comm = QDayCommitment(ctx.ChainID(), crypto.CompressPubkey(&key.PublicKey), common.BytesToAddress(thiefCtrl), thief.salt)
	thief.commit(t, app, ctx.WithBlockHeight(25))
	require.ErrorContains(t, thief.reveal(app, ctx.WithBlockHeight(25)), "too recent", "same block as the victim's reveal")
	require.NoError(t, victim.reveal(app, ctx.WithBlockHeight(25)))
	require.ErrorContains(t, thief.reveal(app, ctx.WithBlockHeight(29)), "older commitment is pending")

	// The other order: a younger commitment revealed first is replaced by the
	// older one within the wait, and only the older one becomes the lock.
	app2, ctx2 := secApp(t)
	vc, tc := secPQAccount(t, app2, ctx2), secPQAccount(t, app2, ctx2)
	key2, _ := crypto.GenerateKey()
	v2 := secNewMigrant(t, app2, ctx2, key2, vc)
	t2 := secNewMigrant(t, app2, ctx2, key2, tc)
	pqFund(t, app2, ctx2, v2.owner, secOne())
	secSetQDay(t, app2, ctx2, 20, 4)
	v2.commit(t, app2, ctx2.WithBlockHeight(20))
	t2.commit(t, app2, ctx2.WithBlockHeight(22))
	require.NoError(t, t2.reveal(app2, ctx2.WithBlockHeight(26)))
	require.NoError(t, v2.reveal(app2, ctx2.WithBlockHeight(27)), "older commitment replaces the pending one")
	app2.secBeginBlock(ctx2.WithBlockHeight(30)) // the replaced entry: nothing happens
	require.Nil(t, app2.pqController(ctx2, v2.owner))
	app2.secBeginBlock(ctx2.WithBlockHeight(31))
	require.Equal(t, []byte(vc), app2.pqController(ctx2, v2.owner))
}

// ---- threat gate

// secRegistryRuntime answers isContractEnforced(who) with (slot[who] != 0,
// slot[who]): the test sets a flag by writing that storage slot.
var secRegistryRuntime = common.FromHex("600435548015156000526020526040" + "6000f3")

func secDeploy(t *testing.T, app *EVMD, ctx sdk.Context, from sdk.AccAddress, runtime []byte) common.Address {
	init := append([]byte{0x60, byte(len(runtime)), 0x60, 0x0c, 0x60, 0x00, 0x39, 0x60, byte(len(runtime)), 0x60, 0x00, 0xf3}, runtime...)
	out, err := app.evmCall(ctx, &MsgEVMCall{Sender: from.String(), Data: init, GasLimit: 500000})
	require.NoError(t, err)
	return common.HexToAddress(out.(*MsgEVMCallResponse).Created)
}

func secFlag(app *EVMD, ctx sdk.Context, reg, target common.Address, reason byte) {
	app.EVMKeeper.SetState(ctx, reg, common.BytesToHash(target.Bytes()), common.Hash{31: reason}.Bytes())
}

func secConsent(target common.Address, seconds uint64) []byte {
	d, _ := SecurityABI.Pack("consent", target, seconds)
	return d
}

func TestThreatGate(t *testing.T) {
	app, ctx := secApp(t)
	user := secPQAccount(t, app, ctx)
	reg := secDeploy(t, app, ctx, user, secRegistryRuntime)
	scam := common.HexToAddress("0x00000000000000000000000000000000005ca400")
	ok := common.HexToAddress("0x0000000000000000000000000000000000600d00")
	call := func(c sdk.Context, to common.Address) error {
		_, err := app.evmCall(c, &MsgEVMCall{Sender: user.String(), To: to.Hex(), Value: "1", GasLimit: 100000})
		return err
	}
	secFlag(app, ctx, reg, scam, 1)
	require.NoError(t, call(ctx, scam), "registry unset: the gate is off")

	_, err := app.setThreatGate(ctx, &MsgSetThreatGate{Authority: user.String(), Registry: reg.Hex(), Enabled: 1})
	require.ErrorContains(t, err, "only governance")
	_, err = app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: ok.Hex(), Enabled: 1})
	require.ErrorContains(t, err, "no contract")
	_, err = app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: reg.Hex(), Enabled: 1})
	require.NoError(t, err)

	err = call(ctx, scam)
	require.ErrorIs(t, err, ErrThreatFlagged, "blocked without consent")
	require.ErrorContains(t, err, "CannotSellInSimulation")
	require.ErrorContains(t, err, "consent(")
	require.NoError(t, call(ctx, ok), "an unflagged target")
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: reg.Hex(), GasLimit: 100000})
	require.NoError(t, err, "the registry itself (appeals, responses) is never refused")
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: secGovAddr(), To: scam.Hex(), GasLimit: 100000})
	require.NotErrorIs(t, err, ErrThreatFlagged, "governance's own calls are not checked")

	// consent through the precompile, as MetaMask sends it
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: SecurityPrecompileAddress.Hex(), Data: secConsent(scam, MaxConsentSeconds+1), GasLimit: 200000})
	require.Error(t, err, "more than a day")
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: SecurityPrecompileAddress.Hex(), Data: secConsent(scam, 3600), GasLimit: 200000})
	require.NoError(t, err)
	require.Equal(t, ctx.BlockTime().Unix()+3600, app.consentUntil(ctx, common.BytesToAddress(user), scam))
	require.NoError(t, call(ctx, scam), "allowed with consent")
	require.ErrorIs(t, call(ctx.WithBlockTime(ctx.BlockTime().Add(3601*time.Second)), scam), ErrThreatFlagged, "consent expired")

	// warning-only: the flag cleared (or never enforced) lets it through
	_, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: SecurityPrecompileAddress.Hex(), Data: secConsent(scam, 0), GasLimit: 200000})
	require.NoError(t, err, "withdraw consent")
	require.ErrorIs(t, call(ctx, scam), ErrThreatFlagged)
	secFlag(app, ctx, reg, scam, 0)
	require.NoError(t, call(ctx, scam), "flag cleared")

	_, err = app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: reg.Hex(), Enabled: 0})
	require.NoError(t, err)
	secFlag(app, ctx, reg, scam, 2)
	require.NoError(t, call(ctx, scam), "gate off")
}

// refused: a contract giving consent for the account that called it.
func TestThreatConsentOnlyDirect(t *testing.T) {
	app, ctx := secApp(t)
	user := secPQAccount(t, app, ctx)
	// forwards its calldata to 0x…0901 and returns the call's status
	fwd := secDeploy(t, app, ctx, user, common.FromHex("366000600037"+"6020600036600060006109015af1"+"60005260206000f3"))
	scam := common.HexToAddress("0x00000000000000000000000000000000005ca400")
	out, err := app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: fwd.Hex(), Data: secConsent(scam, 3600), GasLimit: 300000})
	require.NoError(t, err)
	require.Equal(t, common.Hash{}, common.BytesToHash(out.(*MsgEVMCallResponse).Ret), "the inner call failed")
	require.Zero(t, app.consentUntil(ctx, common.BytesToAddress(user), scam))
	require.Zero(t, app.consentUntil(ctx, fwd, scam))
}

// A broken or hostile registry turns the gate off; its cost is capped.
func TestThreatGateBounded(t *testing.T) {
	app, ctx := secApp(t)
	user := secPQAccount(t, app, ctx)
	target := common.HexToAddress("0x00000000000000000000000000000000005ca400")
	for name, code := range map[string]string{
		"loops forever": "5b600056",
		"reverts":       "60006000fd",
		"short answer":  "60016000526020" + "6000f3",
		"bad reason":    "6001600052610100602052604060" + "00f3",
	} {
		reg := secDeploy(t, app, ctx, user, common.FromHex(code))
		_, err := app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: reg.Hex(), Enabled: 1})
		require.NoError(t, err)
		gas := ctx.GasMeter().GasConsumed()
		start := time.Now()
		require.NoError(t, app.threatCheck(ctx, common.BytesToAddress(user), target), name)
		require.Less(t, time.Since(start), 2*time.Second, name)
		require.Equal(t, gas, ctx.GasMeter().GasConsumed(), "%s: the check costs the tx nothing", name)
		on, _ := app.threatEnforced(ctx, reg, target)
		require.False(t, on, name)
	}
}

// The security precompile's views.
func TestSecurityPrecompileViews(t *testing.T) {
	app, ctx := secApp(t)
	user := secPQAccount(t, app, ctx)
	secSetQDay(t, app, ctx, 500, 9)
	d, _ := SecurityABI.Pack("qday")
	out, err := app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: SecurityPrecompileAddress.Hex(), Data: d, GasLimit: 200000})
	require.NoError(t, err)
	v, err := SecurityABI.Unpack("qday", out.(*MsgEVMCallResponse).Ret)
	require.NoError(t, err)
	require.Equal(t, []any{uint64(500), uint64(9), false}, v)
	owner, _ := crypto.GenerateKey()
	oa := sdk.AccAddress(crypto.PubkeyToAddress(owner.PublicKey).Bytes())
	pqFund(t, app, ctx, oa, secOne())
	app.applyQuantumLock(ctx, oa, user)
	d, _ = SecurityABI.Pack("migration", common.BytesToAddress(oa))
	out, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: SecurityPrecompileAddress.Hex(), Data: d, GasLimit: 200000})
	require.NoError(t, err)
	v, err = SecurityABI.Unpack("migration", out.(*MsgEVMCallResponse).Ret)
	require.NoError(t, err)
	require.Equal(t, true, v[0])
	require.Equal(t, common.BytesToAddress(user), v[1])
	// before the security-core height the address is an empty account
	app.setSecV3Height(ctx, 1000)
	out, err = app.evmCall(ctx, &MsgEVMCall{Sender: user.String(), To: SecurityPrecompileAddress.Hex(), Data: d, GasLimit: 200000})
	require.NoError(t, err)
	require.Empty(t, out.(*MsgEVMCallResponse).Ret)
}

// Security-core state survives a genesis export and import.
func TestSecurityGenesis(t *testing.T) {
	app, ctx := secApp(t)
	secSetQDay(t, app, ctx, 77, 6)
	_, err := app.setIBCHoldRule(ctx, &MsgSetIBCHoldRule{Authority: secGovAddr(), Denom: "uusdc", MinAmount: "5", SupplyBps: 10})
	require.NoError(t, err)
	raw, err := app.pqExportGenesis(ctx)
	require.NoError(t, err)
	app2, ctx2 := pqApp(t)
	require.NoError(t, app2.pqInitGenesis(ctx2, raw))
	app2.secMirrorAfterGenesis(ctx2)
	h, d := app2.qdayParams(ctx2)
	require.Equal(t, []int64{77, 6}, []int64{h, d})
	min, bps, ok := app2.ibcHoldRule(ctx2, "uusdc")
	require.True(t, ok)
	require.Equal(t, "5", min.String())
	require.Equal(t, uint64(10), bps)
	require.True(t, evmtypes.QDayReached(func(a common.Address, k common.Hash) common.Hash { return app2.EVMKeeper.GetState(ctx2, a, k) }, big.NewInt(77)))
}

func TestSecurityMessagesWire(t *testing.T) {
	for _, m := range []interface {
		Marshal() ([]byte, error)
		Unmarshal([]byte) error
	}{
		&MsgSetQDay{Authority: secGovAddr(), Height: 9, RevealDelay: 3},
		&MsgQDayCommit{Signer: "a", Commitment: []byte{1, 2}},
		&MsgQDayReveal{Signer: "a", Owner: "b", Controller: "c", Salt: []byte{3}, Signature: []byte{4}},
		&MsgSetThreatGate{Authority: "a", Registry: "0x01", Enabled: 1},
		&MsgSetIBCHold{Authority: "a", DelaySeconds: 60, Guardian: "g"},
		&MsgSetIBCHoldRule{Authority: "a", Denom: "*", SupplyBps: 5},
		&MsgIBCHoldCancel{Signer: "a", Id: 7},
	} {
		bz, err := m.Marshal()
		require.NoError(t, err)
		require.NoError(t, m.Unmarshal(bz))
		bz2, _ := m.Marshal()
		require.Equal(t, bz, bz2)
	}
}

// The gate and Q-day on a signed Ethereum tx, through the full ante handler.
func TestThreatGateEthereumTx(t *testing.T) {
	app, ctx := secApp(t)
	user := secPQAccount(t, app, ctx)
	reg := secDeploy(t, app, ctx, user, secRegistryRuntime)
	scam := common.HexToAddress("0x00000000000000000000000000000000005ca400")
	secFlag(app, ctx, reg, scam, 6)
	_, err := app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: reg.Hex(), Enabled: 1})
	require.NoError(t, err)
	key, _ := crypto.GenerateKey()
	from := crypto.PubkeyToAddress(key.PublicKey)
	pqFund(t, app, ctx, from.Bytes(), secOne())
	chainID := evmtypes.GetEthChainConfig().ChainID
	ethTx := func(nonce uint64, to common.Address) sdk.Tx {
		signer := ethtypes.LatestSignerForChainID(chainID)
		tx, err := ethtypes.SignTx(ethtypes.NewTx(&ethtypes.DynamicFeeTx{ChainID: chainID, Nonce: nonce, To: &to, Value: big.NewInt(1),
			Gas: 50000, GasFeeCap: big.NewInt(10_000_000_000), GasTipCap: big.NewInt(1)}), signer, key)
		require.NoError(t, err)
		m := &evmtypes.MsgEthereumTx{}
		require.NoError(t, m.FromSignedEthereumTx(tx, signer))
		out, err := m.BuildTx(app.GetTxConfig().NewTxBuilder(), evmtypes.GetEVMCoinDenom())
		require.NoError(t, err)
		return out
	}
	cp := ctx.ConsensusParams()
	cp.Block = &cmtproto.BlockParams{MaxGas: 30_000_000, MaxBytes: 2_000_000}
	ctx = ctx.WithConsensusParams(cp).WithBlockGasMeter(storetypes.NewGasMeter(30_000_000))
	ante := func(c sdk.Context, tx sdk.Tx) error {
		cc, _ := c.CacheContext()
		_, err := app.AnteHandler()(cc, tx, false)
		return err
	}
	err = ante(ctx, ethTx(0, scam))
	require.ErrorIs(t, err, ErrThreatFlagged, "MetaMask tx to an enforced-flagged contract")
	require.ErrorContains(t, err, "SweepsApprovedTokens")
	require.NoError(t, ante(ctx, ethTx(0, common.HexToAddress("0x0000000000000000000000000000000000600d00"))))
	_, err = app.setConsent(ctx, from, scam, 600)
	require.NoError(t, err)
	require.NoError(t, ante(ctx, ethTx(0, scam)), "with consent")
	secSetQDay(t, app, ctx, 11, 3)
	require.ErrorIs(t, ante(ctx.WithBlockHeight(11), ethTx(0, scam)), ErrQDay, "after Q-day no Ethereum tx")
}

// The same vector as zetaphy-network/test/security.test.js: the wallet's
// text, salt and commitment are the chain's, byte for byte.
func TestQDayVectorMatchesJavaScript(t *testing.T) {
	key, err := crypto.HexToECDSA("1111111111111111111111111111111111111111111111111111111111111111")
	require.NoError(t, err)
	owner := crypto.PubkeyToAddress(key.PublicKey)
	ctrl := common.HexToAddress("0x00000000000000000000000000000000000B0b00")
	text := QDayRevealText("zetaphy_77390-1", owner, ctrl)
	sig, err := crypto.Sign(accounts.TextHash([]byte(text)), key)
	require.NoError(t, err)
	sig[64] += 27
	require.Equal(t, "0xf289b1d3157da91eb1ad4b68571ca355b15118bff126892df9a0a91da9fc1c8648ff2b3ecb587e39a6e54cc8b020c768f1b578356571e62ad2007c78b132952b1b", hexutil.Encode(sig))
	c := QDayCommitment("zetaphy_77390-1", crypto.CompressPubkey(&key.PublicKey), ctrl, crypto.Keccak256(sig))
	require.Equal(t, "0x5a438ce634b3440817d5b28d472f435e173b140eb90dacfcffe3888c686a5c72", hexutil.Encode(c))
}

// A chain without the security core gets it with the "zetaphy-v3" upgrade:
// from the next block, never in the upgrade block itself.
func TestSecurityV3UpgradeHandler(t *testing.T) {
	app, ctx := pqApp(t)
	ctx = ctx.WithBlockHeight(40)
	ctx.KVStore(app.GetKey(pqStoreKey)).Delete(secV3Key)
	app.EVMKeeper.DeleteState(ctx, PQLockAddress, evmtypes.SecurityV3Slot)
	require.False(t, app.secV3(ctx))
	require.NoError(t, app.UpgradeKeeper.ApplyUpgrade(ctx, upgradetypes.Plan{Name: ZetaphyV3UpgradeName, Height: 40}))
	require.Equal(t, int64(41), app.secV3Height(ctx))
	require.False(t, app.secV3(ctx), "the upgrade block itself runs as before")
	require.True(t, app.secV3(ctx.WithBlockHeight(41)))
	get := func(a common.Address, k common.Hash) common.Hash { return app.EVMKeeper.GetState(ctx, a, k) }
	require.False(t, evmtypes.SecurityV3(get, big.NewInt(40)))
	require.True(t, evmtypes.SecurityV3(get, big.NewInt(41)), "mirrored for ecrecover")
	_, ok := app.zetaphyPrecompile(ctx, SecurityPrecompileAddress)
	require.False(t, ok, "no precompile before")
	_, ok = app.zetaphyPrecompile(ctx.WithBlockHeight(41), SecurityPrecompileAddress)
	require.True(t, ok)
}

// The threat gate refuses a MsgEVMCall in the ante handler too (CheckTx),
// for the account it acts as.
func TestThreatGateAnteMsgEVMCall(t *testing.T) {
	app, ctx := secApp(t)
	user := secPQAccount(t, app, ctx)
	reg := secDeploy(t, app, ctx, user, secRegistryRuntime)
	scam := common.HexToAddress("0x00000000000000000000000000000000005ca400")
	secFlag(app, ctx, reg, scam, 2)
	_, err := app.setThreatGate(ctx, &MsgSetThreatGate{Authority: secGovAddr(), Registry: reg.Hex(), Enabled: 1})
	require.NoError(t, err)
	b := app.GetTxConfig().NewTxBuilder()
	require.NoError(t, b.SetMsgs(&MsgEVMCall{Sender: user.String(), To: scam.Hex(), GasLimit: 50000}))
	require.ErrorIs(t, app.threatGateTx(ctx, b.GetTx()), ErrThreatFlagged)
	require.NoError(t, b.SetMsgs(&MsgEVMCall{Sender: secGovAddr(), To: scam.Hex(), GasLimit: 50000}))
	require.NoError(t, app.threatGateTx(ctx, b.GetTx()), "governance")
}
