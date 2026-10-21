// ZETAPHY: the IBC large-transfer hold (evmd/zetaphy_ibchold.go). An inbound
// transfer at or over the governance threshold is received but not
// delivered: its acknowledgement waits for the hold delay, then the rest of
// the stack delivers it; the guardian can instead return it to the sender
// (an error acknowledgement, refunded on the source chain).
package ibc

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/suite"

	"github.com/cosmos/evm/evmd"
	"github.com/cosmos/evm/evmd/tests/integration"
	evmibctesting "github.com/cosmos/evm/testutil/ibc"
	transfertypes "github.com/cosmos/ibc-go/v11/modules/apps/transfer/types"
	clienttypes "github.com/cosmos/ibc-go/v11/modules/core/02-client/types"
	channeltypes "github.com/cosmos/ibc-go/v11/modules/core/04-channel/types"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	govtypes "github.com/cosmos/cosmos-sdk/x/gov/types"
)

type IBCHoldTestSuite struct {
	suite.Suite
	coordinator *evmibctesting.Coordinator
	evmChainA   *evmibctesting.TestChain
	chainB      *evmibctesting.TestChain
	path        *evmibctesting.Path
	voucher     string
	bDenom      string
}

func (s *IBCHoldTestSuite) SetupTest() {
	s.coordinator = evmibctesting.NewCoordinator(s.T(), 1, 1, integration.SetupEvmd)
	s.evmChainA = s.coordinator.GetChain(evmibctesting.GetEvmChainID(1))
	s.chainB = s.coordinator.GetChain(evmibctesting.GetChainID(2))
	s.path = evmibctesting.NewTransferPath(s.evmChainA, s.chainB)
	s.path.Setup()
	var err error
	s.bDenom, err = s.chainB.GetSimApp().StakingKeeper.BondDenom(s.chainB.GetContext())
	s.Require().NoError(err)
	s.voucher = transfertypes.NewDenom(s.bDenom, transfertypes.NewHop(s.path.EndpointA.ChannelConfig.PortID, s.path.EndpointA.ChannelID)).IBCDenom()

	// Governance: hold transfers of the voucher from 1000 up, for an hour,
	// guardian = sender account 2 of chain A.
	gov := authtypes.NewModuleAddress(govtypes.ModuleName).String()
	s.gov(&evmd.MsgSetIBCHoldRule{Authority: gov, Denom: s.voucher, MinAmount: "1000"})
	s.gov(&evmd.MsgSetIBCHold{Authority: gov, DelaySeconds: 3600, Guardian: s.guardian().String()})
	s.coordinator.CommitBlock(s.evmChainA)
}

func (s *IBCHoldTestSuite) app() *evmd.EVMD { return s.evmChainA.App.(*evmd.EVMD) }

func (s *IBCHoldTestSuite) guardian() sdk.AccAddress {
	return s.evmChainA.SenderAccounts[2].SenderAccount.GetAddress()
}

func (s *IBCHoldTestSuite) gov(m sdk.Msg) {
	h := s.app().MsgServiceRouter().Handler(m)
	_, err := h(s.evmChainA.GetContext(), m)
	s.Require().NoError(err)
}

func (s *IBCHoldTestSuite) receiver() sdk.AccAddress { return s.evmChainA.SenderAccount.GetAddress() }

func (s *IBCHoldTestSuite) balanceA() sdkmath.Int {
	return s.app().BankKeeper.GetBalance(s.evmChainA.GetContext(), s.receiver(), s.voucher).Amount
}

// sendFromB sends amount of B's bond denom to A and returns the packet.
func (s *IBCHoldTestSuite) sendFromB(amount int64) channeltypes.Packet {
	msg := transfertypes.NewMsgTransfer(s.path.EndpointB.ChannelConfig.PortID, s.path.EndpointB.ChannelID,
		sdk.NewInt64Coin(s.bDenom, amount), s.chainB.SenderAccount.GetAddress().String(), s.receiver().String(),
		clienttypes.NewHeight(1, 1000), 0, "")
	res, err := s.chainB.SendMsgs(msg)
	s.Require().NoError(err)
	p, err := evmibctesting.ParsePacketFromEvents(res.Events)
	s.Require().NoError(err)
	return p
}

func (s *IBCHoldTestSuite) ackOnA(p channeltypes.Packet) ([]byte, bool) {
	return s.app().IBCKeeper.ChannelKeeper.GetPacketAcknowledgement(s.evmChainA.GetContext(), p.DestinationPort, p.DestinationChannel, p.Sequence)
}

func (s *IBCHoldTestSuite) TestSmallTransferNotHeld() {
	p := s.sendFromB(999)
	s.Require().NoError(s.path.RelayPacket(p))
	s.Require().Equal(int64(999), s.balanceA().Int64())
}

func (s *IBCHoldTestSuite) TestLargeTransferHeldThenReleased() {
	p := s.sendFromB(5000)
	s.Require().NoError(s.path.EndpointA.UpdateClient())
	s.Require().NoError(s.path.EndpointA.RecvPacket(p))
	s.Require().True(s.balanceA().IsZero(), "held: nothing delivered")
	_, acked := s.ackOnA(p)
	s.Require().False(acked, "held: no acknowledgement yet")

	// Not before the delay...
	s.coordinator.IncrementTimeBy(30 * time.Minute)
	s.coordinator.CommitBlock(s.evmChainA)
	s.Require().True(s.balanceA().IsZero())
	// ...then delivered by BeginBlock.
	s.coordinator.IncrementTimeBy(31 * time.Minute)
	s.coordinator.CommitBlock(s.evmChainA)
	s.coordinator.CommitBlock(s.evmChainA)
	s.Require().Equal(int64(5000), s.balanceA().Int64(), "released after the delay")
	commitment, acked := s.ackOnA(p)
	s.Require().True(acked)
	ack := channeltypes.NewResultAcknowledgement([]byte{byte(1)})
	s.Require().Equal(channeltypes.CommitAcknowledgement(ack.Acknowledgement()), commitment)

	// The source chain completes the transfer as usual.
	s.Require().NoError(s.path.EndpointB.UpdateClient())
	s.Require().NoError(s.path.EndpointB.AcknowledgePacket(p, ack.Acknowledgement()))
}

func (s *IBCHoldTestSuite) TestGuardianReturnsHeldTransfer() {
	bApp := s.chainB.GetSimApp()
	sender := s.chainB.SenderAccount.GetAddress()
	before := bApp.BankKeeper.GetBalance(s.chainB.GetContext(), sender, s.bDenom).Amount
	p := s.sendFromB(7000)
	afterSend := bApp.BankKeeper.GetBalance(s.chainB.GetContext(), sender, s.bDenom).Amount
	s.Require().True(before.Sub(afterSend).GTE(sdkmath.NewInt(7000)))
	s.Require().NoError(s.path.EndpointA.UpdateClient())
	s.Require().NoError(s.path.EndpointA.RecvPacket(p))

	// refused: anyone but the guardian
	_, err := s.evmChainA.SendMsgsWithSender(s.evmChainA.SenderAccounts[1], &evmd.MsgIBCHoldCancel{Signer: s.evmChainA.SenderAccounts[1].SenderAccount.GetAddress().String(), Id: 1})
	s.Require().ErrorContains(err, "only the IBC hold guardian")
	_, err = s.evmChainA.SendMsgsWithSender(s.evmChainA.SenderAccounts[2], &evmd.MsgIBCHoldCancel{Signer: s.guardian().String(), Id: 1})
	s.Require().NoError(err)
	s.Require().True(s.balanceA().IsZero(), "never delivered")
	_, acked := s.ackOnA(p)
	s.Require().True(acked, "error acknowledgement written")

	// Relayed back, the source chain refunds the sender.
	ack := channeltypes.NewErrorAcknowledgement(errHeldReturned)
	s.Require().NoError(s.path.EndpointB.UpdateClient())
	s.Require().NoError(s.path.EndpointB.AcknowledgePacket(p, ack.Acknowledgement()))
	refunded := bApp.BankKeeper.GetBalance(s.chainB.GetContext(), sender, s.bDenom).Amount
	s.Require().Equal(afterSend.AddRaw(7000), refunded)

	// The delay passing later changes nothing.
	s.coordinator.IncrementTimeBy(2 * time.Hour)
	s.coordinator.CommitBlock(s.evmChainA)
	s.coordinator.CommitBlock(s.evmChainA)
	s.Require().True(s.balanceA().IsZero())
}

// The "*" rule: a share of the denom's supply on this chain. The first
// transfer of a new voucher (supply 0) is held; once the supply is large,
// a small share passes.
func (s *IBCHoldTestSuite) TestSupplyShareRule() {
	gov := authtypes.NewModuleAddress(govtypes.ModuleName).String()
	s.gov(&evmd.MsgSetIBCHoldRule{Authority: gov, Denom: s.voucher}) // removes the voucher's own rule
	s.gov(&evmd.MsgSetIBCHoldRule{Authority: gov, Denom: "*", SupplyBps: 2500})
	s.coordinator.CommitBlock(s.evmChainA)
	p := s.sendFromB(400)
	s.Require().NoError(s.path.EndpointA.UpdateClient())
	s.Require().NoError(s.path.EndpointA.RecvPacket(p))
	s.Require().True(s.balanceA().IsZero(), "first transfer of a new voucher: held")
	s.coordinator.IncrementTimeBy(61 * time.Minute)
	s.coordinator.CommitBlock(s.evmChainA)
	s.coordinator.CommitBlock(s.evmChainA)
	s.Require().Equal(int64(400), s.balanceA().Int64())
	s.Require().NoError(s.path.RelayPacket(s.sendFromB(99)), "under 25% of the supply: delivered at once")
	s.Require().Equal(int64(499), s.balanceA().Int64())
}

// Any unregistered error gives the same acknowledgement bytes (only the
// ABCI code is in them), so the test can rebuild the one the chain wrote.
var errHeldReturned = errors.New("returned")

func TestIBCHoldTestSuite(t *testing.T) {
	suite.Run(t, new(IBCHoldTestSuite))
}
