//go:build test

package evmd

// block.prevrandao from the post-quantum vote certificate (zetaphy_random.go)
// and the real burn of ZETAPHY sent to 0x…dEaD (zetaphy_feeburn.go).

import (
	"bytes"
	"encoding/binary"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/tracing"
	ethparams "github.com/ethereum/go-ethereum/params"
	"github.com/stretchr/testify/require"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	minttypes "github.com/cosmos/cosmos-sdk/x/mint/types"

	"github.com/cosmos/evm/x/vm/statedb"
	evmtypes "github.com/cosmos/evm/x/vm/types"
)

func TestPQPrevRandaoFormula(t *testing.T) {
	att := bytes.Repeat([]byte{1}, pqAttestationSize)
	cert := &MsgPQCertificate{Height: 9, Attestations: att}
	hash := bytes.Repeat([]byte{0xab}, 32)
	a := PrevRandao("zetaphy-1", 10, cert, nil)
	require.Equal(t, a, PrevRandao("zetaphy-1", 10, &MsgPQCertificate{Height: 9, Attestations: bytes.Clone(att)}, nil), "deterministic")
	others := []common.Hash{
		PrevRandao("zetaphy-2", 10, cert, nil),
		PrevRandao("zetaphy-1", 11, cert, nil),
		PrevRandao("zetaphy-1", 10, &MsgPQCertificate{Height: 9, Attestations: append(bytes.Clone(att[:len(att)-1]), 2)}, nil),
		PrevRandao("zetaphy-1", 10, &MsgPQCertificate{Height: 8, Attestations: att}, nil),
		PrevRandao("zetaphy-1", 10, nil, hash),
		PrevRandao("zetaphy-1", 10, nil, nil),
	}
	seen := map[common.Hash]bool{a: true}
	for i, o := range others {
		require.False(t, seen[o], "value %d repeats", i)
		seen[o] = true
	}
	for v := range seen {
		require.NotEqual(t, common.Hash{}, v)
		require.NotEqual(t, common.MaxHash, v)
	}
}

// pqReadRandao runs PREVRANDAO in the EVM of ctx, as a contract would.
func pqReadRandao(t *testing.T, app *EVMD, ctx sdk.Context) common.Hash {
	addr := common.HexToAddress("0x00000000000000000000000000000000000ca11e")
	db := statedb.New(ctx, app.EVMKeeper, statedb.NewEmptyTxConfig())
	db.SetCode(addr, []byte{0x44, 0x5f, 0x52, 0x60, 0x20, 0x5f, 0xf3}, tracing.CodeChangeUnspecified) // PREVRANDAO PUSH0 MSTORE PUSH1 32 PUSH0 RETURN
	require.NoError(t, db.Commit())
	from := common.HexToAddress("0x0000000000000000000000000000000000001234")
	if app.AccountKeeper.GetAccount(ctx, from.Bytes()) == nil {
		app.AccountKeeper.SetAccount(ctx, app.AccountKeeper.NewAccountWithAddress(ctx, from.Bytes()))
	}
	res, err := app.EVMKeeper.CallEVMWithData(ctx, statedb.New(ctx, app.EVMKeeper, statedb.NewEmptyTxConfig()), from, &addr, nil, false, false, nil)
	require.NoError(t, err)
	require.Len(t, res.Ret, 32)
	return common.BytesToHash(res.Ret)
}

func TestPQPrevRandaoFromCertificate(t *testing.T) {
	app, ctx := pqApp(t)
	vals := pqVals(4)
	st := ctx.KVStore(app.GetKey(pqStoreKey))
	votes := []abci.VoteInfo{}
	for _, v := range vals {
		votes = append(votes, abci.VoteInfo{Validator: abci.Validator{Address: v.addr, Power: 25}, BlockIdFlag: cmtproto.BlockIDFlagCommit})
	}
	const H = 10
	hash := bytes.Repeat([]byte{0xab}, 32)
	att := func(vs ...pqVal) []byte {
		var out []byte
		for _, v := range vs {
			sig, err := pqSign(v.sk, pqVoteMsg(ctx.ChainID(), H, hash))
			require.NoError(t, err)
			out = append(append(out, v.addr...), sig...)
		}
		return out
	}
	// preBlock runs PreBlocker's certificate step for block H+1 on a copy of the state.
	preBlock := func(txs ...[]byte) (common.Hash, error) {
		c, _ := ctx.WithBlockHeight(H + 1).CacheContext()
		c.KVStore(app.GetKey(pqStoreKey)).Set(pqLastBlockKey, append(binary.BigEndian.AppendUint64(nil, H), hash...))
		if err := app.pqPreBlock(c, &abci.RequestFinalizeBlock{Height: H + 1, Txs: txs, DecidedLastCommit: abci.CommitInfo{Votes: votes}, Hash: bytes.Repeat([]byte{0xcd}, 32)}); err != nil {
			return common.Hash{}, err
		}
		got := app.prevRandao(c)
		require.Equal(t, got, pqReadRandao(t, app, c), "the EVM sees the stored value")
		return got, nil
	}

	// No keys: fallback from the hash of block H.
	fb, err := preBlock()
	require.NoError(t, err)
	require.Equal(t, PrevRandao(ctx.ChainID(), H+1, nil, hash), fb)

	for _, v := range vals {
		pqRegister(ctx, app, v.addr, v.pub, nil, 1)
	}
	certA := pqCertTx(t, app, H, att(vals[0], vals[1], vals[2]))
	certB := pqCertTx(t, app, H, att(vals[0], vals[1], vals[2], vals[3]))
	ra, err := preBlock(certA)
	require.NoError(t, err)
	require.Equal(t, PrevRandao(ctx.ChainID(), H+1, app.pqCertOf([][]byte{certA}), nil), ra)
	ra2, err := preBlock(certA)
	require.NoError(t, err)
	require.Equal(t, ra, ra2, "deterministic")
	rb, err := preBlock(certB)
	require.NoError(t, err)
	require.NotEqual(t, ra, rb, "depends on the certificate")
	require.NotEqual(t, fb, ra)
	_, err = preBlock(pqCertTx(t, app, H, att(vals[0], vals[1])))
	require.Error(t, err, "an invalid certificate is refused, never used")

	// Vote extensions off: a certificate tx is not checked, so it must not count.
	cp := ctx.ConsensusParams()
	cp.Abci = &cmtproto.ABCIParams{}
	ctx = ctx.WithConsensusParams(cp)
	off, err := preBlock(certA)
	require.NoError(t, err)
	require.Equal(t, fb, off)

	// The randao key is chain history, not genesis.
	st.Set(pqRandaoKey, append(binary.BigEndian.AppendUint64(nil, 3), ra.Bytes()...))
	gen, err := app.pqExportGenesis(ctx)
	require.NoError(t, err)
	require.NotContains(t, string(gen), `"07`)
}

func TestPQPrevRandaoEveryBlock(t *testing.T) {
	app, ctx := pqApp(t)
	seen := map[common.Hash]bool{}
	prev := []byte(nil)
	for h := int64(1); h <= 6; h++ {
		c := ctx.WithBlockHeight(h)
		hash := bytes.Repeat([]byte{byte(h)}, 32)
		votes := abci.CommitInfo{Votes: []abci.VoteInfo{{Validator: abci.Validator{Address: bytes.Repeat([]byte{9}, 20), Power: 10}, BlockIdFlag: cmtproto.BlockIDFlagCommit}}}
		require.NoError(t, app.pqPreBlock(c, &abci.RequestFinalizeBlock{Height: h, Hash: hash, DecidedLastCommit: votes}))
		r := app.prevRandao(c)
		require.Equal(t, PrevRandao(ctx.ChainID(), h, nil, prev), r)
		require.False(t, seen[r], "block %d repeats a value", h)
		seen[r] = true
		prev = hash
		// Queries on the committed state of h see h's value; other heights a fallback.
		require.Equal(t, r, pqReadRandao(t, app, c))
		require.Equal(t, PrevRandao(ctx.ChainID(), h+1, nil, nil), app.prevRandao(c.WithBlockHeight(h+1)))
	}
}

func TestPQDeadBurn(t *testing.T) {
	app, ctx := pqApp(t)
	denom := evmtypes.GetEVMCoinDenom()
	dead := sdk.AccAddress(DeadAddress.Bytes())
	require.Nil(t, app.AccountKeeper.GetAccount(ctx, dead))
	supply := func() sdkmath.Int { return app.BankKeeper.GetSupply(ctx, denom).Amount }

	// No account, no balance: nothing happens, no panic.
	s0 := supply()
	require.NotPanics(t, func() { app.burnDead(ctx) })
	require.Equal(t, s0, supply())

	amt := sdkmath.NewInt(5_000_000_000_000_000_000)
	pqFund(t, app, ctx, dead, amt)
	other := sdk.NewCoins(sdk.NewCoin("uother", sdkmath.NewInt(77)))
	require.NoError(t, app.BankKeeper.MintCoins(ctx, minttypes.ModuleName, other))
	require.NoError(t, app.BankKeeper.SendCoinsFromModuleToAccount(ctx, minttypes.ModuleName, dead, other))
	s1 := supply()
	require.Equal(t, s0.Add(amt), s1)

	app.burnDead(ctx)
	require.True(t, app.BankKeeper.GetBalance(ctx, dead, denom).Amount.IsZero())
	require.Equal(t, s1.Sub(amt), supply(), "total supply drops by the burned amount")
	require.Equal(t, int64(77), app.BankKeeper.GetBalance(ctx, dead, "uother").Amount.Int64(), "other denoms stay")
	require.Equal(t, int64(77), app.BankKeeper.GetSupply(ctx, "uother").Amount.Int64())

	// Zero balance with an account: nothing happens.
	require.NotPanics(t, func() { app.burnDead(ctx) })
	require.Equal(t, s1.Sub(amt), supply())

	// The whole BeginBlocker burns it too.
	pqFund(t, app, ctx, dead, sdkmath.NewInt(3))
	_, err := app.BeginBlocker(ctx)
	require.NoError(t, err)
	require.True(t, app.BankKeeper.GetBalance(ctx, dead, denom).Amount.IsZero())
}

// BLOCKHASH: the EIP-2935 history contract is installed by the first
// BeginBlocker that lacks it, so the EVM keeper records each block's hash
// (in EndBlock).
func TestPQBlockHashHistory(t *testing.T) {
	app, ctx := pqApp(t)
	hist := ethparams.HistoryStorageAddress
	// The test genesis preinstalls it; `zetaphyd init` does not. Remove it.
	app.EVMKeeper.DeleteCodeHash(ctx, hist)
	if acc := app.AccountKeeper.GetAccount(ctx, hist.Bytes()); acc != nil {
		app.AccountKeeper.RemoveAccount(ctx, acc)
	}
	require.False(t, app.EVMKeeper.IsContract(ctx, hist))
	require.Equal(t, common.Hash{}, app.EVMKeeper.GetHashFn(ctx.WithBlockHeight(7))(3), "without it BLOCKHASH is 0")
	// Someone sent coins there first: the account keeps them and gets the code.
	pqFund(t, app, ctx, hist.Bytes(), sdkmath.NewInt(5))

	hashes := map[int64][]byte{}
	for h := int64(3); h <= 6; h++ {
		hashes[h] = bytes.Repeat([]byte{byte(h)}, 32)
		c := ctx.WithBlockHeight(h).WithHeaderHash(hashes[h])
		_, err := app.BeginBlocker(c)
		require.NoError(t, err)
		require.NoError(t, app.EVMKeeper.EndBlock(c)) // the EVM module records the block's hash at its end
	}
	require.True(t, app.EVMKeeper.IsContract(ctx, hist))
	require.Equal(t, int64(5), app.BankKeeper.GetBalance(ctx, hist.Bytes(), evmtypes.GetEVMCoinDenom()).Amount.Int64())
	get := app.EVMKeeper.GetHashFn(ctx.WithBlockHeight(7))
	for h := int64(3); h <= 6; h++ {
		require.Equal(t, common.BytesToHash(hashes[h]), get(uint64(h)), "BLOCKHASH(%d)", h)
	}
	require.Equal(t, common.Hash{}, get(8), "future blocks: 0")
}
