//go:build test

package evmd

// Binary N+1 starts on a chain that completed every earlier upgrade.
//
// The 2026-11-05 testnet halt at block 239468 ("wrong app version 0, upgrade
// handler is missing for zetaphy-v5 upgrade plan"): x/upgrade checks, once per
// process at the first block, that the binary has the handler of the chain's
// last completed upgrade. The other upgrade tests run that check before any
// upgrade is completed (the flag is set by then), so a binary that drops an
// old handler, or registers it too late, passed them. These tests restart: a
// new app on the committed state of one where the upgrade completed.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	cmttypes "github.com/cometbft/cometbft/types"

	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/evm/testutil/constants"
	"github.com/cosmos/evm/testutil/integration/evm/network"
	evmtypes "github.com/cosmos/evm/x/vm/types"

	"cosmossdk.io/log/v2"
	sdkmath "cosmossdk.io/math"

	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	"github.com/cosmos/cosmos-sdk/testutil/mock"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
)

// restartNewApp: what `zetaphyd start` builds, on db, in its own process.
func restartNewApp(t *testing.T, db dbm.DB, home string) *EVMD {
	t.Helper()
	evmtypes.NewEVMConfigurator().ResetTestConfig()
	return NewExampleApp(log.NewNopLogger(), db, true, simtestutil.AppOptionsMap{flags.FlagHome: home}, baseapp.SetChainID(constants.ExampleChainID.ChainID))
}

// restartChain: a chain past genesis and block 1, committed to db.
func restartChain(t *testing.T, db dbm.DB, home string) *EVMD {
	t.Helper()
	app := restartNewApp(t, db, home)
	pk, err := mock.NewPV().GetPubKey()
	require.NoError(t, err)
	valSet := cmttypes.NewValidatorSet([]*cmttypes.Validator{cmttypes.NewValidator(pk, 1)})
	key := secp256k1.GenPrivKey()
	acc := authtypes.NewBaseAccount(key.PubKey().Address().Bytes(), key.PubKey(), 0, 0)
	evmChainID := constants.ExampleChainID.EVMChainID
	bal := banktypes.Balance{Address: acc.GetAddress().String(), Coins: sdk.NewCoins(sdk.NewCoin(evmtypes.DefaultEVMExtendedDenom, sdkmath.NewInt(100000000000000)))}
	gen, err := simtestutil.GenesisStateWithValSet(app.AppCodec(), app.DefaultGenesis(), valSet, []authtypes.GenesisAccount{acc}, bal)
	require.NoError(t, err)
	var bankGen banktypes.GenesisState
	app.AppCodec().MustUnmarshalJSON(gen[banktypes.ModuleName], &bankGen)
	bankGen.DenomMetadata = network.GenerateBankGenesisMetadata(evmChainID)
	gen[banktypes.ModuleName] = app.AppCodec().MustMarshalJSON(&bankGen)
	var evmGen evmtypes.GenesisState
	app.AppCodec().MustUnmarshalJSON(gen[evmtypes.ModuleName], &evmGen)
	evmGen.Params.EvmDenom = constants.ChainsCoinInfo[evmChainID].Denom
	gen[evmtypes.ModuleName] = app.AppCodec().MustMarshalJSON(&evmGen)
	bz, err := json.Marshal(gen)
	require.NoError(t, err)
	_, err = app.InitChain(&abci.RequestInitChain{ConsensusParams: simtestutil.DefaultConsensusParams, AppStateBytes: bz, ChainId: constants.ExampleChainID.ChainID})
	require.NoError(t, err)
	_, err = app.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 1, Time: time.Now()})
	require.NoError(t, err)
	_, err = app.Commit()
	require.NoError(t, err)
	return app
}

// restartComplete: the chain completes upgrade name at block h (its handler
// runs, the done key is written) and commits.
func restartComplete(t *testing.T, app *EVMD, name string, h int64) {
	t.Helper()
	ctx := app.NewUncachedContext(false, cmtproto.Header{Height: h, ChainID: constants.ExampleChainID.ChainID, Time: time.Now()})
	require.NoError(t, app.UpgradeKeeper.ApplyUpgrade(upgAt(ctx, h), upgradetypes.Plan{Name: name, Height: h}))
	app.CommitMultiStore().Commit()
}

func restartFirstBlock(t *testing.T, app *EVMD, h int64) error {
	t.Helper()
	ctx := app.NewUncachedContext(false, cmtproto.Header{Height: h, ChainID: constants.ExampleChainID.ChainID, Time: time.Now()})
	_, err := app.ModuleManager.PreBlock(upgAt(ctx, h))
	return err
}

func restartLastDone(t *testing.T, app *EVMD) (string, int64) {
	t.Helper()
	res, err := app.Query(context.Background(), &abci.RequestQuery{Path: "/store/" + upgradetypes.StoreKey + "/subspace", Data: []byte{upgradetypes.DoneByte}})
	require.NoError(t, err)
	require.Zero(t, res.Code, res.Log)
	name, h, err := zetaphyLastDone(res.Value)
	require.NoError(t, err)
	return name, h
}

// Every upgrade a ZETAPHY chain may have completed keeps its handler.
func TestUpgradeNamesKeepEveryHandler(t *testing.T) {
	require.Equal(t, []string{"v0.6.0-to-v0.7.0", "zetaphy-v2", "zetaphy-v3", "zetaphy-v4", "zetaphy-v5", "zetaphy-firewall"}, zetaphyUpgradeNames,
		"append new upgrades; never drop one a running chain may have completed")
	app, _ := pqApp(t)
	for _, n := range zetaphyUpgradeNames {
		require.True(t, app.UpgradeKeeper.HasHandler(n), "handler %q", n)
	}
}

// A new process of this binary runs the next block of a chain whose last
// completed upgrade is any of them (testnet 2026-11-05: zetaphy-v5).
func TestUpgradeRestartAfterEveryUpgrade(t *testing.T) {
	const h = int64(10)
	for _, name := range zetaphyUpgradeNames {
		t.Run(name, func(t *testing.T) {
			db, home := dbm.NewMemDB(), t.TempDir()
			restartComplete(t, restartChain(t, db, home), name, h)

			app := restartNewApp(t, db, home) // the node restarts with this binary
			last, at := restartLastDone(t, app)
			require.Equal(t, name, last)
			require.Equal(t, h, at)
			require.NoError(t, zetaphyUpgradeCheck(last, nil, h, app.UpgradeKeeper.HasHandler), "upgrade-check agrees")
			require.NoError(t, restartFirstBlock(t, app, h+1), "the first block after the restart")
		})
	}
}

// The halt itself: a binary without the handler of the last completed upgrade
// stops at its first block, and upgrade-check refuses it beforehand.
func TestUpgradeRestartWithoutHandlerStops(t *testing.T) {
	const name, h = "zetaphy-v99", int64(10)
	db, home := dbm.NewMemDB(), t.TempDir()
	prev := restartChain(t, db, home)
	restartComplete(t, prev, ZetaphyV5UpgradeName, 5)
	prev.UpgradeKeeper.SetUpgradeHandler(name, func(_ context.Context, _ upgradetypes.Plan, vm module.VersionMap) (module.VersionMap, error) {
		return vm, nil
	})
	restartComplete(t, prev, name, h)

	app := restartNewApp(t, db, home) // a binary without "zetaphy-v99"
	last, _ := restartLastDone(t, app)
	require.Equal(t, name, last, "the highest height wins, as in GetLastCompletedUpgrade")
	require.ErrorContains(t, zetaphyUpgradeCheck(last, nil, h, app.UpgradeKeeper.HasHandler), `no handler for "zetaphy-v99"`)
	require.ErrorContains(t, restartFirstBlock(t, app, h+1), "upgrade handler is missing for zetaphy-v99 upgrade plan")
}

// upgrade-check follows x/upgrade and zetaphyUpgradeModule for scheduled plans.
func TestUpgradeCheckPlans(t *testing.T) {
	has := func(n string) bool {
		return n == ZetaphyV5UpgradeName || n == ZetaphyV4UpgradeName || n == ZetaphyFirewallUpgradeName
	}
	plan := func(n string, h int64) *upgradetypes.Plan { return &upgradetypes.Plan{Name: n, Height: h} }
	require.NoError(t, zetaphyUpgradeCheck("", nil, 5, has))
	require.NoError(t, zetaphyUpgradeCheck(ZetaphyV5UpgradeName, nil, 5, has))
	require.Error(t, zetaphyUpgradeCheck("zetaphy-v99", nil, 5, has))
	require.NoError(t, zetaphyUpgradeCheck(ZetaphyV5UpgradeName, plan(ZetaphyFirewallUpgradeName, 50), 10, has), "early-allowed")
	require.ErrorContains(t, zetaphyUpgradeCheck(ZetaphyV5UpgradeName, plan(ZetaphyV4UpgradeName, 50), 10, has), "BINARY UPDATED BEFORE TRIGGER")
	require.NoError(t, zetaphyUpgradeCheck(ZetaphyV5UpgradeName, plan("zetaphy-v99", 50), 10, has), "an old binary runs until the height")
	require.ErrorContains(t, zetaphyUpgradeCheck(ZetaphyV5UpgradeName, plan("zetaphy-v99", 50), 49, has), "due at block 50")
	require.NoError(t, zetaphyUpgradeCheck(ZetaphyV5UpgradeName, plan(ZetaphyV4UpgradeName, 50), 49, has), "due, with its handler")
}
