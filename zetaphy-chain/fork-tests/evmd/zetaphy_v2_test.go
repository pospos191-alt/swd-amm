//go:build test

package evmd

// The v2 activation height (zetaphy_upgrade.go), the EIP-2935 ring size, the
// dEaD burn of a vesting account and the proposer's own certificate entry.

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/ethereum/go-ethereum/common"
	ethparams "github.com/ethereum/go-ethereum/params"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	vestingtypes "github.com/cosmos/cosmos-sdk/x/auth/vesting/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"

	"github.com/cosmos/evm/x/vm/statedb"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

// A new chain (`zetaphyd init`, the test genesis) has the features from block 1.
func TestPQV2Genesis(t *testing.T) {
	app, ctx := pqApp(t)
	require.Equal(t, int64(1), app.zetaphyV2Height(ctx))
	def := app.DefaultGenesis()[pqStoreKey]
	// 08: v2 features; 0f: the security core (zetaphy_security.go), both from block 1
	require.JSONEq(t, `[{"key":"08","value":"0000000000000001"},{"key":"0f","value":"0000000000000001"}]`, string(def))
	b := pqGenesisBasic{}
	require.NoError(t, b.ValidateGenesis(nil, nil, def))
	require.NoError(t, b.ValidateGenesis(nil, nil, nil), "a genesis from before the patch has none")
	require.Error(t, b.ValidateGenesis(nil, nil, json.RawMessage(`[{"key":"08","value":"01"}]`)))
	require.Error(t, b.ValidateGenesis(nil, nil, json.RawMessage(`[{"key":"07","value":"00"}]`)), "chain history is not genesis")

	// Export: once on, on from the new chain's start; still pending, kept.
	app.setZetaphyV2Height(ctx, 2)
	gen, err := app.pqExportGenesis(ctx)
	require.NoError(t, err)
	require.Contains(t, string(gen), `{"key":"08","value":"0000000000000001"}`)
	app.setZetaphyV2Height(ctx, 50)
	gen, err = app.pqExportGenesis(ctx)
	require.NoError(t, err)
	require.Contains(t, string(gen), `{"key":"08","value":"0000000000000032"}`)
}

// Below the activation height (or with none) a block runs as before the
// patch: no dEaD burn, no history contract install, PREVRANDAO 0xff…ff, no
// randao write; from it on, all of them.
func TestPQV2ActivationHeight(t *testing.T) {
	const A = 10
	for _, unset := range []bool{false, true} {
		app, ctx := pqApp(t)
		st := ctx.KVStore(app.GetKey(pqStoreKey))
		if unset {
			st.Delete(pqActivationKey)
		} else {
			app.setZetaphyV2Height(ctx, A)
		}
		denom := evmtypes.GetEVMCoinDenom()
		dead := sdk.AccAddress(DeadAddress.Bytes())
		hist := ethparams.HistoryStorageAddress
		app.EVMKeeper.DeleteCodeHash(ctx, hist)
		pqFund(t, app, ctx, dead, sdkmath.NewInt(1000))
		votes := abci.CommitInfo{Votes: []abci.VoteInfo{{Validator: abci.Validator{Address: bytes.Repeat([]byte{9}, 20), Power: 10}, BlockIdFlag: cmtproto.BlockIDFlagCommit}}}

		for h := int64(A - 2); h <= A+1; h++ {
			c := ctx.WithBlockHeight(h).WithHeaderHash(bytes.Repeat([]byte{byte(h)}, 32))
			on := !unset && h >= A
			require.NoError(t, app.pqPreBlock(c, &abci.RequestFinalizeBlock{Height: h, Hash: bytes.Repeat([]byte{byte(h)}, 32), DecidedLastCommit: votes}))
			_, err := app.BeginBlocker(c)
			require.NoError(t, err)
			if !on {
				require.Nil(t, st.Get(pqRandaoKey), "h=%d: no randao write", h)
				require.Equal(t, common.MaxHash, app.prevRandao(c), "h=%d", h)
				require.Equal(t, common.MaxHash, pqReadRandao(t, app, c), "h=%d: the EVM sees upstream's constant", h)
				require.Equal(t, int64(1000), app.BankKeeper.GetBalance(c, dead, denom).Amount.Int64(), "h=%d: no burn", h)
				require.False(t, app.EVMKeeper.IsContract(c, hist), "h=%d: no install", h)
				continue
			}
			r := app.prevRandao(c)
			require.NotEqual(t, common.MaxHash, r)
			require.Equal(t, PrevRandao(c.ChainID(), h, nil, bytes.Repeat([]byte{byte(h - 1)}, 32)), r, "h=%d", h)
			require.Equal(t, r, pqReadRandao(t, app, c))
			require.True(t, app.BankKeeper.GetBalance(c, dead, denom).Amount.IsZero(), "h=%d: burned", h)
			require.True(t, app.EVMKeeper.IsContract(c, hist), "h=%d: installed", h)
		}
	}
}

// The zetaphy-v2 upgrade on a chain without the features: on from the next
// block, with the EIP-2935 window.
func TestPQV2UpgradeHandler(t *testing.T) {
	app, ctx := pqApp(t)
	ctx = ctx.WithBlockHeight(40)
	ctx.KVStore(app.GetKey(pqStoreKey)).Delete(pqActivationKey)
	p := app.EVMKeeper.GetParams(ctx)
	p.HistoryServeWindow = 8192 // what upstream wrote into older genesis files
	require.NoError(t, app.EVMKeeper.SetParams(ctx, p))
	require.False(t, app.zetaphyV2(ctx, 40))

	require.NoError(t, app.UpgradeKeeper.ApplyUpgrade(ctx, upgradetypes.Plan{Name: ZetaphyV2UpgradeName, Height: 40}))
	require.Equal(t, int64(41), app.zetaphyV2Height(ctx))
	require.False(t, app.zetaphyV2(ctx, 40), "the upgrade block itself runs as before")
	require.True(t, app.zetaphyV2(ctx, 41))
	require.Equal(t, uint64(8191), app.EVMKeeper.GetParams(ctx).HistoryServeWindow)
	require.Equal(t, uint64(ethparams.HistoryServeWindow), uint64(evmtypes.DefaultHistoryServeWindow))
}

func pqBlockHash(h uint64) []byte {
	s := sha256.Sum256(binary.BigEndian.AppendUint64([]byte("block"), h))
	return s[:]
}

// A direct call to the EIP-2935 contract returns the hash of the block asked
// for, across the wrap of its 8191-slot ring, and BLOCKHASH agrees.
func TestPQHistoryContractRing(t *testing.T) {
	app, ctx := pqApp(t)
	hist := ethparams.HistoryStorageAddress
	app.EVMKeeper.DeleteCodeHash(ctx, hist)
	_, err := app.BeginBlocker(ctx.WithBlockHeight(1))
	require.NoError(t, err)
	require.True(t, app.EVMKeeper.IsContract(ctx, hist), "installed")
	require.Equal(t, ethparams.HistoryStorageCode, app.EVMKeeper.GetCode(ctx, app.EVMKeeper.GetCodeHash(ctx, hist)))
	require.Equal(t, uint64(8191), app.EVMKeeper.GetParams(ctx).HistoryServeWindow)

	const N = 8200 // the block running; 1..N-1 are recorded
	for h := uint64(1); h < N; h++ {
		app.EVMKeeper.SetHeaderHash(ctx.WithBlockHeight(int64(h)).WithHeaderHash(pqBlockHash(h)))
	}
	run := ctx.WithBlockHeight(N).WithHeaderHash(pqBlockHash(N))
	from := common.HexToAddress("0x0000000000000000000000000000000000001234")
	if app.AccountKeeper.GetAccount(run, from.Bytes()) == nil {
		app.AccountKeeper.SetAccount(run, app.AccountKeeper.NewAccountWithAddress(run, from.Bytes()))
	}
	get := func(c sdk.Context, h uint64) ([]byte, error) {
		c = c.WithGasMeter(storetypes.NewInfiniteGasMeter())
		in := common.BigToHash(new(big.Int).SetUint64(h)).Bytes()
		res, err := app.EVMKeeper.CallEVMWithData(c, statedb.New(c, app.EVMKeeper, statedb.NewEmptyTxConfig()), from, &hist, in, false, false, nil)
		if err != nil {
			return nil, err
		}
		return res.Ret, nil
	}
	for _, h := range []uint64{N - 8191, N - 8190, 8189, 8190, 8191, 8192, 8193, N - 256, N - 1} {
		got, err := get(run, h)
		require.NoError(t, err, "h=%d", h)
		require.Equal(t, pqBlockHash(h), got, "history contract, h=%d (slot %d)", h, h%8191)
	}
	_, err = get(run, N)
	require.Error(t, err, "the running block is not served")
	_, err = get(run, N-8192)
	require.Error(t, err, "older than the window")
	bh := app.EVMKeeper.GetHashFn(run)
	for _, h := range []uint64{N - 256, 8191, 8192, N - 1} {
		require.Equal(t, common.BytesToHash(pqBlockHash(h)), bh(h), "BLOCKHASH(%d)", h)
	}

	// The block's own hash goes in at its end (EndBlock), as EIP-2935 does:
	// while N runs, slot N % 8191 still serves block N-8191.
	_, err = app.BeginBlocker(run)
	require.NoError(t, err)
	got, err := get(run, N-8191)
	require.NoError(t, err)
	require.Equal(t, pqBlockHash(N-8191), got)
	require.NoError(t, app.EVMKeeper.EndBlock(run))
	next := ctx.WithBlockHeight(N + 1)
	got, err = get(next, N)
	require.NoError(t, err)
	require.Equal(t, pqBlockHash(N), got)
	require.Equal(t, common.BytesToHash(pqBlockHash(N)), app.EVMKeeper.GetHashFn(next)(N))
}

// 0x…dEaD made a vesting account before any burn: the spendable part is
// still burned every block, the locked part stays, nothing fails or panics.
func TestPQDeadBurnVesting(t *testing.T) {
	app, ctx := pqApp(t)
	ctx = ctx.WithBlockTime(time.Unix(1_700_000_000, 0))
	denom := evmtypes.GetEVMCoinDenom()
	dead := sdk.AccAddress(DeadAddress.Bytes())
	locked := sdkmath.NewInt(7_000)
	pqFund(t, app, ctx, dead, locked)
	base := app.AccountKeeper.GetAccount(ctx, dead).(*authtypes.BaseAccount)
	orig := sdk.NewCoins(sdk.NewCoin(denom, locked))
	for _, mk := range []func() sdk.AccountI{
		func() sdk.AccountI {
			a, err := vestingtypes.NewContinuousVestingAccount(base, orig, ctx.BlockTime().Unix()+1000, ctx.BlockTime().Unix()+2000)
			require.NoError(t, err)
			return a
		},
		func() sdk.AccountI {
			a, err := vestingtypes.NewPermanentLockedAccount(base, orig)
			require.NoError(t, err)
			return a
		},
	} {
		app.AccountKeeper.SetAccount(ctx, mk())
		require.True(t, app.BankKeeper.SpendableCoin(ctx, dead, denom).Amount.IsZero())
		supply := app.BankKeeper.GetSupply(ctx, denom).Amount
		require.NotPanics(t, func() { app.burnDead(ctx) })
		require.Equal(t, supply, app.BankKeeper.GetSupply(ctx, denom).Amount, "nothing spendable: nothing burned")

		pqFund(t, app, ctx, dead, sdkmath.NewInt(500)) // sent to dEaD afterwards
		require.NotPanics(t, func() { app.burnDead(ctx) })
		require.Equal(t, locked, app.BankKeeper.GetBalance(ctx, dead, denom).Amount, "the locked part stays")
		require.Equal(t, supply, app.BankKeeper.GetSupply(ctx, denom).Amount, "the 500 sent were burned")
	}
}

func pqWriteSeed(t *testing.T, i int) string {
	home := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(home, "config"), 0o700))
	var seed [32]byte
	seed[0] = byte(i + 1) // as pqVals
	require.NoError(t, os.WriteFile(filepath.Join(home, "config", pqVoteSeedFn), []byte(hex.EncodeToString(seed[:])), 0o600))
	return home
}

// From the activation height a keyed proposer must put its own entry in the
// certificate; it signs one itself when its precommit did not bring one.
func TestPQCertProposerEntry(t *testing.T) {
	app, ctx := pqApp(t)
	vals := pqVals(4)
	hash := bytes.Repeat([]byte{0xab}, 32)
	const H = 10
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(pqLastBlockKey, append(binary.BigEndian.AppendUint64(nil, H), hash...))
	votes := []abci.VoteInfo{}
	for _, v := range vals {
		votes = append(votes, abci.VoteInfo{Validator: abci.Validator{Address: v.addr, Power: 25}, BlockIdFlag: cmtproto.BlockIDFlagCommit})
	}
	att := func(vs ...pqVal) []byte {
		var out []byte
		for _, v := range vs {
			sig, err := pqSign(v.sk, pqVoteMsg(ctx.ChainID(), H, hash))
			require.NoError(t, err)
			out = append(append(out, v.addr...), sig...)
		}
		return out
	}
	check := func(proposer []byte, txs ...[]byte) error {
		return app.pqCheckCert(ctx, H+1, proposer, votes, txs)
	}

	// Only vals[3] has a key (25% < 1/3): the 2/3 rule asks for nothing.
	pqRegister(ctx, app, vals[3].addr, vals[3].pub, nil, 1)
	require.NoError(t, check(vals[0].addr), "an unkeyed proposer may send none")
	require.ErrorContains(t, check(vals[3].addr), "proposer's own")
	require.NoError(t, check(vals[3].addr, pqCertTx(t, app, H, att(vals[3]))))
	// Before the activation height: the old rule.
	app.setZetaphyV2Height(ctx, H+2)
	require.NoError(t, check(vals[3].addr))
	app.setZetaphyV2Height(ctx, 1)

	// All keyed: above 2/3 but without the proposer is refused.
	for _, v := range vals[:3] {
		pqRegister(ctx, app, v.addr, v.pub, nil, 1)
	}
	require.ErrorContains(t, check(vals[0].addr, pqCertTx(t, app, H, att(vals[1], vals[2], vals[3]))), "proposer's own")
	require.NoError(t, check(vals[0].addr, pqCertTx(t, app, H, att(vals[0], vals[1], vals[2]))))
	// A proposer that was not a validator of H is not asked.
	require.NoError(t, check(bytes.Repeat([]byte{0x77}, 20), pqCertTx(t, app, H, att(vals[1], vals[2], vals[3]))))

	// The proposer missed H (absent): it signs its entry when proposing.
	ext := []abci.ExtendedVoteInfo{{Validator: abci.Validator{Address: vals[0].addr, Power: 25}, BlockIdFlag: cmtproto.BlockIDFlagAbsent}}
	for _, v := range vals[1:] {
		s, err := pqSign(v.sk, pqVoteMsg(ctx.ChainID(), H, hash))
		require.NoError(t, err)
		ext = append(ext, abci.ExtendedVoteInfo{Validator: abci.Validator{Address: v.addr, Power: 25}, VoteExtension: s, BlockIdFlag: cmtproto.BlockIDFlagCommit})
	}
	require.Len(t, app.pqCertOf([][]byte{app.pqBuildCert(ctx, H+1, vals[0].addr, ext)}).Attestations, 3*pqAttestationSize, "no key file: no own entry")
	app.pqHome = pqWriteSeed(t, 0)
	cert := app.pqBuildCert(ctx, H+1, vals[0].addr, ext)
	c := app.pqCertOf([][]byte{cert})
	require.Len(t, c.Attestations, 4*pqAttestationSize)
	require.Equal(t, vals[0].addr, c.Attestations[:20], "sorted, own entry first")
	require.NoError(t, check(vals[0].addr, cert))
	// Another validator's key file does not sign for the proposer.
	app.pqHome = pqWriteSeed(t, 1)
	require.Len(t, app.pqCertOf([][]byte{app.pqBuildCert(ctx, H+1, vals[0].addr, ext)}).Attestations, 3*pqAttestationSize)
}
