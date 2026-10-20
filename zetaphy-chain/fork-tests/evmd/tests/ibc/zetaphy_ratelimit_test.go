// ZETAPHY: the IBC rate limit (x/ratelimit) is in the transfer stack and
// refuses a transfer that would move more than the governance-set share of
// a denom's supply through a channel within the window.
package ibc

import (
	"testing"

	"github.com/stretchr/testify/suite"

	"github.com/cosmos/evm/evmd"
	"github.com/cosmos/evm/evmd/tests/integration"
	evmibctesting "github.com/cosmos/evm/testutil/ibc"
	ratelimitkeeper "github.com/cosmos/evm/x/ratelimit/keeper"
	ratelimittypes "github.com/cosmos/evm/x/ratelimit/types"
	transfertypes "github.com/cosmos/ibc-go/v11/modules/apps/transfer/types"
	clienttypes "github.com/cosmos/ibc-go/v11/modules/core/02-client/types"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
)

type RateLimitTestSuite struct {
	suite.Suite
	coordinator *evmibctesting.Coordinator
	evmChainA   *evmibctesting.TestChain
	chainB      *evmibctesting.TestChain
}

func (s *RateLimitTestSuite) SetupTest() {
	s.coordinator = evmibctesting.NewCoordinator(s.T(), 1, 1, integration.SetupEvmd)
	s.evmChainA = s.coordinator.GetChain(evmibctesting.GetEvmChainID(1))
	s.chainB = s.coordinator.GetChain(evmibctesting.GetChainID(2))
}

func (s *RateLimitTestSuite) TestSendOverQuotaIsRefused() {
	path := evmibctesting.NewTransferPath(s.evmChainA, s.chainB)
	path.Setup()

	app := s.evmChainA.App.(*evmd.EVMD)
	ctx := s.evmChainA.GetContext()
	denom, err := app.StakingKeeper.BondDenom(ctx)
	s.Require().NoError(err)
	supply := app.BankKeeper.GetSupply(ctx, denom).Amount

	sender := s.evmChainA.SenderAccounts[1]
	balance := app.BankKeeper.GetBalance(ctx, sender.SenderAccount.GetAddress(), denom).Amount
	// The sender must hold more than 1% of the supply for the test to mean anything.
	onePercent := supply.QuoRaw(100)
	s.Require().True(balance.GT(onePercent.MulRaw(2)), "sender balance %s, supply %s", balance, supply)

	// Governance sets a 1% per day send limit for this denom on this channel.
	msgServer := ratelimitkeeper.NewMsgServerImpl(*app.RateLimitKeeper)
	_, err = msgServer.AddRateLimit(ctx, &ratelimittypes.MsgAddRateLimit{
		Authority:         authtypes.NewModuleAddress(govtypes.ModuleName).String(),
		Denom:             denom,
		ChannelOrClientId: path.EndpointA.ChannelID,
		MaxPercentSend:    sdkmath.NewInt(1),
		MaxPercentRecv:    sdkmath.NewInt(1),
		DurationHours:     24,
	})
	s.Require().NoError(err)
	s.coordinator.CommitBlock(s.evmChainA)

	send := func(amount sdkmath.Int) error {
		msg := transfertypes.NewMsgTransfer(
			path.EndpointA.ChannelConfig.PortID, path.EndpointA.ChannelID,
			sdk.NewCoin(denom, amount),
			sender.SenderAccount.GetAddress().String(), s.chainB.SenderAccount.GetAddress().String(),
			clienttypes.NewHeight(1, 110), 0, "",
		)
		_, err := s.evmChainA.SendMsgsWithSender(sender, msg)
		return err
	}

	// Half the quota goes through.
	s.Require().NoError(send(onePercent.QuoRaw(2)))
	// Another full 1% would exceed the quota: refused.
	err = send(onePercent)
	s.Require().Error(err)
	s.Require().Contains(err.Error(), "quota exceeded")
}

func TestRateLimitTestSuite(t *testing.T) {
	suite.Run(t, new(RateLimitTestSuite))
}
