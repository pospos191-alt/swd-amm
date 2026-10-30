// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Echidna / Medusa property harnesses. Each harness IS the forge handler (inherits it), so the fuzzer
// calls the same actions, and exposes the same properties with the echidna_ prefix (bool, true = holds).
// Only hevm cheatcodes Echidna and Medusa support are used (prank, deal, warp, roll, sign, addr).
//
//   cd zetaphy-network
//   echidna audit/invariants/echidna/EchidnaHarnesses.sol --contract EchidnaCheques --config audit/invariants/echidna/echidna.yaml
//   medusa fuzz --config audit/invariants/echidna/medusa.json        (targets every harness below)

import {ZetaphyCheques} from "../../../contracts/ZetaphyCheques.sol";
import {UsefulIssuance} from "../../../contracts/UsefulIssuance.sol";
import {ComputeMarket, IRunnersView} from "../../../contracts/ComputeMarket.sol";
import {HyperlaneLockBoxV2, ISaphanMailbox, ISaphanIsm} from "../../../contracts/HyperlaneLockBoxV2.sol";
import {MockMailbox} from "../../../contracts/MockMailbox.sol";
import {SimpleMultisig} from "../../../contracts/SimpleMultisig.sol";
import {MockERC20, MockRunners, Receiver} from "../utils/Mocks.sol";
import {ChequesHandler} from "../ZetaphyCheques.inv.t.sol";
import {IssuanceHandler, Sink, FakeTimelock, ComputeHandler} from "../Rewards.inv.t.sol";
import {LockBoxHandler} from "../Bridge.inv.t.sol";
import {MultisigHandler, Counter} from "../Governance.inv.t.sol";

contract EchidnaCheques is ChequesHandler {
    constructor() ChequesHandler(new ZetaphyCheques(), new MockERC20("T", "T", 18)) {}

    function echidna_conservation() public view returns (bool) {
        uint256 n = ids.length;
        uint256 owedNative;
        uint256 owedToken;
        for (uint256 i; i < n; i++) {
            Ch memory x = get(ids[i]);
            if (x.paid > x.deposit) return false;
            if (x.done) continue;
            if (x.tok == address(0)) owedNative += x.deposit - x.paid; else owedToken += x.deposit - x.paid;
        }
        return address(c).balance == owedNative && token.balanceOf(address(c)) == owedToken;
    }

    function echidna_noOverpay() public view returns (bool) { return !overpaid; }
    function echidna_noCashAfterClose() public view returns (bool) { return !cashAfterCloseSucceeded; }
    function echidna_payerOnly() public view returns (bool) { return !withdrawWrong && !nonPayerMovedFunds; }
}

contract EchidnaIssuance is IssuanceHandler {
    constructor() IssuanceHandler(_iss(), address(_tl), _sinks(), _o) {
        UsefulIssuance.Bucket[] memory b = new UsefulIssuance.Bucket[](2);
        b[0] = UsefulIssuance.Bucket(address(sinks[0]), 3000, 100 ether, 0);
        b[1] = UsefulIssuance.Bucket(address(sinks[1]), 2000, 1e24, 0);
        vm.prank(address(_tl));
        iss.setBuckets(b);
    }

    FakeTimelock private _tl;
    Receiver private _o;
    UsefulIssuance private _i;

    function _iss() private returns (UsefulIssuance) {
        _tl = new FakeTimelock();
        _o = new Receiver();
        _i = new UsefulIssuance(address(_tl), address(_o));
        return _i;
    }

    function _sinks() private returns (Sink[3] memory s) {
        s = [new Sink(_i), new Sink(_i), new Sink(_i)];
    }

    function echidna_accounting() public view returns (bool) {
        UsefulIssuance.Bucket[] memory b = iss.buckets();
        uint256 sum = iss.pendingOverflow();
        for (uint256 i; i < b.length; i++) {
            if (b[i].accrued > b[i].cap) return false;
            sum += b[i].accrued;
        }
        return address(iss).balance == sum && ghostIn == address(iss).balance + ghostOut;
    }
}

contract EchidnaCompute is ComputeHandler {
    MockRunners private _r;

    constructor() ComputeHandler(_market()) {
        _r.set(rs[0], true, 3, 0);
        _r.set(rs[1], true, 3, 0);
    }

    function _market() private returns (ComputeMarket) {
        _r = new MockRunners();
        return new ComputeMarket(IRunnersView(address(_r)), 1);
    }

    function echidna_escrow() public view returns (bool) {
        uint256 sum;
        for (uint256 i; i < 2; i++) sum += m.credit(reqs[i]) + m.credit(rs[i]);
        uint256 n = m.taskCount();
        for (uint256 i; i < n; i++) {
            ComputeMarket.Task memory t = m.getTask(i);
            if (t.status == ComputeMarket.Status.Open || t.status == ComputeMarket.Status.Taken || t.status == ComputeMarket.Status.Delivered) sum += t.price;
        }
        return address(m).balance == sum && doubleSettle == 0;
    }
}

contract EchidnaLockBox is LockBoxHandler {
    constructor() LockBoxHandler(_box(), _mb, address(0x60F), address(0x6A), bytes32(uint256(0x0B0B))) {}

    MockMailbox private _mb;

    function _box() private returns (HyperlaneLockBoxV2) {
        _mb = new MockMailbox(11155111);
        _mb.setFee(0.01 ether);
        return new HyperlaneLockBoxV2(ISaphanMailbox(address(_mb)), 77390, 77390, bytes32(uint256(0x1A)), bytes32(uint256(0x0B0B)),
            address(0), ISaphanIsm(address(0x15A)), address(0x60F), address(0x6A), 200 ether, 1 hours);
    }

    function echidna_backing() public view returns (bool) {
        return address(box).balance == box.locked() && box.locked() == ghostLocked - ghostClaimed;
    }

    function echidna_claimRules() public view returns (bool) { return badClaims == 0 && overDaily == 0 && forgedQueued == 0; }
}

/// Expected to FAIL (finding SM-1): stale confirmations of removed owners keep counting.
contract EchidnaMultisig is MultisigHandler {
    constructor() MultisigHandler(_ms(), new Counter(), _owners()) {}

    function _owners() private pure returns (address[] memory o) {
        o = new address[](3);
        (o[0], o[1], o[2]) = (address(0x101), address(0x102), address(0x103));
    }

    function _ms() private returns (SimpleMultisig) { return new SimpleMultisig(_owners(), 2); }

    function echidna_executeNeedsCurrentOwnersQuorum() public view returns (bool) { return executedWithoutCurrentQuorum == 0; }
}
