//go:build test

package evmd

// Post-quantum vote certificates and the evidence switch.

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	circl "github.com/cloudflare/circl/sign/mldsa/mldsa44"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/stretchr/testify/require"

	"cosmossdk.io/core/comet"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

type pqVal struct {
	addr []byte
	sk   *circl.PrivateKey
	pub  []byte
}

func pqVals(n int) []pqVal {
	out := make([]pqVal, n)
	for i := range out {
		var seed [32]byte
		seed[0] = byte(i + 1)
		pk, sk := circl.NewKeyFromSeed(&seed)
		out[i] = pqVal{bytes.Repeat([]byte{byte(i + 1)}, 20), sk, pk.Bytes()}
	}
	return out
}

func pqRegister(ctx sdk.Context, app *EVMD, cons, pub, prev []byte, since int64) {
	v := binary.BigEndian.AppendUint64(nil, uint64(since))
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(pqVoteKeyOf(cons), append(append(v, pub...), prev...))
}

func pqCertTx(t *testing.T, app *EVMD, height uint64, att []byte) []byte {
	b := app.GetTxConfig().NewTxBuilder()
	require.NoError(t, b.SetMsgs(&MsgPQCertificate{Signer: sdk.AccAddress(make([]byte, 20)).String(), Height: height, Attestations: att}))
	bz, err := app.GetTxConfig().TxEncoder()(b.GetTx())
	require.NoError(t, err)
	return bz
}

func TestPQCertificateRule(t *testing.T) {
	app, ctx := pqApp(t)
	vals := pqVals(4)
	hash := bytes.Repeat([]byte{0xab}, 32)
	const H = 10 // block being certified; the certificate is checked at H+1
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
	check := func(txs ...[]byte) error { return app.pqCheckCert(ctx, H+1, votes, txs) }

	// No keys registered: nothing is required.
	require.NoError(t, check())

	// All four registered: three of four (75%) pass, two (50%) do not.
	for _, v := range vals {
		pqRegister(ctx, app, v.addr, v.pub, nil, 1)
	}
	require.NoError(t, check(pqCertTx(t, app, H, att(vals[0], vals[1], vals[2]))))
	require.Error(t, check(pqCertTx(t, app, H, att(vals[0], vals[1]))))
	require.Error(t, check(), "no certificate")
	// The same validator twice counts once.
	require.Error(t, check(pqCertTx(t, app, H, att(vals[0], vals[0], vals[1]))))
	// Signatures for another block, another height, or forged ones count for nothing.
	other := append(append([]byte{}, vals[2].addr...), make([]byte, circl.SignatureSize)...)
	require.Error(t, check(pqCertTx(t, app, H, append(att(vals[0], vals[1]), other...))))
	require.Error(t, check(pqCertTx(t, app, H-1, att(vals[0], vals[1], vals[2]))))
	// A validator's signature under another validator's address does not count.
	swapped := att(vals[3])
	copy(swapped, vals[2].addr)
	require.Error(t, check(pqCertTx(t, app, H, append(att(vals[0], vals[1]), swapped...))))

	// One validator without a key (25%): the others need > 2/3·100 − 25 = 41.7.
	ctx.KVStore(app.GetKey(pqStoreKey)).Delete(pqVoteKeyOf(vals[3].addr))
	require.NoError(t, check(pqCertTx(t, app, H, att(vals[0], vals[1]))))
	require.Error(t, check(pqCertTx(t, app, H, att(vals[0]))))

	// A key replaced in block H: votes for H were signed with the old key.
	_, oldSk := circl.NewKeyFromSeed(&[32]byte{9})
	oldPub := oldSk.Public().(*circl.PublicKey).Bytes()
	pqRegister(ctx, app, vals[0].addr, vals[0].pub, oldPub, H)
	sig, err := pqSign(oldSk, pqVoteMsg(ctx.ChainID(), H, hash))
	require.NoError(t, err)
	withOld := append(append(append([]byte{}, vals[0].addr...), sig...), att(vals[1])...)
	require.NoError(t, check(pqCertTx(t, app, H, withOld)))
	require.Error(t, check(pqCertTx(t, app, H, att(vals[0], vals[1]))), "the new key signs from H+1 on")

	// The proposer builds the certificate from the votes it got.
	ext := []abci.ExtendedVoteInfo{}
	for i, v := range vals[1:3] {
		s, err := pqSign(v.sk, pqVoteMsg(ctx.ChainID(), H, hash))
		require.NoError(t, err)
		flag := cmtproto.BlockIDFlagCommit
		if i == 1 {
			flag = cmtproto.BlockIDFlagNil
		}
		ext = append(ext, abci.ExtendedVoteInfo{Validator: abci.Validator{Address: v.addr, Power: 25}, VoteExtension: s, BlockIdFlag: flag})
	}
	c := app.pqCertOf([][]byte{app.pqBuildCert(ctx, H+1, ext)})
	require.NotNil(t, c)
	require.Equal(t, uint64(H), c.Height)
	require.Len(t, c.Attestations, pqAttestationSize, "only the commit vote")
}

// A certificate tx is refused everywhere but as part of a block being finalized.
func TestPQCertificateTxOnlyInBlocks(t *testing.T) {
	app, ctx := pqApp(t)
	bz := pqCertTx(t, app, 1, nil)
	tx, err := app.TxDecode(bz)
	require.NoError(t, err)
	_, err = app.AnteHandler()(ctx.WithExecMode(sdk.ExecModeCheck), tx, false)
	require.ErrorContains(t, err, "first tx of a block")
	_, err = app.AnteHandler()(ctx.WithExecMode(sdk.ExecModeSimulate), tx, true)
	require.Error(t, err)
	_, err = app.AnteHandler()(ctx.WithExecMode(sdk.ExecModeFinalize), tx, false)
	require.NoError(t, err)
	res, err := app.CheckTx(&abci.RequestCheckTx{Tx: bz, Type: abci.CheckTxType_New})
	require.NoError(t, err)
	require.NotZero(t, res.Code)
}

type pqTestEvidence struct{ addr []byte }

func (e pqTestEvidence) Type() comet.MisbehaviorType { return comet.DuplicateVote }
func (e pqTestEvidence) Validator() comet.Validator  { return pqTestValidator(e.addr) }
func (e pqTestEvidence) Height() int64               { return 5 }
func (e pqTestEvidence) Time() time.Time             { return time.Unix(0, 0) }
func (e pqTestEvidence) TotalVotingPower() int64     { return 100 }

type pqTestValidator []byte

func (v pqTestValidator) Address() []byte { return v }
func (v pqTestValidator) Power() int64    { return 1 }

// The evidence switch drops ed25519-only evidence for validators with a key.
func TestPQEvidenceSwitch(t *testing.T) {
	app, ctx := pqApp(t)
	vals := pqVals(2)
	pqRegister(ctx, app, vals[0].addr, vals[0].pub, nil, 1)
	info := pqBlockInfo{nil, pqEvidenceList{pqTestEvidence{vals[0].addr}, pqTestEvidence{vals[1].addr}}}
	ctx = ctx.WithCometInfo(info)
	require.Equal(t, 2, app.pqFilterEvidence(ctx).CometInfo().GetEvidence().Len(), "off by default")
	ctx.KVStore(app.GetKey(pqStoreKey)).Set(pqEvidenceKey, []byte{1})
	got := app.pqFilterEvidence(ctx).CometInfo().GetEvidence()
	require.Equal(t, 1, got.Len())
	require.Equal(t, vals[1].addr, got.Get(0).Validator().Address(), "a validator without a key is still slashable")
}
