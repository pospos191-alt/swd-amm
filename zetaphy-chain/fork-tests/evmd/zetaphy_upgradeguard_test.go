package evmd

import (
	"context"
	"testing"

	"cosmossdk.io/core/header"
	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	upgradetypes "github.com/cosmos/cosmos-sdk/x/upgrade/types"
)

func upgAt(ctx sdk.Context, h int64) sdk.Context {
	return ctx.WithBlockHeight(h).WithHeaderInfo(header.Info{Height: h, Time: ctx.BlockTime(), ChainID: ctx.ChainID()})
}

// The 2026-10-29 testnet case: the release with the v5 handler is installed,
// then the "zetaphy-v5" proposal passes. The chain must go on until the height,
// and the handler must run there.
func TestUpgradeEarlyBinaryV5(t *testing.T) {
	app, ctx := pqApp(t)
	app.setFutV5Height(upgAt(ctx, 40), 0)
	require.NoError(t, app.UpgradeKeeper.ScheduleUpgrade(upgAt(ctx, 40), upgradetypes.Plan{Name: ZetaphyV5UpgradeName, Height: 50}))

	for h := int64(41); h < 50; h++ {
		_, err := app.ModuleManager.PreBlock(upgAt(ctx, h))
		require.NoError(t, err, "block %d: the chain goes on before the upgrade height", h)
		require.False(t, app.futV5(upgAt(ctx, h), h), "v5 stays off before the height")
	}

	_, err := app.ModuleManager.PreBlock(upgAt(ctx, 50))
	require.NoError(t, err)
	require.Equal(t, int64(51), app.futV5Height(upgAt(ctx, 50)), "the handler ran at the height")
	_, err = app.UpgradeKeeper.GetUpgradePlan(upgAt(ctx, 50))
	require.ErrorIs(t, err, upgradetypes.ErrNoUpgradePlanFound, "the plan is done")
	done, h, err := app.UpgradeKeeper.GetLastCompletedUpgrade(upgAt(ctx, 51))
	require.NoError(t, err)
	require.Equal(t, ZetaphyV5UpgradeName, done)
	require.Equal(t, int64(50), h)

	_, err = app.ModuleManager.PreBlock(upgAt(ctx, 51))
	require.NoError(t, err, "blocks after the upgrade")
}

// Every other case keeps x/upgrade's behaviour.
func TestUpgradeGuardKeepsOtherStops(t *testing.T) {
	require.Equal(t, map[string]bool{ZetaphyV5UpgradeName: true}, zetaphyEarlyUpgrades,
		"only upgrades without new stores may run early (zetaphy-v2..v4 add the wasm store)")

	// A handler that is not on the list, installed early: still refused.
	app, ctx := pqApp(t)
	const other = "zetaphy-test-other"
	app.UpgradeKeeper.SetUpgradeHandler(other, func(c context.Context, _ upgradetypes.Plan, vm module.VersionMap) (module.VersionMap, error) {
		return vm, nil
	})
	require.NoError(t, app.UpgradeKeeper.ScheduleUpgrade(upgAt(ctx, 40), upgradetypes.Plan{Name: other, Height: 50}))
	_, err := app.ModuleManager.PreBlock(upgAt(ctx, 41))
	require.ErrorContains(t, err, "BINARY UPDATED BEFORE TRIGGER")

	// A binary without the handler at the height: it stops and asks for the new binary.
	app2, ctx2 := pqApp(t)
	require.NoError(t, app2.UpgradeKeeper.ScheduleUpgrade(upgAt(ctx2, 40), upgradetypes.Plan{Name: "zetaphy-v99", Height: 50}))
	_, err = app2.ModuleManager.PreBlock(upgAt(ctx2, 45))
	require.NoError(t, err, "before the height an old binary goes on")
	_, err = app2.ModuleManager.PreBlock(upgAt(ctx2, 50))
	require.ErrorContains(t, err, `UPGRADE "zetaphy-v99" NEEDED`)

	// A listed name whose handler this binary lacks behaves as x/upgrade does.
	app3, ctx3 := pqApp(t)
	require.NoError(t, app3.UpgradeKeeper.ScheduleUpgrade(upgAt(ctx3, 40), upgradetypes.Plan{Name: ZetaphyV5UpgradeName, Height: 50}))
	delete(zetaphyEarlyUpgrades, ZetaphyV5UpgradeName)
	_, err = app3.ModuleManager.PreBlock(upgAt(ctx3, 41))
	zetaphyEarlyUpgrades[ZetaphyV5UpgradeName] = true
	require.ErrorContains(t, err, "BINARY UPDATED BEFORE TRIGGER", "without the list entry the SDK guard applies")
}
